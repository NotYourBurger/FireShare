import { describe, expect, it } from "vitest";
import {
  loadAccessConfig,
  loadCleanupConfig,
  loadConfig,
  loadExpiryConfig,
  loadLimitsConfig,
  loadUploadConfig,
} from "./config";

describe("expiry config", () => {
  it("defaults to 1d,3d,7d,14d,30d with 7d preselected", () => {
    expect(loadExpiryConfig({})).toEqual({
      options: [
        { value: "1d", seconds: 86400 },
        { value: "3d", seconds: 3 * 86400 },
        { value: "7d", seconds: 7 * 86400 },
        { value: "14d", seconds: 14 * 86400 },
        { value: "30d", seconds: 30 * 86400 },
      ],
      default: "7d",
    });
  });

  it("reads hour and day presets in the order listed", () => {
    expect(loadExpiryConfig({ EXPIRY_OPTIONS: "2d, 12h,1h", EXPIRY_DEFAULT: "12h" })).toEqual({
      options: [
        { value: "2d", seconds: 2 * 86400 },
        { value: "12h", seconds: 12 * 3600 },
        { value: "1h", seconds: 3600 },
      ],
      default: "12h",
    });
  });

  it.each(["7", "0d", "1w", "1.5d", "-1d", "1d,,3d", "07d", "10000d", "1D"])(
    "rejects EXPIRY_OPTIONS=%s",
    (value) => {
      expect(() => loadExpiryConfig({ EXPIRY_OPTIONS: value, EXPIRY_DEFAULT: "1d" })).toThrow(
        /^Invalid EXPIRY_OPTIONS/,
      );
    },
  );

  it("rejects presets that repeat the same duration", () => {
    expect(() => loadExpiryConfig({ EXPIRY_OPTIONS: "1d,24h", EXPIRY_DEFAULT: "1d" })).toThrow(
      /^Invalid EXPIRY_OPTIONS: "24h" repeats/,
    );
  });

  it("rejects an EXPIRY_DEFAULT that isn't one of the presets", () => {
    expect(() => loadExpiryConfig({ EXPIRY_OPTIONS: "1d,3d", EXPIRY_DEFAULT: "7d" })).toThrow(
      'Invalid EXPIRY_DEFAULT "7d": must be one of EXPIRY_OPTIONS (1d, 3d)',
    );
    // The default for EXPIRY_DEFAULT has to be listed too.
    expect(() => loadExpiryConfig({ EXPIRY_OPTIONS: "1d,3d" })).toThrow(/^Invalid EXPIRY_DEFAULT/);
  });

  it("is part of the app config", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x",
        S3_ENDPOINT: "http://x",
        S3_BUCKET: "b",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
        EXPIRY_DEFAULT: "2d",
      }),
    ).toThrow(/^Invalid EXPIRY_DEFAULT/);
  });
});

describe("upload config", () => {
  it("defaults to 64 MB chunks and 3 files at a time", () => {
    expect(loadUploadConfig({})).toEqual({ chunkSize: 64 * 1024 * 1024, parallelFiles: 3 });
  });

  it("reads the chunk size in KB, MB or GB and the parallel file count", () => {
    expect(loadUploadConfig({ UPLOAD_CHUNK_SIZE: "8MB", UPLOAD_PARALLEL_FILES: "5" })).toEqual({
      chunkSize: 8 * 1024 * 1024,
      parallelFiles: 5,
    });
    expect(loadUploadConfig({ UPLOAD_CHUNK_SIZE: "1GB" }).chunkSize).toBe(1024 ** 3);
    expect(loadUploadConfig({ UPLOAD_CHUNK_SIZE: "5120KB" }).chunkSize).toBe(5 * 1024 * 1024);
  });

  it.each(["4MB", "6GB", "64", "64mb", "64 MB", "1.5GB", "0MB", "-64MB"])("rejects UPLOAD_CHUNK_SIZE=%s", (value) => {
    expect(() => loadUploadConfig({ UPLOAD_CHUNK_SIZE: value })).toThrow(/^Invalid UPLOAD_CHUNK_SIZE/);
  });

  it.each(["0", "11", "2.5", "-1", "three"])("rejects UPLOAD_PARALLEL_FILES=%s", (value) => {
    expect(() => loadUploadConfig({ UPLOAD_PARALLEL_FILES: value })).toThrow(/^Invalid UPLOAD_PARALLEL_FILES/);
  });
});

