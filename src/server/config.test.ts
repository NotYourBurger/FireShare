import { describe, expect, it } from "vitest";
import { loadConfig, loadExpiryConfig } from "./config";

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
