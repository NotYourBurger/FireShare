import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { beforeEach, describe, expect, it } from "vitest";
import { schema, type Database } from "./db";
import { createTestDb } from "./db/test-db";
import { createShareService, ShareError, type Download, type NewFile, type NewShare, type ShareService } from "./shares";
import { MIN_PART_SIZE } from "./storage/adapter";
import type { StorageAdapter } from "./storage/adapter";
import { createMemoryStorage } from "./storage/memory";
import { generateToken, hashToken } from "./tokens";

let db: Database;
let storage: StorageAdapter;
let service: ShareService;
let clock: Date;

beforeEach(async () => {
  db = await createTestDb();
  storage = createMemoryStorage();
  clock = new Date("2026-01-01T00:00:00Z");
  service = createShareService({ db, storage, now: () => clock });
});

const DAY = 86400;

/** Moves the clock forward. */
const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

const body = (data: Buffer | string) => Readable.from([Buffer.from(data)]);

const withFiles = (files: NewFile[], expirySeconds = 7 * DAY): NewShare => ({
  title: null,
  message: null,
  expirySeconds,
  files,
});

const file = (name: string, size: number): NewFile => ({ name, size, contentType: "text/plain" });

/** Uploads each file's whole content in one chunk. */
async function uploadAll(share: { files: { id: string }[] }, contents: string[]) {
  for (const [i, content] of contents.entries()) {
    await service.writeChunk(share.files[i].id, 0, body(content), Buffer.byteLength(content));
  }
}

