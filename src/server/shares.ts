import { and, asc, count, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { Readable } from "node:stream";
import type { LimitsConfig } from "./config";
import { schema, type Database } from "./db";
import { createHash, randomUUID } from "node:crypto";
import { chunkHashesFingerprint, combineCrc32, verifiedChunk } from "./integrity";
import {
  MIN_PART_SIZE,
  ObjectChangedError,
  type ByteRange,
  type StorageAdapter,
  type StoredPart,
  type UploadedPart,
} from "./storage/adapter";
import { generateToken, hashToken } from "./tokens";
import { createStreamingZip, createZip, safeFileName, zipEntryNames } from "./zip";

const { shares, files } = schema;

export type ShareErrorCode =
  | "not_found"
  | "offset_mismatch"
  | "invalid_chunk"
  | "checksum_mismatch"
  | "not_finalizable"
  | "tampered"
  | "too_large"
  | "storage_full"
  | "quota_exceeded";

export class ShareError extends Error {
  constructor(
    readonly code: ShareErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ShareError";
  }
}

export interface NewFile {
  name: string;
  size: number;
  contentType: string;
}

export interface NewShare {
  /** The uploader's IP address, or null if it isn't known. */
  clientIp: string | null;
  title: string | null;
  message: string | null;
  /** How long the link works, counted from when the share becomes ready. */
  expirySeconds: number;
  files: NewFile[];
}

export interface SharedFile {
  id: string;
  name: string;
  size: number;
}

export interface SharePage {
  title: string | null;
  message: string | null;
  files: SharedFile[];
  /** Whether Download all can be offered for this share. */
  downloadAll: boolean;
}

export interface ArchiveDownload {
  name: string;
  /** Exact archive size when every file's CRC32 is known up front, or null when streamed with data descriptors. */
  size: number | null;
  contentType: string;
  /** Strong validator when the archive layout is fixed up front, or null when streamed with data descriptors. */
  etag: string | null;
  /**
   * Streams the archive, or just `range` of it when `size` is known, from the
   * objects whose fingerprints were checked. Throws a `tampered` ShareError if
   * any object changed since.
   */
  read(range?: ByteRange): Promise<Readable>;
}

export interface Download extends ArchiveDownload {
  size: number;
  /** Strong validator for the file's content, quoted as an HTTP ETag. */
  etag: string;
  /**
   * Short-lived presigned URL to read this file directly from storage with
   * the given Content-Disposition header.
   */
  presign(contentDisposition: string): Promise<string>;
}

/** Where a finalized share stands: serving, past its expiry, or deleted early by the uploader. */
export type ShareStatus = "active" | "expired" | "deleted";

/** What the holder of the management link sees. */
export interface ManagedShare {
  status: ShareStatus;
  title: string | null;
  message: string | null;
  expiresAt: Date;
  deletedAt: Date | null;
  files: SharedFile[];
}

/**
 * What a share token leads to: the share, "unavailable" once its link has
 * expired or been deleted, or nothing.
 */
type Lookup<T> = T | "unavailable" | null;

/** The limits a new share must fit within; each is null when it's off. */
export type ShareLimits = Pick<
  LimitsConfig,
  "maxShareSize" | "maxFilesPerShare" | "maxTotalStorage" | "uploadQuotaPerIp" | "maxActiveSharesPerIp"
>;

const NO_LIMITS: ShareLimits = {
  maxShareSize: null,
  maxFilesPerShare: null,
  maxTotalStorage: null,
  uploadQuotaPerIp: null,
  maxActiveSharesPerIp: null,
};

/** Serializes the limit checks of shares being created, so parallel uploads can't race past a limit. */
const LIMITS_LOCK = 0x46697265; // "Fire"

const QUOTA_WINDOW_SECONDS = 86400;

type ShareRow = typeof shares.$inferSelect;
type FileRow = typeof files.$inferSelect;

/** The file's CRC32 from its chunks', or null for files without per-chunk CRC32s. */
function fileCrc32(file: FileRow): number | null {
  if (file.size > 0 && file.parts.length === 0) return null;
  if (file.parts.some((part) => typeof part.crc32 !== "number")) return null;
  return combineCrc32(file.parts as { size: number; crc32: number }[]);
}

/**
 * Inspects the parts already uploaded to storage for a direct-mode file and
 * returns the contiguous valid byte offset starting from part 1.
 */
function contiguousProgress(storedParts: StoredPart[], fileSize: number, chunkSize?: number) {
  let offset = 0;
  let completedParts = 0;
  for (let i = 0; i < storedParts.length && offset < fileSize; i++) {
    const partNumber = i + 1;
    const part = storedParts[i];
    if (part.partNumber !== partNumber) break;
    if (chunkSize !== undefined) {
      const expectedSize = Math.min(chunkSize, fileSize - offset);
      if (part.size !== expectedSize) break;
    } else {
      if (offset + part.size > fileSize) break;
      if (offset + part.size < fileSize && part.size < MIN_PART_SIZE) break;
    }
    offset += part.size;
    completedParts = partNumber;
  }
  return { offset, completedParts };
}

function tampered(fileId: string, detail: string): ShareError {
  console.error(`Refusing download of file ${fileId}: stored object doesn't match its fingerprint (${detail})`);
  return new ShareError("tampered", "The stored file has changed since it was shared");
}

export function createShareService({
  db,
  storage,
  limits = NO_LIMITS,
  now = () => new Date(),
}: {
  db: Database;
  storage: StorageAdapter;
  limits?: ShareLimits;
  now?: () => Date;
}) {
  const countsOtherShares =
    limits.maxTotalStorage !== null || limits.uploadQuotaPerIp !== null || limits.maxActiveSharesPerIp !== null;

  /** Shares that hold storage and a link: still uploading, or ready and not yet expired. */
  const isActive = () =>
    or(eq(shares.status, "pending"), and(eq(shares.status, "ready"), gt(shares.expiresAt, now())));

  const fromClient = (clientIp: string | null) =>
    clientIp === null ? isNull(shares.clientIp) : eq(shares.clientIp, clientIp);

  /** Total declared size of the files of the shares matching `where`. */
  async function declaredBytes(query: Pick<Database, "select">, where: SQL | undefined) {
    const [row] = await query
      .select({ bytes: sql<string | null>`sum(${files.size})` })
      .from(files)
      .innerJoin(shares, eq(files.shareId, shares.id))
      .where(where);
    return Number(row?.bytes ?? 0);
  }

  /**
   * Throws a ShareError, with a message for the uploader, if `newShare`
   * doesn't fit within the limits beside the shares already created.
   */
  async function checkLimits(query: Pick<Database, "select">, newShare: NewShare) {
    const size = newShare.files.reduce((sum, file) => sum + file.size, 0);
    const { maxShareSize, maxFilesPerShare, maxTotalStorage, uploadQuotaPerIp, maxActiveSharesPerIp } = limits;
    if (maxFilesPerShare !== null && newShare.files.length > maxFilesPerShare) {
      throw new ShareError(
        "too_large",
        `A share can hold at most ${maxFilesPerShare} files, and this one has ${newShare.files.length}. Share fewer files at once.`,
      );
    }
    if (maxShareSize !== null && size > maxShareSize.bytes) {
      throw new ShareError(
        "too_large",
        `A share can be at most ${maxShareSize.value} in total. Share fewer or smaller files.`,
      );
    }
    if (maxActiveSharesPerIp !== null) {
      const [{ active }] = await query
        .select({ active: count() })
        .from(shares)
        .where(and(fromClient(newShare.clientIp), isActive()));
      if (active >= maxActiveSharesPerIp) {
        throw new ShareError(
          "quota_exceeded",
          `You already have ${active} active shares, the most allowed. Delete one from Recent shares, or wait for one to expire.`,
        );
      }
    }
    if (uploadQuotaPerIp !== null) {
      const since = new Date(now().getTime() - QUOTA_WINDOW_SECONDS * 1000);
      const uploaded = await declaredBytes(query, and(fromClient(newShare.clientIp), gt(shares.createdAt, since)));
      if (uploaded + size > uploadQuotaPerIp.bytes) {
        throw new ShareError(
          "quota_exceeded",
          `This share would take you past the upload quota of ${uploadQuotaPerIp.value} per 24 hours. Try a smaller share, or try again later.`,
        );
      }
    }
    if (maxTotalStorage !== null && (await declaredBytes(query, isActive())) + size > maxTotalStorage.bytes) {
      throw new ShareError(
        "storage_full",
        "The server doesn't have room for this share right now. Try a smaller share, or try again later.",
      );
    }
  }

  function statusOf(share: ShareRow): ShareStatus {
    if (share.status === "deleted") return "deleted";
    return share.expiresAt && share.expiresAt > now() ? "active" : "expired";
  }

  /** Checked on every request, so expiry and deletion stop even a resume already under way. */
  async function findSharedShare(token: string): Promise<Lookup<ShareRow>> {
    const share = await db.query.shares.findFirst({
      where: and(eq(shares.tokenHash, hashToken(token)), inArray(shares.status, ["ready", "deleted"])),
    });
    if (!share) return null;
    return statusOf(share) === "active" ? share : "unavailable";
  }

  function findManagedShare(managementToken: string) {
    return db.query.shares.findFirst({
      where: and(
        eq(shares.managementTokenHash, hashToken(managementToken)),
        inArray(shares.status, ["ready", "deleted"]),
      ),
    });
  }

  async function findPendingFile(fileId: string) {
    if (!isUuid(fileId)) return null;
    const [row] = await db
      .select({ file: files })
      .from(files)
      .innerJoin(shares, eq(files.shareId, shares.id))
      .where(and(eq(files.id, fileId), eq(shares.status, "pending")));
    return row?.file ?? null;
  }

  function filesOf(shareId: string) {
    return db.query.files.findMany({ where: eq(files.shareId, shareId), orderBy: asc(files.position) });
  }

  /**
   * The ETag the file's stored object must still have, or null when the
   * object is missing. Throws a `tampered` ShareError, and logs it, when the
   * object's size or ETag no longer matches the fingerprint recorded at finalize.
   */
  async function checkFingerprint(file: FileRow): Promise<string | null> {
    const stored = await storage.head(file.storageKey);
    if (!stored) return null;
    if (stored.size !== file.size) {
      throw tampered(file.id, `size ${stored.size}, expected ${file.size}`);
    }
    // Files completed before fingerprints were recorded can only be checked by size.
    if (file.fingerprintEtag !== null && stored.etag !== file.fingerprintEtag) {
      throw tampered(file.id, `ETag ${stored.etag}, expected ${file.fingerprintEtag}`);
    }
    return stored.etag;
  }

  /** Reads the object whose ETag was checked; ifMatch closes the gap between the check and the read. */
  async function readChecked(file: FileRow, etag: string, range?: ByteRange) {
    try {
      return await storage.getReadStream(file.storageKey, { range, ifMatch: etag });
    } catch (err) {
      if (err instanceof ObjectChangedError) throw tampered(file.id, "ETag changed while opening");
      throw err;
    }
  }

  return {
    /**
     * Creates a `pending` share with a random storage key for each file. The
     * share and all its files appear together or not at all; files can never
     * be added to it afterwards. Throws a ShareError, before anything is
     * stored, if the share doesn't fit within the limits.
     */
    async createShare(newShare: NewShare) {
      const { clientIp, title, message, expirySeconds, files: newFiles } = newShare;
      await checkLimits(db, newShare);
      const uploads: { storageKey: string; multipartUploadId: string }[] = [];
      try {
        for (const file of newFiles) {
          const storageKey = randomUUID();
          const { uploadId } = await storage.createUpload(storageKey, file.contentType);
          uploads.push({ storageKey, multipartUploadId: uploadId });
        }
        return await db.transaction(async (tx) => {
          if (countsOtherShares) {
            // Checked again under the lock: another share may have been created since.
            await tx.execute(sql`select pg_advisory_xact_lock(${LIMITS_LOCK})`);
            await checkLimits(tx, newShare);
          }
          const [share] = await tx
            .insert(shares)
            .values({ title, message, expirySeconds, clientIp, createdAt: now() })
            .returning({ id: shares.id });
          const created = await tx
            .insert(files)
            .values(newFiles.map((file, i) => ({ ...file, ...uploads[i], shareId: share.id, position: i })))
            .returning({ id: files.id, name: files.name, size: files.size, position: files.position });
          created.sort((a, b) => a.position - b.position);
          return { id: share.id, files: created.map(({ position: _, ...file }) => file) };
        });
      } catch (err) {
        // No row points at these uploads, so nothing else would ever remove them.
        await Promise.allSettled(uploads.map((upload) => storage.abortUpload(upload.storageKey, upload.multipartUploadId)));
        throw err;
      }
    },

    /** Upload progress of a file in a `pending` share, or null. */
    async getUpload(fileId: string, chunkSize?: number) {
      const file = await findPendingFile(fileId);
      if (!file) return null;
      if (file.uploadOffset > 0 || file.size === 0 || file.parts.length > 0) {
        return { size: file.size, offset: file.uploadOffset };
      }
      const storedParts = await storage.listParts(file.storageKey, file.multipartUploadId);
      const { offset } = contiguousProgress(storedParts, file.size, chunkSize);
      return { size: file.size, offset };
    },

    /**
     * Upload progress and short-lived presigned part URLs for the remaining
     * parts of a file in a `pending` share, or null. Signs only as many
     * `uploadPart` URLs as the remaining bytes require.
     */
    async getDirectUpload(fileId: string, chunkSize: number) {
      const file = await findPendingFile(fileId);
      if (!file) return null;
      if (file.size === 0) {
        return { size: 0, offset: 0, partUrls: [] as string[] };
      }
      const storedParts = await storage.listParts(file.storageKey, file.multipartUploadId);
      const { offset, completedParts } = contiguousProgress(storedParts, file.size, chunkSize);
      const totalParts = Math.ceil(file.size / chunkSize);
      const partUrls: string[] = [];
      for (let partNumber = completedParts + 1; partNumber <= totalParts; partNumber++) {
        partUrls.push(
          await storage.getPresignedUrl({
            action: "uploadPart",
            key: file.storageKey,
            uploadId: file.multipartUploadId,
            partNumber,
          }),
        );
      }
      return { size: file.size, offset, partUrls };
    },

    /**
     * Streams one chunk into the next storage part and returns the new offset.
     * A chunk whose SHA-256 (hex) isn't `sha256` never becomes a part. The
     * offset only advances once storage has accepted the whole chunk.
     */
    async writeChunk(fileId: string, offset: number, body: Readable, length: number, sha256: string) {
      const file = await findPendingFile(fileId);
      if (!file) throw new ShareError("not_found", "No such upload");
      if (offset !== file.uploadOffset) {
        throw new ShareError("offset_mismatch", `Upload is at offset ${file.uploadOffset}`);
      }
      const newOffset = offset + length;
      if (newOffset > file.size) {
        // More bytes than the uploader declared: the share fails, and cleanup removes it.
        await db
          .update(shares)
          .set({ status: "abandoned" })
          .where(and(eq(shares.id, file.shareId), eq(shares.status, "pending")));
        throw new ShareError("too_large", "More bytes were sent than the file's declared size, so the upload was stopped");
      }
      if (newOffset < file.size && length < MIN_PART_SIZE) {
        throw new ShareError("invalid_chunk", `Chunks before the last must be at least ${MIN_PART_SIZE} bytes`);
      }
      if (length === 0) return offset;
      const chunk = verifiedChunk(body, sha256);
      const part = await storage
        .writePart(file.storageKey, file.multipartUploadId, file.parts.length + 1, chunk.stream, length)
        .catch((err: unknown) => {
          if (chunk.mismatched()) throw new ShareError("checksum_mismatch", "Chunk doesn't match its SHA-256");
          throw err;
        });
      const updated = await db
        .update(files)
        .set({ uploadOffset: newOffset, parts: [...file.parts, { ...part, size: length, ...chunk.digest() }] })
        .where(and(eq(files.id, fileId), eq(files.uploadOffset, offset)))
        .returning({ id: files.id });
      if (updated.length === 0) {
        throw new ShareError("offset_mismatch", "Another chunk was written concurrently");
      }
      return newOffset;
    },

    /**
     * Completes every file, checks its stored size and records its
     * fingerprint, then marks the share `ready`, starting its expiry;
     * returns the share token and the management token, once. If any file can't be completed the share stays `pending`, and a
     * later call picks up where this one stopped.
     */
    async finalize(shareId: string, chunkSize?: number) {
      const share = isUuid(shareId)
        ? await db.query.shares.findFirst({
            where: and(eq(shares.id, shareId), eq(shares.status, "pending")),
          })
        : undefined;
      if (!share) throw new ShareError("not_found", "No such pending share");

      const shareFiles = await filesOf(shareId);
      if (shareFiles.length === 0) {
        throw new ShareError("not_finalizable", "Not every file has finished uploading");
      }

      const resolvedParts = new Map<string, schema.FilePart[]>();
      for (const file of shareFiles) {
        if (file.completedAt || file.size === 0) continue;
        if (file.parts.length > 0) {
          if (file.uploadOffset !== file.size) {
            throw new ShareError("not_finalizable", "Not every file has finished uploading");
          }
          resolvedParts.set(file.id, file.parts);
          continue;
        }
        const storedParts = await storage.listParts(file.storageKey, file.multipartUploadId);
        if (storedParts.length === 0) {
          throw new ShareError("not_finalizable", "Not every file has finished uploading");
        }
        const totalSize = storedParts.reduce((sum, part) => sum + part.size, 0);
        const contiguous = storedParts.every((part, i) => part.partNumber === i + 1);
        const validNonFinalSizes = storedParts
          .slice(0, -1)
          .every((part) => (chunkSize !== undefined ? part.size === chunkSize : part.size >= MIN_PART_SIZE));
        if (contiguous && validNonFinalSizes && totalSize < file.size) {
          const lastSize = storedParts[storedParts.length - 1].size;
          const isInProgressPrefix =
            chunkSize !== undefined ? lastSize === chunkSize : lastSize >= MIN_PART_SIZE;
          if (isInProgressPrefix) {
            throw new ShareError("not_finalizable", "Not every file has finished uploading");
          }
        }
        if (!contiguous || !validNonFinalSizes || totalSize !== file.size) {
          await storage.abortUpload(file.storageKey, file.multipartUploadId);
          await storage.delete(file.storageKey);
          throw new ShareError(
            "invalid_chunk",
            `Stored object for file ${file.id} is ${totalSize}, not ${file.size} bytes`,
          );
        }
        resolvedParts.set(file.id, storedParts);
      }

      for (const file of shareFiles) {
        if (file.completedAt) continue;
        let partsToComplete: UploadedPart[];
        let partsForDb: schema.FilePart[];
        if (file.size === 0) {
          // A multipart upload needs at least one part, even an empty one.
          partsToComplete = [await storage.writePart(file.storageKey, file.multipartUploadId, 1, Readable.from([]), 0)];
          partsForDb = file.parts;
        } else {
          partsForDb = resolvedParts.get(file.id)!;
          partsToComplete = partsForDb;
        }
        await storage.completeUpload(file.storageKey, file.multipartUploadId, partsToComplete);
        const stored = await storage.head(file.storageKey);
        if (stored?.size !== file.size) {
          await storage.delete(file.storageKey);
          throw new ShareError(
            "invalid_chunk",
            `Stored object for file ${file.id} is ${stored?.size ?? "missing"}, not ${file.size} bytes`,
          );
        }
        const hasChunkHashes =
          file.size === 0 || (partsForDb.length > 0 && partsForDb.every((part) => typeof part.sha256 === "string"));
        await db
          .update(files)
          .set({
            uploadOffset: file.size,
            parts: partsForDb,
            completedAt: now(),
            fingerprintHash: hasChunkHashes
              ? chunkHashesFingerprint(partsForDb.map((part) => part.sha256!))
              : null,
            fingerprintEtag: stored.etag,
          })
          .where(and(eq(files.id, file.id), isNull(files.completedAt)));
      }

      const token = generateToken();
      const managementToken = generateToken();
      const readyAt = now();
      const expiresAt = new Date(readyAt.getTime() + share.expirySeconds * 1000);
      const updated = await db
        .update(shares)
        .set({
          status: "ready",
          tokenHash: hashToken(token),
          managementTokenHash: hashToken(managementToken),
          readyAt,
          expiresAt,
        })
        .where(and(eq(shares.id, shareId), eq(shares.status, "pending")))
        .returning({ id: shares.id });
      if (updated.length === 0) throw new ShareError("not_found", "No such pending share");
      return { token, managementToken, expiresAt };
    },

    /** What a recipient sees for a share token, "unavailable", or null for anything else. */
    async viewShare(token: string): Promise<Lookup<SharePage>> {
      const share = await findSharedShare(token);
      if (!share || share === "unavailable") return share;
      const shareFiles = await filesOf(share.id);
      return {
        title: share.title,
        message: share.message,
        files: shareFiles.map(({ id, name, size }) => ({ id, name, size })),
        downloadAll: true,
      };
    },

    /**
     * Resolves a share token and one of its files, "unavailable" once the link
     * has expired or been deleted, or null for anything else not downloadable. Throws a `tampered`
     * ShareError, and logs it, when the stored object's size or ETag no
     * longer matches the fingerprint recorded at finalize.
     */
    async openDownload(token: string, fileId: string): Promise<Lookup<Download>> {
      const share = await findSharedShare(token);
      if (!share || share === "unavailable") return share;
      if (!isUuid(fileId)) return null;
      const file = await db.query.files.findFirst({
        where: and(eq(files.id, fileId), eq(files.shareId, share.id)),
      });
      if (!file) return null;
      const etag = await checkFingerprint(file);
      // A missing object must look exactly like an unknown token.
      if (!etag) return null;
      return {
        name: file.name,
        size: file.size,
        contentType: file.contentType,
        etag: `"${file.fingerprintHash ?? file.id}"`,
        read: (range) => readChecked(file, etag, range),
        presign: (contentDisposition) =>
          storage.getPresignedUrl({
            action: "getObject",
            key: file.storageKey,
            responseContentDisposition: contentDisposition,
            responseContentType: file.contentType,
          }),
      };
    },

    /**
     * The whole share as one store-only ZIP64, like {@link openDownload} for a
     * file: "unavailable", or null for anything not downloadable. When every
     * file's CRC32 is known up front, the archive is laid out with an exact
     * size and ETag so Range requests work; otherwise (e.g., direct-mode files
     * before background CRC32 runs) it streams with ZIP data descriptors.
     * Every file's fingerprint is checked before any bytes are served, and each
     * read is guarded again.
     */
    async openArchive(token: string): Promise<Lookup<ArchiveDownload>> {
      const share = await findSharedShare(token);
      if (!share || share === "unavailable") return share;
      const shareFiles = await filesOf(share.id);
      const etags = await Promise.all(shareFiles.map(checkFingerprint));
      if (etags.some((etag) => etag === null)) return null;

      const names = zipEntryNames(shareFiles.map((file) => file.name));
      const modified = share.readyAt ?? share.createdAt;
      const archiveName = `${share.title ? safeFileName(share.title) : "Shared files"}.zip`;
      const crcs = shareFiles.map(fileCrc32);
      if (crcs.some((crc) => crc === null)) {
        const streamingEntries = shareFiles.map((file, i) => ({ name: names[i], size: file.size }));
        return {
          name: archiveName,
          size: null,
          contentType: "application/zip",
          etag: null,
          read: async () =>
            createStreamingZip(streamingEntries, modified, (i, range) => readChecked(shareFiles[i], etags[i]!, range)),
        };
      }

      const entries = shareFiles.map((file, i) => ({ name: names[i], size: file.size, crc32: crcs[i]! }));
      const zip = createZip(entries, modified, (i, range) => readChecked(shareFiles[i], etags[i]!, range));
      // The archive's bytes follow from exactly these inputs.
      const version = createHash("sha256")
        .update(JSON.stringify([entries, shareFiles.map((file) => file.fingerprintHash ?? file.id), modified]))
        .digest("hex");
      return {
        name: archiveName,
        size: zip.size,
        contentType: "application/zip",
        etag: `"${version}"`,
        read: async (range) => zip.read(range),
      };
    },

    /** The share a management token belongs to, whatever its status, or null. */
    async manageShare(managementToken: string): Promise<ManagedShare | null> {
      const share = await findManagedShare(managementToken);
      if (!share?.expiresAt) return null;
      const shareFiles = await filesOf(share.id);
      return {
        status: statusOf(share),
        title: share.title,
        message: share.message,
        expiresAt: share.expiresAt,
        deletedAt: share.deletedAt,
        files: shareFiles.map(({ id, name, size }) => ({ id, name, size })),
      };
    },

    /**
     * Deletes the share early: its link stops serving at once, exactly as if
     * it had expired. Deleting again changes nothing. Returns false for an
     * unknown management token.
     */
    async deleteShare(managementToken: string): Promise<boolean> {
      const deleted = await db
        .update(shares)
        .set({ status: "deleted", deletedAt: now() })
        .where(and(eq(shares.managementTokenHash, hashToken(managementToken)), eq(shares.status, "ready")))
        .returning({ id: shares.id });
      return deleted.length > 0 || (await findManagedShare(managementToken)) !== undefined;
    },
  };
}

export type ShareService = ReturnType<typeof createShareService>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}
