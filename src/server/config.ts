import { parseNetworks, type Networks } from "./client-address";
import { MAX_PART_SIZE, MIN_PART_SIZE } from "./storage/adapter";

type Env = Record<string, string | undefined>;

/** Every problem found in the configuration, one message per bad variable. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
  }
}

/** Runs one part of a loader; on failure records its problems and returns undefined. */
type Check = <T>(part: () => T) => T;

/**
 * Runs `load`, carrying on past each failed `check` so that one start names
 * every bad variable, then throws them together as one ConfigError.
 */
function collect<T>(load: (check: Check) => T): T {
  const problems: string[] = [];
  const check: Check = (part) => {
    try {
      return part();
    } catch (err) {
      problems.push(...(err instanceof ConfigError ? err.problems : [err instanceof Error ? err.message : String(err)]));
      return undefined as never;
    }
  };
  const result = load(check);
  if (problems.length > 0) throw new ConfigError(problems);
  return result;
}

/** What's wrong with the configuration the given loaders read; empty when it's all valid. */
export function configProblems(...loaders: (() => unknown)[]): string[] {
  try {
    collect((check) => loaders.forEach((load) => check(load)));
    return [];
  } catch (err) {
    return (err as ConfigError).problems;
  }
}

/** The startup error for `problems`, one bad variable per line. */
export function describeConfigProblems(component: string, problems: string[]): string {
  const settings = problems.length === 1 ? "this setting" : `these ${problems.length} settings`;
  return `${component} can't start. Fix ${settings} in .env:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`;
}

/** Configuration from the environment (see .env.example); throws a ConfigError naming every bad variable. */
export function loadConfig(env: Env = process.env) {
  return collect((check) => ({
    databaseUrl: check(() => databaseUrl(env)),
    s3: {
      endpoint: check(() => s3Endpoint(env)),
      region: env.S3_REGION?.trim() || "us-east-1",
      bucket: check(() => bucketName(env)),
      accessKeyId: check(() => required(env, "S3_ACCESS_KEY_ID")),
      secretAccessKey: check(() => required(env, "S3_SECRET_ACCESS_KEY")),
    },
    transfer: check(() => loadTransferConfig(env)),
    expiry: check(() => loadExpiryConfig(env)),
    upload: check(() => loadUploadConfig(env)),
    limits: check(() => loadLimitsConfig(env)),
    cleanup: check(() => loadCleanupConfig(env)),
  }));
}

function databaseUrl(env: Env): string {
  const value = required(env, "DATABASE_URL");
  let protocol: string | undefined;
  try {
    protocol = new URL(value).protocol;
  } catch {}
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    // Not quoted: the value holds the database password.
    throw new Error("Invalid DATABASE_URL: use a postgres:// URL, like postgres://fireshare:password@db:5432/fireshare");
  }
  return value;
}

