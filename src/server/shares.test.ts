import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Database } from "./db";
import { createTestDb } from "./db/test-db";
import { chunkHashesFingerprint, combineCrc32 } from "./integrity";
import { createShareService, ShareError, type Download, type NewFile, type NewShare, type ShareService } from "./shares";
import { MIN_PART_SIZE } from "./storage/adapter";
import type { StorageAdapter } from "./storage/adapter";
import { createMemoryStorage } from "./storage/memory";
import { unzip } from "./test-unzip";
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

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Writes `data` as one chunk with its correct SHA-256; `length` defaults to its real length. */
const write = (fileId: string, offset: number, data: Buffer | string, length = Buffer.byteLength(data)) =>
  service.writeChunk(fileId, offset, body(data), length, sha256(data));

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
    await write(share.files[i].id, 0, content);
  }
}

describe("share service", () => {
  it("serves an uploaded file through the share token after finalize", async () => {
    const share = await service.createShare(withFiles([
      { name: "render.exr", size: 11, contentType: "image/x-exr" },
    ]));
    const [file] = share.files;

    expect(await write(file.id, 0, "hello world")).toBe(11);
    const { token } = await service.finalize(share.id);

    const download = await service.openDownload(token, file.id);
    expect(download).toMatchObject({ name: "render.exr", size: 11, contentType: "image/x-exr" });
    expect((await buffer(await (download as Download).read())).toString()).toBe("hello world");
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
    await write(share.files[0].id, 0, "a");
    const { token } = await service.finalize(share.id);

    await storage.delete(keys[0]);
    expect(await service.openDownload(token, share.files[0].id)).toBeNull();
  });

  it("stores only a hash of the share token", async () => {
    const share = await service.createShare(withFiles([{ name: "a.txt", size: 1, contentType: "text/plain" }]));
    await write(share.files[0].id, 0, "a");
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

      await write(fileId, 0, big.subarray(0, MIN_PART_SIZE));
      expect(await service.getUpload(fileId)).toEqual({ size: big.length, offset: MIN_PART_SIZE });

      await write(fileId, MIN_PART_SIZE, big.subarray(MIN_PART_SIZE));
      const { token } = await service.finalize(shareId);
      const download = await service.openDownload(token, fileId);
      expect((await buffer(await (download as Download).read())).equals(big)).toBe(true);
    });

    it("rejects a chunk that doesn't start at the current offset", async () => {
      const { fileId } = await pendingFile(big.length);
      await expect(write(fileId, 5, "xyz")).rejects.toThrow(
        expect.objectContaining({ code: "offset_mismatch" }),
      );
    });

    it("rejects a chunk that would run past the declared size", async () => {
      const { fileId } = await pendingFile(2);
      await expect(write(fileId, 0, "xyz")).rejects.toThrow(
        expect.objectContaining({ code: "invalid_chunk" }),
      );
    });

    it("rejects a non-final chunk smaller than the storage minimum part size", async () => {
      const { fileId } = await pendingFile(big.length);
      await expect(write(fileId, 0, "xyz")).rejects.toThrow(
        expect.objectContaining({ code: "invalid_chunk" }),
      );
      expect(await service.getUpload(fileId)).toEqual({ size: big.length, offset: 0 });
    });

    it("keeps the offset unchanged when a chunk's body is cut short", async () => {
      const { fileId } = await pendingFile(3);
      await expect(write(fileId, 0, "x", 3)).rejects.toThrow();
      expect(await service.getUpload(fileId)).toEqual({ size: 3, offset: 0 });
    });

    it("reports unknown uploads as not found", async () => {
      expect(await service.getUpload(crypto.randomUUID())).toBeNull();
      await expect(write(crypto.randomUUID(), 0, "x")).rejects.toBeInstanceOf(ShareError);
    });
  });

  describe("chunk verification", () => {
    const first = Buffer.alloc(MIN_PART_SIZE, 1);
    const second = Buffer.from("the rest");

    async function pendingFile() {
      const share = await service.createShare(withFiles([file("big.bin", first.length + second.length)]));
      return { shareId: share.id, fileId: share.files[0].id };
    }

    /** Records whether storage accepted each part it was asked to write. */
    function watchParts() {
      const accepted: boolean[] = [];
      const writePart = storage.writePart;
      storage.writePart = (...args) =>
        writePart(...args).then(
          (part) => (accepted.push(true), part),
          (err: unknown) => {
            accepted.push(false);
            throw err;
          },
        );
      return accepted;
    }

    it("rejects a chunk that doesn't match its SHA-256 without storing it", async () => {
      const { fileId } = await pendingFile();
      const accepted = watchParts();
      const corrupted = Buffer.from(first);
      corrupted[12345] ^= 0xff;

      await expect(
        service.writeChunk(fileId, 0, body(corrupted), corrupted.length, sha256(first)),
      ).rejects.toThrow(expect.objectContaining({ code: "checksum_mismatch" }));
      expect(accepted).toEqual([false]);
      expect(await service.getUpload(fileId)).toEqual({ size: first.length + second.length, offset: 0 });
    });

    it("accepts the chunk when it's sent again intact", async () => {
      const { shareId, fileId } = await pendingFile();
      const corrupted = Buffer.from(first);
      corrupted[0] ^= 0xff;
      await expect(service.writeChunk(fileId, 0, body(corrupted), corrupted.length, sha256(first))).rejects.toThrow();

      await write(fileId, 0, first);
      await write(fileId, first.length, second);
      const { token } = await service.finalize(shareId);
      const download = await service.openDownload(token, fileId);
      expect((await buffer(await (download as Download).read())).equals(Buffer.concat([first, second]))).toBe(true);
    });

    it("stores each chunk's SHA-256 and CRC32, which combine into the file's CRC32", async () => {
      const { fileId } = await pendingFile();
      await write(fileId, 0, first);
      await write(fileId, first.length, second);

      const [row] = await db.select().from(schema.files);
      expect(row.parts).toEqual([
        expect.objectContaining({ partNumber: 1, size: first.length, sha256: sha256(first), crc32: crc32(first) }),
        expect.objectContaining({ partNumber: 2, size: second.length, sha256: sha256(second), crc32: crc32(second) }),
      ]);
      expect(combineCrc32(row.parts)).toBe(crc32(Buffer.concat([first, second])));
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
      await write(share.files[0].id, 0, "a");
      await service.finalize(share.id);

      await expect(service.finalize(share.id)).rejects.toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
    });

    it("accepts no more chunks once the share is ready", async () => {
      const share = await service.createShare(withFiles([{ name: "a.txt", size: 1, contentType: "text/plain" }]));
      await write(share.files[0].id, 0, "a");
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

    it("records each file's fingerprint: the hash of its chunk hashes and the storage ETag", async () => {
      const keys: string[] = [];
      const createUpload = storage.createUpload;
      storage.createUpload = (key, type) => (keys.push(key), createUpload(key, type));
      const chunks = [Buffer.alloc(MIN_PART_SIZE, 1), Buffer.from("tail")];
      const share = await service.createShare(
        withFiles([file("a.bin", MIN_PART_SIZE + 4), file("b.txt", 1), file("empty.txt", 0)]),
      );
      await write(share.files[0].id, 0, chunks[0]);
      await write(share.files[0].id, MIN_PART_SIZE, chunks[1]);
      await write(share.files[1].id, 0, "b");
      await service.finalize(share.id);

      const rows = await db.query.files.findMany({ orderBy: (files, { asc }) => asc(files.position) });
      const expectedHashes = [
        chunkHashesFingerprint(chunks.map(sha256)),
        chunkHashesFingerprint([sha256("b")]),
        chunkHashesFingerprint([]),
      ];
      for (const [i, row] of rows.entries()) {
        expect(row.fingerprintHash).toBe(expectedHashes[i]);
        expect(row.fingerprintEtag).toBe((await storage.head(keys[i]))!.etag);
      }
    });

    it("refuses a file whose stored size doesn't match, leaving the share pending", async () => {
      const share = await service.createShare(withFiles([file("a.txt", 1)]));
      await write(share.files[0].id, 0, "a");
      const head = storage.head;
      storage.head = async (key) => {
        const info = await head(key);
        return info && { ...info, size: info.size + 1 };
      };

      await expect(service.finalize(share.id)).rejects.toThrow(/not 1 bytes/);
      const [row] = await db.select().from(schema.shares);
      expect(row).toMatchObject({ status: "pending", tokenHash: null });
    });

    it("shares an empty file", async () => {
      const share = await service.createShare(withFiles([{ name: "empty.txt", size: 0, contentType: "text/plain" }]));
      const { token } = await service.finalize(share.id);

      const download = await service.openDownload(token, share.files[0].id);
      expect(download).toMatchObject({ name: "empty.txt", size: 0 });
      expect(await buffer(await (download as Download).read())).toHaveLength(0);
    });
  });

  describe("tamper check", () => {
    let keys: string[];
    let errors: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      keys = [];
      const createUpload = storage.createUpload;
      storage.createUpload = (key, type) => (keys.push(key), createUpload(key, type));
      errors = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => errors.mockRestore());

    async function readyFile(content: string) {
      const share = await service.createShare(withFiles([file("a.txt", content.length)]));
      await write(share.files[0].id, 0, content);
      const { token } = await service.finalize(share.id);
      return { token, fileId: share.files[0].id };
    }

    /** Swaps the stored object for `content`, as if someone wrote to the bucket directly. */
    async function replaceObject(key: string, content: string) {
      const { uploadId } = await storage.createUpload(key);
      const part = await storage.writePart(key, uploadId, 1, body(content), content.length);
      await storage.completeUpload(key, uploadId, [part]);
    }

    it("refuses and logs a file whose stored object was replaced, even at the same size", async () => {
      const { token, fileId } = await readyFile("hello");
      await replaceObject(keys[0], "HELLO");

      await expect(service.openDownload(token, fileId)).rejects.toMatchObject({ code: "tampered" });
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`file ${fileId}.*ETag`)));
    });

    it("refuses and logs a file whose stored size no longer matches", async () => {
      const { token, fileId } = await readyFile("hello");
      await replaceObject(keys[0], "hello!");

      await expect(service.openDownload(token, fileId)).rejects.toMatchObject({ code: "tampered" });
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(/size 6, expected 5/));
    });

    it("refuses to read an object replaced after the check", async () => {
      const { token, fileId } = await readyFile("hello");
      const download = (await service.openDownload(token, fileId)) as Download;
      await replaceObject(keys[0], "HELLO");

      await expect(download.read()).rejects.toMatchObject({ code: "tampered" });
      expect(errors).toHaveBeenCalledOnce();
    });

    it("checks only the size of files completed before fingerprints were recorded", async () => {
      const { token, fileId } = await readyFile("hello");
      await db.update(schema.files).set({ fingerprintHash: null, fingerprintEtag: null });

      const download = (await service.openDownload(token, fileId)) as Download;
      expect((await buffer(await download.read())).toString()).toBe("hello");
      expect(download.etag).toBe(`"${fileId}"`);
      await replaceObject(keys[0], "hello!");
      await expect(service.openDownload(token, fileId)).rejects.toMatchObject({ code: "tampered" });
    });

    it("serves an untouched file, with its fingerprint as the ETag", async () => {
      const { token, fileId } = await readyFile("hello");
      const download = (await service.openDownload(token, fileId)) as Download;
      expect(download.etag).toBe(`"${chunkHashesFingerprint([sha256("hello")])}"`);
      expect((await buffer(await download.read({ start: 1, end: 3 }))).toString()).toBe("ell");
      expect(errors).not.toHaveBeenCalled();
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
        downloadAll: true,
      });
      for (const [i, content] of ["bb", "aaa", ""].entries()) {
        const download = await service.openDownload(token, share.files[i].id);
        expect((await buffer(await (download as Download).read())).toString()).toBe(content);
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
      expect((await buffer(await (download as Download).read())).toString()).toBe("b");
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
        await expect(write(id, 1, "")).rejects.toThrow(
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

  describe("download all", () => {
    let keys: string[];
    let errors: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      keys = [];
      const createUpload = storage.createUpload;
      storage.createUpload = (key, type) => (keys.push(key), createUpload(key, type));
      errors = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => errors.mockRestore());

    async function readyShare(names: string[], contents: string[], title: string | null = null) {
      const share = await service.createShare({
        ...withFiles(names.map((name, i) => file(name, contents[i].length))),
        title,
      });
      await uploadAll(share, contents);
      const { token } = await service.finalize(share.id);
      return token;
    }

    const archiveOf = async (token: string) => buffer(await ((await service.openArchive(token)) as Download).read());

    it("zips every file of the share, in the uploader's order, under its own name", async () => {
      const token = await readyShare(["b.txt", "日本語.txt", "empty.bin"], ["bb", "aaa", ""], "Final renders");
      const archive = (await service.openArchive(token)) as Download;
      expect(archive).toMatchObject({ name: "Final renders.zip", contentType: "application/zip" });

      const data = await buffer(await archive.read());
      expect(data.length).toBe(archive.size);
      const entries = await unzip(data);
      expect(entries.map((entry) => entry.name)).toEqual(["b.txt", "日本語.txt", "empty.bin"]);
      expect(await Promise.all(entries.map(async (entry) => (await entry.data()).toString()))).toEqual(["bb", "aaa", ""]);
      // The CRC32s were recorded at upload, not computed now.
      expect(entries.map((entry) => entry.crc32)).toEqual(["bb", "aaa", ""].map((text) => crc32(Buffer.from(text))));
    });

    it("gives duplicate and unsafe names distinct plain file names", async () => {
      const token = await readyShare(["a.txt", "A.txt", "../../etc/passwd"], ["1", "2", "3"]);
      const entries = await unzip(await archiveOf(token));
      expect(entries.map((entry) => entry.name)).toEqual(["a.txt", "A (2).txt", ".._.._etc_passwd"]);
      expect((await service.openArchive(token)) as Download).toMatchObject({ name: "Shared files.zip" });
    });

    it("has a stable ETag and the same bytes on every request", async () => {
      const token = await readyShare(["a.txt", "b.txt"], ["hello", "world"]);
      const first = (await service.openArchive(token)) as Download;
      advance(3600);
      const second = (await service.openArchive(token)) as Download;
      expect(second.etag).toBe(first.etag);
      expect(first.etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect((await buffer(await first.read())).equals(await buffer(await second.read()))).toBe(true);
    });

    it("checks every file's fingerprint before serving anything", async () => {
      const token = await readyShare(["a.txt", "b.txt"], ["hello", "world"]);
      const { uploadId } = await storage.createUpload(keys[1]);
      const part = await storage.writePart(keys[1], uploadId, 1, body("WORLD"), 5);
      await storage.completeUpload(keys[1], uploadId, [part]);

      await expect(service.openArchive(token)).rejects.toMatchObject({ code: "tampered" });
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(/ETag/));
    });

    it("fails the stream instead of serving a file replaced after the check", async () => {
      const token = await readyShare(["a.txt", "b.txt"], ["hello", "world"]);
      const archive = (await service.openArchive(token)) as Download;
      const { uploadId } = await storage.createUpload(keys[1]);
      const part = await storage.writePart(keys[1], uploadId, 1, body("WORLD"), 5);
      await storage.completeUpload(keys[1], uploadId, [part]);

      await expect(buffer(await archive.read())).rejects.toMatchObject({ code: "tampered" });
    });

    it("answers like an unknown token when a stored file has gone missing", async () => {
      const token = await readyShare(["a.txt", "b.txt"], ["hello", "world"]);
      await storage.delete(keys[1]);
      expect(await service.openArchive(token)).toBeNull();
    });

    it("isn't offered for files uploaded before CRC32s were recorded", async () => {
      const token = await readyShare(["a.txt", "b.txt"], ["hello", "world"]);
      expect(await service.viewShare(token)).toMatchObject({ downloadAll: true });
      const [row] = await db.select().from(schema.files).where(eq(schema.files.name, "b.txt"));
      await db
        .update(schema.files)
        .set({ parts: row.parts.map(({ crc32: _, ...part }) => part as typeof part & { crc32: number }) })
        .where(eq(schema.files.id, row.id));

      expect(await service.viewShare(token)).toMatchObject({ downloadAll: false });
      expect(await service.openArchive(token)).toBeNull();
    });

    it("reports an expired share as expired, and an unknown token as nothing", async () => {
      const token = await readyShare(["a.txt"], ["a"]);
      expect(await service.openArchive(generateToken())).toBeNull();
      advance(7 * DAY);
      expect(await service.openArchive(token)).toBe("unavailable");
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
      expect(await service.viewShare(token)).toBe("unavailable");
      expect(await service.openDownload(token, fileId)).toBe("unavailable");
    });

    it("counts expiry from when the share becomes ready, not from when the upload started", async () => {
      const share = await service.createShare(withFiles([file("a.txt", 1)], DAY));
      advance(2 * DAY);
      await uploadAll(share, ["a"]);
      const { token } = await service.finalize(share.id);

      advance(DAY - 1);
      expect(await service.viewShare(token)).not.toBe("unavailable");
      advance(1);
      expect(await service.viewShare(token)).toBe("unavailable");
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
      expect(await service.openDownload(token, crypto.randomUUID())).toBe("unavailable");
      expect(await service.openDownload(token, "not-a-uuid")).toBe("unavailable");
    });

    it("still shows nothing for an unknown token", async () => {
      await readyShare(DAY);
      advance(DAY);
      expect(await service.viewShare(generateToken())).toBeNull();
    });
  });

  describe("management link", () => {
    async function readyShare() {
      const share = await service.createShare({
        ...withFiles([file("a.txt", 1), file("b.txt", 2)], DAY),
        title: "Shot 12",
        message: "Final grade",
      });
      await uploadAll(share, ["a", "bb"]);
      const { token, managementToken } = await service.finalize(share.id);
      return { token, managementToken, fileIds: share.files.map((f) => f.id) };
    }

    it("is issued with the share link, as a different 128-bit token, and stored only as a hash", async () => {
      const { token, managementToken } = await readyShare();
      expect(managementToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(managementToken).not.toBe(token);

      const rows = await db.select().from(schema.shares);
      expect(JSON.stringify(rows)).not.toContain(managementToken);
      expect(rows[0].managementTokenHash).toBe(hashToken(managementToken));
    });

    it("shows the share's status, expiry, title, message and files", async () => {
      const { managementToken } = await readyShare();
      expect(await service.manageShare(managementToken)).toEqual({
        status: "active",
        title: "Shot 12",
        message: "Final grade",
        expiresAt: new Date("2026-01-02T00:00:00Z"),
        deletedAt: null,
        files: [
          { id: expect.any(String), name: "a.txt", size: 1 },
          { id: expect.any(String), name: "b.txt", size: 2 },
        ],
      });
      advance(DAY);
      expect(await service.manageShare(managementToken)).toMatchObject({ status: "expired" });
    });

    it("doesn't open the share through the share token, nor the other way round", async () => {
      const { token, managementToken, fileIds } = await readyShare();
      expect(await service.manageShare(token)).toBeNull();
      expect(await service.deleteShare(token)).toBe(false);
      expect(await service.viewShare(managementToken)).toBeNull();
      expect(await service.openDownload(managementToken, fileIds[0])).toBeNull();
    });

    it("shows nothing for an unknown token", async () => {
      await readyShare();
      expect(await service.manageShare(generateToken())).toBeNull();
      expect(await service.deleteShare(generateToken())).toBe(false);
    });

    it("deletes the share: its link stops serving at once, like an expired one", async () => {
      const { token, managementToken, fileIds } = await readyShare();
      advance(60);
      expect(await service.deleteShare(managementToken)).toBe(true);

      expect(await service.viewShare(token)).toBe("unavailable");
      expect(await service.openDownload(token, fileIds[0])).toBe("unavailable");
      expect(await service.openArchive(token)).toBe("unavailable");
      expect(await service.manageShare(managementToken)).toMatchObject({
        status: "deleted",
        deletedAt: new Date("2026-01-01T00:01:00Z"),
        files: [{ name: "a.txt" }, { name: "b.txt" }],
      });
    });

    it("keeps the first deletion time when deleted again", async () => {
      const { managementToken } = await readyShare();
      await service.deleteShare(managementToken);
      advance(60);
      expect(await service.deleteShare(managementToken)).toBe(true);
      expect(await service.manageShare(managementToken)).toMatchObject({
        status: "deleted",
        deletedAt: new Date("2026-01-01T00:00:00Z"),
      });
    });

    it("shows a deleted share as deleted even after its expiry", async () => {
      const { managementToken } = await readyShare();
      await service.deleteShare(managementToken);
      advance(2 * DAY);
      expect(await service.manageShare(managementToken)).toMatchObject({ status: "deleted" });
    });

    it("leaves other shares serving", async () => {
      const first = await readyShare();
      const second = await readyShare();
      await service.deleteShare(first.managementToken);
      expect(await service.viewShare(second.token)).toMatchObject({ title: "Shot 12" });
    });
  });
});
