import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { PEER_ADDRESS_HEADER } from "./client-address";
import { loadAccessConfig, loadExpiryConfig, loadUploadConfig } from "./config";
import { createTestDb } from "./db/test-db";
import { createHttpHandlers, type HttpHandlers } from "./http";
import { createShareService } from "./shares";
import { createMemoryStorage } from "./storage/memory";
import { createUploadAccess, PASSWORD_ATTEMPTS } from "./upload-access";

const origin = "http://fireshare.test";
const PASSWORD = "correct horse battery staple";

let clock: Date;

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
});

const advanceMinutes = (minutes: number) => {
  clock = new Date(clock.getTime() + minutes * 60_000);
};

async function app(env: Record<string, string>) {
  return createHttpHandlers({
    shares: createShareService({ db: await createTestDb(), storage: createMemoryStorage(), now: () => clock }),
    expiry: loadExpiryConfig({}),
    upload: loadUploadConfig({}),
    access: createUploadAccess(loadAccessConfig(env), () => clock),
  });
}

/** Headers as a request from `peer` arrives at the handlers. */
function from(peer: string, headers: Record<string, string> = {}) {
  return { [PEER_ADDRESS_HEADER]: peer, ...headers };
}

function login(http: HttpHandlers, password: string, headers = from("192.0.2.1"), url = `${origin}/api/upload-session`) {
  return http.createUploadSession(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ password }),
    }),
  );
}

/** The `Cookie` header a browser sends back after `login`. */
async function session(http: HttpHandlers, headers = from("192.0.2.1")) {
  const res = await login(http, PASSWORD, headers);
  expect(res.status).toBe(204);
  return res.headers.get("Set-Cookie")!.split(";")[0];
}