describe("limits config", () => {
  const off = {
    maxShareSize: null,
    maxFilesPerShare: null,
    maxTotalStorage: null,
    uploadQuotaPerIp: null,
    maxActiveSharesPerIp: null,
    rateLimitUpload: null,
    rateLimitDownload: null,
  };

  it("turns every limit off when unset or empty", () => {
    expect(loadLimitsConfig({})).toEqual(off);
    expect(
      loadLimitsConfig({
        MAX_SHARE_SIZE: "",
        MAX_FILES_PER_SHARE: " ",
        MAX_TOTAL_STORAGE: "",
        UPLOAD_QUOTA_PER_IP: "",
        MAX_ACTIVE_SHARES_PER_IP: "",
        RATE_LIMIT_UPLOAD: "",
        RATE_LIMIT_DOWNLOAD: "",
      }),
    ).toEqual(off);
  });

  it("reads sizes in KB, MB, GB or TB and whole-number counts", () => {
    expect(
      loadLimitsConfig({
        MAX_SHARE_SIZE: "50GB",
        MAX_FILES_PER_SHARE: "500",
        MAX_TOTAL_STORAGE: "2TB",
        UPLOAD_QUOTA_PER_IP: "500MB",
        MAX_ACTIVE_SHARES_PER_IP: "20",
        RATE_LIMIT_UPLOAD: "600",
        RATE_LIMIT_DOWNLOAD: "300",
      }),
    ).toEqual({
      maxShareSize: { bytes: 50 * 1024 ** 3, value: "50GB" },
      maxFilesPerShare: 500,
      maxTotalStorage: { bytes: 2 * 1024 ** 4, value: "2TB" },
      uploadQuotaPerIp: { bytes: 500 * 1024 ** 2, value: "500MB" },
      maxActiveSharesPerIp: 20,
      rateLimitUpload: 600,
      rateLimitDownload: 300,
    });
    expect(loadLimitsConfig({ UPLOAD_QUOTA_PER_IP: "64KB" }).uploadQuotaPerIp).toEqual({ bytes: 65536, value: "64KB" });
  });

  it.each(["MAX_SHARE_SIZE", "MAX_TOTAL_STORAGE", "UPLOAD_QUOTA_PER_IP"])("rejects invalid sizes in %s", (name) => {
    for (const value of ["50", "50gb", "50 GB", "1.5GB", "0GB", "-1GB", "50PB", "99999999TB"]) {
      expect(() => loadLimitsConfig({ [name]: value })).toThrow(new RegExp(`^Invalid ${name} "${value}"`));
    }
  });

  it.each(["MAX_FILES_PER_SHARE", "MAX_ACTIVE_SHARES_PER_IP", "RATE_LIMIT_UPLOAD", "RATE_LIMIT_DOWNLOAD"])(
    "rejects invalid counts in %s",
    (name) => {
      for (const value of ["0", "-1", "2.5", "ten", "1e3", "010"]) {
        expect(() => loadLimitsConfig({ [name]: value })).toThrow(new RegExp(`^Invalid ${name} "${value}"`));
      }
    },
  );

  it("stops the app at startup on an invalid limit", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x",
        S3_ENDPOINT: "http://x",
        S3_BUCKET: "b",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
        MAX_SHARE_SIZE: "lots",
      }),
    ).toThrow(/^Invalid MAX_SHARE_SIZE/);
  });
});

