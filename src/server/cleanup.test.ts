import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { crc32 } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCleanup } from "./cleanup";
import { schema, type Database } from "./db";
import { createTestDb } from "./db/test-db";
import { createShareService, type ArchiveDownload, type Download, type ShareService } from "./shares";
import { MIN_PART_SIZE, type StorageAdapter } from "./storage/adapter";
import { createMemoryStorage } from "./storage/memory";
import { unzip } from "./test-unzip";

let db: Database;
let storage: StorageAdapter;
let service: ShareService;
let clock: Date;

const HOUR = 3600;
const DAY = 86400;
const config = { deleteGraceSeconds: HOUR, pendingTtlSeconds: DAY };

beforeEach(async () => {
  db = await createTestDb();
  storage = createMemoryStorage();
  clock = new Date("2026-01-01T00:00:00Z");
  service = createShareService({ db, storage, now: () => clock });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

const cleanup = (adapter: StorageAdapter = storage, signal?: AbortSignal) =>
  createCleanup({ db, storage: adapter, config, now: () => clock }).run(signal);

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Creates a share of these files and uploads all of them. */
async function uploaded(contents: string[], expirySeconds = DAY) {
  const share = await service.createShare({
    clientIp: null,
    title: null,
    message: null,
    expirySeconds,
    files: contents.map((content, i) => ({ name: `f${i}.txt`, size: content.length, contentType: "text/plain" })),
  });
  for (const [i, content] of contents.entries()) {
    await service.writeChunk(share.files[i].id, 0, Readable.from([Buffer.from(content)]), content.length, sha256(content));
  }
  return share;
}

async function rowsOf(shareId: string) {
  return db.query.files.findMany({ where: eq(schema.files.shareId, shareId) });
}

const nothing = {
  expiredShares: 0,
  removedFiles: 0,
  removedBytes: 0,
  abandonedShares: 0,
  abandonedBytes: 0,
  checksummedFiles: 0,
  checksummedBytes: 0,
  failures: 0,
};

describe("cleanup of expired and deleted shares", () => {
  it("removes an expired share's bytes only once DELETE_GRACE has passed", async () => {
    const share = await uploaded(["hello", "world!"]);
    await service.finalize(share.id);
    const keys = (await rowsOf(share.id)).map((file) => file.storageKey);

    advance(DAY + HOUR - 1);
    expect(await cleanup()).toEqual(nothing);
    for (const key of keys) expect(await storage.head(key)).not.toBeNull();

    advance(1);
    expect(await cleanup()).toEqual({ ...nothing, expiredShares: 1, removedFiles: 2, removedBytes: 11 });
    for (const key of keys) expect(await storage.head(key)).toBeNull();
    for (const file of await rowsOf(share.id)) expect(file.removedAt).toEqual(clock);
  });

  it("lets a download started before expiry finish within the grace period", async () => {
    const share = await uploaded(["the whole file"]);
    const { token } = await service.finalize(share.id);
    const download = (await service.openDownload(token, share.files[0].id)) as Download;

    advance(DAY + HOUR / 2);
    await cleanup();
    expect(await service.openDownload(token, share.files[0].id)).toBe("unavailable");
    expect((await buffer(await download.read({ start: 4, end: 13 }))).toString()).toBe("whole file");
  });

  it("counts the grace of a deleted share from its deletion", async () => {
    const share = await uploaded(["bytes"], 30 * DAY);
    const { managementToken } = await service.finalize(share.id);
    advance(DAY);
    await service.deleteShare(managementToken);

    advance(HOUR - 1);
    expect(await cleanup()).toEqual(nothing);
    advance(1);
    expect(await cleanup()).toMatchObject({ expiredShares: 1, removedFiles: 1, removedBytes: 5 });
    expect(await service.manageShare(managementToken)).toMatchObject({ status: "deleted" });
  });

  it("never touches an active share", async () => {
    const share = await uploaded(["keep me"], 7 * DAY);
    const { token } = await service.finalize(share.id);

    advance(7 * DAY - 1);
    expect(await cleanup()).toEqual(nothing);
    expect(await service.openDownload(token, share.files[0].id)).not.toBe("unavailable");
  });

  it("finishes after a crash part way through a share, without errors or repeats", async () => {
    const share = await uploaded(["one", "two", "three"]);
    await service.finalize(share.id);
    advance(DAY + HOUR);
    // Storage fails on the second file, as if the worker had died there.
    let calls = 0;
    const flaky = {
      ...storage,
      delete: async (key: string) => {
        if (++calls === 2) throw new Error("connection reset");
        return storage.delete(key);
      },
    };

    expect(await cleanup(flaky)).toEqual({ ...nothing, removedFiles: 1, removedBytes: 3, failures: 1 });
    expect(await cleanup(flaky)).toEqual({ ...nothing, expiredShares: 1, removedFiles: 2, removedBytes: 8 });
    expect(await cleanup()).toEqual(nothing);
    for (const file of await rowsOf(share.id)) {
      expect(file.removedAt).not.toBeNull();
      expect(await storage.head(file.storageKey)).toBeNull();
    }
  });

  it("completes a file whose object was deleted before the crash but never marked removed", async () => {
    const share = await uploaded(["gone"]);
    await service.finalize(share.id);
    const [file] = await rowsOf(share.id);
    await storage.delete(file.storageKey);
    advance(DAY + HOUR);

    expect(await cleanup()).toMatchObject({ removedFiles: 1, failures: 0 });
  });
});

describe("cleanup of abandoned uploads", () => {
  it("removes pending shares older than PENDING_TTL with their incomplete uploads", async () => {
    const share = await uploaded(["partial"]);
    const [file] = await rowsOf(share.id);
    advance(DAY - 1);
    const fresh = await uploaded(["recent"]);

    advance(1);
    expect(await cleanup()).toEqual({ ...nothing, abandonedShares: 1, abandonedBytes: 7 });
    expect(await rowsOf(share.id)).toEqual([]);
    expect(await db.query.shares.findFirst({ where: eq(schema.shares.id, share.id) })).toBeUndefined();
    await expect(
      storage.writePart(file.storageKey, file.multipartUploadId, 2, Readable.from([Buffer.from("x")]), 1),
    ).rejects.toThrow("No such upload");

    // The younger share is untouched and can still finish.
    expect(await service.finalize(fresh.id)).toMatchObject({ token: expect.any(String) });
  });

  it("stops a claimed share from being finalized or written to", async () => {
    const share = await uploaded(["data"]);
    advance(DAY);
    // Claim it, but crash before its storage is cleared.
    const failing = { ...storage, abortUpload: () => Promise.reject(new Error("storage down")) };
    expect(await cleanup(failing)).toMatchObject({ abandonedShares: 0, failures: 1 });

    await expect(service.finalize(share.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await service.getUpload(share.files[0].id)).toBeNull();

    expect(await cleanup()).toEqual({ ...nothing, abandonedShares: 1, abandonedBytes: 4 });
    expect(await cleanup()).toEqual(nothing);
  });

  it("deletes an object a finalize completed before the share was claimed", async () => {
    const share = await uploaded(["done"]);
    const [file] = await rowsOf(share.id);
    await storage.completeUpload(file.storageKey, file.multipartUploadId, file.parts);
    advance(DAY);

    expect(await cleanup()).toMatchObject({ abandonedShares: 1 });
    expect(await storage.head(file.storageKey)).toBeNull();
  });
});

describe("background CRC32 of direct-mode files", () => {
  /**
   * Creates and finalizes a share whose files went straight to storage, as
   * presigned direct-mode uploads do: the server never sees their bytes, so
   * it has no chunk CRC32s.
   */
  async function directShare(contents: Buffer[], expirySeconds = DAY) {
    const share = await service.createShare({
      clientIp: null,
      title: null,
      message: null,
      expirySeconds,
      files: contents.map((content, i) => ({
        name: `f${i}.bin`,
        size: content.length,
        contentType: "application/octet-stream",
      })),
    });
    const rows = (await rowsOf(share.id)).sort((a, b) => a.position - b.position);
    for (const [i, row] of rows.entries()) {
      const content = contents[i];
      for (let offset = 0, part = 1; offset < content.length; offset += MIN_PART_SIZE, part++) {
        const chunk = content.subarray(offset, offset + MIN_PART_SIZE);
        await storage.writePart(row.storageKey, row.multipartUploadId, part, Readable.from([chunk]), chunk.length);
      }
    }
    return { ...share, ...(await service.finalize(share.id, MIN_PART_SIZE)) };
  }

  const archive = async (token: string) => (await service.openArchive(token)) as ArchiveDownload;

  it("makes Download all resumable once every file has a CRC32", async () => {
    const big = Buffer.alloc(MIN_PART_SIZE + 7, 0x5a);
    const contents = [big, Buffer.from("small"), Buffer.alloc(0)];
    const share = await directShare(contents);

    // An empty file's CRC32 is known at finalize; the others' aren't.
    expect((await rowsOf(share.id)).map((row) => row.crc32).sort()).toEqual([0, null, null]);
    // Before the job: streamed with data descriptors, so no size, ETag or Range.
    expect(await archive(share.token)).toMatchObject({ size: null, etag: null });
    const streamed = await buffer(await (await archive(share.token)).read());

    expect(await cleanup()).toEqual({ ...nothing, checksummedFiles: 2, checksummedBytes: big.length + 5 });
    const laidOut = await archive(share.token);
    expect(laidOut).toMatchObject({ size: expect.any(Number), etag: expect.any(String) });
    const whole = await buffer(await laidOut.read());
    expect(whole.length).toBe(laidOut.size);
    const entries = await unzip(whole);
    expect(entries.map((entry) => entry.crc32)).toEqual(contents.map((content) => crc32(content)));
    const data = await Promise.all(entries.map((entry) => entry.data()));
    expect(data.map((bytes, i) => bytes.equals(contents[i]))).toEqual([true, true, true]);
    // Any range can now be served on its own.
    const tail = await buffer(await laidOut.read({ start: 100, end: laidOut.size! - 1 }));
    expect(tail.equals(whole.subarray(100))).toBe(true);
    // The streamed layout held the same CRC32s.
    expect((await unzip(streamed)).map((entry) => entry.crc32)).toEqual(entries.map((entry) => entry.crc32));
  });

  it("stores the same CRC32 proxy mode records for the same file", async () => {
    const content = Buffer.concat([Buffer.alloc(MIN_PART_SIZE, 1), Buffer.from("tail of the file")]);
    const direct = await directShare([content]);
    const proxied = await service.createShare({
      clientIp: null,
      title: null,
      message: null,
      expirySeconds: DAY,
      files: [{ name: "f.bin", size: content.length, contentType: "application/octet-stream" }],
    });
    const fileId = proxied.files[0].id;
    for (const [offset, chunk] of [
      [0, content.subarray(0, MIN_PART_SIZE)],
      [MIN_PART_SIZE, content.subarray(MIN_PART_SIZE)],
    ] as const) {
      await service.writeChunk(fileId, offset, Readable.from([chunk]), chunk.length, sha256(chunk));
    }
    await service.finalize(proxied.id);

    // Proxy mode combines its chunks' CRC32s at finalize, so the worker only reads the direct file.
    const [proxiedRow] = await rowsOf(proxied.id);
    expect(proxiedRow.crc32).toBe(crc32(content));
    expect(await cleanup()).toMatchObject({ checksummedFiles: 1, checksummedBytes: content.length });
    const [directRow] = await rowsOf(direct.id);
    expect(directRow.crc32).toBe(proxiedRow.crc32);
  });

  it("combines the chunk CRC32s of proxied files from before the column, without reading them", async () => {
    const share = await uploaded(["old file"]);
    const { token } = await service.finalize(share.id);
    await db.update(schema.files).set({ crc32: null }).where(eq(schema.files.shareId, share.id));
    const reads = vi.spyOn(storage, "getReadStream");

    expect(await cleanup()).toEqual({ ...nothing, checksummedFiles: 1 });
    expect(reads).not.toHaveBeenCalled();
    expect((await rowsOf(share.id))[0].crc32).toBe(crc32(Buffer.from("old file")));
    expect(await archive(token)).toMatchObject({ size: expect.any(Number) });
  });

  it("does each file once, and finishes after being stopped part way", async () => {
    const share = await directShare([Buffer.from("first"), Buffer.from("second")]);
    const stop = new AbortController();
    let reads = 0;
    const stopping = {
      ...storage,
      getReadStream: async (...args: Parameters<StorageAdapter["getReadStream"]>) => {
        const stream = await storage.getReadStream(...args);
        // The worker is told to stop while it reads the second file.
        if (++reads === 2) stop.abort();
        return stream;
      },
    };

    expect(await cleanup(stopping, stop.signal)).toEqual({ ...nothing, checksummedFiles: 1, checksummedBytes: 5 });
    expect(await archive(share.token)).toMatchObject({ size: null });
    expect(await cleanup()).toEqual({ ...nothing, checksummedFiles: 1, checksummedBytes: 6 });
    expect(await cleanup()).toEqual(nothing);
    expect(await archive(share.token)).toMatchObject({ size: expect.any(Number) });
  });

  it("retries a file whose read failed on the next run", async () => {
    const share = await directShare([Buffer.from("flaky")]);
    const failing = { ...storage, getReadStream: () => Promise.reject(new Error("connection reset")) };

    expect(await cleanup(failing)).toEqual({ ...nothing, failures: 1 });
    expect(await cleanup()).toEqual({ ...nothing, checksummedFiles: 1, checksummedBytes: 5 });
    expect((await rowsOf(share.id))[0].crc32).toBe(crc32(Buffer.from("flaky")));
  });

  it("skips files of shares that expired or were deleted before the job reached them", async () => {
    const expired = await directShare([Buffer.from("expired")], HOUR);
    const deleted = await directShare([Buffer.from("deleted")]);
    await service.deleteShare(deleted.managementToken);
    advance(HOUR);
    const reads = vi.spyOn(storage, "getReadStream");

    expect(await cleanup()).toMatchObject({ checksummedFiles: 0, failures: 0 });
    expect(reads).not.toHaveBeenCalled();
    for (const share of [expired, deleted]) expect((await rowsOf(share.id))[0].crc32).toBeNull();
  });

  it("skips a share that expires while the job is working through earlier ones", async () => {
    const first = await directShare([Buffer.from("first")], 2 * HOUR);
    advance(1);
    const second = await directShare([Buffer.from("second")], HOUR);
    const slow = {
      ...storage,
      getReadStream: async (...args: Parameters<StorageAdapter["getReadStream"]>) => {
        // Reading the first share's file takes past the second share's expiry.
        advance(HOUR);
        return storage.getReadStream(...args);
      },
    };

    expect(await cleanup(slow)).toEqual({ ...nothing, checksummedFiles: 1, checksummedBytes: 5 });
    expect((await rowsOf(first.id))[0].crc32).not.toBeNull();
    expect((await rowsOf(second.id))[0].crc32).toBeNull();
  });

  it("leaves an object that no longer matches its fingerprint to the download check", async () => {
    const share = await directShare([Buffer.from("original")]);
    const [row] = await rowsOf(share.id);
    const upload = await storage.createUpload(row.storageKey);
    const part = await storage.writePart(row.storageKey, upload.uploadId, 1, Readable.from([Buffer.from("replaced")]), 8);
    await storage.completeUpload(row.storageKey, upload.uploadId, [part]);

    expect(await cleanup()).toEqual(nothing);
    expect((await rowsOf(share.id))[0].crc32).toBeNull();
    await expect(service.openArchive(share.token)).rejects.toMatchObject({ code: "tampered" });
  });
});
