import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { ExpiryConfig, UploadConfig } from "./config";
import { ShareError, type Download, type NewShare, type ShareErrorCode, type ShareService } from "./shares";
import type { ByteRange } from "./storage/adapter";
import type { UploadAccess, UploadAccessControl } from "./upload-access";

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
  // The stored object conflicts with the fingerprint recorded at finalize.
  tampered: 409,
};

/**
 * Framework-independent request handlers. The Next.js route files only
 * forward to these.
 */
export function createHttpHandlers({
  shares,
  expiry,
  upload,
  access,
}: {
  shares: ShareService;
  expiry: ExpiryConfig;
  upload: UploadConfig;
  access: UploadAccessControl;
}) {
  /** A refusal for a request that may not upload, or null to go ahead. */
  function refuseUpload(req: Request, respond: (status: number, error: string) => Response): Response | null {
    const result = access.check(req.headers);
    if (result === "allowed") return null;
    return respond(accessStatus[result], ACCESS_ERROR[result]);
  }
  const refuseJson = (req: Request) => refuseUpload(req, (status, error) => json(status, { error }));
  const refuseTus = (req: Request) => refuseUpload(req, (status) => tus(status));

  return {
    /** Whether the request's sender may upload, for the upload page. */
    uploadAccess(headers: Pick<Headers, "get">): UploadAccess {
      return access.check(headers);
    },

    /** Where download pages link to report abuse, or null for no link. */
    abuseReportUrl() {
      return access.abuseReportUrl;
    },

    /** POST /api/upload-session — trades the upload password for a session cookie. */
    async createUploadSession(req: Request) {
      const input = await req.json().catch(() => null);
      const password = isRecord(input) && typeof input.password === "string" ? input.password : null;
      if (password === null) return json(400, { error: "Invalid request" });
      const secure = new URL(req.url).protocol === "https:";
      const result = access.login(req.headers, password, secure);
      if (result.ok) return new Response(null, { status: 204, headers: { "Set-Cookie": result.cookie, "Cache-Control": "no-store" } });
      switch (result.reason) {
        case "wrong":
          return json(401, { error: "Wrong password" });
        case "rate_limited":
          return Response.json(
            { error: "Too many wrong passwords. Try again later." },
            { status: 429, headers: { "Retry-After": String(result.retryAfter), "Cache-Control": "no-store" } },
          );
        case "network":
          return json(403, { error: ACCESS_ERROR.network });
        case "public":
          return json(404, { error: "Uploads need no password" });
      }
    },

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
      const refused = refuseJson(req);
      if (refused) return refused;
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
      const rejected = checkTusVersion(req) ?? refuseTus(req);
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
      const rejected = checkTusVersion(req) ?? refuseTus(req);
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

    /**
     * POST /api/shares/:id/finalize — makes the share `ready` and returns its
     * share link and management link, once.
     */
    async finalize(req: Request, shareId: string) {
      const refused = refuseJson(req);
      if (refused) return refused;
      try {
        const { token, managementToken, expiresAt } = await shares.finalize(shareId);
        return json(200, { path: `/d/${token}`, managementPath: `/m/${managementToken}`, expiresAt });
      } catch (err) {
        if (err instanceof ShareError) return json(errorStatus[err.code], { error: err.message });
        throw err;
      }
    },

    /** Data for the recipient page at /d/:token, "unavailable", or null to show not-found. */
    async viewShare(token: string) {
      return shares.viewShare(token);
    },

    /** Data for the management page at /m/:token, or null to show not-found. */
    async viewManagement(managementToken: string) {
      return shares.manageShare(managementToken);
    },

    /** GET /api/manage/:token — the share's status and details, for Recent shares. */
    async getManaged(_req: Request, managementToken: string) {
      const share = await shares.manageShare(managementToken);
      return share ? json(200, share) : json(404, { error: "No such share" });
    },

    /** DELETE /api/manage/:token — stops the share link at once. */
    async deleteManaged(_req: Request, managementToken: string) {
      const deleted = await shares.deleteShare(managementToken);
      return deleted ? new Response(null, { status: 204 }) : json(404, { error: "No such share" });
    },

    /**
     * GET /d/:token/files/:fileId — streams one shared file as an attachment,
     * or the single byte range asked for, so interrupted downloads resume.
     */
    async download(req: Request, token: string, fileId: string) {
      try {
        const file = await shares.openDownload(token, fileId);
        if (file === "unavailable") return html(410, UNAVAILABLE_PAGE);
        if (!file) return html(404, NOT_FOUND_PAGE);
        return await serveFile(req, file);
      } catch (err) {
        if (err instanceof ShareError && err.code === "tampered") return html(errorStatus.tampered, TAMPERED_PAGE);
        throw err;
      }
    },

    /**
     * GET /d/:token/all — streams the whole share as one zip, with an exact
     * length and byte ranges like a single file, so it resumes too.
     */
    async downloadAll(req: Request, token: string) {
      try {
        const archive = await shares.openArchive(token);
        if (archive === "unavailable") return html(410, UNAVAILABLE_PAGE);
        if (!archive) return html(404, NOT_FOUND_PAGE);
        return await serveFile(req, archive);
      } catch (err) {
        if (err instanceof ShareError && err.code === "tampered") return html(errorStatus.tampered, TAMPERED_PAGE);
        throw err;
      }
    },
  };
}

export type HttpHandlers = ReturnType<typeof createHttpHandlers>;

const accessStatus = { password: 401, network: 403 } as const;

const ACCESS_ERROR = {
  password: "Enter the upload password to upload. If you already did, your session has ended: reload the page.",
  network: "Uploads aren't allowed from your network.",
} as const;

async function serveFile(req: Request, file: Download) {
  const headers = {
    "Content-Type": file.contentType,
    "Content-Disposition": contentDisposition(file.name),
    "Accept-Ranges": "bytes",
    ETag: file.etag,
    ...SAFE_HEADERS,
  };
  // A resume that names an older version of the file gets the whole file instead.
  const ifRange = req.headers.get("If-Range");
  const range = ifRange === null || ifRange === file.etag ? parseRange(req.headers.get("Range"), file.size) : null;
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${file.size}` } });
  }
  const stream = Readable.toWeb(await file.read(range ?? undefined)) as ReadableStream;
  if (!range) {
    return new Response(stream, { status: 200, headers: { ...headers, "Content-Length": String(file.size) } });
  }
  return new Response(stream, {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${file.size}`,
    },
  });
}

/**
 * The byte range a `Range` header asks for (RFC 9110), clamped to the file,
 * or null to send the whole file. Multiple ranges and malformed headers are
 * ignored, as the RFC allows.
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  const first = match[1] === "" ? null : parseNonNegativeInt(match[1]);
  const last = match[2] === "" ? null : parseNonNegativeInt(match[2]);
  if (first === null) {
    // Suffix range: the last `last` bytes.
    if (last === null) return null;
    if (last === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (last !== null && last < first) return null;
  if (first >= size) return "unsatisfiable";
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

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

const TAMPERED_PAGE = page(
  "File unavailable",
  "This file can't be downloaded",
  "A stored copy has changed since it was shared, so FireShare won't serve it. Ask the sender to share it again.",
);

// Keep in step with ShareUnavailable in src/app/d/[token]/share-view.tsx.
const UNAVAILABLE_PAGE = page(
  "Link no longer available",
  "This link is no longer available",
  "It has expired or the sender deleted it, so its files can't be downloaded. Ask the sender for a new link.",
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
