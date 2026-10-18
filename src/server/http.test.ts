import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PEER_ADDRESS_HEADER, parseNetworks } from "./client-address";
import { loadAccessConfig, loadExpiryConfig, loadUploadConfig } from "./config";
import { createCleanup } from "./cleanup";
import type { Database } from "./db";
import { createTestDb } from "./db/test-db";
import { createHttpHandlers, MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH, parseRange, type HttpHandlers } from "./http";
import { createShareService } from "./shares";
import { createMemoryStorage } from "./storage/memory";
import { MIN_PART_SIZE, type StorageAdapter } from "./storage/adapter";
import { unzip } from "./test-unzip";
import { generateToken } from "./tokens";
import { createUploadAccess } from "./upload-access";

let http: HttpHandlers;
let storage: StorageAdapter;
let clock: Date;

beforeEach(async () => {
  clock = new Date("2026-01-01T00:00:00Z");
  storage = createMemoryStorage();
  const shares = createShareService({
    db: await createTestDb(),
    storage,
    now: () => clock,
  });
  http = createHttpHandlers({
    shares,
    expiry: loadExpiryConfig({ EXPIRY_OPTIONS: "12h,1d,7d", EXPIRY_DEFAULT: "1d" }),
    upload: loadUploadConfig({ UPLOAD_CHUNK_SIZE: "8MB", UPLOAD_PARALLEL_FILES: "2" }),
    access: createUploadAccess(loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "abuse@example.com" })),
  });
});

/** Moves the clock forward. */
const advanceHours = (hours: number) => {
  clock = new Date(clock.getTime() + hours * 3600_000);
};

const origin = "http://fireshare.test";

