import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { ObjectChangedError, type StorageAdapter, type StoredPart } from "./adapter";
import { exactLength } from "./exact-length";
import { presignS3Url } from "./presign";

export interface S3StorageConfig {
  endpoint: string;
  /** Where browsers reach storage for presigned URLs; defaults to `endpoint`. */
  directEndpoint?: string | null;
  /** Origin the bucket's CORS rule allows when `ensureBucket` runs. */
  corsOrigin?: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: () => Date;
}

export interface S3Storage extends StorageAdapter {
  /** Creates the bucket if it doesn't exist yet, and applies `corsOrigin` when configured. */
  ensureBucket(): Promise<void>;
  ensureCors(origin: string): Promise<void>;
}

/** The v1 storage driver: any S3-compatible API (Garage by default). */
export function createS3Storage(config: S3StorageConfig): S3Storage {
  const { bucket } = config;
  const presignConfig = {
    endpoint: config.directEndpoint || config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
  let appliedCorsOrigin: string | null = null;
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Streamed bodies with trailing checksums (aws-chunked) aren't supported
    // by every S3-compatible server; only checksum when the API demands it.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  async function ensureCors(origin: string) {
    if (appliedCorsOrigin === origin) return;
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [origin],
              AllowedMethods: ["GET", "HEAD", "PUT"],
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag", "Content-Length", "Content-Range"],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
    appliedCorsOrigin = origin;
  }

  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
      if (config.corsOrigin) await ensureCors(config.corsOrigin);
    },

    ensureCors,

    async createUpload(key, contentType) {
      const { UploadId } = await client.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      );
      if (!UploadId) throw new Error("Storage returned no upload id");
      return { uploadId: UploadId };
    },

    async writePart(key, uploadId, partNumber, body, length) {
      // The SDK pipes the body without watching it for errors, so a body
      // that fails the length check has to abort the request explicitly.
      const checked = exactLength(body, length);
      const abort = new AbortController();
      let bodyError: unknown;
      checked.on("error", (err) => {
        bodyError = err;
        abort.abort(err);
      });
      const { ETag } = await client
        .send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: checked,
            ContentLength: length,
          }),
          { abortSignal: abort.signal },
        )
        .catch((err: unknown) => {
          throw bodyError ?? err;
        });
      if (!ETag) throw new Error("Storage returned no part ETag");
      return { partNumber, etag: ETag };
    },

    async listParts(key, uploadId) {
      const parts: StoredPart[] = [];
      let partNumberMarker: string | undefined;
      try {
        for (;;) {
          const page = await client.send(
            new ListPartsCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumberMarker: partNumberMarker,
            }),
          );
          for (const part of page.Parts ?? []) {
            if (part.PartNumber !== undefined && part.ETag !== undefined && part.Size !== undefined) {
              parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size });
            }
          }
          if (!page.IsTruncated || !page.NextPartNumberMarker) break;
          partNumberMarker = page.NextPartNumberMarker;
        }
      } catch (err) {
        if (isNotFound(err)) return [];
        throw err;
      }
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    },

    async completeUpload(key, uploadId, parts) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: etag })),
          },
        }),
      );
    },

    async abortUpload(key, uploadId) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
      } catch (err) {
        // NoSuchUpload: already aborted or completed.
        if (!isNotFound(err)) throw err;
      }
    },

    async putEmpty(key, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: new Uint8Array(0), ContentLength: 0, ContentType: contentType }),
      );
    },

    async getReadStream(key, { range, ifMatch } = {}) {
      const { Body } = await client
        .send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            Range: range && `bytes=${range.start}-${range.end}`,
            IfMatch: ifMatch,
          }),
        )
        .catch((err: unknown) => {
          if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 412) {
            throw new ObjectChangedError(key);
          }
          throw err;
        });
      if (!Body) throw new Error("Storage returned no body");
      return Body as Readable;
    },

    async getPresignedUrl(request) {
      return presignS3Url(presignConfig, request, config.now?.());
    },

    async head(key) {
      try {
        const { ContentLength, ETag } = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return { size: ContentLength ?? 0, etag: ETag ?? "" };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404;
}

