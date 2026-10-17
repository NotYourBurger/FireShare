import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { clientAddress, type Networks } from "./client-address";
import type { AccessConfig } from "./config";
import { createRateLimiter } from "./rate-limit";

export const SESSION_COOKIE = "fireshare_upload";
const SESSION_SECONDS = 30 * 86400;
/** Wrong passwords allowed per client IP in each window. */
export const PASSWORD_ATTEMPTS = 10;
const PASSWORD_WINDOW_SECONDS = 15 * 60;

/** Whether a request may upload, and if not, what's missing. */
export type UploadAccess = "allowed" | "password" | "network";

export type LoginResult =
  | { ok: true; cookie: string }
  | { ok: false; reason: "wrong" | "network" | "public" }
  | { ok: false; reason: "rate_limited"; retryAfter: number };

type RequestHeaders = Pick<Headers, "get">;

/**
 * Who may upload: from allowed networks only, when `UPLOAD_ALLOWED_IPS` is
 * set, and with a session from the upload password unless uploads are public.
 * Downloads never go through here.
 */
export function createUploadAccess(config: AccessConfig, now: () => Date = () => new Date()) {
  // Changing the password ends every session signed with the old one.
  const key = config.password ? createHmac("sha256", config.password).update("fireshare upload session").digest() : null;
  const passwordAttempts = createRateLimiter({
    limit: PASSWORD_ATTEMPTS,
    windowSeconds: PASSWORD_WINDOW_SECONDS,
    now,
  });

  const fromAllowedNetwork = (headers: RequestHeaders) =>
    !config.allowedIps || allowed(config.allowedIps, clientAddress(headers, config.trustedProxies));

  function hasSession(headers: RequestHeaders): boolean {
    if (!key) return true;
    const value = readCookie(headers.get("Cookie"), SESSION_COOKIE);
    const match = value && /^(\d{1,12})\.([\w-]{43})$/.exec(value);
    if (!match) return false;
    const expires = Number(match[1]);
    if (expires * 1000 <= now().getTime()) return false;
    return timingSafeEqual(Buffer.from(match[2]), Buffer.from(sign(key, expires)));
  }

  return {
    /** Where download pages link to report abuse, or null for no link. */
    abuseReportUrl: config.abuseReportUrl,

    /** The client's IP address, through `TRUSTED_PROXIES`; null when unknown. */
    clientAddress(headers: RequestHeaders): string | null {
      return clientAddress(headers, config.trustedProxies);
    },

    /** Whether bytes may be uploaded with these request headers. */
    check(headers: RequestHeaders): UploadAccess {
      if (!fromAllowedNetwork(headers)) return "network";
      return hasSession(headers) ? "allowed" : "password";
    },

    /**
     * Checks the upload password and, if it's right, returns the session
     * cookie to set. Wrong guesses are limited per client IP.
     */
    login(headers: RequestHeaders, password: string, secure: boolean): LoginResult {
      if (!key) return { ok: false, reason: "public" };
      if (!fromAllowedNetwork(headers)) return { ok: false, reason: "network" };
      const client = clientAddress(headers, config.trustedProxies) ?? "unknown";
      const retryAfter = passwordAttempts.retryAfter(client);
      if (retryAfter > 0) return { ok: false, reason: "rate_limited", retryAfter };
      if (!sameSecret(password, config.password!)) {
        passwordAttempts.hit(client);
        return { ok: false, reason: "wrong" };
      }
      const expires = Math.floor(now().getTime() / 1000) + SESSION_SECONDS;
      const attributes = [`Max-Age=${SESSION_SECONDS}`, "Path=/", "HttpOnly", "SameSite=Lax", ...(secure ? ["Secure"] : [])];
      return { ok: true, cookie: [`${SESSION_COOKIE}=${expires}.${sign(key, expires)}`, ...attributes].join("; ") };
    },
  };
}

export type UploadAccessControl = ReturnType<typeof createUploadAccess>;

function allowed(networks: Networks, address: string | null) {
  return address !== null && networks.has(address);
}

function sign(key: Buffer, expires: number): string {
  return createHmac("sha256", key).update(`upload:${expires}`).digest("base64url");
}

/** Constant-time comparison, whatever the lengths. */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function readCookie(header: string | null, name: string): string | null {
  for (const pair of header?.split(";") ?? []) {
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}