function createShare(files: unknown, fields: Record<string, unknown> = {}) {
  return http.createShare(
    new Request(`${origin}/api/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...fields, files }),
    }),
  );
}

/** The tus `Upload-Checksum` header value for `data`. */
const checksum = (data: string | Buffer) => `sha256 ${createHash("sha256").update(data).digest("base64")}`;

/**
 * Sends `data` as one tus chunk, with its correct checksum unless `headers`
 * says otherwise; a header set to undefined is left out.
 */
function patch(
  uploadId: string,
  offset: number,
  data: string | Buffer,
  headers: Record<string, string | undefined> = {},
) {
  const merged = {
    "Tus-Resumable": "1.0.0",
    "Content-Type": "application/offset+octet-stream",
    "Upload-Offset": String(offset),
    "Content-Length": String(Buffer.byteLength(data)),
    "Upload-Checksum": checksum(data),
    ...headers,
  };
  return http.patchUpload(
    new Request(`${origin}/api/uploads/${uploadId}`, {
      method: "PATCH",
      headers: Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
      body: typeof data === "string" ? data : new Uint8Array(data),
    }),
    uploadId,
  );
}

function head(uploadId: string) {
  return http.headUpload(
    new Request(`${origin}/api/uploads/${uploadId}`, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } }),
    uploadId,
  );
}

function finalize(shareId: string) {
  return http.finalize(new Request(`${origin}/api/shares/${shareId}/finalize`, { method: "POST" }), shareId);
}

/** Creates, uploads and finalizes a one-file share; returns the file's download path. */
async function share(name: string, data: string, fields: Record<string, unknown> = {}): Promise<string> {
  const created = await (await createShare([{ name, size: Buffer.byteLength(data) }], fields)).json();
  await patch(created.files[0].id, 0, data);
  const { path } = await (await finalize(created.id)).json();
  return `${path}/files/${created.files[0].id}`;
}

/** GET /d/:token/files/:fileId */
function download(path: string, headers: Record<string, string> = {}) {
  const [, token, fileId] = path.match(/^\/d\/([^/]+)\/files\/([^/]+)$/)!;
  return http.download(new Request(`${origin}${path}`, { headers }), token, fileId);
}

describe("HTTP API", () => {
  it("uploads a file over tus and serves it from the share link as a safe attachment", async () => {
    const created = await createShare([{ name: "notes.txt", size: 11, type: "text/plain" }]);
    expect(created.status).toBe(201);
    const { id, files } = await created.json();
    expect(files[0].uploadUrl).toBe(`/api/uploads/${files[0].id}`);

    const head = await http.headUpload(
      new Request(`${origin}${files[0].uploadUrl}`, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } }),
      files[0].id,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("Upload-Offset")).toBe("0");
    expect(head.headers.get("Upload-Length")).toBe("11");
    expect(head.headers.get("Cache-Control")).toBe("no-store");

    const patched = await patch(files[0].id, 0, "hello world");
    expect(patched.status).toBe(204);
    expect(patched.headers.get("Upload-Offset")).toBe("11");
    expect(patched.headers.get("Tus-Resumable")).toBe("1.0.0");

    const finalized = await finalize(id);
    expect(finalized.status).toBe(200);
    const { path, managementPath, expiresAt } = await finalized.json();
    expect(path).toMatch(/^\/d\/[A-Za-z0-9_-]{22}$/);
    expect(managementPath).toMatch(/^\/m\/[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBe("2026-01-02T00:00:00.000Z");

    const res = await download(`${path}/files/${files[0].id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`,
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Length")).toBe("11");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("downloads non-ASCII and quote-containing filenames under their real name", async () => {
    const res = await download(await share('résumé "final".pdf', "x"));
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
  });

  it("answers unknown and malformed downloads with the same not-found page", async () => {
    const unknown = await download(`/d/${generateToken()}/files/${crypto.randomUUID()}`);
    const malformed = await download("/d/<script>/files/<script>");
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(unknown.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const page = await unknown.text();
    expect(page).toContain("isn't available");
    expect(await malformed.text()).toBe(page);
  });

  describe("tus upload endpoint", () => {
    async function pendingUpload(size = 4) {
      const { files } = await (await createShare([{ name: "a.bin", size }])).json();
      return files[0].id as string;
    }

    it("advertises tus 1.0.0 with SHA-256 checksums on OPTIONS", async () => {
      const res = await http.optionsUpload();
      expect(res.status).toBe(204);
      expect(res.headers.get("Tus-Version")).toBe("1.0.0");
      expect(res.headers.get("Tus-Extension")).toBe("checksum");
      expect(res.headers.get("Tus-Checksum-Algorithm")).toBe("sha256");
    });

    it("rejects a chunk whose SHA-256 doesn't match with 460, keeping the offset", async () => {
      const id = await pendingUpload();
      const res = await patch(id, 0, "abcd", { "Upload-Checksum": checksum("abce") });
      expect(res.status).toBe(460);
      expect((await head(id)).headers.get("Upload-Offset")).toBe("0");
    });

    it.each([
      ["no checksum", undefined],
      ["an unsupported algorithm", `md5 ${createHash("md5").update("abcd").digest("base64")}`],
      ["a hex digest", `sha256 ${createHash("sha256").update("abcd").digest("hex")}`],
      ["a truncated digest", checksum("abcd").slice(0, -4)],
    ])("rejects a chunk with %s with 400", async (_case, value) => {
      const id = await pendingUpload();
      expect((await patch(id, 0, "abcd", { "Upload-Checksum": value })).status).toBe(400);
      expect((await head(id)).headers.get("Upload-Offset")).toBe("0");
    });

    it("completes a file after a corrupted chunk is sent again intact", async () => {
      const first = Buffer.alloc(MIN_PART_SIZE, 1);
      const second = Buffer.from("tail");
      const { id, files } = await (await createShare([{ name: "a.bin", size: first.length + second.length }])).json();
      const fileId = files[0].id;

      const corrupted = Buffer.from(first);
      corrupted[1000] ^= 0xff;
      expect((await patch(fileId, 0, corrupted, { "Upload-Checksum": checksum(first) })).status).toBe(460);
      expect((await patch(fileId, 0, first)).status).toBe(204);
      expect((await patch(fileId, first.length, second)).status).toBe(204);

      const { path } = await (await finalize(id)).json();
      const res = await download(`${path}/files/${fileId}`);
      expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.concat([first, second]))).toBe(true);
    });

    it("rejects requests without a supported Tus-Resumable header", async () => {
      const id = await pendingUpload();
      expect((await patch(id, 0, "abcd", { "Tus-Resumable": "0.2.0" })).status).toBe(412);
    });

    it("rejects chunks that aren't offset+octet-stream", async () => {
      const id = await pendingUpload();
      expect((await patch(id, 0, "abcd", { "Content-Type": "text/plain" })).status).toBe(415);
    });

    it("answers a chunk at the wrong offset with 409", async () => {
      const id = await pendingUpload();
      expect((await patch(id, 2, "cd")).status).toBe(409);
    });

    it("answers an oversized chunk with 413", async () => {
      const id = await pendingUpload(2);
      expect((await patch(id, 0, "abcd")).status).toBe(413);
    });

    it("answers unknown uploads with 404", async () => {
      const id = crypto.randomUUID();
      const head = await http.headUpload(
        new Request(`${origin}/api/uploads/${id}`, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } }),
        id,
      );
      expect(head.status).toBe(404);
      expect((await patch(id, 0, "abcd")).status).toBe(404);
    });
  });

  describe("share creation", () => {
    it.each([
      ["no files", []],
      ["a missing name", [{ size: 1 }]],
      ["a negative size", [{ name: "a", size: -1 }]],
      ["a fractional size", [{ name: "a", size: 1.5 }]],
      ["a non-array", { name: "a", size: 1 }],
    ])("rejects %s", async (_case, files) => {
      expect((await createShare(files)).status).toBe(400);
    });

    it("creates one share with an upload URL for each file, in order", async () => {
      const res = await createShare([
        { name: "b.txt", size: 1 },
        { name: "a.txt", size: 2 },
      ]);
      expect(res.status).toBe(201);
      const { id, files } = await res.json();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(files.map((f: { name: string }) => f.name)).toEqual(["b.txt", "a.txt"]);
      expect(new Set(files.map((f: { uploadUrl: string }) => f.uploadUrl)).size).toBe(2);
    });

    it("stores title and message trimmed, and blank ones as absent", async () => {
      const created = await (
        await createShare([{ name: "a.txt", size: 1 }], { title: "  Renders  ", message: "   " })
      ).json();
      await patch(created.files[0].id, 0, "a");
      const { path } = await (await finalize(created.id)).json();

      expect(await http.viewShare(path.replace("/d/", ""))).toMatchObject({
        title: "Renders",
        message: null,
      });
    });

    it.each([
      ["a title over the limit", { title: "x".repeat(MAX_TITLE_LENGTH + 1) }],
      ["a message over the limit", { message: "x".repeat(MAX_MESSAGE_LENGTH + 1) }],
      ["a non-text title", { title: 42 }],
      ["a non-text message", { message: ["hi"] }],
    ])("rejects %s with a reason", async (_case, fields) => {
      const res = await createShare([{ name: "a", size: 1 }], fields);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Title|Message/);
    });

    it("accepts a title and message exactly at the limit", async () => {
      const res = await createShare([{ name: "a", size: 1 }], {
        title: "x".repeat(MAX_TITLE_LENGTH),
        message: "x".repeat(MAX_MESSAGE_LENGTH),
      });
      expect(res.status).toBe(201);
    });

    it("rejects a body that isn't JSON", async () => {
      const res = await http.createShare(
        new Request(`${origin}/api/shares`, { method: "POST", body: "nope" }),
      );
      expect(res.status).toBe(400);
    });
  });

  it("answers finalizing a share with any file incomplete with 409", async () => {
    const { id, files } = await (
      await createShare([
        { name: "a.bin", size: 1 },
        { name: "b.bin", size: 4 },
      ])
    ).json();
    await patch(files[0].id, 0, "a");
    expect((await finalize(id)).status).toBe(409);
  });

  it("serves each file of a multi-file share from its own URL under its own name", async () => {
    const names = ["日本語 ファイル.txt", "../../etc/passwd", "with spaces & 'quotes'.txt"];
    const { id, files } = await (await createShare(names.map((name) => ({ name, size: 1 })))).json();
    for (const [i, file] of files.entries()) await patch(file.id, 0, String(i));
    const { path } = await (await finalize(id)).json();

    for (const [i, file] of files.entries()) {
      const res = await download(`${path}/files/${file.id}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(String(i));
      const disposition = res.headers.get("Content-Disposition")!;
      const encoded = disposition.match(/filename\*=UTF-8''(.+)$/)![1];
      expect(decodeURIComponent(encoded)).toBe(names[i]);
    }
  });

  it("refuses chunks for a file once its share is ready", async () => {
    const { id, files } = await (await createShare([{ name: "a.bin", size: 1 }])).json();
    await patch(files[0].id, 0, "a");
    await finalize(id);
    expect((await patch(files[0].id, 1, "")).status).toBe(404);
  });

  it("gives the upload form the configured chunk size and parallel file count", () => {
    expect(http.uploadOptions()).toMatchObject({ chunkSize: 8 * 1024 * 1024, parallelFiles: 2, direct: false });
  });

  describe("resumable downloads", () => {
    it("advertises byte ranges and answers a Range request with 206", async () => {
      const path = await share("a.txt", "0123456789");
      const full = await download(path);
      expect(full.headers.get("Accept-Ranges")).toBe("bytes");
      expect(full.headers.get("ETag")).toMatch(/^"[0-9a-f]{64}"$/);

      const res = await download(path, { Range: "bytes=2-5" });
      expect(res.status).toBe(206);
      expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
      expect(res.headers.get("Content-Length")).toBe("4");
      expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
      expect(await res.text()).toBe("2345");
    });

    it("resumes an interrupted download into a byte-identical file", async () => {
      const data = Buffer.alloc(MIN_PART_SIZE + 1000);
      for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 251;
      const created = await (await createShare([{ name: "big.bin", size: data.length }])).json();
      const fileId = created.files[0].id;
      await patch(fileId, 0, data.subarray(0, MIN_PART_SIZE));
      await patch(fileId, MIN_PART_SIZE, data.subarray(MIN_PART_SIZE));
      const { path } = await (await finalize(created.id)).json();
      const filePath = `${path}/files/${fileId}`;

      // The connection drops halfway through.
      const first = await download(filePath);
      const half = Buffer.from(await first.arrayBuffer()).subarray(0, Math.floor(data.length / 2));

      const rest = await download(filePath, { Range: `bytes=${half.length}-`, "If-Range": first.headers.get("ETag")! });
      expect(rest.status).toBe(206);
      expect(rest.headers.get("Content-Range")).toBe(`bytes ${half.length}-${data.length - 1}/${data.length}`);
      const resumed = Buffer.concat([half, Buffer.from(await rest.arrayBuffer())]);
      expect(resumed.equals(data)).toBe(true);
    });

    it("sends the whole file when If-Range names another version", async () => {
      const path = await share("a.txt", "0123456789");
      const res = await download(path, { Range: "bytes=5-", "If-Range": '"something-else"' });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Range")).toBeNull();
      expect(await res.text()).toBe("0123456789");
    });

    it("answers a range past the end with 416 and the file size", async () => {
      const path = await share("a.txt", "0123456789");
      const res = await download(path, { Range: "bytes=10-" });
      expect(res.status).toBe(416);
      expect(res.headers.get("Content-Range")).toBe("bytes */10");
      expect(await res.text()).toBe("");
    });

    it("streams from storage instead of buffering the file", async () => {
      const path = await share("a.txt", "x");
      let pulled = 0;
      storage.getReadStream = async () =>
        Readable.from(
          (function* () {
            for (let i = 0; i < 10_000; i++, pulled++) yield Buffer.alloc(64 * 1024);
          })(),
        );

      const res = await download(path);
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      expect(pulled).toBeLessThan(100);
    });

    it("refuses with a clear page, and logs, when the stored file no longer matches its fingerprint", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const path = await share("a.txt", "0123456789");
      const head = storage.head;
      storage.head = async (key) => {
        const info = await head(key);
        return info && { ...info, etag: '"changed"' };
      };

      for (const headers of [{}, { Range: "bytes=5-" }] as Record<string, string>[]) {
        const res = await download(path, headers);
        expect(res.status).toBe(409);
        expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
        expect(res.headers.get("Content-Disposition")).toBeNull();
        expect(await res.text()).toContain("This file can't be downloaded");
      }
      expect(errors).toHaveBeenCalledTimes(2);
      errors.mockRestore();
    });
  });

  describe("download all", () => {
    /** Creates, uploads and finalizes a share; returns its link path. */
    async function shareAll(files: Record<string, string | Buffer>, fields: Record<string, unknown> = {}) {
      const names = Object.keys(files);
      const created = await (
        await createShare(names.map((name) => ({ name, size: Buffer.byteLength(files[name]) })), fields)
      ).json();
      for (const [i, name] of names.entries()) {
        const data = Buffer.from(files[name]);
        for (let offset = 0; offset < data.length; offset += MIN_PART_SIZE) {
          await patch(created.files[i].id, offset, data.subarray(offset, offset + MIN_PART_SIZE));
        }
        if (data.length === 0) await patch(created.files[i].id, 0, "");
      }
      const { path } = await (await finalize(created.id)).json();
      return path as string;
    }

    function downloadAll(path: string, headers: Record<string, string> = {}) {
      const token = path.slice("/d/".length);
      return http.downloadAll(new Request(`${origin}${path}/all`, { headers }), token);
    }

    it("streams the whole share as a zip with an exact length, as a safe attachment", async () => {
      const path = await shareAll({ "a.txt": "hello", "日本語.txt": "world" }, { title: "Shot 12" });
      const res = await downloadAll(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/zip");
      expect(res.headers.get("Content-Disposition")).toBe(
        `attachment; filename="Shot 12.zip"; filename*=UTF-8''Shot%2012.zip`,
      );
      expect(res.headers.get("Accept-Ranges")).toBe("bytes");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const data = Buffer.from(await res.arrayBuffer());
      expect(res.headers.get("Content-Length")).toBe(String(data.length));
      const entries = await unzip(data);
      expect(entries.map((entry) => entry.name)).toEqual(["a.txt", "日本語.txt"]);
      expect((await entries[1].data()).toString()).toBe("world");
    });

    it("resumes an interrupted zip download into a byte-identical archive", async () => {
      const big = Buffer.alloc(MIN_PART_SIZE + 1000);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
      const path = await shareAll({ "big.bin": big, "small.txt": "after" });

      const first = await downloadAll(path);
      const whole = Buffer.from(await first.arrayBuffer());
      const half = whole.subarray(0, Math.floor(whole.length / 2));
      const rest = await downloadAll(path, { Range: `bytes=${half.length}-`, "If-Range": first.headers.get("ETag")! });
      expect(rest.status).toBe(206);
      expect(rest.headers.get("Content-Range")).toBe(`bytes ${half.length}-${whole.length - 1}/${whole.length}`);
      const resumed = Buffer.concat([half, Buffer.from(await rest.arrayBuffer())]);
      expect(resumed.equals(whole)).toBe(true);
      expect((await (await unzip(resumed))[0].data()).equals(big)).toBe(true);
    });

    it("streams from storage instead of assembling the zip", async () => {
      const path = await shareAll({ "a.txt": "x", "b.txt": "y" });
      let pulled = 0;
      storage.getReadStream = async () =>
        Readable.from(
          (function* () {
            for (let i = 0; i < 10_000; i++, pulled++) yield Buffer.alloc(64 * 1024);
          })(),
        );

      const res = await downloadAll(path);
      const reader = res.body!.getReader();
      for (let i = 0; i < 3; i++) await reader.read();
      await reader.cancel();
      expect(pulled).toBeLessThan(100);
    });

    it("refuses with a clear page when any stored file no longer matches its fingerprint", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const path = await shareAll({ "a.txt": "hello", "b.txt": "world" });
      const head = storage.head;
      let calls = 0;
      storage.head = async (key) => {
        const info = await head(key);
        return info && (++calls === 2 ? { ...info, etag: '"changed"' } : info);
      };

      const res = await downloadAll(path);
      expect(res.status).toBe(409);
      expect(res.headers.get("Content-Disposition")).toBeNull();
      expect(await res.text()).toContain("can't be downloaded");
      expect(errors).toHaveBeenCalledOnce();
      errors.mockRestore();
    });

    it("answers expired and unknown links like single-file downloads do", async () => {
      const path = await shareAll({ "a.txt": "a" });
      expect((await http.downloadAll(new Request(`${origin}/d/x/all`), generateToken())).status).toBe(404);
      advanceHours(24);
      expect((await downloadAll(path)).status).toBe(410);
    });
  });

  describe("expiry", () => {
    it("offers the configured presets with the default preselected", () => {
      expect(http.uploadOptions()).toMatchObject({ expiryOptions: ["12h", "1d", "7d"], expiryDefault: "1d" });
    });

    it.each([["2d"], ["24h"], [7], [""], [null]])("rejects the expiry %j with a reason", async (expiry) => {
      const res = await createShare([{ name: "a", size: 1 }], { expiry });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Expiry must be one of 12h, 1d, 7d");
    });

    it("keeps the link working for the chosen preset", async () => {
      const path = await share("a.txt", "a", { expiry: "12h" });
      advanceHours(11);
      expect((await download(path)).status).toBe(200);
      advanceHours(1);
      expect((await download(path)).status).toBe(410);
    });

    it("uses the default preset when none is given", async () => {
      const path = await share("a.txt", "a");
      advanceHours(23);
      expect((await download(path)).status).toBe(200);
      advanceHours(1);
      expect((await download(path)).status).toBe(410);
    });

    it("refuses downloads and resumes of an expired share with an expired page", async () => {
      const path = await share("a.txt", "abc", { expiry: "12h" });
      advanceHours(12);

      for (const headers of [{}, { Range: "bytes=1-" }] as Record<string, string>[]) {
        const res = await download(path, headers);
        expect(res.status).toBe(410);
        expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
        expect(res.headers.get("Content-Disposition")).toBeNull();
        expect(res.headers.get("Cache-Control")).toBe("private, no-store");
        expect(await res.text()).toContain("This link is no longer available");
      }
      expect(await http.viewShare(path.split("/")[2])).toBe("unavailable");
    });
  });
});