function createShare(http: HttpHandlers, headers: Record<string, string>, size = 5) {
  return http.createShare(
    new Request(`${origin}/api/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ files: [{ name: "a.txt", size }] }),
    }),
  );
}

function patch(http: HttpHandlers, uploadId: string, data: string, headers: Record<string, string>) {
  return http.patchUpload(
    new Request(`${origin}/api/uploads/${uploadId}`, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Content-Type": "application/offset+octet-stream",
        "Upload-Offset": "0",
        "Content-Length": String(data.length),
        "Upload-Checksum": `sha256 ${createHash("sha256").update(data).digest("base64")}`,
        ...headers,
      },
      body: data,
    }),
    uploadId,
  );
}

function head(http: HttpHandlers, uploadId: string, headers: Record<string, string>) {
  return http.headUpload(
    new Request(`${origin}/api/uploads/${uploadId}`, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0", ...headers } }),
    uploadId,
  );
}

function finalize(http: HttpHandlers, shareId: string, headers: Record<string, string>) {
  return http.finalize(new Request(`${origin}/api/shares/${shareId}/finalize`, { method: "POST", headers }), shareId);
}

/** Uploads one file with `headers` and returns its download path. */
async function upload(http: HttpHandlers, headers: Record<string, string>) {
  const { id, files } = await (await createShare(http, headers)).json();
  expect((await patch(http, files[0].id, "hello", headers)).status).toBe(204);
  const { path } = await (await finalize(http, id, headers)).json();
  return { token: path.slice("/d/".length), fileId: files[0].id as string };
}

describe("upload password", () => {
  it("refuses every upload step without a session, with a JSON or tus 401", async () => {
    const http = await app({ UPLOAD_PASSWORD: PASSWORD });
    const anonymous = from("192.0.2.1");
    const created = await createShare(http, anonymous);
    expect(created.status).toBe(401);
    expect((await created.json()).error).toMatch(/upload password/);

    // A share created with a session can't be continued without one.
    const cookie = await session(http);
    const { id, files } = await (await createShare(http, from("192.0.2.1", { Cookie: cookie }))).json();
    const patched = await patch(http, files[0].id, "hello", anonymous);
    expect(patched.status).toBe(401);
    expect(patched.headers.get("Tus-Resumable")).toBe("1.0.0");
    expect((await head(http, files[0].id, anonymous)).status).toBe(401);
    expect((await finalize(http, id, anonymous)).status).toBe(401);
    expect(http.uploadAccess(new Headers(anonymous))).toBe("password");
  });

  it("gives a long-lived HTTP-only session cookie for the right password, which uploads", async () => {
    const http = await app({ UPLOAD_PASSWORD: PASSWORD });
    const res = await login(http, PASSWORD);
    expect(res.status).toBe(204);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^fireshare_upload=\d+\.[\w-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);

    const headers = from("192.0.2.1", { Cookie: `theme=dark; ${cookie.split(";")[0]}` });
    expect(http.uploadAccess(new Headers(headers))).toBe("allowed");
    const { token, fileId } = await upload(http, headers);
    expect((await http.download(new Request(`${origin}/d/${token}/files/${fileId}`), token, fileId)).status).toBe(200);
  });

  it("marks the cookie Secure over HTTPS", async () => {
    const http = await app({ UPLOAD_PASSWORD: PASSWORD });
    const res = await login(http, PASSWORD, from("192.0.2.1"), "https://fireshare.test/api/upload-session");
    expect(res.headers.get("Set-Cookie")).toMatch(/; Secure$/);
  });

  it("never asks recipients for the password", async () => {
    const http = await app({ UPLOAD_PASSWORD: PASSWORD });
    const { token, fileId } = await upload(http, from("192.0.2.1", { Cookie: await session(http) }));
    const stranger = new Headers(from("198.51.100.7"));
    expect(await http.viewShare(token)).toMatchObject({ files: [{ name: "a.txt" }] });
    const file = await http.download(new Request(`${origin}/d/${token}/files/${fileId}`, { headers: stranger }), token, fileId);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("hello");
    const all = await http.downloadAll(new Request(`${origin}/d/${token}/all`, { headers: stranger }), token);
    expect(all.status).toBe(200);
  });

  it("rejects a wrong password with 401", async () => {
    const http = await app({ UPLOAD_PASSWORD: PASSWORD });
    const res = await login(http, "wrong");
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect((await login(http, `${PASSWORD} `)).status).toBe(401);
    expect((await login(http, "")).status).toBe(401);
  });

  it("rejects requests without a password field with 400", async () => {
    const http = await app({ UPLOAD_PASSWORD: PASSWORD });
    const res = await http.createUploadSession(
      new Request(`${origin}/api/upload-session`, { method: "POST", body: JSON.stringify({ password: 1 }) }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses expired, forged and other-password cookies", async () => {
    const http = await app({ UPLOAD_PASSWORD: PASSWORD });
    const cookie = await session(http);
    const [, expires, signature] = /=(\d+)\.(.+)$/.exec(cookie)!;
    const check = (value: string) => http.uploadAccess(new Headers(from("192.0.2.1", { Cookie: value })));

    expect(check(`fireshare_upload=${Number(expires) + 86400}.${signature}`)).toBe("password");
    const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
    expect(check(`fireshare_upload=${expires}.${flipped}`)).toBe("password");
    expect(check("fireshare_upload=garbage")).toBe("password");

    const other = await app({ UPLOAD_PASSWORD: "a different password" });
    expect(other.uploadAccess(new Headers(from("192.0.2.1", { Cookie: cookie })))).toBe("password");

    expect(check(cookie)).toBe("allowed");
    advanceMinutes(30 * 24 * 60);
    expect(check(cookie)).toBe("password");
  });

  it("limits wrong passwords per client IP, then lets it try again", async () => {
    const http = await app({ UPLOAD_PASSWORD: PASSWORD });
    const attacker = from("203.0.113.9");
    for (let i = 0; i < PASSWORD_ATTEMPTS; i++) expect((await login(http, `guess ${i}`, attacker)).status).toBe(401);

    // Even the right password is refused until the window ends.
    const limited = await login(http, PASSWORD, attacker);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBe(15 * 60);
    expect(limited.headers.get("Set-Cookie")).toBeNull();

    // Others aren't affected.
    expect((await login(http, PASSWORD, from("192.0.2.1"))).status).toBe(204);

    advanceMinutes(10);
    expect(Number((await login(http, PASSWORD, attacker)).headers.get("Retry-After"))).toBe(5 * 60);
    advanceMinutes(5);
    expect((await login(http, PASSWORD, attacker)).status).toBe(204);
  });

  it("counts attempts by the client behind a trusted proxy, not by the proxy", async () => {
    const http = await app({ UPLOAD_PASSWORD: PASSWORD, TRUSTED_PROXIES: "10.0.0.2" });
    const via = (client: string) => from("10.0.0.2", { "X-Forwarded-For": client });
    for (let i = 0; i < PASSWORD_ATTEMPTS; i++) await login(http, "guess", via("203.0.113.9"));
    expect((await login(http, PASSWORD, via("203.0.113.9"))).status).toBe(429);
    expect((await login(http, PASSWORD, via("192.0.2.1"))).status).toBe(204);
  });
});

describe("public uploads", () => {
  const env = { ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "abuse@example.com" };

  it("uploads without a session, and has no password to enter", async () => {
    const http = await app(env);
    expect(http.uploadAccess(new Headers(from("192.0.2.1")))).toBe("allowed");
    await upload(http, from("192.0.2.1"));
    expect((await login(http, "anything")).status).toBe(404);
  });

  it("links download pages to the abuse contact only when uploads are public", async () => {
    expect((await app(env)).abuseReportUrl()).toBe("mailto:abuse@example.com?subject=Abuse%20report");
    expect((await app({ UPLOAD_PASSWORD: PASSWORD, ABUSE_CONTACT: "abuse@example.com" })).abuseReportUrl()).toBeNull();
  });
});

describe("UPLOAD_ALLOWED_IPS", () => {
  const env = { UPLOAD_PASSWORD: PASSWORD, UPLOAD_ALLOWED_IPS: "192.168.1.0/24, fd00::/8" };

  it("refuses uploads and password attempts from other networks with 403", async () => {
    const http = await app(env);
    const outside = from("198.51.100.7");
    expect(http.uploadAccess(new Headers(outside))).toBe("network");
    expect((await login(http, PASSWORD, outside)).status).toBe(403);

    // A session from inside doesn't carry over to another network.
    const cookie = await session(http, from("192.168.1.20"));
    const created = await createShare(http, from("198.51.100.7", { Cookie: cookie }));
    expect(created.status).toBe(403);
    expect((await created.json()).error).toMatch(/network/);
  });

  it("uploads from allowed IPv4 and IPv6 networks, and serves downloads anywhere", async () => {
    const http = await app(env);
    const cookie = await session(http, from("192.168.1.20"));
    const { token, fileId } = await upload(http, from("::ffff:192.168.1.20", { Cookie: cookie }));
    expect(http.uploadAccess(new Headers(from("fd12::1", { Cookie: cookie })))).toBe("allowed");

    const res = await http.download(
      new Request(`${origin}/d/${token}/files/${fileId}`, { headers: from("198.51.100.7") }),
      token,
      fileId,
    );
    expect(res.status).toBe(200);
  });

  it("refuses uploads when the client address is unknown", async () => {
    const http = await app(env);
    expect(http.uploadAccess(new Headers())).toBe("network");
  });

  it("ignores X-Forwarded-For from an untrusted address", async () => {
    const http = await app({ ...env, TRUSTED_PROXIES: "10.0.0.2" });
    const forged = from("198.51.100.7", { "X-Forwarded-For": "192.168.1.20" });
    expect(http.uploadAccess(new Headers(forged))).toBe("network");
    expect((await login(http, PASSWORD, forged)).status).toBe(403);

    const proxied = from("10.0.0.2", { "X-Forwarded-For": "192.168.1.20" });
    expect((await login(http, PASSWORD, proxied)).status).toBe(204);
  });
});
