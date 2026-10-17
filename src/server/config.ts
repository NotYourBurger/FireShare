import { parseNetworks, type Networks } from "./client-address";
import { MAX_PART_SIZE, MIN_PART_SIZE } from "./storage/adapter";

type Env = Record<string, string | undefined>;

/** Configuration from the environment (see .env.example). */
export function loadConfig(env: Env = process.env) {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    s3: {
      endpoint: required(env, "S3_ENDPOINT"),
      region: env.S3_REGION || "us-east-1",
      bucket: required(env, "S3_BUCKET"),
      accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
    },
    expiry: loadExpiryConfig(env),
    upload: loadUploadConfig(env),
    cleanup: loadCleanupConfig(env),
  };
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

  const defaultValue = env.EXPIRY_DEFAULT || "7d";
  if (!options.some((option) => option.value === defaultValue)) {
    throw new Error(
      `Invalid EXPIRY_DEFAULT "${defaultValue}": must be one of EXPIRY_OPTIONS (${options.map((o) => o.value).join(", ")})`,
    );
  }
  return { options, default: defaultValue };
}

export interface UploadConfig {
  /** Bytes per uploaded chunk; also the size of each storage part. */
  chunkSize: number;
  /** How many files a browser uploads at once. */
  parallelFiles: number;
}

const SIZE = /^([1-9]\d*)(KB|MB|GB)$/;
const UNIT_BYTES = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
const MAX_PARALLEL_FILES = 10;

/** How browsers upload; throws on any invalid value. */
export function loadUploadConfig(env: Env = process.env): UploadConfig {
  const chunkSizeValue = env.UPLOAD_CHUNK_SIZE || "64MB";
  const match = SIZE.exec(chunkSizeValue);
  const chunkSize = match ? Number(match[1]) * UNIT_BYTES[match[2] as keyof typeof UNIT_BYTES] : NaN;
  if (!(chunkSize >= MIN_PART_SIZE && chunkSize <= MAX_PART_SIZE)) {
    throw new Error(
      `Invalid UPLOAD_CHUNK_SIZE "${chunkSizeValue}": use a size from 5MB to 5GB, like 64MB`,
    );
  }

  const parallelValue = env.UPLOAD_PARALLEL_FILES || "3";
  const parallelFiles = /^\d+$/.test(parallelValue) ? Number(parallelValue) : NaN;
  if (!(parallelFiles >= 1 && parallelFiles <= MAX_PARALLEL_FILES)) {
    throw new Error(
      `Invalid UPLOAD_PARALLEL_FILES "${parallelValue}": use a whole number from 1 to ${MAX_PARALLEL_FILES}`,
    );
  }
  return { chunkSize, parallelFiles };
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
  return {
    deleteGraceSeconds: duration(env, "DELETE_GRACE", "1h"),
    pendingTtlSeconds: duration(env, "PENDING_TTL", "24h"),
  };
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
  const publicValue = env.ALLOW_PUBLIC_UPLOAD || "false";
  if (publicValue !== "true" && publicValue !== "false") {
    throw new Error(`Invalid ALLOW_PUBLIC_UPLOAD "${publicValue}": use true or false`);
  }
  const isPublic = publicValue === "true";
  const password = env.UPLOAD_PASSWORD || null;
  if (!isPublic && !password) {
    throw new Error(
      "Missing UPLOAD_PASSWORD: set an upload password, or set ALLOW_PUBLIC_UPLOAD=true to let anyone upload",
    );
  }
  if (isPublic && password) {
    throw new Error("UPLOAD_PASSWORD is set but ALLOW_PUBLIC_UPLOAD=true would ignore it: set only one of them");
  }

  let abuseReportUrl: string | null = null;
  if (isPublic) {
    const contact = env.ABUSE_CONTACT?.trim();
    if (!contact) {
      throw new Error(
        "Missing ABUSE_CONTACT: with ALLOW_PUBLIC_UPLOAD=true, download pages link to it so people can report abuse",
      );
    }
    abuseReportUrl = EMAIL.test(contact) ? `mailto:${contact}?subject=${encodeURIComponent("Abuse report")}` : httpUrl(contact);
    if (!abuseReportUrl) {
      throw new Error(`Invalid ABUSE_CONTACT "${contact}": use an email address or an http(s) URL`);
    }
  }

  return {
    password,
    allowedIps: parseNetworks(env.UPLOAD_ALLOWED_IPS, "UPLOAD_ALLOWED_IPS"),
    trustedProxies: parseNetworks(env.TRUSTED_PROXIES, "TRUSTED_PROXIES"),
    abuseReportUrl,
  };
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
