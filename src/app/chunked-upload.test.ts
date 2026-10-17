import { randomBytes } from "node:crypto";
import type { HttpRequest, HttpResponse, HttpStack } from "tus-js-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccessConfig, loadExpiryConfig, loadUploadConfig } from "@/server/config";
import { createTestDb } from "@/server/db/test-db";
import { createHttpHandlers, type HttpHandlers } from "@/server/http";
import { createShareService } from "@/server/shares";
import { MIN_PART_SIZE } from "@/server/storage/adapter";
import { createMemoryStorage } from "@/server/storage/memory";
import { createUploadAccess } from "@/server/upload-access";
import { uploadFile } from "./chunked-upload";

const CHUNK = MIN_PART_SIZE;
const origin = "http://fireshare.test";

let http: HttpHandlers;

beforeEach(async () => {
  http = createHttpHandlers({
    shares: createShareService({ db: await createTestDb(), storage: createMemoryStorage() }),
    expiry: loadExpiryConfig({}),
    upload: loadUploadConfig({}),
    access: createUploadAccess(loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "abuse@example.com" })),
  });
});

interface Sent {
  method: string;
  offset: number;
}

/**
 * A tus HTTP stack that calls the server's handlers in-process. `interfere`
 * sees each PATCH body before it's sent and can corrupt it or drop the
 * connection.
 */
