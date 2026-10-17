import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadExpiryConfig, loadUploadConfig } from "./config";
import { createTestDb } from "./db/test-db";
import { createHttpHandlers, MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH, parseRange, type HttpHandlers } from "./http";
import { createShareService } from "./shares";
import { createMemoryStorage } from "./storage/memory";
import { MIN_PART_SIZE, type StorageAdapter } from "./storage/adapter";
import { generateToken } from "./tokens";

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
    const { path } = await finalized.json();
    expect(path).toMatch(/^\/d\/[A-Za-z0-9_-]{22}$/);

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

    it("answers an oversized chunk with 400", async () => {
      const id = await pendingUpload(2);
      expect((await patch(id, 0, "abcd")).status).toBe(400);
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
    expect(http.uploadOptions()).toMatchObject({ chunkSize: 8 * 1024 * 1024, parallelFiles: 2 });
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
        expect(await res.text()).toContain("This link has expired");
      }
      expect(await http.viewShare(path.split("/")[2])).toBe("expired");
    });
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
