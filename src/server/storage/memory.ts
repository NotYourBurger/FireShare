import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { ObjectChangedError, type PresignedUrlRequest, type StorageAdapter, type UploadedPart } from "./adapter";
import { exactLength } from "./exact-length";
import { presignS3Url } from "./presign";

export interface MemoryStorage extends StorageAdapter {
  ensureCors(origin: string): Promise<void>;
  /** Origins allowed by the bucket's CORS rule. */
  corsOrigins(): string[];
  /** Handles presigned `PUT`, `GET` and CORS `OPTIONS` requests in memory, like S3 does. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** An in-process driver for tests and local experiments. */
export function createMemoryStorage({
  directEndpoint = "https://storage.fireshare.test",
  now = () => new Date(),
}: {
  directEndpoint?: string;
  now?: () => Date;
} = {}): MemoryStorage {
  const objects = new Map<string, { data: Buffer; etag: string }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  let allowedOrigins: string[] = [];
  const presignConfig = {
    endpoint: directEndpoint,
    region: "us-east-1",
    bucket: "fireshare",
    accessKeyId: "memory-access-key",
    secretAccessKey: "memory-secret-key",
  };

  function verifyPresigned(req: Request, url: URL): { key: string } | null {
    const prefix = `${new URL(directEndpoint).pathname.replace(/\/$/, "")}/${presignConfig.bucket}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!key) return null;

    const amzDate = url.searchParams.get("X-Amz-Date");
    const expires = Number(url.searchParams.get("X-Amz-Expires"));
    if (!amzDate || !Number.isInteger(expires) || expires <= 0) return null;
    const signedAt = parseAmzDate(amzDate);
    if (!signedAt) return null;
    const elapsedSeconds = (now().getTime() - signedAt.getTime()) / 1000;
    if (elapsedSeconds < 0 || elapsedSeconds >= expires) return null;

    let action: PresignedUrlRequest;
    if (req.method === "PUT") {
      const partNumber = Number(url.searchParams.get("partNumber"));
      const uploadId = url.searchParams.get("uploadId");
      if (!Number.isInteger(partNumber) || partNumber < 1 || !uploadId) return null;
      action = { action: "uploadPart", key, uploadId, partNumber, expiresInSeconds: expires };
    } else if (req.method === "GET") {
      action = {
        action: "getObject",
        key,
        expiresInSeconds: expires,
        responseContentDisposition: url.searchParams.get("response-content-disposition") ?? undefined,
        responseContentType: url.searchParams.get("response-content-type") ?? undefined,
      };
    } else {
      return null;
    }

    const expected = presignS3Url(presignConfig, action, signedAt);
    return expected === url.href ? { key } : null;
  }

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

    async listParts(key, uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== key) return [];
      return [...upload.parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([partNumber, data]) => ({ partNumber, etag: md5(data), size: data.length }));
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

    async abortUpload(key, uploadId) {
      if (uploads.get(uploadId)?.key === key) uploads.delete(uploadId);
    },

    async putEmpty(key) {
      const data = Buffer.alloc(0);
      objects.set(key, { data, etag: md5(data) });
    },

    async getReadStream(key, { range, ifMatch } = {}) {
      const object = objects.get(key);
      if (!object) throw new Error("No such object");
      if (ifMatch !== undefined && ifMatch !== object.etag) throw new ObjectChangedError(key);
      return Readable.from([range ? object.data.subarray(range.start, range.end + 1) : object.data]);
    },

    async getPresignedUrl(request) {
      return presignS3Url(presignConfig, request, now());
    },

    async ensureCors(origin) {
      allowedOrigins = [origin];
    },

    corsOrigins() {
      return [...allowedOrigins];
    },

    async fetch(input, init) {
      const req = new Request(input, init);
      const origin = req.headers.get("Origin");
      const corsHeaders: Record<string, string> = {};
      if (origin) {
        if (!allowedOrigins.includes(origin)) return new Response(null, { status: 403 });
        corsHeaders["Access-Control-Allow-Origin"] = origin;
        corsHeaders["Access-Control-Allow-Methods"] = "GET, HEAD, PUT";
        corsHeaders["Access-Control-Expose-Headers"] = "ETag, Content-Length, Content-Range";
      }
      if (req.method === "OPTIONS") {
        return origin ? new Response(null, { status: 200, headers: corsHeaders }) : new Response(null, { status: 403 });
      }

      const url = new URL(req.url);
      const verified = verifyPresigned(req, url);
      if (!verified) return new Response("Forbidden", { status: 403, headers: corsHeaders });

      if (req.method === "PUT") {
        const uploadId = url.searchParams.get("uploadId")!;
        const partNumber = Number(url.searchParams.get("partNumber"));
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== verified.key) return new Response("NoSuchUpload", { status: 404, headers: corsHeaders });
        const data = Buffer.from(await req.arrayBuffer());
        upload.parts.set(partNumber, data);
        return new Response(null, { status: 200, headers: { ...corsHeaders, ETag: md5(data) } });
      }

      const object = objects.get(verified.key);
      if (!object) return new Response("NoSuchKey", { status: 404, headers: corsHeaders });
      const headers: Record<string, string> = {
        ...corsHeaders,
        "Content-Length": String(object.data.length),
        ETag: object.etag,
      };
      const disposition = url.searchParams.get("response-content-disposition");
      const contentType = url.searchParams.get("response-content-type");
      if (disposition) headers["Content-Disposition"] = disposition;
      if (contentType) headers["Content-Type"] = contentType;
      return new Response(new Uint8Array(object.data), { status: 200, headers });
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

function parseAmzDate(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function md5(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
}

