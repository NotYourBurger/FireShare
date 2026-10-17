import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { ObjectChangedError, type StorageAdapter, type UploadedPart } from "./adapter";
import { exactLength } from "./exact-length";

/** An in-process driver for tests and local experiments. */
export function createMemoryStorage(): StorageAdapter {
  const objects = new Map<string, { data: Buffer; etag: string }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();

  return {
    async createUpload(key) {
      const uploadId = randomUUID();
      uploads.set(uploadId, { key, parts: new Map() });
      return { uploadId };
    },

    async writePart(key, uploadId, partNumber, body, length): Promise<UploadedPart> {
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error("No such upload");
      const data = await buffer(exactLength(body, length));
      upload.parts.set(partNumber, data);
      return { partNumber, etag: md5(data) };
    },

    async completeUpload(key, uploadId, parts) {
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error("No such upload");
      const data = Buffer.concat(
        parts.map(({ partNumber, etag }) => {
          const part = upload.parts.get(partNumber);
          if (!part || md5(part) !== etag) throw new Error(`Invalid part ${partNumber}`);
          return part;
        }),
      );
      uploads.delete(uploadId);
      objects.set(key, { data, etag: `${md5(data)}-${parts.length}` });
    },

    async getReadStream(key, { range, ifMatch } = {}) {
      const object = objects.get(key);
      if (!object) throw new Error("No such object");
      if (ifMatch !== undefined && ifMatch !== object.etag) throw new ObjectChangedError(key);
      return Readable.from([range ? object.data.subarray(range.start, range.end + 1) : object.data]);
    },

    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.data.length, etag: object.etag } : null;
    },

    async delete(key) {
      objects.delete(key);
    },
  };
}

function md5(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
}