function s3Endpoint(env: Env): string {
  const value = required(env, "S3_ENDPOINT");
  if (!httpUrl(value)) throw new Error(`Invalid S3_ENDPOINT "${value}": use an http(s) URL, like http://storage:9000`);
  return value;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function bucketName(env: Env): string {
  const value = required(env, "S3_BUCKET");
  if (!BUCKET.test(value)) {
    throw new Error(
      `Invalid S3_BUCKET "${value}": use 3 to 63 lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit`,
    );
  }
  return value;
}

export type TransferMode = "proxy" | "direct" | "auto";

export interface TransferConfig {
  mode: TransferMode;
  /** HTTPS URL where browsers reach storage in `direct` and `auto` modes; null in `proxy` mode. */
  directEndpoint: string | null;
  /** The app's own origin for the bucket's CORS rule, when set in `.env`. */
  appOrigin: string | null;
  /** Clients that transfer directly in `auto` mode, by trusted client IP; null in other modes. */
  directNetworks: Networks | null;
}

/**
 * How file bytes travel; throws on any invalid value, a missing HTTPS
 * endpoint for direct transfers, or `auto` mode without `DIRECT_NETWORKS`.
 */
export function loadTransferConfig(env: Env = process.env): TransferConfig {
  return collect((check) => {
    // The checks that depend on the mode are skipped when it's invalid.
    const mode = check((): TransferMode => {
      const value = env.TRANSFER_MODE?.trim() || "proxy";
      if (value !== "proxy" && value !== "direct" && value !== "auto") {
        throw new Error(`Invalid TRANSFER_MODE "${value}": use proxy, direct or auto`);
      }
      return value;
    });

    const directEndpoint = check(() => {
      const value = env.STORAGE_DIRECT_ENDPOINT?.trim();
      if (value) {
        const endpoint = httpsEndpoint(value);
        if (!endpoint) {
          throw new Error(
            `Invalid STORAGE_DIRECT_ENDPOINT "${value}": use an https:// URL, like https://storage.lan.example.com`,
          );
        }
        return endpoint;
      }
      if (mode === "direct" || mode === "auto") {
        throw new Error(
          `Missing STORAGE_DIRECT_ENDPOINT: TRANSFER_MODE=${mode} requires an https:// URL for storage, like https://storage.lan.example.com`,
        );
      }
      return null;
    });

    const appOrigin = check(() => {
      const value = env.APP_ORIGIN?.trim();
      if (!value) return null;
      const origin = httpOrigin(value);
      if (!origin) throw new Error(`Invalid APP_ORIGIN "${value}": use an http(s) origin, like https://share.example.com`);
      return origin;
    });

    const directNetworks = check(() => {
      const networks = parseNetworks(env.DIRECT_NETWORKS, "DIRECT_NETWORKS");
      if (mode === "auto" && !networks) {
        throw new Error(
          "Missing DIRECT_NETWORKS: TRANSFER_MODE=auto requires the networks that transfer directly, like 192.168.1.0/24,10.8.0.0/16",
        );
      }
      if (mode && mode !== "auto" && networks) {
        throw new Error(`DIRECT_NETWORKS is set but TRANSFER_MODE=${mode} would ignore it: set TRANSFER_MODE=auto or remove it`);
      }
      return networks;
    });

    return { mode, directEndpoint, appOrigin, directNetworks };
  });
}

export interface ExpiryOption {
  /** As written in `EXPIRY_OPTIONS`, e.g. "7d". */
  value: string;
  seconds: number;
}

export interface ExpiryConfig {
  options: ExpiryOption[];
  default: string;
}

const EXPIRY = /^([1-9]\d{0,3})([hd])$/;
const UNIT_SECONDS = { h: 3600, d: 86400 };

/** The expiry presets offered to uploaders; throws on any invalid value. */
export function loadExpiryConfig(env: Env = process.env): ExpiryConfig {
  return collect((check) => {
    const options = check(() => expiryOptions(env));
    const defaultValue = env.EXPIRY_DEFAULT || "7d";
    // EXPIRY_DEFAULT can only be checked against valid options.
    if (options) {
      check(() => {
        if (!options.some((option) => option.value === defaultValue)) {
          throw new Error(
            `Invalid EXPIRY_DEFAULT "${defaultValue}": must be one of EXPIRY_OPTIONS (${options.map((o) => o.value).join(", ")})`,
          );
        }
      });
    }
    return { options, default: defaultValue };
  });
}

function expiryOptions(env: Env): ExpiryOption[] {
  const list = env.EXPIRY_OPTIONS || "1d,3d,7d,14d,30d";
  const options: ExpiryOption[] = [];
  for (const entry of list.split(",")) {
    const value = entry.trim();
    const match = EXPIRY.exec(value);
    if (!match) {
      throw new Error(
        `Invalid EXPIRY_OPTIONS entry "${value}": use a whole number of hours or days, like 12h or 7d`,
      );
    }
    const seconds = Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
    if (options.some((option) => option.seconds === seconds)) {
      throw new Error(`Invalid EXPIRY_OPTIONS: "${value}" repeats another entry`);
    }
    options.push({ value, seconds });
  }
  return options;
}

export interface UploadConfig {
  /** Bytes per uploaded chunk; also the size of each storage part. */
  chunkSize: number;
  /** How many files a browser uploads at once. */
  parallelFiles: number;
}

const SIZE = /^([1-9]\d*)(KB|MB|GB|TB)$/;
const UNIT_BYTES = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
const MAX_PARALLEL_FILES = 10;

/** Bytes in a size like "64MB" (1MB = 1024 x 1024 bytes), or NaN if it isn't one. */
function parseSize(value: string): number {
  const match = SIZE.exec(value);
  const bytes = match ? Number(match[1]) * UNIT_BYTES[match[2] as keyof typeof UNIT_BYTES] : NaN;
  return Number.isSafeInteger(bytes) ? bytes : NaN;
}

/** How browsers upload; throws on any invalid value. */
export function loadUploadConfig(env: Env = process.env): UploadConfig {
  return collect((check) => ({
    chunkSize: check(() => {
      const value = env.UPLOAD_CHUNK_SIZE || "64MB";
      const chunkSize = parseSize(value);
      if (!(chunkSize >= MIN_PART_SIZE && chunkSize <= MAX_PART_SIZE)) {
        throw new Error(`Invalid UPLOAD_CHUNK_SIZE "${value}": use a size from 5MB to 5GB, like 64MB`);
      }
      return chunkSize;
    }),
    parallelFiles: check(() => {
      const value = env.UPLOAD_PARALLEL_FILES || "3";
      const parallelFiles = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!(parallelFiles >= 1 && parallelFiles <= MAX_PARALLEL_FILES)) {
        throw new Error(`Invalid UPLOAD_PARALLEL_FILES "${value}": use a whole number from 1 to ${MAX_PARALLEL_FILES}`);
      }
      return parallelFiles;
    }),
  }));
}

