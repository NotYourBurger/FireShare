import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ChecksumMismatchError, chunkHashesFingerprint, combineCrc32, crc32Combine, verifiedChunk } from "./integrity";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** A stream that delivers `data` in pieces of `size` bytes. */
const pieces = (data: Buffer, size: number) =>
  Readable.from(Array.from({ length: Math.ceil(data.length / size) }, (_, i) => data.subarray(i * size, (i + 1) * size)));

describe("verified chunks", () => {
  it("passes a matching chunk through and reports its SHA-256 and CRC32", async () => {
    const data = randomBytes(100_000);
    const chunk = verifiedChunk(pieces(data, 4096), sha256(data));
    expect((await buffer(chunk.stream)).equals(data)).toBe(true);
    expect(chunk.digest()).toEqual({ sha256: sha256(data), crc32: crc32(data) });
    expect(chunk.mismatched()).toBe(false);
  });

  it("fails a chunk that doesn't match, without passing on its last piece", async () => {
    const data = randomBytes(10_000);
    const chunk = verifiedChunk(pieces(data, 1000), sha256(Buffer.from("something else")));
    let received = 0;
    chunk.stream.on("data", (piece: Buffer) => (received += piece.length));

    await expect(new Promise((resolve, reject) => chunk.stream.on("end", resolve).on("error", reject))).rejects.toBeInstanceOf(
      ChecksumMismatchError,
    );
    expect(received).toBe(9000);
    expect(chunk.mismatched()).toBe(true);
  });

  it("verifies an empty chunk", async () => {
    const chunk = verifiedChunk(Readable.from([]), sha256(Buffer.alloc(0)));
    expect(await buffer(chunk.stream)).toHaveLength(0);
    expect(chunk.digest().crc32).toBe(0);
  });
});

describe("CRC32 combination", () => {
  it("combines two CRC32s into the CRC32 of the concatenation", () => {
    for (const [a, b] of [
      [1, 1],
      [1000, 7],
      [0, 50],
      [50, 0],
      [65_537, 123_457],
    ]) {
      const first = randomBytes(a);
      const second = randomBytes(b);
      expect(crc32Combine(crc32(first), crc32(second), b)).toBe(crc32(Buffer.concat([first, second])));
    }
  });

  it("gives a whole file's CRC32 from its chunks' CRC32s", () => {
    const chunks = [randomBytes(70_000), randomBytes(70_000), randomBytes(1234)];
    expect(combineCrc32(chunks.map((chunk) => ({ crc32: crc32(chunk), size: chunk.length })))).toBe(
      crc32(Buffer.concat(chunks)),
    );
    expect(combineCrc32([])).toBe(0);
  });

  it("handles chunks longer than 4 GiB", () => {
    // 2^32 zero bytes, built from CRC32s of smaller runs of zeros.
    const zeros = Buffer.alloc(1 << 20);
    let crc = crc32(zeros);
    for (let size = zeros.length; size < 2 ** 32; size *= 2) crc = crc32Combine(crc, crc, size);
    const crcOf4GiB = crc;
    // CRC32 of 4 GiB + 1 MiB of zeros, two ways.
    expect(crc32Combine(crcOf4GiB, crc32(zeros), zeros.length)).toBe(crc32Combine(crc32(zeros), crcOf4GiB, 2 ** 32));
  });
});

describe("chunk-hash fingerprint", () => {
  it("is the SHA-256 of the raw chunk hashes in order", () => {
    const hashes = [sha256(Buffer.from("a")), sha256(Buffer.from("b"))];
    const expected = sha256(Buffer.concat(hashes.map((hash) => Buffer.from(hash, "hex"))));
    expect(chunkHashesFingerprint(hashes)).toBe(expected);
    expect(chunkHashesFingerprint([...hashes].reverse())).not.toBe(expected);
  });
});
