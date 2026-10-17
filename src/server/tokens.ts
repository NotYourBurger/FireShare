import { createHash, randomBytes } from "node:crypto";

/** A 128-bit random link token, base64url-encoded (22 characters). */
export function generateToken(): string {
  return randomBytes(16).toString("base64url");
}

/** Only this hash is stored, so a database leak exposes no working links. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
