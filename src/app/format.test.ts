import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";

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
