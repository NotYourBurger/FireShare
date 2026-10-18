import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { MIN_PART_SIZE, ObjectChangedError, type StorageAdapter } from "./adapter";
import { createMemoryStorage } from "./memory";
import { createS3Storage } from "./s3";

interface TestDriver {
  storage: StorageAdapter;
  fetch: typeof globalThis.fetch;
  advanceSeconds?: (seconds: number) => void;
}

const drivers: [string, () => Promise<TestDriver>][] = [
  [
    "memory",
    async () => {
      let clock = new Date("2026-01-01T00:00:00Z");
      const storage = createMemoryStorage({ now: () => clock });
      return {
        storage,
        fetch: storage.fetch,
        advanceSeconds: (seconds) => {
          clock = new Date(clock.getTime() + seconds * 1000);
        },
      };
    },
  ],
];

// Runs against a real S3 API (e.g. Garage) when one is configured:
// TEST_S3_ENDPOINT=http://localhost:3900 TEST_S3_REGION=garage TEST_S3_ACCESS_KEY_ID=… TEST_S3_SECRET_ACCESS_KEY=…
if (process.env.TEST_S3_ENDPOINT) {
  drivers.push([
    "s3",
    async () => {
      const storage = createS3Storage({
        endpoint: process.env.TEST_S3_ENDPOINT!,
        region: process.env.TEST_S3_REGION ?? "us-east-1",
        bucket: process.env.TEST_S3_BUCKET ?? "fireshare-test",
        accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY!,
      });
      await storage.ensureBucket();
      return { storage, fetch: globalThis.fetch };
    },
  ]);
}

