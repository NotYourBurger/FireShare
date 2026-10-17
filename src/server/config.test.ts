import { describe, expect, it } from "vitest";
import { loadCleanupConfig, loadConfig, loadExpiryConfig, loadUploadConfig } from "./config";

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
