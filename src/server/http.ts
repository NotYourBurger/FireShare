import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { ExpiryConfig, UploadConfig } from "./config";
import { ShareError, type NewShare, type ShareErrorCode, type ShareService } from "./shares";

const TUS_VERSION = "1.0.0";
const MAX_NAME_LENGTH = 255;
export const MAX_TITLE_LENGTH = 200;
export const MAX_MESSAGE_LENGTH = 5000;
const MIME_TYPE = /^[\w.+-]+\/[\w.+-]+$/;
/** `Upload-Checksum` from the tus checksum extension; only SHA-256 is accepted. */
const UPLOAD_CHECKSUM = /^sha256 ([A-Za-z0-9+/]{43}=)$/;

const errorStatus: Record<ShareErrorCode, number> = {
  not_found: 404,
  offset_mismatch: 409,
  invalid_chunk: 400,
  // tus checksum extension: "460 Checksum Mismatch".
  checksum_mismatch: 460,
  not_finalizable: 409,
};

/**
 * Framework-independent request handlers. The Next.js route files only
 * forward to these.
 */
export function createHttpHandlers({
  shares,
  expiry,
  upload,
}: {
  shares: ShareService;
  expiry: ExpiryConfig;
  upload: UploadConfig;
}) {
  return {
    /** Choices and settings for the upload form. */
    uploadOptions() {
      return {
        expiryOptions: expiry.options.map((option) => option.value),
        expiryDefault: expiry.default,
        chunkSize: upload.chunkSize,
        parallelFiles: upload.parallelFiles,
      };
    },

    /** POST /api/shares — authorizes and creates a `pending` share. */
    async createShare(req: Request) {
      const newShare = parseNewShare(await req.json().catch(() => null), expiry);
      if (typeof newShare === "string") return json(400, { error: newShare });
      const share = await shares.createShare(newShare);
      return json(201, {
        id: share.id,
        files: share.files.map((file) => ({ ...file, uploadUrl: `/api/uploads/${file.id}` })),
      });
    },

    /** OPTIONS /api/uploads/:id — tus capability discovery. */
    async optionsUpload() {
      return new Response(null, {
        status: 204,
        headers: {
          "Tus-Resumable": TUS_VERSION,
          "Tus-Version": TUS_VERSION,
          "Tus-Extension": "checksum",
          "Tus-Checksum-Algorithm": "sha256",
        },
      });
    },

    /** HEAD /api/uploads/:id — tus offset query. */
    async headUpload(req: Request, uploadId: string) {
      const rejected = checkTusVersion(req);
      if (rejected) return rejected;
      const upload = await shares.getUpload(uploadId);
      if (!upload) return tus(404);
      return tus(200, {
        "Upload-Offset": String(upload.offset),
        "Upload-Length": String(upload.size),
        "Cache-Control": "no-store",
      });
    },

    /**
     * PATCH /api/uploads/:id — tus chunk, streamed straight into storage.
     * Every chunk must carry its SHA-256 in `Upload-Checksum`.
     */
    async patchUpload(req: Request, uploadId: string) {
      const rejected = checkTusVersion(req);
      if (rejected) return rejected;
      if (req.headers.get("Content-Type") !== "application/offset+octet-stream") return tus(415);
      const offset = parseNonNegativeInt(req.headers.get("Upload-Offset"));
      const length = parseNonNegativeInt(req.headers.get("Content-Length"));
      const checksum = UPLOAD_CHECKSUM.exec(req.headers.get("Upload-Checksum") ?? "");
      if (offset === null || length === null || !checksum) return tus(400);
      const sha256 = Buffer.from(checksum[1], "base64").toString("hex");

      const body = req.body
        ? Readable.fromWeb(req.body as NodeReadableStream<Uint8Array>)
        : Readable.from([]);
      try {
        const newOffset = await shares.writeChunk(uploadId, offset, body, length, sha256);
        return tus(204, { "Upload-Offset": String(newOffset) });
      } catch (err) {
        body.destroy();
        if (err instanceof ShareError) return tus(errorStatus[err.code]);
        throw err;
      }
    },

    /** POST /api/shares/:id/finalize — makes the share `ready` and returns its link once. */
    async finalize(_req: Request, shareId: string) {
      try {
        const { token } = await shares.finalize(shareId);
        return json(200, { path: `/d/${token}` });
      } catch (err) {
        if (err instanceof ShareError) return json(errorStatus[err.code], { error: err.message });
        throw err;
      }
    },

    /** Data for the recipient page at /d/:token, "expired", or null to show not-found. */
    async viewShare(token: string) {
      return shares.viewShare(token);
    },

    /** GET /d/:token/files/:fileId — streams one shared file as an attachment. */
    async download(_req: Request, token: string, fileId: string) {
      const file = await shares.openDownload(token, fileId);
      if (file === "expired") return html(410, EXPIRED_PAGE);
      if (!file) return html(404, NOT_FOUND_PAGE);
      return new Response(Readable.toWeb(file.stream) as ReadableStream, {
        status: 200,
        headers: {
          "Content-Type": file.contentType,
          "Content-Length": String(file.size),
          "Content-Disposition": contentDisposition(file.name),
          ...SAFE_HEADERS,
        },
      });
    },
  };
}

