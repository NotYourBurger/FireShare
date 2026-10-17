import { createHash } from "node:crypto";
import { pipeline, Transform, type Readable } from "node:stream";
import { crc32 } from "node:zlib";

export class ChecksumMismatchError extends Error {
  constructor() {
    super("Chunk doesn't match its SHA-256");
    this.name = "ChecksumMismatchError";
  }
}

export interface ChunkDigest {
  /** Hex SHA-256 of the chunk. */
  sha256: string;
  crc32: number;
}

/**
 * Passes `body` through while hashing it, and fails instead of ending if its
 * SHA-256 isn't `expectedSha256` (hex). The most recent piece is held back
 * until the hash is confirmed, so storage never receives a whole bad chunk
 * and can't accept it as a part. `digest()` is valid once the stream has ended.
 */
export function verifiedChunk(body: Readable, expectedSha256: string) {
  const hash = createHash("sha256");
  let crc = 0;
  let held: Buffer | null = null;
  let mismatched = false;
  const checked = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      crc = crc32(chunk, crc);
      const previous = held;
      held = chunk;
      callback(null, previous ?? undefined);
    },
    flush(callback) {
      if (hash.digest("hex") !== expectedSha256) {
        mismatched = true;
        callback(new ChecksumMismatchError());
        return;
      }
      callback(null, held ?? undefined);
    },
  });
  return {
    stream: pipeline(body, checked, () => {}) as Readable,
    /** Whether the stream failed because the hash didn't match. */
    mismatched: () => mismatched,
    digest: (): ChunkDigest => ({ sha256: expectedSha256, crc32: crc }),
  };
}

/** A file's content fingerprint: the SHA-256 (hex) of its chunk hashes, in order. */
export function chunkHashesFingerprint(chunkSha256s: string[]): string {
  const hash = createHash("sha256");
  for (const sha256 of chunkSha256s) hash.update(Buffer.from(sha256, "hex"));
  return hash.digest("hex");
}

/** The CRC32 of a whole file from the CRC32s of its consecutive chunks. */
export function combineCrc32(chunks: { crc32: number; size: number }[]): number {
  return chunks.reduce((crc, chunk) => crc32Combine(crc, chunk.crc32, chunk.size), 0);
}

// CRC32 combination as in zlib's crc32_combine: arithmetic on polynomials
// over GF(2), modulo the (reflected) CRC-32 polynomial.
const POLY = 0xedb88320;

/** a(x) * b(x) modulo p(x). */
function multModP(a: number, b: number): number {
  let m = 0x80000000;
  let p = 0;
  for (;;) {
    if (a & m) {
      p ^= b;
      if ((a & (m - 1)) === 0) break;
    }
    m >>>= 1;
    b = b & 1 ? (b >>> 1) ^ POLY : b >>> 1;
  }
  return p >>> 0;
}

/** X2N[k] = x^(2^k) modulo p(x). */
const X2N: number[] = [];
for (let k = 0, p = 1 << 30; k < 32; k++, p = multModP(p, p)) X2N.push(p);

/** x^(n * 2^k) modulo p(x); n may exceed 32 bits. */
function x2nModP(n: number, k: number): number {
  let p = 0x80000000;
  for (; n > 0; n = Math.floor(n / 2), k++) {
    if (n % 2) p = multModP(X2N[k & 31], p);
  }
  return p;
}

/** CRC32 of A followed by B, from CRC32(A), CRC32(B) and B's length in bytes. */
export function crc32Combine(crcA: number, crcB: number, lengthB: number): number {
  return (multModP(x2nModP(lengthB, 3), crcA) ^ crcB) >>> 0;
}
