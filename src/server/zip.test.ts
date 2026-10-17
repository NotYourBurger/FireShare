import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32Combine } from "./integrity";
import type { ByteRange } from "./storage/adapter";
import { unzip, unzipRanges } from "./test-unzip";
import { createZip, safeFileName, zipEntryNames } from "./zip";

const modified = new Date("2026-03-04T05:06:08Z");

/** A zip of in-memory files, reading each through a range like storage would. */
function zipOf(files: Record<string, Buffer | string>) {
  const contents = Object.values(files).map((data) => Buffer.from(data));
  const opened: number[] = [];
  const zip = createZip(
    Object.keys(files).map((name, i) => ({ name, size: contents[i].length, crc32: crc32(contents[i]) })),
    modified,
    async (index, range) => {
      opened.push(index);
      return Readable.from([contents[index].subarray(range.start, range.end + 1)]);
    },
  );
  return { zip, opened };
}

const GB = 1024 ** 3;

/** CRC32 of `size` zero bytes, without allocating them. */
function zerosCrc32(size: number): number {
  const block = 64 * 1024 * 1024;
  const blockCrc = crc32(Buffer.alloc(block));
  let crc = 0;
  for (let left = size; left > 0; left -= block) {
    crc = left >= block ? crc32Combine(crc, blockCrc, block) : crc32Combine(crc, crc32(Buffer.alloc(left)), left);
  }
  return crc;
}

/** `range` of a run of zero bytes, streamed in small pieces. */
function zeros(range: ByteRange): Readable {
  let left = range.end - range.start + 1;
  return Readable.from(
    (function* () {
      for (; left > 0; left -= 1024 * 1024) yield Buffer.alloc(Math.min(left, 1024 * 1024));
    })(),
  );
}

