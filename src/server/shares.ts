import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Readable } from "node:stream";
import { schema, type Database } from "./db";
import { createHash, randomUUID } from "node:crypto";
import { chunkHashesFingerprint, combineCrc32, verifiedChunk } from "./integrity";
import {
  MIN_PART_SIZE,
  ObjectChangedError,
  type ByteRange,
  type StorageAdapter,
  type UploadedPart,
} from "./storage/adapter";
import { generateToken, hashToken } from "./tokens";
import { createZip, safeFileName, zipEntryNames } from "./zip";

const { shares, files } = schema;

export type ShareErrorCode =
  | "not_found"
  | "offset_mismatch"
  | "invalid_chunk"
  | "checksum_mismatch"
  | "not_finalizable"
  | "tampered";

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
  /** Whether every file's CRC32 is known, so Download all can be offered. */
  downloadAll: boolean;
}

export interface Download {
  name: string;
  size: number;
  contentType: string;
  /** Strong validator for the file's content, quoted as an HTTP ETag. */
  etag: string;
  /**
   * Streams the file, or just `range` of it, from the object whose
   * fingerprint was checked. Throws a `tampered` ShareError if the object
   * changed since.
   */
  read(range?: ByteRange): Promise<Readable>;
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

type ShareRow = typeof shares.$inferSelect;
type FileRow = typeof files.$inferSelect;

/** The file's CRC32 from its chunks', or null for files uploaded before CRC32s were recorded. */
function fileCrc32(file: FileRow): number | null {
  if (file.parts.some((part) => typeof part.crc32 !== "number")) return null;
  return combineCrc32(file.parts);
}

function tampered(fileId: string, detail: string): ShareError {
  console.error(`Refusing download of file ${fileId}: stored object doesn't match its fingerprint (${detail})`);
  return new ShareError("tampered", "The stored file has changed since it was shared");
}

export function createShareService({
  db,
  storage,
  now = () => new Date(),
}: {
  db: Database;
  storage: StorageAdapter;
  now?: () => Date;
}) {
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
     * be added to it afterwards.
     */
    async createShare({ title, message, expirySeconds, files: newFiles }: NewShare) {
      const uploads: { storageKey: string; multipartUploadId: string }[] = [];
      for (const file of newFiles) {
        const storageKey = randomUUID();
        const { uploadId } = await storage.createUpload(storageKey, file.contentType);
        uploads.push({ storageKey, multipartUploadId: uploadId });
      }
      return db.transaction(async (tx) => {
        const [share] = await tx
          .insert(shares)
          .values({ title, message, expirySeconds, createdAt: now() })
          .returning({ id: shares.id });
        const created = await tx
          .insert(files)
          .values(newFiles.map((file, i) => ({ ...file, ...uploads[i], shareId: share.id, position: i })))
          .returning({ id: files.id, name: files.name, size: files.size, position: files.position });
        created.sort((a, b) => a.position - b.position);
        return { id: share.id, files: created.map(({ position: _, ...file }) => file) };
      });
    },

    /** Upload progress of a file in a `pending` share, or null. */
    async getUpload(fileId: string) {
      const file = await findPendingFile(fileId);
      return file ? { size: file.size, offset: file.uploadOffset } : null;
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
        throw new ShareError("invalid_chunk", "Chunk runs past the end of the file");
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
    async finalize(shareId: string) {
      const share = isUuid(shareId)
        ? await db.query.shares.findFirst({
            where: and(eq(shares.id, shareId), eq(shares.status, "pending")),
          })
        : undefined;
      if (!share) throw new ShareError("not_found", "No such pending share");

      const shareFiles = await filesOf(shareId);
      if (shareFiles.length === 0 || shareFiles.some((file) => file.uploadOffset !== file.size)) {
        throw new ShareError("not_finalizable", "Not every file has finished uploading");
      }
      for (const file of shareFiles) {
        if (file.completedAt) continue;
        let parts: UploadedPart[] = file.parts;
        if (file.size === 0) {
          // A multipart upload needs at least one part, even an empty one.
          parts = [await storage.writePart(file.storageKey, file.multipartUploadId, 1, Readable.from([]), 0)];
        }
        await storage.completeUpload(file.storageKey, file.multipartUploadId, parts);
        const stored = await storage.head(file.storageKey);
        if (stored?.size !== file.size) {
          throw new Error(`Stored object for file ${file.id} is ${stored?.size ?? "missing"}, not ${file.size} bytes`);
        }
        await db
          .update(files)
          .set({
            completedAt: now(),
            fingerprintHash: chunkHashesFingerprint(file.parts.map((part) => part.sha256)),
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
        downloadAll: shareFiles.every((file) => fileCrc32(file) !== null),
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
      };
    },

    /**
     * The whole share as one store-only ZIP64, like {@link openDownload} for a
     * file: "unavailable", or null for anything not downloadable, including a
     * share with a file whose CRC32 isn't known. Every file's fingerprint is
     * checked before any bytes are served, and each read is guarded again.
     */
    async openArchive(token: string): Promise<Lookup<Download>> {
      const share = await findSharedShare(token);
      if (!share || share === "unavailable") return share;
      const shareFiles = await filesOf(share.id);
      const crcs = shareFiles.map(fileCrc32);
      if (crcs.some((crc) => crc === null)) return null;
      const etags = await Promise.all(shareFiles.map(checkFingerprint));
      if (etags.some((etag) => etag === null)) return null;

      const names = zipEntryNames(shareFiles.map((file) => file.name));
      const entries = shareFiles.map((file, i) => ({ name: names[i], size: file.size, crc32: crcs[i]! }));
      const modified = share.readyAt ?? share.createdAt;
      const zip = createZip(entries, modified, (i, range) => readChecked(shareFiles[i], etags[i]!, range));
      // The archive's bytes follow from exactly these inputs.
      const version = createHash("sha256")
        .update(JSON.stringify([entries, shareFiles.map((file) => file.fingerprintHash ?? file.id), modified]))
        .digest("hex");
      return {
        name: `${share.title ? safeFileName(share.title) : "Shared files"}.zip`,
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