/** A size limit, in bytes and as written in `.env` for messages. */
export interface SizeLimit {
  bytes: number;
  value: string;
}

/** Each limit is null when it's off. */
export interface LimitsConfig {
  maxShareSize: SizeLimit | null;
  maxFilesPerShare: number | null;
  /** All pending shares plus ready ones that haven't expired. */
  maxTotalStorage: SizeLimit | null;
  /** Declared bytes of the shares one client IP created in the last 24 hours. */
  uploadQuotaPerIp: SizeLimit | null;
  /** Pending shares plus ready ones that haven't expired, per client IP. */
  maxActiveSharesPerIp: number | null;
  /** Requests per minute per client IP. */
  rateLimitUpload: number | null;
  rateLimitDownload: number | null;
}

/** Limits and quotas; each is off when empty. Throws on any invalid value. */
export function loadLimitsConfig(env: Env = process.env): LimitsConfig {
  return collect((check) => ({
    maxShareSize: check(() => sizeLimit(env, "MAX_SHARE_SIZE")),
    maxFilesPerShare: check(() => countLimit(env, "MAX_FILES_PER_SHARE")),
    maxTotalStorage: check(() => sizeLimit(env, "MAX_TOTAL_STORAGE")),
    uploadQuotaPerIp: check(() => sizeLimit(env, "UPLOAD_QUOTA_PER_IP")),
    maxActiveSharesPerIp: check(() => countLimit(env, "MAX_ACTIVE_SHARES_PER_IP")),
    rateLimitUpload: check(() => countLimit(env, "RATE_LIMIT_UPLOAD")),
    rateLimitDownload: check(() => countLimit(env, "RATE_LIMIT_DOWNLOAD")),
  }));
}

function sizeLimit(env: Env, name: string): SizeLimit | null {
  const value = env[name]?.trim();
  if (!value) return null;
  const bytes = parseSize(value);
  if (Number.isNaN(bytes)) {
    throw new Error(`Invalid ${name} "${value}": use a size in KB, MB, GB or TB, like 500MB or 50GB, or leave it empty for no limit`);
  }
  return { bytes, value };
}

