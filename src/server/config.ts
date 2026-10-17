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

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
