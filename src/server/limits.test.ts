import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PEER_ADDRESS_HEADER } from "./client-address";
import { loadAccessConfig, loadExpiryConfig, loadLimitsConfig, loadUploadConfig } from "./config";
import { createTestDb } from "./db/test-db";
import { createHttpHandlers, type HttpHandlers } from "./http";
import { createRateLimiter } from "./rate-limit";
import { createShareService, type NewFile, type ShareService } from "./shares";
import { createMemoryStorage } from "./storage/memory";
import type { StorageAdapter } from "./storage/adapter";
import { createUploadAccess } from "./upload-access";

const DAY = 86400;

let storage: StorageAdapter;
let clock: Date;

/** Moves the clock forward. */
const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

const file = (size: number, name = "a.bin"): NewFile => ({ name, size, contentType: "application/octet-stream" });

beforeEach(() => {
  storage = createMemoryStorage();
  clock = new Date("2026-01-01T00:00:00Z");
});

describe("share limits", () => {
  let service: ShareService;

  async function withLimits(env: Record<string, string>) {
    service = createShareService({ db: await createTestDb(), storage, limits: loadLimitsConfig(env), now: () => clock });
  }

  const create = (files: NewFile[], clientIp: string | null = "203.0.113.1", expirySeconds = DAY) =>
    service.createShare({ clientIp, title: null, message: null, expirySeconds, files });

  /** Creates, uploads and finalizes a share of `content`; returns its management token. */
  async function ready(content: string, clientIp = "203.0.113.1") {
    const share = await create([file(content.length)], clientIp);
    await service.writeChunk(share.files[0].id, 0, Readable.from([Buffer.from(content)]), content.length, sha256(content));
    return (await service.finalize(share.id)).managementToken;
  }

  const refusal = (code: string, message: RegExp) => expect.objectContaining({ code, message: expect.stringMatching(message) });

  it("is all off when left empty", async () => {
    await withLimits({
      MAX_SHARE_SIZE: "",
      MAX_FILES_PER_SHARE: "",
      MAX_TOTAL_STORAGE: "",
      UPLOAD_QUOTA_PER_IP: "",
      MAX_ACTIVE_SHARES_PER_IP: "",
    });
    for (let i = 0; i < 3; i++) await create(Array.from({ length: 50 }, (_, j) => file(2 ** 40, `${j}.bin`)));
  });

  it("refuses a share with more files than MAX_FILES_PER_SHARE before storing anything", async () => {
    await withLimits({ MAX_FILES_PER_SHARE: "2" });
    const createUpload = vi.spyOn(storage, "createUpload");
    await expect(create([file(1, "a"), file(1, "b"), file(1, "c")])).rejects.toThrow(
      refusal("too_large", /^A share can hold at most 2 files, and this one has 3\./),
    );
    expect(createUpload).not.toHaveBeenCalled();
    await create([file(1, "a"), file(1, "b")]);
  });

  it("refuses a share larger than MAX_SHARE_SIZE in total", async () => {
    await withLimits({ MAX_SHARE_SIZE: "1KB" });
    await expect(create([file(1000), file(25)])).rejects.toThrow(refusal("too_large", /at most 1KB in total/));
    await create([file(1000), file(24)]);
  });

  it("counts pending and unexpired shares toward MAX_TOTAL_STORAGE, from every client", async () => {
    await withLimits({ MAX_TOTAL_STORAGE: "1KB" });
    await create([file(1000)], "203.0.113.1");
    await expect(create([file(25)], "203.0.113.2")).rejects.toThrow(refusal("storage_full", /doesn't have room/));
    await create([file(24)], "203.0.113.2");
  });

  it("frees MAX_TOTAL_STORAGE as shares expire or are deleted", async () => {
    await withLimits({ MAX_TOTAL_STORAGE: "1KB" });
    const deleted = await ready("x".repeat(600));
    await service.deleteShare(deleted);
    await ready("x".repeat(600));
    await expect(create([file(600)])).rejects.toThrow(refusal("storage_full", /./));
    advance(DAY);
    await create([file(600)]);
  });

  it("limits the bytes each client IP declares in 24 hours to UPLOAD_QUOTA_PER_IP", async () => {
    await withLimits({ UPLOAD_QUOTA_PER_IP: "1KB" });
    const deleted = await ready("x".repeat(1000));
    // Deleting a share doesn't give its bytes back within the day.
    await service.deleteShare(deleted);
    await expect(create([file(25)])).rejects.toThrow(
      refusal("quota_exceeded", /past the upload quota of 1KB per 24 hours/),
    );
    await create([file(1024)], "203.0.113.2");
    advance(DAY - 1);
    await expect(create([file(25)])).rejects.toThrow(refusal("quota_exceeded", /./));
    advance(1);
    await create([file(1024)]);
  });

  it("limits each client IP's pending and unexpired shares to MAX_ACTIVE_SHARES_PER_IP", async () => {
    await withLimits({ MAX_ACTIVE_SHARES_PER_IP: "2" });
    await ready("a");
    const deleted = await ready("b");
    await expect(create([file(1)])).rejects.toThrow(refusal("quota_exceeded", /^You already have 2 active shares/));
    await create([file(1)], "203.0.113.2");

    await service.deleteShare(deleted);
    await create([file(1)]);
    await expect(create([file(1)])).rejects.toThrow(refusal("quota_exceeded", /./));
    advance(DAY);
    // The ready share has expired; the pending one still counts.
    await create([file(1)]);
    await expect(create([file(1)])).rejects.toThrow(refusal("quota_exceeded", /./));
  });

  it("counts shares from an unknown address together", async () => {
    await withLimits({ MAX_ACTIVE_SHARES_PER_IP: "1" });
    await create([file(1)], null);
    await expect(create([file(1)], null)).rejects.toThrow(refusal("quota_exceeded", /./));
  });

  it("lets only as many parallel shares through as fit, and discards the others' uploads", async () => {
    await withLimits({ MAX_TOTAL_STORAGE: "1KB", MAX_ACTIVE_SHARES_PER_IP: "5" });
    const abortUpload = vi.spyOn(storage, "abortUpload");
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => create([file(400)])));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect(abortUpload).toHaveBeenCalledTimes(2);
  });
});

