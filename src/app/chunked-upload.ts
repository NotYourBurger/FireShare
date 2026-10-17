import { Upload, type DetailedError, type HttpStack } from "tus-js-client";

/** tus checksum extension: the server rejected a chunk whose SHA-256 didn't match. */
const CHECKSUM_MISMATCH = 460;

export interface ChunkedUploadOptions {
  chunkSize: number;
  /** Bytes of the file the server has accepted or is receiving. */
  onProgress?: (bytesSent: number) => void;
  /** A request failed and is about to be retried. */
  onRetry?: () => void;
  /** The server accepted a chunk. */
  onChunkAccepted?: () => void;
  retryDelays?: number[];
  /** Stops the upload; the promise rejects. What the server accepted stays. */
  signal?: AbortSignal;
  /** Replaces the browser's XMLHttpRequest stack (tests). */
  httpStack?: HttpStack;
}

/**
 * Uploads `file` to an existing tus upload, starting from the offset the
 * server reports, so an interrupted upload resumes from its last completed
 * chunk. Each chunk carries its SHA-256; a chunk the server rejects as
 * corrupted, like one cut off by a network error, is sent again on its own.
 */
export function uploadFile(file: Blob, uploadUrl: string, options: ChunkedUploadOptions): Promise<void> {
  if (!globalThis.crypto?.subtle) {
    return Promise.reject(new Error("Uploading needs a secure connection: open this page over HTTPS"));
  }
  // SHA-256 (base64) of each chunk, by the offset it starts at.
  const checksums = new Map<number, string>();
  return new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      uploadUrl,
      chunkSize: options.chunkSize,
      retryDelays: options.retryDelays ?? [0, 1000, 3000, 5000, 10_000, 20_000, 30_000],
      storeFingerprintForResuming: false,
      httpStack: options.httpStack,
      fileReader: {
        async openFile(input: Blob) {
          return {
            size: input.size,
            async slice(start: number, end: number) {
              const value = input.slice(start, end);
              checksums.set(start, await sha256Base64(value));
              return { value, done: end >= input.size };
            },
            close() {},
          };
        },
      },
      onBeforeRequest(req) {
        if (req.getMethod() !== "PATCH") return;
        const offset = Number(req.getHeader("Upload-Offset"));
        req.setHeader("Upload-Checksum", `sha256 ${checksums.get(offset)}`);
        checksums.delete(offset);
      },
      onShouldRetry(err: DetailedError) {
        const status = err.originalResponse?.getStatus() ?? 0;
        // Network errors, server errors, a lost offset race and corrupted chunks.
        const retry =
          status === 0 || status >= 500 || status === 409 || status === 423 || status === CHECKSUM_MISMATCH;
        if (retry) options.onRetry?.();
        return retry;
      },
      onProgress: (bytesSent) => options.onProgress?.(bytesSent),
      onChunkComplete: () => options.onChunkAccepted?.(),
      onSuccess: () => resolve(),
      onError: reject,
    });
    options.signal?.throwIfAborted();
    options.signal?.addEventListener("abort", () => {
      void upload.abort();
      reject(options.signal!.reason);
    });
    upload.start();
  });
}

async function sha256Base64(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return btoa(String.fromCharCode(...digest));
}
