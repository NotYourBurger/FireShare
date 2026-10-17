import { Readable } from "node:stream";
import type { ByteRange } from "./storage/adapter";

/** One file in a zip, with its CRC32 known up front. */
export interface ZipEntry {
  name: string;
  size: number;
  crc32: number;
}

export interface ZipArchive {
  /** The archive's exact length in bytes. */
  size: number;
  /** Streams the archive, or just `range` of it; file bytes come from `openEntry`. */
  read(range?: ByteRange): Readable;
}

/** Opens `range` of entry `index`'s data. */
export type OpenEntry = (index: number, range: ByteRange) => Promise<Readable>;

/**
 * A store-only (uncompressed) ZIP64 archive of `entries`, laid out up front.
 * Because every CRC32 is known, no data descriptors are needed: each byte of
 * the archive is fixed before any file is read, so its size is exact and any
 * range can be served on its own. Headers are built in memory; file data is
 * only ever streamed through. ZIP64 fields are used only where a size or
 * offset doesn't fit in 32 bits, so small archives stay plain zips.
 */
export function createZip(entries: ZipEntry[], modified: Date, openEntry: OpenEntry): ZipArchive {
  const { time, date } = dosDateTime(modified);
  const segments: Segment[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const push = (segment: Segment) => {
    segments.push(segment);
    offset += segment.size;
  };

  entries.forEach((entry, index) => {
    const name = Buffer.from(entry.name, "utf8");
    const headerOffset = offset;
    const large = entry.size >= MAX32;
    const version = large || headerOffset >= MAX32 ? VERSION_ZIP64 : VERSION_DEFAULT;

    const localExtra = large ? zip64Extra([entry.size, entry.size]) : EMPTY;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(entry.crc32 >>> 0, 14);
    local.writeUInt32LE(large ? MAX32 : entry.size, 18);
    local.writeUInt32LE(large ? MAX32 : entry.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    push(bytes(Buffer.concat([local, name, localExtra])));
    if (entry.size > 0) push({ size: entry.size, entry: index });

    // The central directory's ZIP64 field holds only the values that overflowed, in this order.
    const overflowed = [...(large ? [entry.size, entry.size] : []), ...(headerOffset >= MAX32 ? [headerOffset] : [])];
    const centralExtra = overflowed.length > 0 ? zip64Extra(overflowed) : EMPTY;
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(VERSION_ZIP64, 4); // made by: MS-DOS host, so no Unix permissions apply
    header.writeUInt16LE(version, 6);
    header.writeUInt16LE(FLAG_UTF8, 8);
    header.writeUInt16LE(METHOD_STORE, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(entry.crc32 >>> 0, 16);
    header.writeUInt32LE(large ? MAX32 : entry.size, 20);
    header.writeUInt32LE(large ? MAX32 : entry.size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(centralExtra.length, 30);
    // Comment length, start disk, internal and external attributes stay 0.
    header.writeUInt32LE(Math.min(headerOffset, MAX32), 42);
    central.push(header, name, centralExtra);
  });

  const directory = Buffer.concat(central);
  const directoryOffset = offset;
  push(bytes(directory));

  const count = entries.length;
  const needsZip64 = count >= MAX16 || directory.length >= MAX32 || directoryOffset >= MAX32;
  if (needsZip64) {
    const zip64EndOffset = offset;
    const end = Buffer.alloc(56 + 20);
    end.writeUInt32LE(0x06064b50, 0);
    end.writeBigUInt64LE(44n, 4); // size of the rest of this record
    end.writeUInt16LE(VERSION_ZIP64, 12);
    end.writeUInt16LE(VERSION_ZIP64, 14);
    // This disk and the directory's start disk stay 0.
    end.writeBigUInt64LE(BigInt(count), 24);
    end.writeBigUInt64LE(BigInt(count), 32);
    end.writeBigUInt64LE(BigInt(directory.length), 40);
    end.writeBigUInt64LE(BigInt(directoryOffset), 48);
    // Locator: where the ZIP64 end record is.
    end.writeUInt32LE(0x07064b50, 56);
    end.writeBigUInt64LE(BigInt(zip64EndOffset), 64);
    end.writeUInt32LE(1, 72); // total disks
    push(bytes(end));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, MAX16), 8);
  end.writeUInt16LE(Math.min(count, MAX16), 10);
  end.writeUInt32LE(Math.min(directory.length, MAX32), 12);
  end.writeUInt32LE(Math.min(directoryOffset, MAX32), 16);
  push(bytes(end));

  const size = offset;
  return {
    size,
    read(range = { start: 0, end: size - 1 }) {
      return Readable.from(readSegments(segments, range, openEntry));
    },
  };
}

type Segment = { size: number; data: Buffer } | { size: number; entry: number };

async function* readSegments(segments: Segment[], range: ByteRange, openEntry: OpenEntry) {
  let offset = 0;
  for (const segment of segments) {
    const start = Math.max(range.start, offset) - offset;
    const end = Math.min(range.end, offset + segment.size - 1) - offset;
    offset += segment.size;
    if (start > end) continue;
    // Entries are opened one at a time, only once the reader reaches them.
    if ("data" in segment) yield segment.data.subarray(start, end + 1);
    else yield* await openEntry(segment.entry, { start, end });
  }
}

/**
 * Names for the files inside a zip: path separators and characters Windows
 * or macOS can't store are replaced, so every entry extracts as one plain
 * file, and duplicates (ignoring case and Unicode normalization, as those
 * filesystems do) get " (2)", " (3)" and so on before the extension.
 */
export function zipEntryNames(names: string[]): string[] {
  const taken = new Set<string>();
  const key = (name: string) => name.normalize("NFC").toLowerCase();
  const safe = names.map(safeFileName);
  for (const name of safe) taken.add(key(name));
  const seen = new Set<string>();
  return safe.map((name) => {
    if (!seen.has(key(name))) {
      seen.add(key(name));
      return name;
    }
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let n = 2;
    while (taken.has(key(`${stem} (${n})${ext}`))) n++;
    const unique = `${stem} (${n})${ext}`;
    taken.add(key(unique));
    seen.add(key(unique));
    return unique;
  });
}

/** `name` as a single file name that any common filesystem accepts; "file" if nothing is left. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_")
    // Windows drops trailing dots and spaces, which would merge names like "a." and "a".
    .replace(/[. ]+$/, "")
    .trim();
  if (cleaned === "") return "file";
  // Windows reserves these device names, with or without an extension.
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
/** General-purpose bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const EMPTY = Buffer.alloc(0);

const bytes = (data: Buffer): Segment => ({ size: data.length, data });

/** The ZIP64 extended information extra field (tag 0x0001) holding `values` as 64-bit numbers. */
function zip64Extra(values: number[]): Buffer {
  const field = Buffer.alloc(4 + 8 * values.length);
  field.writeUInt16LE(0x0001, 0);
  field.writeUInt16LE(8 * values.length, 2);
  values.forEach((value, i) => field.writeBigUInt64LE(BigInt(value), 4 + 8 * i));
  return field;
}

/**
 * MS-DOS date and time fields. Zips have no time zone, so UTC is used: the
 * same share always yields the same bytes, whatever the server's zone.
 */
function dosDateTime(at: Date) {
  if (at.getUTCFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}
