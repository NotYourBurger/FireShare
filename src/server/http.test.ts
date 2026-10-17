import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./db/test-db";
import { createHttpHandlers, MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH, type HttpHandlers } from "./http";
import { createShareService } from "./shares";
import { createMemoryStorage } from "./storage/memory";
import { generateToken } from "./tokens";

let http: HttpHandlers;

beforeEach(async () => {
  const shares = createShareService({ db: await createTestDb(), storage: createMemoryStorage() });
  http = createHttpHandlers({ shares });
});

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

function patch(uploadId: string, offset: number, data: string, headers: Record<string, string> = {}) {
  return http.patchUpload(
    new Request(`${origin}/api/uploads/${uploadId}`, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Content-Type": "application/offset+octet-stream",
        "Upload-Offset": String(offset),
        "Content-Length": String(Buffer.byteLength(data)),
        ...headers,
      },
      body: data,
    }),
    uploadId,
  );
}

function finalize(shareId: string) {
  return http.finalize(new Request(`${origin}/api/shares/${shareId}/finalize`, { method: "POST" }), shareId);
}

/** Creates, uploads and finalizes a one-file share; returns the file's download path. */
async function share(name: string, data: string): Promise<string> {
  const created = await (await createShare([{ name, size: Buffer.byteLength(data) }])).json();
  await patch(created.files[0].id, 0, data);
  const { path } = await (await finalize(created.id)).json();
  return `${path}/files/${created.files[0].id}`;
}

/** GET /d/:token/files/:fileId */
function download(path: string) {
  const [, token, fileId] = path.match(/^\/d\/([^/]+)\/files\/([^/]+)$/)!;
  return http.download(new Request(`${origin}${path}`), token, fileId);
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

    it("advertises tus 1.0.0 on OPTIONS", async () => {
      const res = await http.optionsUpload();
      expect(res.status).toBe(204);
      expect(res.headers.get("Tus-Version")).toBe("1.0.0");
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
});