export type HttpHandlers = ReturnType<typeof createHttpHandlers>;

const SAFE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  // The token is in the URL; don't leak it to other sites.
  "Referrer-Policy": "no-referrer",
};

const page = (title: string, heading: string, text: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · FireShare</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f5f2;color:#1d1b18}main{max-width:28rem;padding:1rem}@media(prefers-color-scheme:dark){body{background:#1a1917;color:#ecebe8}}</style></head>
<body><main><h1>${heading}</h1><p>${text}</p></main></body>
</html>`;

const NOT_FOUND_PAGE = page(
  "Link not available",
  "This link isn't available",
  "It may have been mistyped, expired or been deleted.",
);

const EXPIRED_PAGE = page(
  "Link expired",
  "This link has expired",
  "The files it shared are no longer available. Ask the sender for a new link.",
);

/** The validated share, or an error message for the uploader. */
function parseNewShare(input: unknown, expiry: ExpiryConfig): NewShare | string {
  if (!isRecord(input)) return "Invalid request";
  const expiryValue = input.expiry === undefined ? expiry.default : input.expiry;
  const expiryOption = expiry.options.find((option) => option.value === expiryValue);
  if (!expiryOption) return `Expiry must be one of ${expiry.options.map((option) => option.value).join(", ")}`;
  const title = parseText(input.title, MAX_TITLE_LENGTH);
  if (title === undefined) return `Title must be text of at most ${MAX_TITLE_LENGTH} characters`;
  const message = parseText(input.message, MAX_MESSAGE_LENGTH);
  if (message === undefined) return `Message must be text of at most ${MAX_MESSAGE_LENGTH} characters`;
  if (!Array.isArray(input.files) || input.files.length === 0) return "Invalid files";
  const files = [];
  for (const file of input.files as unknown[]) {
    if (!isRecord(file)) return "Invalid files";
    const { name, size, type } = file;
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH) return "Invalid files";
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return "Invalid files";
    const contentType =
      typeof type === "string" && MIME_TYPE.test(type) ? type : "application/octet-stream";
    files.push({ name, size, contentType });
  }
  return { title, message, expirySeconds: expiryOption.seconds, files };
}

/** Optional plain text: trimmed, blank becomes null, undefined when invalid. */
function parseText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length > maxLength) return undefined;
  return text || null;
}

/** `attachment` with an ASCII fallback name plus the exact UTF-8 name (RFC 6266). */
function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function checkTusVersion(req: Request): Response | null {
  return req.headers.get("Tus-Resumable") === TUS_VERSION
    ? null
    : tus(412, { "Tus-Version": TUS_VERSION });
}

function tus(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers: { "Tus-Resumable": TUS_VERSION, ...headers } });
}

function html(status: number, body: string) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...SAFE_HEADERS },
  });
}

function json(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function parseNonNegativeInt(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
