import { and, asc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { crc32 } from "node:zlib";
import type { CleanupConfig } from "./config";
import { schema, type Database } from "./db";
import { partsCrc32 } from "./shares";
import { ObjectChangedError, type StorageAdapter } from "./storage/adapter";

const { shares, files } = schema;

/** What one cleanup run removed. */
export interface CleanupReport {
  /** Expired or deleted shares whose files were removed this run. */
  expiredShares: number;
  removedFiles: number;
  removedBytes: number;
  /** Pending shares past `PENDING_TTL`, removed with their incomplete uploads. */
  abandonedShares: number;
  abandonedBytes: number;
  /** Files of active shares whose CRC32 was computed this run, so their share's Download all became resumable. */
  checksummedFiles: number;
  /** Bytes read from storage to compute them. */
  checksummedBytes: number;
  /** Shares, or files for the CRC32 job, that hit an error; they're retried on the next run. */
  failures: number;
}

/**
 * The cleanup worker's jobs. Every step can be repeated, so a run cut short
 * at any point is completed by the next one, and two runs at once only
 * repeat each other's work.
 */
export function createCleanup({
  db,
  storage,
  config,
  now = () => new Date(),
}: {
  db: Database;
  storage: StorageAdapter;
  config: CleanupConfig;
  now?: () => Date;
}) {
  const ago = (seconds: number) => new Date(now().getTime() - seconds * 1000);

  /**
   * Deletes the stored objects of shares that expired or were deleted more
   * than `DELETE_GRACE` ago. Links stop serving at expiry on their own; the
   * grace only lets downloads already under way finish. Each file is marked
   * removed once its object is gone, and the share's rows stay so its
   * management link can still show what it held.
   */
  async function removeExpired(report: CleanupReport) {
    const cutoff = ago(config.deleteGraceSeconds);
    const due = await db
      .select({ id: files.id, shareId: files.shareId, storageKey: files.storageKey, size: files.size })
      .from(files)
      .innerJoin(shares, eq(files.shareId, shares.id))
      .where(
        and(
          isNull(files.removedAt),
          or(
            and(eq(shares.status, "ready"), lte(shares.expiresAt, cutoff)),
            and(eq(shares.status, "deleted"), lte(shares.deletedAt, cutoff)),
          ),
        ),
      );

    for (const [shareId, shareFiles] of Map.groupBy(due, (file) => file.shareId)) {
      try {
        let removedAny = false;
        for (const file of shareFiles) {
          await storage.delete(file.storageKey);
          const marked = await db
            .update(files)
            .set({ removedAt: now() })
            .where(and(eq(files.id, file.id), isNull(files.removedAt)))
            .returning({ id: files.id });
          // Another run got here first and already counted it.
          if (marked.length === 0) continue;
          removedAny = true;
          report.removedFiles++;
          report.removedBytes += file.size;
        }
        if (removedAny) report.expiredShares++;
      } catch (err) {
        report.failures++;
        console.error(`Cleanup couldn't remove the files of share ${shareId}:`, err);
      }
    }
  }

  /**
   * Removes `pending` shares older than `PENDING_TTL` with their incomplete
   * multipart uploads. Each is first claimed as `abandoned`, so a finalize or
   * chunk still in flight can no longer make it `ready`; its storage is
   * cleared, and only then does its row go, so no record outlives a
   * half-cleared share for longer than the next run.
   */
  async function removeAbandoned(report: CleanupReport) {
    await db
      .update(shares)
      .set({ status: "abandoned" })
      .where(and(eq(shares.status, "pending"), lte(shares.createdAt, ago(config.pendingTtlSeconds))));
    const abandoned = await db.select({ id: shares.id }).from(shares).where(eq(shares.status, "abandoned"));

    for (const { id: shareId } of abandoned) {
      try {
        const shareFiles = await db
          .select({
            storageKey: files.storageKey,
            multipartUploadId: files.multipartUploadId,
            uploadOffset: files.uploadOffset,
          })
          .from(files)
          .where(eq(files.shareId, shareId));
        for (const file of shareFiles) {
          await storage.abortUpload(file.storageKey, file.multipartUploadId);
          // A finalize that got in before the claim may have completed the object.
          await storage.delete(file.storageKey);
        }
        const removed = await db
          .delete(shares)
          .where(and(eq(shares.id, shareId), eq(shares.status, "abandoned")))
          .returning({ id: shares.id });
        if (removed.length === 0) continue;
        report.abandonedShares++;
        report.abandonedBytes += shareFiles.reduce((sum, file) => sum + file.uploadOffset, 0);
      } catch (err) {
        report.failures++;
        console.error(`Cleanup couldn't remove abandoned share ${shareId}:`, err);
      }
    }
  }

  /**
   * Computes the CRC32 of each file of an active share that has none yet:
   * direct-mode files, whose bytes never passed through the server. Each
   * object is read once, guarded by the ETag recorded at finalize, and its
   * CRC32 stored as soon as it's done, so a run cut short only repeats the
   * file it was reading. A share that expires or is deleted before its turn
   * is skipped. Stops between files, and abandons the file being read, once
   * `signal` is aborted.
   */
  async function computeCrc32s(report: CleanupReport, signal?: AbortSignal) {
    const active = () => and(eq(shares.status, "ready"), gt(shares.expiresAt, now()));
    const due = await db
      .select({ file: files })
      .from(files)
      .innerJoin(shares, eq(files.shareId, shares.id))
      .where(and(isNull(files.crc32), isNotNull(files.completedAt), isNull(files.removedAt), active()))
      .orderBy(asc(shares.readyAt), asc(files.position));

    for (const { file } of due) {
      if (signal?.aborted) return;
      try {
        // Files from before the crc32 column only need their chunks' combined.
        let crc = partsCrc32(file.size, file.parts);
        if (crc === null) {
          const [stillActive] = await db
            .select({ id: shares.id })
            .from(shares)
            .where(and(eq(shares.id, file.shareId), active()));
          if (!stillActive) continue;
          crc = await readCrc32(file, signal);
          if (crc === null) continue;
          report.checksummedBytes += file.size;
        }
        const stored = await db
          .update(files)
          .set({ crc32: crc })
          .where(and(eq(files.id, file.id), isNull(files.crc32)))
          .returning({ id: files.id });
        if (stored.length > 0) report.checksummedFiles++;
      } catch (err) {
        if (signal?.aborted) return;
        report.failures++;
        console.error(`Cleanup couldn't compute the CRC32 of file ${file.id} in share ${file.shareId}:`, err);
      }
    }
  }

  /**
   * Streams the object and returns its CRC32, or null when it no longer
   * matches the fingerprint recorded at finalize. Downloads refuse such an
   * object anyway, so there's nothing to compute.
   */
  async function readCrc32(file: typeof files.$inferSelect, signal?: AbortSignal): Promise<number | null> {
    const stored = await storage.head(file.storageKey);
    if (!stored || stored.size !== file.size || (file.fingerprintEtag !== null && stored.etag !== file.fingerprintEtag)) {
      return null;
    }
    if (file.size === 0) return 0;
    try {
      const stream = await storage.getReadStream(file.storageKey, { ifMatch: stored.etag });
      const abort = () => stream.destroy(new Error("Cleanup worker stopping"));
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted();
        let crc = 0;
        let length = 0;
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          crc = crc32(chunk, crc);
          length += chunk.length;
        }
        if (length !== file.size) throw new Error(`Read ${length} bytes, expected ${file.size}`);
        return crc;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    } catch (err) {
      if (err instanceof ObjectChangedError) return null;
      throw err;
    }
  }

  return {
    /** Runs every job once; `signal` cuts the CRC32 job short. */
    async run(signal?: AbortSignal): Promise<CleanupReport> {
      const report: CleanupReport = {
        expiredShares: 0,
        removedFiles: 0,
        removedBytes: 0,
        abandonedShares: 0,
        abandonedBytes: 0,
        checksummedFiles: 0,
        checksummedBytes: 0,
        failures: 0,
      };
      await removeExpired(report);
      await removeAbandoned(report);
      await computeCrc32s(report, signal);
      return report;
    },
  };
}

export type Cleanup = ReturnType<typeof createCleanup>;
