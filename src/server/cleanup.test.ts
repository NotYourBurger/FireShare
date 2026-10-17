import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCleanup } from "./cleanup";
import { schema, type Database } from "./db";
import { createTestDb } from "./db/test-db";
import { createShareService, type Download, type ShareService } from "./shares";
import type { StorageAdapter } from "./storage/adapter";
import { createMemoryStorage } from "./storage/memory";

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

const cleanup = (adapter: StorageAdapter = storage) =>
  createCleanup({ db, storage: adapter, config, now: () => clock }).run();

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

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