describe("cleanup config", () => {
  it("defaults to a 1h delete grace and a 24h pending TTL", () => {
    expect(loadCleanupConfig({})).toEqual({ deleteGraceSeconds: 3600, pendingTtlSeconds: 86400 });
  });

  it("reads minutes, hours and days, including no grace at all", () => {
    expect(loadCleanupConfig({ DELETE_GRACE: "0m", PENDING_TTL: "2d" })).toEqual({
      deleteGraceSeconds: 0,
      pendingTtlSeconds: 2 * 86400,
    });
    expect(loadCleanupConfig({ DELETE_GRACE: "90m" }).deleteGraceSeconds).toBe(90 * 60);
  });

  it.each(["1", "1w", "1.5h", "-1h", "01h", "1H", "100000d"])("rejects DELETE_GRACE=%s", (value) => {
    expect(() => loadCleanupConfig({ DELETE_GRACE: value })).toThrow(/^Invalid DELETE_GRACE/);
  });

  it("rejects an invalid PENDING_TTL", () => {
    expect(() => loadCleanupConfig({ PENDING_TTL: "1 day" })).toThrow(/^Invalid PENDING_TTL "1 day"/);
  });
});

describe("access config", () => {
  it("requires an upload password unless public uploads are turned on", () => {
    expect(() => loadAccessConfig({})).toThrow(
      "Missing UPLOAD_PASSWORD: set an upload password, or set ALLOW_PUBLIC_UPLOAD=true to let anyone upload",
    );
    expect(() => loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "false" })).toThrow(/^Missing UPLOAD_PASSWORD/);
    expect(loadAccessConfig({ UPLOAD_PASSWORD: "secret" })).toEqual({
      password: "secret",
      allowedIps: null,
      trustedProxies: null,
      abuseReportUrl: null,
    });
  });

  it.each(["yes", "1", "TRUE"])("rejects ALLOW_PUBLIC_UPLOAD=%s", (value) => {
    expect(() => loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: value, UPLOAD_PASSWORD: "x" })).toThrow(
      /^Invalid ALLOW_PUBLIC_UPLOAD/,
    );
  });

  it("refuses a password that public uploads would ignore", () => {
    expect(() =>
      loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", UPLOAD_PASSWORD: "x", ABUSE_CONTACT: "a@example.com" }),
    ).toThrow(/set only one of them/);
  });

  it("needs an abuse contact for public uploads, as an email address or URL", () => {
    expect(() => loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true" })).toThrow(/^Missing ABUSE_CONTACT/);
    expect(loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "abuse@example.com" })).toMatchObject({
      password: null,
      abuseReportUrl: "mailto:abuse@example.com?subject=Abuse%20report",
    });
    expect(
      loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: "https://example.com/report" }).abuseReportUrl,
    ).toBe("https://example.com/report");
    for (const contact of ["javascript:alert(1)", "not a contact", "ftp://example.com"]) {
      expect(() => loadAccessConfig({ ALLOW_PUBLIC_UPLOAD: "true", ABUSE_CONTACT: contact }), contact).toThrow(
        /^Invalid ABUSE_CONTACT/,
      );
    }
  });

  it("reads the allowed networks and trusted proxies", () => {
    const config = loadAccessConfig({
      UPLOAD_PASSWORD: "x",
      UPLOAD_ALLOWED_IPS: "192.168.0.0/16",
      TRUSTED_PROXIES: "172.16.0.1",
    });
    expect(config.allowedIps!.has("192.168.4.4")).toBe(true);
    expect(config.trustedProxies!.has("172.16.0.1")).toBe(true);
    expect(() => loadAccessConfig({ UPLOAD_PASSWORD: "x", UPLOAD_ALLOWED_IPS: "office" })).toThrow(
      /^Invalid UPLOAD_ALLOWED_IPS entry "office"/,
    );
  });

  it("isn't needed by the shared config the cleanup worker loads", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x",
        S3_ENDPOINT: "http://x",
        S3_BUCKET: "b",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
      }),
    ).not.toThrow();
  });
});