describe("share service", () => {
  it("serves an uploaded file through the share token after finalize", async () => {
    const share = await service.createShare(withFiles([
      { name: "render.exr", size: 11, contentType: "image/x-exr" },
    ]));
    const [file] = share.files;

    expect(await service.writeChunk(file.id, 0, body("hello world"), 11)).toBe(11);
    const { token } = await service.finalize(share.id);

    const download = await service.openDownload(token, file.id);
    expect(download).toMatchObject({ name: "render.exr", size: 11, contentType: "image/x-exr" });
    expect((await buffer((download as Download).stream)).toString()).toBe("hello world");
  });

  it("returns nothing for an unknown token", async () => {
    expect(await service.openDownload(generateToken(), crypto.randomUUID())).toBeNull();
  });

  it("stores files under random server-chosen keys, never the client filename", async () => {
    const keys: string[] = [];
    const createUpload = storage.createUpload;
    storage.createUpload = (key, type) => (keys.push(key), createUpload(key, type));

    await service.createShare(withFiles([{ name: "../../etc/passwd", size: 1, contentType: "text/plain" }]));
    await service.createShare(withFiles([{ name: "../../etc/passwd", size: 1, contentType: "text/plain" }]));

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers like an unknown token when the stored file has gone missing", async () => {
    const keys: string[] = [];
    const createUpload = storage.createUpload;
    storage.createUpload = (key, type) => (keys.push(key), createUpload(key, type));
    const share = await service.createShare(withFiles([{ name: "a.txt", size: 1, contentType: "text/plain" }]));
    await service.writeChunk(share.files[0].id, 0, body("a"), 1);
    const { token } = await service.finalize(share.id);

    await storage.delete(keys[0]);
    expect(await service.openDownload(token, share.files[0].id)).toBeNull();
  });

  it("stores only a hash of the share token", async () => {
    const share = await service.createShare(withFiles([{ name: "a.txt", size: 1, contentType: "text/plain" }]));
    await service.writeChunk(share.files[0].id, 0, body("a"), 1);
    const { token } = await service.finalize(share.id);

    const rows = await db.select().from(schema.shares);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].tokenHash).toBe(hashToken(token));
  });

  describe("chunked upload", () => {
    const big = Buffer.alloc(MIN_PART_SIZE + 3, 7);

    async function pendingFile(size: number) {
      const share = await service.createShare(withFiles([{ name: "big.bin", size, contentType: "application/octet-stream" }]));
      return { shareId: share.id, fileId: share.files[0].id };
    }

    it("reports the offset reached so far and assembles chunks in order", async () => {
      const { shareId, fileId } = await pendingFile(big.length);
      expect(await service.getUpload(fileId)).toEqual({ size: big.length, offset: 0 });

      await service.writeChunk(fileId, 0, body(big.subarray(0, MIN_PART_SIZE)), MIN_PART_SIZE);
      expect(await service.getUpload(fileId)).toEqual({ size: big.length, offset: MIN_PART_SIZE });

      await service.writeChunk(fileId, MIN_PART_SIZE, body(big.subarray(MIN_PART_SIZE)), 3);
      const { token } = await service.finalize(shareId);
      const download = await service.openDownload(token, fileId);
      expect((await buffer((download as Download).stream)).equals(big)).toBe(true);
    });

    it("rejects a chunk that doesn't start at the current offset", async () => {
      const { fileId } = await pendingFile(big.length);
      await expect(service.writeChunk(fileId, 5, body("xyz"), 3)).rejects.toThrow(
        expect.objectContaining({ code: "offset_mismatch" }),
      );
    });

    it("rejects a chunk that would run past the declared size", async () => {
      const { fileId } = await pendingFile(2);
      await expect(service.writeChunk(fileId, 0, body("xyz"), 3)).rejects.toThrow(
        expect.objectContaining({ code: "invalid_chunk" }),
      );
    });

    it("rejects a non-final chunk smaller than the storage minimum part size", async () => {
      const { fileId } = await pendingFile(big.length);
      await expect(service.writeChunk(fileId, 0, body("xyz"), 3)).rejects.toThrow(
        expect.objectContaining({ code: "invalid_chunk" }),
      );
      expect(await service.getUpload(fileId)).toEqual({ size: big.length, offset: 0 });
    });

    it("keeps the offset unchanged when a chunk's body is cut short", async () => {
      const { fileId } = await pendingFile(3);
      await expect(service.writeChunk(fileId, 0, body("x"), 3)).rejects.toThrow();
      expect(await service.getUpload(fileId)).toEqual({ size: 3, offset: 0 });
    });

    it("reports unknown uploads as not found", async () => {
      expect(await service.getUpload(crypto.randomUUID())).toBeNull();
      await expect(service.writeChunk(crypto.randomUUID(), 0, body("x"), 1)).rejects.toBeInstanceOf(ShareError);
    });
  });

  describe("finalize", () => {
    it("refuses a share whose files haven't fully arrived, leaving it pending", async () => {
      const share = await service.createShare(withFiles([{ name: "a.txt", size: 2, contentType: "text/plain" }]));
      await expect(service.finalize(share.id)).rejects.toThrow(
        expect.objectContaining({ code: "not_finalizable" }),
      );
      expect(await service.getUpload(share.files[0].id)).toEqual({ size: 2, offset: 0 });
    });

    it("issues the share token only once", async () => {
      const share = await service.createShare(withFiles([{ name: "a.txt", size: 1, contentType: "text/plain" }]));
      await service.writeChunk(share.files[0].id, 0, body("a"), 1);
      await service.finalize(share.id);

      await expect(service.finalize(share.id)).rejects.toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
    });

    it("accepts no more chunks once the share is ready", async () => {
      const share = await service.createShare(withFiles([{ name: "a.txt", size: 1, contentType: "text/plain" }]));
      await service.writeChunk(share.files[0].id, 0, body("a"), 1);
      await service.finalize(share.id);

      expect(await service.getUpload(share.files[0].id)).toBeNull();
    });

    it("reports unknown shares as not found", async () => {
      await expect(service.finalize(crypto.randomUUID())).rejects.toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
      await expect(service.finalize("not-a-uuid")).rejects.toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
    });

    it("shares an empty file", async () => {
      const share = await service.createShare(withFiles([{ name: "empty.txt", size: 0, contentType: "text/plain" }]));
      const { token } = await service.finalize(share.id);

      const download = await service.openDownload(token, share.files[0].id);
      expect(download).toMatchObject({ name: "empty.txt", size: 0 });
      expect(await buffer((download as Download).stream)).toHaveLength(0);
    });
  });

  describe("multi-file shares", () => {
    it("serves every file of one share through its single token, in the uploader's order", async () => {
      const message = "Shot 12, v3.\nCall me if anything's off.";
      const share = await service.createShare({
        title: "Final renders",
        message,
        expirySeconds: DAY,
        files: [file("b.txt", 2), file("a.txt", 3), file("c.txt", 0)],
      });
      expect(share.files.map((f) => f.name)).toEqual(["b.txt", "a.txt", "c.txt"]);
      await uploadAll(share, ["bb", "aaa", ""]);
      const { token } = await service.finalize(share.id);

      expect(await service.viewShare(token)).toEqual({
        title: "Final renders",
        message,
        files: share.files,
      });
      for (const [i, content] of ["bb", "aaa", ""].entries()) {
        const download = await service.openDownload(token, share.files[i].id);
        expect((await buffer((download as Download).stream)).toString()).toBe(content);
      }
      expect(await db.select().from(schema.shares)).toHaveLength(1);
    });

    it("stays pending, with no link, until every file has arrived", async () => {
      const share = await service.createShare(withFiles([file("a.txt", 1), file("b.txt", 1)]));
      await uploadAll(share, ["a"]);

      await expect(service.finalize(share.id)).rejects.toThrow(
        expect.objectContaining({ code: "not_finalizable" }),
      );
      const [row] = await db.select().from(schema.shares);
      expect(row).toMatchObject({ status: "pending", tokenHash: null });
      expect(await service.getUpload(share.files[1].id)).toEqual({ size: 1, offset: 0 });
    });

    it("never becomes ready when one file fails to complete, and can be finalized again later", async () => {
      const share = await service.createShare(withFiles([file("a.txt", 1), file("b.txt", 1)]));
      await uploadAll(share, ["a", "b"]);
      const completeUpload = storage.completeUpload;
      let calls = 0;
      storage.completeUpload = async (...args) => {
        if (++calls === 2) throw new Error("storage unavailable");
        return completeUpload(...args);
      };

      await expect(service.finalize(share.id)).rejects.toThrow("storage unavailable");
      const [row] = await db.select().from(schema.shares);
      expect(row).toMatchObject({ status: "pending", tokenHash: null });

      // The first file is already assembled; a retry completes only the rest.
      const { token } = await service.finalize(share.id);
      expect(calls).toBe(3);
      const download = await service.openDownload(token, share.files[1].id);
      expect((await buffer((download as Download).stream)).toString()).toBe("b");
    });

    it("creates nothing when storage fails partway through creating the share", async () => {
      const createUpload = storage.createUpload;
      let calls = 0;
      storage.createUpload = async (...args) => {
        if (++calls === 2) throw new Error("storage unavailable");
        return createUpload(...args);
      };

      await expect(service.createShare(withFiles([file("a.txt", 1), file("b.txt", 1)]))).rejects.toThrow();
      expect(await db.select().from(schema.shares)).toHaveLength(0);
      expect(await db.select().from(schema.files)).toHaveLength(0);
    });

    it("accepts no more bytes for any file once the share is ready", async () => {
      const share = await service.createShare(withFiles([file("a.txt", 1), file("b.txt", 1)]));
      await uploadAll(share, ["a", "b"]);
      await service.finalize(share.id);

      for (const { id } of share.files) {
        expect(await service.getUpload(id)).toBeNull();
        await expect(service.writeChunk(id, 1, body(""), 0)).rejects.toThrow(
          expect.objectContaining({ code: "not_found" }),
        );
      }
    });

    it("doesn't serve another share's file through a token", async () => {
      const first = await service.createShare(withFiles([file("a.txt", 1)]));
      const second = await service.createShare(withFiles([file("secret.txt", 1)]));
      await uploadAll(first, ["a"]);
      await uploadAll(second, ["s"]);
      const { token } = await service.finalize(first.id);
      await service.finalize(second.id);

      expect(await service.openDownload(token, second.files[0].id)).toBeNull();
      expect(await service.openDownload(token, "not-a-uuid")).toBeNull();
    });

    it("shows nothing for an unknown token", async () => {
      expect(await service.viewShare(generateToken())).toBeNull();
    });
  });

  describe("expiry", () => {
    async function readyShare(expirySeconds: number) {
      const share = await service.createShare(withFiles([file("a.txt", 1)], expirySeconds));
      await uploadAll(share, ["a"]);
      const { token } = await service.finalize(share.id);
      return { token, fileId: share.files[0].id };
    }

    it("serves the share until its expiry, then reports it expired", async () => {
      const { token, fileId } = await readyShare(DAY);

      advance(DAY - 1);
      expect(await service.viewShare(token)).toMatchObject({ files: [{ name: "a.txt" }] });
      expect(await service.openDownload(token, fileId)).toMatchObject({ name: "a.txt" });

      advance(1);
      expect(await service.viewShare(token)).toBe("expired");
      expect(await service.openDownload(token, fileId)).toBe("expired");
    });

    it("counts expiry from when the share becomes ready, not from when the upload started", async () => {
      const share = await service.createShare(withFiles([file("a.txt", 1)], DAY));
      advance(2 * DAY);
      await uploadAll(share, ["a"]);
      const { token } = await service.finalize(share.id);

      advance(DAY - 1);
      expect(await service.viewShare(token)).not.toBe("expired");
      advance(1);
      expect(await service.viewShare(token)).toBe("expired");
    });

    it("records when the share expires", async () => {
      await readyShare(3 * DAY);
      const [row] = await db.select().from(schema.shares);
      expect(row.expirySeconds).toBe(3 * DAY);
      expect(row.expiresAt).toEqual(new Date("2026-01-04T00:00:00Z"));
    });

    it("reports an expired share as expired whichever file is asked for", async () => {
      const { token } = await readyShare(DAY);
      advance(DAY);
      expect(await service.openDownload(token, crypto.randomUUID())).toBe("expired");
      expect(await service.openDownload(token, "not-a-uuid")).toBe("expired");
    });

    it("still shows nothing for an unknown token", async () => {
      await readyShare(DAY);
      advance(DAY);
      expect(await service.viewShare(generateToken())).toBeNull();
    });
  });
});
