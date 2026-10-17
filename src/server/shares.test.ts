import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { beforeEach, describe, expect, it } from "vitest";
import { schema, type Database } from "./db";
import { createTestDb } from "./db/test-db";
import { createShareService, ShareError, type ShareService } from "./shares";
import { MIN_PART_SIZE } from "./storage/adapter";
import type { StorageAdapter } from "./storage/adapter";
import { createMemoryStorage } from "./storage/memory";
import { generateToken, hashToken } from "./tokens";

let db: Database;
let storage: StorageAdapter;
let service: ShareService;

beforeEach(async () => {
  db = await createTestDb();
  storage = createMemoryStorage();
  service = createShareService({ db, storage });
});

const body = (data: Buffer | string) => Readable.from([Buffer.from(data)]);

describe("share service", () => {
  it("serves an uploaded file through the share token after finalize", async () => {
    const share = await service.createShare([
      { name: "render.exr", size: 11, contentType: "image/x-exr" },
    ]);
    const [file] = share.files;

    expect(await service.writeChunk(file.id, 0, body("hello world"), 11)).toBe(11);
    const { token } = await service.finalize(share.id);

    const download = await service.openDownload(token);
    expect(download).toMatchObject({ name: "render.exr", size: 11, contentType: "image/x-exr" });
    expect((await buffer(download!.stream)).toString()).toBe("hello world");
  });

  it("returns nothing for an unknown token", async () => {
    expect(await service.openDownload(generateToken())).toBeNull();
  });

  it("stores files under random server-chosen keys, never the client filename", async () => {
    const keys: string[] = [];
    const createUpload = storage.createUpload;
    storage.createUpload = (key, type) => (keys.push(key), createUpload(key, type));

    await service.createShare([{ name: "../../etc/passwd", size: 1, contentType: "text/plain" }]);
    await service.createShare([{ name: "../../etc/passwd", size: 1, contentType: "text/plain" }]);

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers like an unknown token when the stored file has gone missing", async () => {
    const keys: string[] = [];
    const createUpload = storage.createUpload;
    storage.createUpload = (key, type) => (keys.push(key), createUpload(key, type));
    const share = await service.createShare([{ name: "a.txt", size: 1, contentType: "text/plain" }]);
    await service.writeChunk(share.files[0].id, 0, body("a"), 1);
    const { token } = await service.finalize(share.id);

    await storage.delete(keys[0]);
    expect(await service.openDownload(token)).toBeNull();
  });

  it("stores only a hash of the share token", async () => {
    const share = await service.createShare([{ name: "a.txt", size: 1, contentType: "text/plain" }]);
    await service.writeChunk(share.files[0].id, 0, body("a"), 1);
    const { token } = await service.finalize(share.id);

    const rows = await db.select().from(schema.shares);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].tokenHash).toBe(hashToken(token));
  });

  describe("chunked upload", () => {
    const big = Buffer.alloc(MIN_PART_SIZE + 3, 7);

    async function pendingFile(size: number) {
      const share = await service.createShare([{ name: "big.bin", size, contentType: "application/octet-stream" }]);
      return { shareId: share.id, fileId: share.files[0].id };
    }

    it("reports the offset reached so far and assembles chunks in order", async () => {
      const { shareId, fileId } = await pendingFile(big.length);
      expect(await service.getUpload(fileId)).toEqual({ size: big.length, offset: 0 });

      await service.writeChunk(fileId, 0, body(big.subarray(0, MIN_PART_SIZE)), MIN_PART_SIZE);
      expect(await service.getUpload(fileId)).toEqual({ size: big.length, offset: MIN_PART_SIZE });

      await service.writeChunk(fileId, MIN_PART_SIZE, body(big.subarray(MIN_PART_SIZE)), 3);
      const { token } = await service.finalize(shareId);
      const download = await service.openDownload(token);
      expect((await buffer(download!.stream)).equals(big)).toBe(true);
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
      const share = await service.createShare([{ name: "a.txt", size: 2, contentType: "text/plain" }]);
      await expect(service.finalize(share.id)).rejects.toThrow(
        expect.objectContaining({ code: "not_finalizable" }),
      );
      expect(await service.getUpload(share.files[0].id)).toEqual({ size: 2, offset: 0 });
    });

    it("issues the share token only once", async () => {
      const share = await service.createShare([{ name: "a.txt", size: 1, contentType: "text/plain" }]);
      await service.writeChunk(share.files[0].id, 0, body("a"), 1);
      await service.finalize(share.id);

      await expect(service.finalize(share.id)).rejects.toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
    });

    it("accepts no more chunks once the share is ready", async () => {
      const share = await service.createShare([{ name: "a.txt", size: 1, contentType: "text/plain" }]);
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
      const share = await service.createShare([{ name: "empty.txt", size: 0, contentType: "text/plain" }]);
      const { token } = await service.finalize(share.id);

      const download = await service.openDownload(token);
      expect(download).toMatchObject({ name: "empty.txt", size: 0 });
      expect(await buffer(download!.stream)).toHaveLength(0);
    });
  });
});
