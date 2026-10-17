import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { schema, type Database } from "./db";
import { MIN_PART_SIZE, type StorageAdapter } from "./storage/adapter";
import { generateToken, hashToken } from "./tokens";

const { shares, files } = schema;

export type ShareErrorCode = "not_found" | "offset_mismatch" | "invalid_chunk" | "not_finalizable";

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

export interface Download {
  name: string;
  size: number;
  contentType: string;
  stream: Readable;
}

export function createShareService({ db, storage }: { db: Database; storage: StorageAdapter }) {
  async function findPendingFile(fileId: string) {
    if (!isUuid(fileId)) return null;
    const [row] = await db
      .select({ file: files })
      .from(files)
      .innerJoin(shares, eq(files.shareId, shares.id))
      .where(and(eq(files.id, fileId), eq(shares.status, "pending")));
    return row?.file ?? null;
  }

  return {
    /** Creates a `pending` share with a random storage key for each file. */
    async createShare(newFiles: NewFile[]) {
      const [share] = await db.insert(shares).values({}).returning({ id: shares.id });
      const created = [];
      for (const file of newFiles) {
        const storageKey = randomUUID();
        const { uploadId } = await storage.createUpload(storageKey, file.contentType);
        const [row] = await db
          .insert(files)
          .values({ ...file, shareId: share.id, storageKey, multipartUploadId: uploadId })
          .returning({ id: files.id, name: files.name, size: files.size });
        created.push(row);
      }
      return { id: share.id, files: created };
    },

    /** Upload progress of a file in a `pending` share, or null. */
    async getUpload(fileId: string) {
      const file = await findPendingFile(fileId);
      return file ? { size: file.size, offset: file.uploadOffset } : null;
    },

    /**
     * Streams one chunk into the next storage part and returns the new offset.
     * The offset only advances once storage has accepted the whole chunk.
     */
    async writeChunk(fileId: string, offset: number, body: Readable, length: number) {
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
      const part = await storage.writePart(
        file.storageKey,
        file.multipartUploadId,
        file.parts.length + 1,
        body,
        length,
      );
      const updated = await db
        .update(files)
        .set({ uploadOffset: newOffset, parts: [...file.parts, part] })
        .where(and(eq(files.id, fileId), eq(files.uploadOffset, offset)))
        .returning({ id: files.id });
      if (updated.length === 0) {
        throw new ShareError("offset_mismatch", "Another chunk was written concurrently");
      }
      return newOffset;
    },

    /** Completes every file and marks the share `ready`; returns the share token once. */
    async finalize(shareId: string) {
      const share = isUuid(shareId)
        ? await db.query.shares.findFirst({
            where: and(eq(shares.id, shareId), eq(shares.status, "pending")),
          })
        : undefined;
      if (!share) throw new ShareError("not_found", "No such pending share");

      const shareFiles = await db.query.files.findMany({ where: eq(files.shareId, shareId) });
      if (shareFiles.some((file) => file.uploadOffset !== file.size)) {
        throw new ShareError("not_finalizable", "Not every file has finished uploading");
      }
      for (const file of shareFiles) {
        let parts = file.parts;
        if (file.size === 0) {
          // A multipart upload needs at least one part, even an empty one.
          parts = [await storage.writePart(file.storageKey, file.multipartUploadId, 1, Readable.from([]), 0)];
        }
        await storage.completeUpload(file.storageKey, file.multipartUploadId, parts);
      }

      const token = generateToken();
      const updated = await db
        .update(shares)
        .set({ status: "ready", tokenHash: hashToken(token), readyAt: new Date() })
        .where(and(eq(shares.id, shareId), eq(shares.status, "pending")))
        .returning({ id: shares.id });
      if (updated.length === 0) throw new ShareError("not_found", "No such pending share");
      return { token };
    },

    /** Resolves a share token to its file, or null for anything not downloadable. */
    async openDownload(token: string): Promise<Download | null> {
      const share = await db.query.shares.findFirst({
        where: and(eq(shares.tokenHash, hashToken(token)), eq(shares.status, "ready")),
      });
      if (!share) return null;
      const file = await db.query.files.findFirst({ where: eq(files.shareId, share.id) });
      // A missing object must look exactly like an unknown token.
      if (!file || !(await storage.head(file.storageKey))) return null;
      return {
        name: file.name,
        size: file.size,
        contentType: file.contentType,
        stream: await storage.getReadStream(file.storageKey),
      };
    },
  };
}

export type ShareService = ReturnType<typeof createShareService>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}