describe("zip archive", () => {
  it("holds every file, in order, uncompressed and with its CRC32", async () => {
    const { zip } = zipOf({ "a.txt": "hello", "empty.bin": "", "c.txt": "x".repeat(70_000) });
    const archive = await buffer(zip.read());
    expect(archive.length).toBe(zip.size);

    const entries = await unzip(archive);
    expect(entries.map((entry) => [entry.name, entry.size])).toEqual([
      ["a.txt", 5],
      ["empty.bin", 0],
      ["c.txt", 70_000],
    ]);
    for (const entry of entries) {
      expect(crc32(await entry.data())).toBe(entry.crc32);
    }
    expect((await entries[0].data()).toString()).toBe("hello");
    // Stored: the archive is the files plus headers, with nothing compressed.
    expect(zip.size).toBeGreaterThan(70_005);
  });

  it("marks names as UTF-8 so they keep their exact characters", async () => {
    const names = ["日本語.txt", "Ünïcödé — résumé.pdf", "🎬 shot.mov", "e\u0301.txt"];
    const { zip } = zipOf(Object.fromEntries(names.map((name) => [name, name])));
    const entries = await unzip(await buffer(zip.read()));
    expect(entries.map((entry) => entry.name)).toEqual(names);
    for (const entry of entries) expect(entry.flags & 0x0800).toBe(0x0800);
  });

  it("produces the same bytes every time", async () => {
    const first = await buffer(zipOf({ "a.txt": "hello", "b.txt": "world" }).zip.read());
    const second = await buffer(zipOf({ "a.txt": "hello", "b.txt": "world" }).zip.read());
    expect(first.equals(second)).toBe(true);
  });

  it("serves any byte range as exactly that slice of the archive", async () => {
    const { zip } = zipOf({ "a.txt": "hello", "empty.bin": "", "c.txt": "0123456789".repeat(100) });
    const whole = await buffer(zip.read());
    const ranges = [
      [0, 0],
      [0, 29],
      [30, 40],
      [10, zip.size - 1],
      [zip.size - 22, zip.size - 1],
      [zip.size - 1, zip.size - 1],
    ];
    for (let start = 0; start < zip.size; start += 37) ranges.push([start, Math.min(start + 100, zip.size - 1)]);
    for (const [start, end] of ranges) {
      expect((await buffer(zip.read({ start, end }))).equals(whole.subarray(start, end + 1))).toBe(true);
    }
  });

  it("resumes from any offset into a byte-identical archive", async () => {
    const { zip } = zipOf({ "a.txt": "a".repeat(1000), "b.txt": "b".repeat(1000) });
    const whole = await buffer(zip.read());
    for (const cut of [1, 500, 1100, zip.size - 5]) {
      const resumed = Buffer.concat([whole.subarray(0, cut), await buffer(zip.read({ start: cut, end: zip.size - 1 }))]);
      expect(resumed.equals(whole)).toBe(true);
    }
  });

  it("opens each file only when the reader reaches it, and only the part asked for", async () => {
    const { zip, opened } = zipOf({ "a.txt": "aaaa", "b.txt": "bbbb", "c.txt": "cccc" });
    const stream = zip.read();
    await new Promise((resolve) => stream.once("readable", resolve));
    expect(opened).toEqual([]);
    await buffer(stream);
    expect(opened).toEqual([0, 1, 2]);

    // A range inside the last file's data reads nothing else.
    opened.length = 0;
    const whole = await buffer(zipOf({ "a.txt": "aaaa", "b.txt": "bbbb", "c.txt": "cccc" }).zip.read());
    const at = whole.lastIndexOf("cccc");
    expect((await buffer(zip.read({ start: at + 1, end: at + 2 }))).toString()).toBe("cc");
    expect(opened).toEqual([2]);
  });

  it("uses ZIP64 for files and offsets past 4 GB, readable by an independent reader", async () => {
    const big = 4.5 * GB;
    const small = Buffer.from("after the big one");
    const zip = createZip(
      [
        { name: "huge.exr", size: big, crc32: zerosCrc32(big) },
        { name: "notes.txt", size: small.length, crc32: crc32(small) },
      ],
      modified,
      async (index, range) => (index === 0 ? zeros(range) : Readable.from([small.subarray(range.start, range.end + 1)])),
    );
    expect(zip.size).toBeGreaterThan(big + small.length);

    // Read through ranges, as a resuming client would, without holding 4.5 GB.
    const entries = await unzipRanges(zip.size, (range) => zip.read(range));
    expect(entries.map((entry) => [entry.name, entry.size])).toEqual([
      ["huge.exr", big],
      ["notes.txt", small.length],
    ]);
    expect(entries[1].localHeaderOffset).toBeGreaterThan(big);
    expect((await entries[1].data()).equals(small)).toBe(true);
    // The archive ends with a ZIP64 end record and locator before the classic end record.
    const tail = await buffer(zip.read({ start: zip.size - 98, end: zip.size - 1 }));
    expect(tail.readUInt32LE(0)).toBe(0x06064b50);
    expect(tail.readUInt32LE(56)).toBe(0x07064b50);
    expect(tail.readUInt32LE(76)).toBe(0x06054b50);
  });

  it("stays a plain zip, with no ZIP64 records, when everything fits in 32 bits", async () => {
    const { zip } = zipOf({ "a.txt": "hello" });
    const archive = await buffer(zip.read());
    expect(archive.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(-1);
    expect(archive.readUInt16LE(4)).toBe(20);
  });
});

describe("zip entry names", () => {
  it("keeps ordinary and unicode names as they are", () => {
    expect(zipEntryNames(["render.exr", "日本語 b.txt", ".env"])).toEqual([
      "render.exr",
      "日本語 b.txt",
      ".env",
    ]);
  });

  it("turns every name into one plain file, never a path", () => {
    expect(safeFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(safeFileName("C:\\Windows\\win.ini")).toBe("C__Windows_win.ini");
    expect(safeFileName("a\u0000b\nc")).toBe("a_b_c");
    expect(safeFileName('what? "really" <yes> | *')).toBe("what_ _really_ _yes_ _ _");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName("   ")).toBe("file");
    expect(safeFileName("notes. . ")).toBe("notes");
    expect(safeFileName("CON")).toBe("_CON");
    expect(safeFileName("nul.txt")).toBe("_nul.txt");
    expect(safeFileName("console.log")).toBe("console.log");
  });

  it("numbers duplicates before the extension, ignoring case and Unicode normalization", () => {
    expect(zipEntryNames(["a.txt", "A.TXT", "a.txt", "b", "b", "e\u0301", "\u00e9"])).toEqual([
      "a.txt",
      "A (2).TXT",
      "a (3).txt",
      "b",
      "b (2)",
      "e\u0301",
      "\u00e9 (2)",
    ]);
  });

  it("never picks a number that another file already uses", () => {
    expect(zipEntryNames(["a.txt", "a.txt", "a (2).txt"])).toEqual(["a.txt", "a (3).txt", "a (2).txt"]);
  });

  it("counts names that only clash once made safe as duplicates", () => {
    expect(zipEntryNames(["a/b", "a\\b", "a:b"])).toEqual(["a_b", "a_b (2)", "a_b (3)"]);
  });
});
