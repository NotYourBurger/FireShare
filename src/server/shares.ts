import { and, asc, eq, isNull } from "drizzle-orm";
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
}

export interface Download {
  name: string;
  size: number;
  contentType: string;
  stream: Readable;
}

/** What a share token leads to: the share, a share whose link has expired, or nothing. */
type Lookup<T> = T | "expired" | null;

export function createShareService({
  db,
  storage,
  now = () => new Date(),
}: {
  db: Database;
  storage: StorageAdapter;
  now?: () => Date;
}) {
  async function findReadyShare(token: string): Promise<Lookup<typeof shares.$inferSelect>> {
    const share = await db.query.shares.findFirst({
      where: and(eq(shares.tokenHash, hashToken(token)), eq(shares.status, "ready")),
    });
    if (!share) return null;
    return share.expiresAt && share.expiresAt > now() ? share : "expired";
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
        const [share] = await tx.insert(shares).values({ title, message, expirySeconds }).returning({ id: shares.id });
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

    /**
     * Completes every file and marks the share `ready`, starting its expiry;
     * returns the share token once. If any file can't be completed the share stays `pending`, and a
     * later call picks up where this one stopped.
     */
    async finalize(shareId: string) {
      const share = isUuid(shareId)
        ? await db.query.shares.findFirst({
            where: and(eq(shares.id, shareId), eq(shares.status, "pending")),
          })
        : undefined;
      if (!share) throw new ShareError("not_found", "No such pending share");

      const shareFiles = await db.query.files.findMany({
        where: eq(files.shareId, shareId),
        orderBy: asc(files.position),
      });
      if (shareFiles.length === 0 || shareFiles.some((file) => file.uploadOffset !== file.size)) {
        throw new ShareError("not_finalizable", "Not every file has finished uploading");
      }
      for (const file of shareFiles) {
        if (file.completedAt) continue;
        let parts = file.parts;
        if (file.size === 0) {
          // A multipart upload needs at least one part, even an empty one.
          parts = [await storage.writePart(file.storageKey, file.multipartUploadId, 1, Readable.from([]), 0)];
        }
        await storage.completeUpload(file.storageKey, file.multipartUploadId, parts);
        await db
          .update(files)
          .set({ completedAt: now() })
          .where(and(eq(files.id, file.id), isNull(files.completedAt)));
      }

      const token = generateToken();
      const readyAt = now();
      const expiresAt = new Date(readyAt.getTime() + share.expirySeconds * 1000);
      const updated = await db
        .update(shares)
        .set({ status: "ready", tokenHash: hashToken(token), readyAt, expiresAt })
        .where(and(eq(shares.id, shareId), eq(shares.status, "pending")))
        .returning({ id: shares.id });
      if (updated.length === 0) throw new ShareError("not_found", "No such pending share");
      return { token };
    },

    /** What a recipient sees for a share token, or null for anything not viewable. */
    async viewShare(token: string): Promise<Lookup<SharePage>> {
      const share = await findReadyShare(token);
      if (!share || share === "expired") return share;
      const shareFiles = await db
        .select({ id: files.id, name: files.name, size: files.size })
        .from(files)
        .where(eq(files.shareId, share.id))
        .orderBy(asc(files.position));
      return { title: share.title, message: share.message, files: shareFiles };
    },

    /**
     * Resolves a share token and one of its files, "expired" once the link has
     * expired, or null for anything else not downloadable.
     */
    async openDownload(token: string, fileId: string): Promise<Lookup<Download>> {
      const share = await findReadyShare(token);
      if (!share || share === "expired") return share;
      if (!isUuid(fileId)) return null;
      const file = await db.query.files.findFirst({
        where: and(eq(files.id, fileId), eq(files.shareId, share.id)),
      });
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