describe("management link", () => {
  /** Creates, uploads and finalizes a one-file share; returns its file's download path and management token. */
  async function managedShare(data: string) {
    const created = await (await createShare([{ name: "a.txt", size: Buffer.byteLength(data) }], { title: "Shot 12" })).json();
    await patch(created.files[0].id, 0, data);
    const { path, managementPath } = await (await finalize(created.id)).json();
    return { filePath: `${path}/files/${created.files[0].id}`, managementToken: managementPath.slice("/m/".length) };
  }

  const getManaged = (token: string) => http.getManaged(new Request(`${origin}/api/manage/${token}`), token);
  const deleteManaged = (token: string) =>
    http.deleteManaged(new Request(`${origin}/api/manage/${token}`, { method: "DELETE" }), token);

  it("reports the share's status and details without caching", async () => {
    const { managementToken } = await managedShare("abc");
    const res = await getManaged(managementToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      status: "active",
      title: "Shot 12",
      expiresAt: "2026-01-02T00:00:00.000Z",
      deletedAt: null,
      files: [{ name: "a.txt", size: 3 }],
    });
  });

  it("stops downloads, including resumes, as soon as the share is deleted", async () => {
    const { filePath, managementToken } = await managedShare("0123456789");
    const first = await download(filePath);
    expect(first.status).toBe(200);

    expect((await deleteManaged(managementToken)).status).toBe(204);

    const resume = { Range: "bytes=5-", "If-Range": first.headers.get("ETag")! };
    for (const headers of [{}, resume] as Record<string, string>[]) {
      const res = await download(filePath, headers);
      expect(res.status).toBe(410);
      expect(res.headers.get("Content-Disposition")).toBeNull();
      expect(await res.text()).toContain("This link is no longer available");
    }
    expect((await http.downloadAll(new Request(`${origin}/d/x/all`), filePath.split("/")[2])).status).toBe(410);
    expect(await (await getManaged(managementToken)).json()).toMatchObject({ status: "deleted" });
  });

  it("answers deleting again with success", async () => {
    const { managementToken } = await managedShare("a");
    await deleteManaged(managementToken);
    expect((await deleteManaged(managementToken)).status).toBe(204);
  });

  it("answers unknown management tokens, and share tokens, with 404", async () => {
    const { filePath } = await managedShare("a");
    for (const token of [generateToken(), filePath.split("/")[2], "<script>"]) {
      expect((await getManaged(token)).status).toBe(404);
      expect((await deleteManaged(token)).status).toBe(404);
    }
    expect((await download(filePath)).status).toBe(200);
  });
});

