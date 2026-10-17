import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "./tokens";

describe("link tokens", () => {
  it("are 22 URL-safe characters encoding 128 random bits", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(16);
  });

  it("are not repeated", () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateToken));
    expect(tokens.size).toBe(1000);
  });

  it("hash to the SHA-256 hex digest of the token", () => {
    // echo -n "abc" | sha256sum
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
