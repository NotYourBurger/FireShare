import type { Readable } from "node:stream";

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface StoredPart extends UploadedPart {
  size: number;
}

export interface ObjectInfo {
  size: number;
  etag: string;
}

/** Inclusive byte offsets, as in an HTTP `Range` header. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface ReadOptions {
  /** Only these bytes; `end` must be within the object. */
  range?: ByteRange;
  /** Refuse with {@link ObjectChangedError} unless the object still has this ETag. */
  ifMatch?: string;
}

/** A single-action, single-key operation a browser may perform directly against storage. */
export type PresignedUrlRequest =
  | {
      action: "uploadPart";
      key: string;
      uploadId: string;
      partNumber: number;
      expiresInSeconds?: number;
    }
  | {
      action: "getObject";
      key: string;
      expiresInSeconds?: number;
      responseContentDisposition?: string;
      responseContentType?: string;
    };

/** The object no longer has the ETag a read was made against. */
export class ObjectChangedError extends Error {
  constructor(key: string) {
    super(`Object ${key} has changed`);
    this.name = "ObjectChangedError";
  }
}

/**
 * The only way FireShare touches file bytes. Nothing outside a driver may
 * talk to a storage SDK directly.
 */
export interface StorageAdapter {
  /** Starts a multipart upload for `key`. */
  createUpload(key: string, contentType?: string): Promise<{ uploadId: string }>;
  /**
   * Streams one part. `length` must be exact; the body is never buffered.
   * Every part but the last must be at least {@link MIN_PART_SIZE} bytes.
   */
  writePart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Readable,
    length: number,
  ): Promise<UploadedPart>;
  /** Parts uploaded so far for `uploadId`, in ascending `partNumber` order, or `[]` when the upload doesn't exist. */
  listParts(key: string, uploadId: string): Promise<StoredPart[]>;
  completeUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  /**
   * Discards an incomplete multipart upload and its parts. Succeeds when the
   * upload no longer exists, whether aborted or completed.
   */
  abortUpload(key: string, uploadId: string): Promise<void>;
  getReadStream(key: string, options?: ReadOptions): Promise<Readable>;
  /** Issues a short-lived URL signed for one storage key and one action. */
  getPresignedUrl(request: PresignedUrlRequest): Promise<string>;
  /** Restricts the bucket's CORS rules to `origin` only. */
  ensureCors?(origin: string): Promise<void>;
  /** Returns null when the object doesn't exist. */
  head(key: string): Promise<ObjectInfo | null>;
  /** Succeeds when the object doesn't exist. */
  delete(key: string): Promise<void>;
}

/** How long a presigned URL works before storage rejects it. */
export const PRESIGN_TTL_SECONDS = 5 * 60;

/** S3's minimum size for every multipart part except the last. */
export const MIN_PART_SIZE = 5 * 1024 * 1024;

/** S3's maximum size for any multipart part. */
export const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;

