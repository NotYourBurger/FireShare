import { describe, expect, it } from "vitest";
import { formatBytes, formatExpiry } from "./format";

describe("formatBytes", () => {
  it.each([
    [0, "0 bytes"],
    [1, "1 byte"],
    [999, "999 bytes"],
    [1000, "1 KB"],
    [1536, "1.54 KB"],
    [999_950, "1 MB"],
    [1_500_000, "1.5 MB"],
    [50_000_000_000, "50 GB"],
    [123_456_789_012_345, "123 TB"],
    [5_000_000_000_000_000, "5000 TB"],
  ])("formats %d as %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("formatExpiry", () => {
  it.each([
    ["1d", "1 day"],
    ["7d", "7 days"],
    ["1h", "1 hour"],
    ["12h", "12 hours"],
  ])("formats %s as %s", (value, text) => {
    expect(formatExpiry(value)).toBe(text);
  });
});