function inProcessStack(
  interfere?: (offset: number, body: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> | "drop",
) {
  const sent: Sent[] = [];
  const stack: HttpStack = {
    getName: () => "in-process",
    createRequest(method, url) {
      const headers: Record<string, string> = {};
      const request: HttpRequest = {
        getMethod: () => method,
        getURL: () => url,
        setHeader: (name, value) => void (headers[name] = value),
        getHeader: (name) => headers[name],
        setProgressHandler: () => {},
        abort: async () => {},
        getUnderlyingObject: () => null,
        async send(body?: Blob) {
          const id = url.split("/").pop()!;
          const offset = Number(headers["Upload-Offset"]);
          sent.push({ method, offset });
          let res: Response;
          if (method === "HEAD") {
            res = await http.headUpload(new Request(url, { method, headers }), id);
          } else {
            let bytes = new Uint8Array(await (body ?? new Blob()).arrayBuffer());
            const changed = interfere?.(offset, bytes);
            if (changed === "drop") throw new Error("Connection reset");
            if (changed) bytes = changed;
            res = await http.patchUpload(
              new Request(url, { method, headers: { ...headers, "Content-Length": String(bytes.length) }, body: bytes }),
              id,
            );
          }
          return response(res);
        },
      };
      return request;
    },
  };
  return { stack, sent };
}

function response(res: Response): HttpResponse {
  return {
    getStatus: () => res.status,
    getHeader: (name) => res.headers.get(name) ?? undefined,
    getBody: () => "",
    getUnderlyingObject: () => res,
  };
}

/** A pending one-file share for `data`; returns its id and upload URL. */
async function pendingShare(data: Uint8Array) {
  const res = await http.createShare(
    new Request(`${origin}/api/shares`, {
      method: "POST",
      body: JSON.stringify({ files: [{ name: "plate.exr", size: data.length }] }),
    }),
  );
  const { id, files } = await res.json();
  return { shareId: id as string, fileId: files[0].id as string, uploadUrl: `${origin}${files[0].uploadUrl}` };
}

/** Finalizes the share and downloads its file. */
async function finalizeAndDownload(shareId: string, fileId: string) {
  const finalized = await http.finalize(new Request(`${origin}/api/shares/${shareId}/finalize`), shareId);
  const { path } = await finalized.json();
  const token = path.split("/").pop();
  const res = await http.download(new Request(`${origin}${path}/files/${fileId}`), token, fileId);
  return Buffer.from(await res.arrayBuffer());
}

const patches = (sent: Sent[]) => sent.filter((req) => req.method === "PATCH").map((req) => req.offset);

describe("chunked upload", () => {
  const data = randomBytes(CHUNK * 2 + 1234);

  it("uploads a file chunk by chunk, each with its SHA-256", async () => {
    const { shareId, fileId, uploadUrl } = await pendingShare(data);
    const { stack, sent } = inProcessStack();
    let progress = 0;

    await uploadFile(new Blob([data]), uploadUrl, {
      chunkSize: CHUNK,
      httpStack: stack,
      onProgress: (bytes) => (progress = bytes),
    });

    expect(patches(sent)).toEqual([0, CHUNK, 2 * CHUNK]);
    expect(progress).toBe(data.length);
    expect((await finalizeAndDownload(shareId, fileId)).equals(data)).toBe(true);
  });

  it("sends a chunk corrupted in transit again and completes correctly", async () => {
    const { shareId, fileId, uploadUrl } = await pendingShare(data);
    let corrupted = false;
    const { stack, sent } = inProcessStack((offset, body) => {
      if (offset !== CHUNK || corrupted) return body;
      corrupted = true;
      const copy = body.slice();
      copy[42] ^= 0xff;
      return copy;
    });
    let retries = 0;

    await uploadFile(new Blob([data]), uploadUrl, {
      chunkSize: CHUNK,
      httpStack: stack,
      retryDelays: [0],
      onRetry: () => retries++,
    });

    expect(retries).toBe(1);
    expect(patches(sent)).toEqual([0, CHUNK, CHUNK, 2 * CHUNK]);
    expect((await finalizeAndDownload(shareId, fileId)).equals(data)).toBe(true);
  });

  it("resumes after being cut off without sending finished chunks again", async () => {
    const { shareId, fileId, uploadUrl } = await pendingShare(data);
    // The browser dies while sending the second chunk.
    const first = inProcessStack((offset, body) => (offset === CHUNK ? "drop" : body));
    await expect(
      uploadFile(new Blob([data]), uploadUrl, { chunkSize: CHUNK, httpStack: first.stack, retryDelays: [] }),
    ).rejects.toThrow();
    expect(patches(first.sent)).toEqual([0, CHUNK]);

    // Reopened: a new upload of the same file to the same URL.
    const second = inProcessStack();
    await uploadFile(new Blob([data]), uploadUrl, { chunkSize: CHUNK, httpStack: second.stack });

    expect(second.sent[0].method).toBe("HEAD");
    expect(patches(second.sent)).toEqual([CHUNK, 2 * CHUNK]);
    expect((await finalizeAndDownload(shareId, fileId)).equals(data)).toBe(true);
  });

  it("finishes at once when the server already has the whole file", async () => {
    const { uploadUrl } = await pendingShare(data);
    await uploadFile(new Blob([data]), uploadUrl, { chunkSize: CHUNK, httpStack: inProcessStack().stack });

    const again = inProcessStack();
    await uploadFile(new Blob([data]), uploadUrl, { chunkSize: CHUNK, httpStack: again.stack });
    expect(patches(again.sent)).toEqual([]);
  });

  it("gives up on an upload the server doesn't know", async () => {
    const { stack } = inProcessStack();
    await expect(
      uploadFile(new Blob([data]), `${origin}/api/uploads/${crypto.randomUUID()}`, { chunkSize: CHUNK, httpStack: stack }),
    ).rejects.toThrow();
  });
});

describe("direct chunked upload", () => {
  const data = randomBytes(CHUNK * 2 + 1234);
  let memStorage: ReturnType<typeof createMemoryStorage>;
  let directHttp: HttpHandlers;

  beforeEach(async () => {
    memStorage = createMemoryStorage();
    directHttp = createHttpHandlers({
      shares: createShareService({ db: await createTestDb(), storage: memStorage }),
      expiry: loadExpiryConfig({}),
      upload: loadUploadConfig({ UPLOAD_CHUNK_SIZE: "5MB" }),
      access: createUploadAccess(loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "abuse@example.com" })),
      transfer: { mode: "direct", directEndpoint: "https://storage.local:9000", appOrigin: null },
      ensureCors: (o) => memStorage.ensureCors(o),
    });
  });

  function directFetch(failPart?: (partNumber: number) => boolean): {
    fetchFn: typeof globalThis.fetch;
    putParts: number[];
  } {
    const putParts: number[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.origin === origin) {
        const id = parsed.pathname.split("/").pop()!;
        return directHttp.getUpload(new Request(url, init), id);
      }
      const partNumber = Number(parsed.searchParams.get("partNumber"));
      putParts.push(partNumber);
      if (failPart?.(partNumber)) {
        throw new Error("Connection reset");
      }
      const body = init?.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : undefined;
      return memStorage.fetch(new Request(url, { method: init?.method ?? "GET", body }));
    }) as typeof globalThis.fetch;
    return { fetchFn, putParts };
  }

  it("uploads parts directly to storage without browser hashing", async () => {
    const createRes = await directHttp.createShare(
      new Request(`${origin}/api/shares`, {
        method: "POST",
        body: JSON.stringify({ files: [{ name: "plate.exr", size: data.length }] }),
      }),
    );
    const { id: shareId, files } = await createRes.json();
    const file = files[0];
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest");
    const { fetchFn, putParts } = directFetch();
    let progress = 0;

    await uploadFile(new Blob([data]), `${origin}${file.uploadUrl}`, {
      chunkSize: CHUNK,
      direct: true,
      partUrls: file.partUrls,
      fetch: fetchFn,
      onProgress: (bytes) => (progress = bytes),
    });

    expect(digestSpy).not.toHaveBeenCalled();
    digestSpy.mockRestore();
    expect(putParts).toEqual([1, 2, 3]);
    expect(progress).toBe(data.length);

    const finRes = await directHttp.finalize(new Request(`${origin}/api/shares/${shareId}/finalize`), shareId);
    expect(finRes.status).toBe(200);
  });

  it("resumes an interrupted direct upload from the last completed part", async () => {
    const createRes = await directHttp.createShare(
      new Request(`${origin}/api/shares`, {
        method: "POST",
        body: JSON.stringify({ files: [{ name: "plate.exr", size: data.length }] }),
      }),
    );
    const { id: shareId, files } = await createRes.json();
    const file = files[0];
    const uploadUrl = `${origin}${file.uploadUrl}`;

    // First attempt fails on part 2.
    const first = directFetch((partNumber) => partNumber === 2);
    await expect(
      uploadFile(new Blob([data]), uploadUrl, {
        chunkSize: CHUNK,
        direct: true,
        partUrls: file.partUrls,
        fetch: first.fetchFn,
        retryDelays: [],
      }),
    ).rejects.toThrow();
    expect(first.putParts).toEqual([1, 2]);

    // Resume queries GET /api/uploads/:id and uploads only parts 2 and 3.
    const second = directFetch();
    await uploadFile(new Blob([data]), uploadUrl, {
      chunkSize: CHUNK,
      direct: true,
      fetch: second.fetchFn,
    });
    expect(second.putParts).toEqual([2, 3]);

    const finRes = await directHttp.finalize(new Request(`${origin}/api/shares/${shareId}/finalize`), shareId);
    expect(finRes.status).toBe(200);
  });
});
