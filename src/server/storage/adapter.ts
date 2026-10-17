import type { Readable } from "node:stream";

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectInfo {
  size: number;
  etag: string;
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
  completeUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  getReadStream(key: string): Promise<Readable>;
  /** Returns null when the object doesn't exist. */
  head(key: string): Promise<ObjectInfo | null>;
  delete(key: string): Promise<void>;
}

/** S3's minimum size for every multipart part except the last. */
export const MIN_PART_SIZE = 5 * 1024 * 1024;