function countLimit(env: Env, name: string): number | null {
  const value = env[name]?.trim();
  if (!value) return null;
  const count = /^[1-9]\d{0,8}$/.test(value) ? Number(value) : NaN;
  if (Number.isNaN(count)) {
    throw new Error(`Invalid ${name} "${value}": use a whole number of at least 1, or leave it empty for no limit`);
  }
  return count;
}

export interface CleanupConfig {
  /** How long an expired or deleted share's bytes are kept, so downloads under way can finish. */
  deleteGraceSeconds: number;
  /** How old a `pending` share gets before it counts as abandoned. */
  pendingTtlSeconds: number;
}

const DURATION = /^(0|[1-9]\d{0,4})([mhd])$/;
const DURATION_SECONDS = { m: 60, h: 3600, d: 86400 };

/** When the cleanup worker reclaims storage; throws on any invalid value. */
export function loadCleanupConfig(env: Env = process.env): CleanupConfig {
  return collect((check) => ({
    deleteGraceSeconds: check(() => duration(env, "DELETE_GRACE", "1h")),
    pendingTtlSeconds: check(() => duration(env, "PENDING_TTL", "24h")),
  }));
}

function duration(env: Env, name: string, fallback: string): number {
  const value = env[name] || fallback;
  const match = DURATION.exec(value);
  if (!match) {
    throw new Error(`Invalid ${name} "${value}": use a whole number of minutes, hours or days, like 30m, 1h or 2d`);
  }
  return Number(match[1]) * DURATION_SECONDS[match[2] as keyof typeof DURATION_SECONDS];
}

export interface AccessConfig {
  /** Null when uploads are public. */
  password: string | null;
  /** Networks uploads may come from; null allows any. */
  allowedIps: Networks | null;
  /** Proxies whose `X-Forwarded-For` is believed. */
  trustedProxies: Networks | null;
  /** Where download pages link to report abuse; only set when uploads are public. */
  abuseReportUrl: string | null;
}

const EMAIL = /^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/;

/**
 * Who may upload; the app needs this, the worker doesn't. Throws on any
 * invalid value, and when nothing protects uploads.
 */
export function loadAccessConfig(env: Env = process.env): AccessConfig {
  return collect((check) => {
    // Whether UPLOAD_PASSWORD or ABUSE_CONTACT is needed is only known when this is valid.
    const isPublic = check(() => {
      const value = env.ALLOW_PUBLIC_UPLOAD || "false";
      if (value !== "true" && value !== "false") {
        throw new Error(`Invalid ALLOW_PUBLIC_UPLOAD "${value}": use true or false`);
      }
      return value === "true";
    });

    const password = env.UPLOAD_PASSWORD || null;
    check(() => {
      if (isPublic === false && !password) {
        throw new Error(
          "Missing UPLOAD_PASSWORD: set an upload password, or set ALLOW_PUBLIC_UPLOAD=true to let anyone upload",
        );
      }
      if (isPublic && password) {
        throw new Error("UPLOAD_PASSWORD is set but ALLOW_PUBLIC_UPLOAD=true would ignore it: set only one of them");
      }
    });

    const abuseReportUrl = check(() => {
      if (!isPublic) return null;
      const contact = env.ABUSE_CONTACT?.trim();
      if (!contact) {
        throw new Error(
          "Missing ABUSE_CONTACT: with ALLOW_PUBLIC_UPLOAD=true, download pages link to it so people can report abuse",
        );
      }
      const url = EMAIL.test(contact) ? `mailto:${contact}?subject=${encodeURIComponent("Abuse report")}` : httpUrl(contact);
      if (!url) throw new Error(`Invalid ABUSE_CONTACT "${contact}": use an email address or an http(s) URL`);
      return url;
    });

    return {
      password,
      allowedIps: check(() => parseNetworks(env.UPLOAD_ALLOWED_IPS, "UPLOAD_ALLOWED_IPS")),
      trustedProxies: check(() => parseNetworks(env.TRUSTED_PROXIES, "TRUSTED_PROXIES")),
      abuseReportUrl,
    };
  });
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function httpsEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}: it's required (see .env.example)`);
  return value;
}

