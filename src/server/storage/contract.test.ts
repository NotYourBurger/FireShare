import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { MIN_PART_SIZE, ObjectChangedError, type StorageAdapter } from "./adapter";
import { createMemoryStorage } from "./memory";
import { createS3Storage } from "./s3";

const drivers: [string, () => Promise<StorageAdapter>][] = [
  ["memory", async () => createMemoryStorage()],
];

// Runs against a real S3 API (e.g. RustFS) when one is configured:
// TEST_S3_ENDPOINT=http://localhost:9000 TEST_S3_ACCESS_KEY_ID=… TEST_S3_SECRET_ACCESS_KEY=…
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
      return storage;
    },
  ]);
}

describe.each(drivers)("%s storage driver", (_name, create) => {
  it("assembles a multipart upload from streamed parts", async () => {
    const storage = await create();
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
    const storage = await create();
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

  it("stores an empty file as a single empty part", async () => {
    const storage = await create();
    const key = randomUUID();
    const { uploadId } = await storage.createUpload(key);
    const part = await storage.writePart(key, uploadId, 1, Readable.from([]), 0);
    await storage.completeUpload(key, uploadId, [part]);

    expect(await storage.head(key)).toMatchObject({ size: 0 });
  });

  it("reports missing objects as null and deletes objects", async () => {
    const storage = await create();
    const key = randomUUID();
    expect(await storage.head(key)).toBeNull();

    const { uploadId } = await storage.createUpload(key);
    const part = await storage.writePart(key, uploadId, 1, Readable.from([Buffer.from("hi")]), 2);
    await storage.completeUpload(key, uploadId, [part]);
    await storage.delete(key);

    expect(await storage.head(key)).toBeNull();
  });

  it("rejects a part whose body is shorter than its declared length", async () => {
    const storage = await create();
    const key = randomUUID();
    const { uploadId } = await storage.createUpload(key);
    await expect(
      storage.writePart(key, uploadId, 1, Readable.from([Buffer.from("short")]), 100),
    ).rejects.toThrow();
  });
});