describe.each(drivers)("%s storage driver", (_name, create) => {
  it("assembles a multipart upload from streamed parts", async () => {
    const { storage } = await create();
    const key = randomUUID();
    const first = randomBytes(MIN_PART_SIZE);
    const last = randomBytes(1234);

    const { uploadId } = await storage.createUpload(key, "application/octet-stream");
    const p1 = await storage.writePart(key, uploadId, 1, Readable.from([first]), first.length);
    const p2 = await storage.writePart(key, uploadId, 2, Readable.from([last]), last.length);
    await storage.completeUpload(key, uploadId, [p1, p2]);

    expect(await storage.head(key)).toMatchObject({ size: first.length + last.length });
    const stored = await buffer(await storage.getReadStream(key));
    expect(stored.equals(Buffer.concat([first, last]))).toBe(true);
  });

  it("reads a byte range, and refuses a read whose ETag no longer matches", async () => {
    const { storage } = await create();
    const key = randomUUID();
    const { uploadId } = await storage.createUpload(key);
    const part = await storage.writePart(key, uploadId, 1, Readable.from([Buffer.from("0123456789")]), 10);
    await storage.completeUpload(key, uploadId, [part]);
    const { etag } = (await storage.head(key))!;

    const range = await storage.getReadStream(key, { range: { start: 2, end: 5 }, ifMatch: etag });
    expect((await buffer(range)).toString()).toBe("2345");
    await expect(storage.getReadStream(key, { ifMatch: '"not-the-etag"' })).rejects.toBeInstanceOf(
      ObjectChangedError,
    );
  });

  it("stores an empty file", async () => {
    const { storage } = await create();
    const key = randomUUID();
    await storage.putEmpty(key, "text/plain");

    expect(await storage.head(key)).toMatchObject({ size: 0 });
    expect(await buffer(await storage.getReadStream(key))).toHaveLength(0);
  });

  it("reports missing objects as null and deletes objects", async () => {
    const { storage } = await create();
    const key = randomUUID();
    expect(await storage.head(key)).toBeNull();

    const { uploadId } = await storage.createUpload(key);
    const part = await storage.writePart(key, uploadId, 1, Readable.from([Buffer.from("hi")]), 2);
    await storage.completeUpload(key, uploadId, [part]);
    await storage.delete(key);

    expect(await storage.head(key)).toBeNull();
  });

  it("aborts an incomplete upload, and aborting again or after completion succeeds", async () => {
    const { storage } = await create();
    const key = randomUUID();
    const { uploadId } = await storage.createUpload(key);
    await storage.writePart(key, uploadId, 1, Readable.from([Buffer.from("hi")]), 2);
    await storage.abortUpload(key, uploadId);
    await storage.abortUpload(key, uploadId);

    await expect(
      storage.writePart(key, uploadId, 2, Readable.from([Buffer.from("hi")]), 2),
    ).rejects.toThrow();
    expect(await storage.head(key)).toBeNull();

    const done = randomUUID();
    const upload = await storage.createUpload(done);
    const part = await storage.writePart(done, upload.uploadId, 1, Readable.from([Buffer.from("hi")]), 2);
    await storage.completeUpload(done, upload.uploadId, [part]);
    await storage.abortUpload(done, upload.uploadId);
    expect(await storage.head(done)).toMatchObject({ size: 2 });
  });

  it("deletes a missing object without error", async () => {
    const { storage } = await create();
    await storage.delete(randomUUID());
  });

  it("rejects a part whose body is shorter than its declared length", async () => {
    const { storage } = await create();
    const key = randomUUID();
    const { uploadId } = await storage.createUpload(key);
    await expect(
      storage.writePart(key, uploadId, 1, Readable.from([Buffer.from("short")]), 100),
    ).rejects.toThrow();
  });

  it("uploads parts and downloads objects through presigned URLs, and lists uploaded parts", async () => {
    const { storage, fetch } = await create();
    const key = randomUUID();
    const { uploadId } = await storage.createUpload(key, "text/plain");

    const putUrl = await storage.getPresignedUrl({ action: "uploadPart", key, uploadId, partNumber: 1 });
    const putRes = await fetch(putUrl, { method: "PUT", body: "direct-bytes" });
    expect(putRes.status).toBe(200);

    const parts = await storage.listParts(key, uploadId);
    expect(parts).toEqual([{ partNumber: 1, etag: expect.any(String), size: 12 }]);
    await storage.completeUpload(key, uploadId, parts);
    expect(await storage.listParts(key, uploadId)).toEqual([]);

    const getUrl = await storage.getPresignedUrl({
      action: "getObject",
      key,
      responseContentDisposition: 'attachment; filename="note.txt"',
      responseContentType: "text/plain",
    });
    const getRes = await fetch(getUrl);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Content-Disposition")).toBe('attachment; filename="note.txt"');
    expect(await getRes.text()).toBe("direct-bytes");
  });

  it("scopes each presigned URL to its own key, action and lifetime", async () => {
    const { storage, fetch, advanceSeconds } = await create();
    const key = randomUUID();
    const otherKey = randomUUID();
    const { uploadId } = await storage.createUpload(key);

    const putPart1 = await storage.getPresignedUrl({
      action: "uploadPart",
      key,
      uploadId,
      partNumber: 1,
      expiresInSeconds: 60,
    });
    // Wrong HTTP method, wrong partNumber, wrong key.
    expect((await fetch(putPart1, { method: "GET" })).status).toBe(403);
    expect((await fetch(putPart1.replace("partNumber=1", "partNumber=2"), { method: "PUT", body: "x" })).status).toBe(
      403,
    );
    expect((await fetch(putPart1.replace(key, otherKey), { method: "PUT", body: "x" })).status).toBe(403);

    const part = await storage.writePart(key, uploadId, 1, Readable.from([Buffer.from("ok")]), 2);
    await storage.completeUpload(key, uploadId, [part]);

    const getUrl = await storage.getPresignedUrl({
      action: "getObject",
      key,
      expiresInSeconds: 60,
      responseContentDisposition: 'attachment; filename="ok.txt"',
    });
    expect((await fetch(getUrl, { method: "PUT", body: "overwrite" })).status).toBe(403);
    expect((await fetch(getUrl, { method: "DELETE" })).status).toBe(403);
    expect((await fetch(getUrl.replace(key, otherKey))).status).toBe(403);

    if (advanceSeconds) {
      advanceSeconds(60);
      expect((await fetch(getUrl)).status).toBe(403);
      expect((await fetch(putPart1, { method: "PUT", body: "late" })).status).toBe(403);
    }
  });

  it("restricts bucket CORS to the configured app origin only", async () => {
    const { storage, fetch } = await create();
    await storage.ensureCors?.("https://share.example.com");
    const key = randomUUID();
    const { uploadId } = await storage.createUpload(key);
    const url = await storage.getPresignedUrl({ action: "uploadPart", key, uploadId, partNumber: 1 });
    const objectUrl = url.split("?")[0];

    const allowed = await fetch(objectUrl, {
      method: "OPTIONS",
      headers: { Origin: "https://share.example.com", "Access-Control-Request-Method": "PUT" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://share.example.com");

    // A failed preflight blocks the browser whatever its headers say (Garage adds a `*` to it).
    const blocked = await fetch(objectUrl, {
      method: "OPTIONS",
      headers: { Origin: "https://other.example.com", "Access-Control-Request-Method": "PUT" },
    });
    expect(blocked.status).toBe(403);

    // A request that needs no preflight still gets no permission to read the response.
    await storage.putEmpty(key);
    const read = await fetch(await storage.getPresignedUrl({ action: "getObject", key }), {
      headers: { Origin: "https://other.example.com" },
    });
    expect(read.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

