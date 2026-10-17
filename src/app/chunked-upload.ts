import { Upload, type DetailedError, type HttpStack } from "tus-js-client";

/** tus checksum extension: the server rejected a chunk whose SHA-256 didn't match. */
const CHECKSUM_MISMATCH = 460;

export interface ChunkedUploadOptions {
  chunkSize: number;
  /** True when uploading directly to storage with presigned part URLs instead of proxied tus PATCHes. */
  direct?: boolean;
  /** Initial presigned uploadPart URLs for direct mode; omitted when resuming. */
  partUrls?: string[];
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
  /** Replaces global fetch for direct-mode requests (tests). */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_RETRY_DELAYS = [0, 1000, 3000, 5000, 10_000, 20_000, 30_000];

/**
 * Uploads `file` to an existing upload, starting from the offset the server
 * reports, so an interrupted upload resumes from its last completed chunk.
 * In proxy mode, each chunk carries its SHA-256 via tus; in direct mode, each
 * part is PUT directly to its short-lived presigned storage URL without
 * browser hashing.
 */
export function uploadFile(file: Blob, uploadUrl: string, options: ChunkedUploadOptions): Promise<void> {
  if (options.direct || options.partUrls !== undefined) {
    return uploadDirectFile(file, uploadUrl, options);
  }
  if (!globalThis.crypto?.subtle) {
    return Promise.reject(new Error("Uploading needs a secure connection: open this page over HTTPS"));
  }
  // SHA-256 (base64) of each chunk, by the offset it starts at.
  const checksums = new Map<number, string>();
  return new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      uploadUrl,
      chunkSize: options.chunkSize,
      retryDelays: options.retryDelays ?? DEFAULT_RETRY_DELAYS,
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
        // Network errors, server errors, a lost offset race, corrupted chunks and rate limits.
        const retry =
          status === 0 ||
          status >= 500 ||
          status === 409 ||
          status === 423 ||
          status === 429 ||
          status === CHECKSUM_MISMATCH;
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

async function uploadDirectFile(file: Blob, uploadUrl: string, options: ChunkedUploadOptions): Promise<void> {
  options.signal?.throwIfAborted();
  if (file.size === 0) {
    options.onProgress?.(0);
    return;
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;

  let offset = 0;
  let partUrls: string[];
  if (options.partUrls !== undefined) {
    partUrls = [...options.partUrls];
  } else {
    const status = await fetchDirectUploadStatus(uploadUrl, fetchFn, options.signal);
    offset = status.offset;
    partUrls = [...status.partUrls];
  }
  options.onProgress?.(offset);

  while (offset < file.size) {
    options.signal?.throwIfAborted();
    if (partUrls.length === 0) {
      const status = await fetchDirectUploadStatus(uploadUrl, fetchFn, options.signal);
      offset = status.offset;
      partUrls = [...status.partUrls];
      if (offset >= file.size) break;
      if (partUrls.length === 0) {
        throw new Error("No presigned part URLs available to continue upload");
      }
    }

    const end = Math.min(offset + options.chunkSize, file.size);
    const slice = file.slice(offset, end);
    let attempt = 0;
    while (true) {
      options.signal?.throwIfAborted();
      let status = 0;
      let ok = false;
      try {
        const res = await fetchFn(partUrls[0], {
          method: "PUT",
          body: slice,
          signal: options.signal,
        });
        status = res.status;
        ok = res.ok;
      } catch (err) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (attempt >= retryDelays.length) throw err;
      }

      if (ok) {
        offset = end;
        partUrls.shift();
        options.onChunkAccepted?.();
        options.onProgress?.(offset);
        break;
      }

      const retryable = status === 0 || status >= 500 || status === 429 || status === 403;
      if (!retryable || attempt >= retryDelays.length) {
        throw new Error(`Part upload failed (${status})`);
      }
      options.onRetry?.();
      const delay = retryDelays[attempt++];
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (status === 403) {
        const refreshed = await fetchDirectUploadStatus(uploadUrl, fetchFn, options.signal);
        offset = refreshed.offset;
        partUrls = [...refreshed.partUrls];
        break;
      }
    }
  }
}

async function fetchDirectUploadStatus(
  uploadUrl: string,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<{ size: number; offset: number; partUrls: string[] }> {
  const res = await fetchFn(uploadUrl, { method: "GET", cache: "no-store", signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Upload status query failed (${res.status})`);
  }
  return res.json();
}

async function sha256Base64(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return btoa(String.fromCharCode(...digest));
}
