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

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