describe("Range header parsing", () => {
  it.each([
    ["bytes=0-4", 10, { start: 0, end: 4 }],
    ["bytes=4-", 10, { start: 4, end: 9 }],
    ["bytes=4-100", 10, { start: 4, end: 9 }],
    ["bytes=-3", 10, { start: 7, end: 9 }],
    ["bytes=-100", 10, { start: 0, end: 9 }],
    ["bytes=10-", 10, "unsatisfiable"],
    ["bytes=-0", 10, "unsatisfiable"],
    ["bytes=0-", 0, "unsatisfiable"],
    ["bytes=-1", 0, "unsatisfiable"],
    [null, 10, null],
    ["bytes=5-2", 10, null],
    ["bytes=0-1,4-5", 10, null],
    ["bytes=-", 10, null],
    ["items=0-1", 10, null],
    ["bytes=99999999999999999999-", 10, null],
  ] as const)("%s of %i bytes → %o", (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});

describe("direct transfer mode", () => {
  let memStorage: ReturnType<typeof createMemoryStorage>;
  let directHttp: HttpHandlers;
  let db: Database;

  beforeEach(async () => {
    clock = new Date("2026-01-01T00:00:00Z");
    memStorage = createMemoryStorage({ now: () => clock });
    db = await createTestDb();
    const shares = createShareService({
      db,
      storage: memStorage,
      now: () => clock,
    });
    directHttp = createHttpHandlers({
      shares,
      expiry: loadExpiryConfig({ EXPIRY_OPTIONS: "12h,1d,7d", EXPIRY_DEFAULT: "1d" }),
      upload: loadUploadConfig({ UPLOAD_CHUNK_SIZE: "5MB", UPLOAD_PARALLEL_FILES: "2" }),
      access: createUploadAccess(loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "abuse@example.com" })),
      transfer: { mode: "direct", directEndpoint: "https://storage.local:9000", appOrigin: null, directNetworks: null },
      ensureCors: (o) => memStorage.ensureCors(o),
    });
  });

  it("uploads directly to storage via presigned part URLs, resumes, and redirects single-file downloads", async () => {
    const size = MIN_PART_SIZE + 4;
    const createRes = await directHttp.createShare(
      new Request(`${origin}/api/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Direct share",
          files: [
            { name: "clip.mov", size, type: "video/quicktime" },
            { name: "empty.txt", size: 0, type: "text/plain" },
          ],
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    expect(memStorage.corsOrigins()).toEqual([origin]);

    const created = await createRes.json();
    expect(created.files[0].partUrls).toHaveLength(2);
    expect(created.files[1].partUrls).toEqual([]);

    // Proxied PATCH is refused in direct mode.
    const patchRes = await directHttp.patchUpload(
      new Request(`${origin}/api/uploads/${created.files[0].id}`, {
        method: "PATCH",
        headers: { "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream" },
      }),
      created.files[0].id,
    );
    expect(patchRes.status).toBe(405);

    // Upload part 1 directly to storage.
    const part1 = Buffer.alloc(MIN_PART_SIZE, 0x42);
    expect(
      (await memStorage.fetch(new Request(created.files[0].partUrls[0], { method: "PUT", body: part1 }))).status,
    ).toBe(200);

    // Resume via GET /api/uploads/:id returns offset and only the remaining part URL.
    const resumeRes = await directHttp.getUpload(
      new Request(`${origin}/api/uploads/${created.files[0].id}`),
      created.files[0].id,
    );
    expect(resumeRes.status).toBe(200);
    const resumed = await resumeRes.json();
    expect(resumed.offset).toBe(MIN_PART_SIZE);
    expect(resumed.partUrls).toHaveLength(1);

    // Upload part 2 and finalize.
    const part2 = Buffer.from("tail");
    expect(
      (await memStorage.fetch(new Request(resumed.partUrls[0], { method: "PUT", body: part2 }))).status,
    ).toBe(200);

    const finRes = await directHttp.finalize(
      new Request(`${origin}/api/shares/${created.id}/finalize`, { method: "POST" }),
      created.id,
    );
    expect(finRes.status).toBe(200);
    const { path } = await finRes.json();
    const token = path.slice("/d/".length);

    // Single-file download redirects (302) to a short-lived presigned GET URL with Content-Disposition.
    const dlRes = await directHttp.download(
      new Request(`${origin}${path}/files/${created.files[0].id}`),
      token,
      created.files[0].id,
    );
    expect(dlRes.status).toBe(302);
    expect(dlRes.headers.get("Cache-Control")).toBe("private, no-store");
    const location = dlRes.headers.get("Location")!;
    expect(location).toBeTruthy();

    const storageGet = await memStorage.fetch(new Request(location));
    expect(storageGet.status).toBe(200);
    expect(storageGet.headers.get("Content-Disposition")).toContain("clip.mov");
    expect(Buffer.from(await storageGet.arrayBuffer()).equals(Buffer.concat([part1, part2]))).toBe(true);

    // Until the cleanup worker has the CRC32s, Download all streams a store-only ZIP without Range or Content-Length.
    const zipRes = await directHttp.downloadAll(new Request(`${origin}${path}/all`), token);
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("Accept-Ranges")).toBe("none");
    expect(zipRes.headers.get("Content-Length")).toBeNull();
    expect(zipRes.headers.get("ETag")).toBeNull();
    const streamed = Buffer.from(await zipRes.arrayBuffer());
    const entries = await unzip(streamed);
    expect(entries.map((e) => [e.name, e.size])).toEqual([
      ["clip.mov", size],
      ["empty.txt", 0],
    ]);

    // Once it has, Download all has an exact size and resumes like any download.
    const config = { deleteGraceSeconds: 3600, pendingTtlSeconds: 86400 };
    await createCleanup({ db, storage: memStorage, config, now: () => clock }).run();
    const fullRes = await directHttp.downloadAll(new Request(`${origin}${path}/all`), token);
    expect(fullRes.headers.get("Accept-Ranges")).toBe("bytes");
    const full = Buffer.from(await fullRes.arrayBuffer());
    expect(Number(fullRes.headers.get("Content-Length"))).toBe(full.length);
    const rest = await directHttp.downloadAll(
      new Request(`${origin}${path}/all`, {
        headers: { Range: "bytes=1000-", "If-Range": fullRes.headers.get("ETag")! },
      }),
      token,
    );
    expect(rest.status).toBe(206);
    expect(Buffer.from(await rest.arrayBuffer()).equals(full.subarray(1000))).toBe(true);
    expect((await unzip(full)).map((e) => e.crc32)).toEqual(entries.map((e) => e.crc32));
  });
});

describe("auto transfer mode", () => {
  const LAN = "192.168.1.20";
  const INTERNET = "203.0.113.5";
  const PROXY = "172.16.0.2";
  let memStorage: ReturnType<typeof createMemoryStorage>;
  let autoHttp: HttpHandlers;

  beforeEach(async () => {
    clock = new Date("2026-01-01T00:00:00Z");
    memStorage = createMemoryStorage({ now: () => clock });
    autoHttp = createHttpHandlers({
      shares: createShareService({ db: await createTestDb(), storage: memStorage, now: () => clock }),
      expiry: loadExpiryConfig({ EXPIRY_OPTIONS: "12h,1d,7d", EXPIRY_DEFAULT: "1d" }),
      upload: loadUploadConfig({ UPLOAD_CHUNK_SIZE: "5MB", UPLOAD_PARALLEL_FILES: "2" }),
      access: createUploadAccess(
        loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "abuse@example.com", TRUSTED_PROXIES: `${PROXY}/32` }),
      ),
      transfer: {
        mode: "auto",
        directEndpoint: "https://storage.local:9000",
        appOrigin: null,
        directNetworks: parseNetworks("192.168.1.0/24,10.8.0.0/16", "DIRECT_NETWORKS"),
      },
      ensureCors: (o) => memStorage.ensureCors(o),
    });
  });

  /** Headers of a request whose socket comes from `peer`. */
  const from = (peer: string, headers: Record<string, string> = {}) => ({ [PEER_ADDRESS_HEADER]: peer, ...headers });

  async function createFrom(headers: Record<string, string>, data: Buffer) {
    const res = await autoHttp.createShare(
      new Request(`${origin}/api/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ files: [{ name: "plate.exr", size: data.length }] }),
      }),
    );
    expect(res.status).toBe(201);
    return res.json();
  }

  /** Uploads `data` as one tus chunk through the app. */
  async function patchFrom(headers: Record<string, string>, fileId: string, data: Buffer) {
    return autoHttp.patchUpload(
      new Request(`${origin}/api/uploads/${fileId}`, {
        method: "PATCH",
        headers: {
          ...headers,
          "Tus-Resumable": "1.0.0",
          "Content-Type": "application/offset+octet-stream",
          "Upload-Offset": "0",
          "Content-Length": String(data.length),
          "Upload-Checksum": checksum(data),
        },
        body: new Uint8Array(data),
      }),
      fileId,
    );
  }

  async function finalizeShare(shareId: string) {
    const res = await autoHttp.finalize(new Request(`${origin}/api/shares/${shareId}/finalize`, { method: "POST" }), shareId);
    expect(res.status).toBe(200);
    const { path } = await res.json();
    return path.slice("/d/".length) as string;
  }

  function downloadFrom(headers: Record<string, string>, token: string, fileId: string) {
    return autoHttp.download(new Request(`${origin}/d/${token}/files/${fileId}`, { headers }), token, fileId);
  }

  /** The file's bytes as the client gets them: streamed by the app, or from storage after a redirect. */
  async function fetchFile(res: Response): Promise<Buffer> {
    const body = res.status === 302 ? await memStorage.fetch(new Request(res.headers.get("Location")!)) : res;
    expect(body.status).toBe(200);
    return Buffer.from(await body.arrayBuffer());
  }

  it("tells the upload form which clients upload straight to storage", () => {
    expect(autoHttp.uploadOptions(new Headers(from(LAN))).direct).toBe(true);
    expect(autoHttp.uploadOptions(new Headers(from(INTERNET))).direct).toBe(false);
    expect(autoHttp.uploadOptions(new Headers(from(PROXY, { "X-Forwarded-For": LAN }))).direct).toBe(true);
  });

  it("uploads a LAN client's file directly, and serves it through the app to the internet", async () => {
    const data = Buffer.alloc(MIN_PART_SIZE + 4, 0x42);
    const created = await createFrom(from(LAN), data);
    const file = created.files[0];
    expect(file.partUrls).toHaveLength(2);
    expect(memStorage.corsOrigins()).toEqual([origin]);
    for (const [i, url] of (file.partUrls as string[]).entries()) {
      const part = data.subarray(i * MIN_PART_SIZE, (i + 1) * MIN_PART_SIZE);
      expect((await memStorage.fetch(new Request(url, { method: "PUT", body: part }))).status).toBe(200);
    }
    const token = await finalizeShare(created.id);

    const outside = await downloadFrom(from(INTERNET), token, file.id);
    expect(outside.status).toBe(200);
    expect((await fetchFile(outside)).equals(data)).toBe(true);

    const inside = await downloadFrom(from(LAN), token, file.id);
    expect(inside.status).toBe(302);
    expect((await fetchFile(inside)).equals(data)).toBe(true);
  });

  it("uploads an internet client's file through the app, and redirects LAN clients to storage for it", async () => {
    const data = Buffer.from("proxied bytes");
    const created = await createFrom(from(INTERNET), data);
    const file = created.files[0];
    expect(file.partUrls).toBeUndefined();
    expect(memStorage.corsOrigins()).toEqual([]);
    expect((await patchFrom(from(INTERNET), file.id, data)).status).toBe(204);
    const token = await finalizeShare(created.id);

    const inside = await downloadFrom(from("10.8.3.4"), token, file.id);
    expect(inside.status).toBe(302);
    expect((await fetchFile(inside)).equals(data)).toBe(true);
    const outside = await downloadFrom(from(INTERNET), token, file.id);
    expect(outside.status).toBe(200);
    expect((await fetchFile(outside)).equals(data)).toBe(true);
  });

  it("decides uploads by the trusted client IP, so a forged X-Forwarded-For can't select direct mode", async () => {
    const data = Buffer.from("x");
    const forged = await createFrom(from(INTERNET, { "X-Forwarded-For": LAN }), data);
    expect(forged.files[0].partUrls).toBeUndefined();
    // Through the trusted proxy, the address it saw counts, not what the client claimed before it.
    const viaProxy = await createFrom(from(PROXY, { "X-Forwarded-For": LAN }), data);
    expect(viaProxy.files[0].partUrls).toHaveLength(1);
    const forgedViaProxy = await createFrom(from(PROXY, { "X-Forwarded-For": `${LAN}, ${INTERNET}` }), data);
    expect(forgedViaProxy.files[0].partUrls).toBeUndefined();
  });

  it("decides downloads by the trusted client IP", async () => {
    const data = Buffer.from("proxied bytes");
    const created = await createFrom(from(INTERNET), data);
    const fileId = created.files[0].id;
    await patchFrom(from(INTERNET), fileId, data);
    const token = await finalizeShare(created.id);

    expect((await downloadFrom(from(INTERNET, { "X-Forwarded-For": LAN }), token, fileId)).status).toBe(200);
    expect((await downloadFrom(from(PROXY, { "X-Forwarded-For": `${LAN}, ${INTERNET}` }), token, fileId)).status).toBe(200);
    expect((await downloadFrom(from(PROXY, { "X-Forwarded-For": LAN }), token, fileId)).status).toBe(302);
  });

  it("resumes a direct upload only from a direct network", async () => {
    const data = Buffer.alloc(MIN_PART_SIZE + 4, 0x42);
    const created = await createFrom(from(LAN), data);
    const fileId = created.files[0].id;
    const status = (peer: string) =>
      autoHttp.getUpload(new Request(`${origin}/api/uploads/${fileId}`, { headers: from(peer) }), fileId);

    const inside = await status(LAN);
    expect(inside.status).toBe(200);
    expect((await inside.json()).partUrls).toHaveLength(2);

    const outside = await status(INTERNET);
    expect(outside.status).toBe(403);
    expect((await outside.json()).error).toMatch(/only works from the network it began on/);
  });

  it("resumes an upload begun through the app from any network", async () => {
    const data = Buffer.from("proxied bytes");
    const created = await createFrom(from(INTERNET), data);
    expect((await patchFrom(from(LAN), created.files[0].id, data)).status).toBe(204);
    await finalizeShare(created.id);
  });
});