describe("limits over HTTP", () => {
  let http: HttpHandlers;
  const origin = "http://fireshare.test";

  async function withLimits(env: Record<string, string>) {
    const limits = loadLimitsConfig(env);
    const perMinute = (limit: number | null) =>
      limit === null ? null : createRateLimiter({ limit, windowSeconds: 60, now: () => clock });
    http = createHttpHandlers({
      shares: createShareService({ db: await createTestDb(), storage, limits, now: () => clock }),
      expiry: loadExpiryConfig({}),
      upload: loadUploadConfig({}),
      access: createUploadAccess(loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "abuse@example.com" })),
      rateLimits: { upload: perMinute(limits.rateLimitUpload), download: perMinute(limits.rateLimitDownload) },
    });
  }

  const from = (address: string) => ({ [PEER_ADDRESS_HEADER]: address });

  function createShare(files: { name: string; size: number }[], address = "203.0.113.1") {
    return http.createShare(
      new Request(`${origin}/api/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...from(address) },
        body: JSON.stringify({ files }),
      }),
    );
  }

  function patch(uploadId: string, data: string, address = "203.0.113.1") {
    return http.patchUpload(
      new Request(`${origin}/api/uploads/${uploadId}`, {
        method: "PATCH",
        headers: {
          "Tus-Resumable": "1.0.0",
          "Content-Type": "application/offset+octet-stream",
          "Upload-Offset": "0",
          "Content-Length": String(data.length),
          "Upload-Checksum": `sha256 ${createHash("sha256").update(data).digest("base64")}`,
          ...from(address),
        },
        body: data,
      }),
      uploadId,
    );
  }

  function head(uploadId: string) {
    return http.headUpload(
      new Request(`${origin}/api/uploads/${uploadId}`, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } }),
      uploadId,
    );
  }

  it("refuses an over-limit share before any upload with the reason", async () => {
    await withLimits({ MAX_SHARE_SIZE: "1KB", MAX_TOTAL_STORAGE: "2KB", MAX_ACTIVE_SHARES_PER_IP: "1" });

    const tooLarge = await createShare([{ name: "a", size: 1025 }]);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: "A share can be at most 1KB in total. Share fewer or smaller files." });

    expect((await createShare([{ name: "a", size: 1024 }])).status).toBe(201);
    const tooMany = await createShare([{ name: "a", size: 1 }]);
    expect(tooMany.status).toBe(403);
    expect((await tooMany.json()).error).toMatch(/^You already have 1 active shares/);

    expect((await createShare([{ name: "a", size: 1024 }], "203.0.113.2")).status).toBe(201);
    const full = await createShare([{ name: "a", size: 1 }], "203.0.113.3");
    expect(full.status).toBe(507);
    expect((await full.json()).error).toMatch(/doesn't have room/);
  });

  it("cuts off a chunk longer than the file's declared size and fails its share", async () => {
    await withLimits({});
    const { files } = await (await createShare([{ name: "a", size: 2 }])).json();
    expect((await patch(files[0].id, "abcd")).status).toBe(413);
    expect((await head(files[0].id)).status).toBe(404);
    expect((await patch(files[0].id, "ab")).status).toBe(404);
  });

  it("answers uploads past RATE_LIMIT_UPLOAD per minute with 429 and Retry-After, per client IP", async () => {
    await withLimits({ RATE_LIMIT_UPLOAD: "2" });
    const { files } = await (await createShare([{ name: "a", size: 2 }])).json();
    advance(15);
    expect((await patch(files[0].id, "ab")).status).toBe(204);

    const limited = await createShare([{ name: "b", size: 1 }]);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("45");
    expect(await limited.json()).toEqual({ error: "Too many requests from your network. Try again in 45 seconds." });
    const tus = await patch(files[0].id, "ab");
    expect(tus.status).toBe(429);
    expect(tus.headers.get("Retry-After")).toBe("45");
    expect(tus.headers.get("Tus-Resumable")).toBe("1.0.0");

    expect((await createShare([{ name: "b", size: 1 }], "203.0.113.2")).status).toBe(201);
    advance(45);
    expect((await createShare([{ name: "b", size: 1 }])).status).toBe(201);
  });

  it("answers downloads past RATE_LIMIT_DOWNLOAD per minute with 429 and Retry-After", async () => {
    await withLimits({ RATE_LIMIT_DOWNLOAD: "1" });
    const { id, files } = await (await createShare([{ name: "a", size: 2 }])).json();
    await patch(files[0].id, "ab");
    const { path } = await (
      await http.finalize(new Request(`${origin}/api/shares/${id}/finalize`, { method: "POST" }), id)
    ).json();
    const token = path.slice("/d/".length);
    const download = (address: string) =>
      http.download(new Request(`${origin}${path}/files/${files[0].id}`, { headers: from(address) }), token, files[0].id);

    expect((await download("203.0.113.1")).status).toBe(200);
    const limited = await download("203.0.113.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.text()).toContain("Try again in 60 seconds.");
    const all = await http.downloadAll(new Request(`${origin}${path}/all`, { headers: from("203.0.113.1") }), token);
    expect(all.status).toBe(429);
    expect((await download("203.0.113.2")).status).toBe(200);
  });

  it("leaves uploads and downloads unlimited when the rate limits are empty", async () => {
    await withLimits({ RATE_LIMIT_UPLOAD: "", RATE_LIMIT_DOWNLOAD: "" });
    for (let i = 0; i < 50; i++) expect((await createShare([{ name: "a", size: 1 }])).status).toBe(201);
  });
});
