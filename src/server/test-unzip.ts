import type { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import yauzl from "yauzl";
import type { ByteRange } from "./storage/adapter";

/** One entry as an independent zip reader (yauzl) sees it. */
export interface UnzippedEntry {
  name: string;
  size: number;
  crc32: number;
  flags: number;
  localHeaderOffset: number;
  /** Reads the entry's data; yauzl checks it is exactly `size` bytes. */
  data(): Promise<Buffer>;
}

/** Every entry of the zip in `data`, in order. */
export function unzip(data: Buffer): Promise<UnzippedEntry[]> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(data, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(entriesOf(zip)))),
  );
}

/**
 * Every entry of a zip of `size` bytes read through `read`, one byte range at
 * a time, so archives too big to hold in memory can be checked.
 */
export function unzipRanges(size: number, read: (range: ByteRange) => Readable): Promise<UnzippedEntry[]> {
  class Reader extends yauzl.RandomAccessReader {
    _readStreamForRange(start: number, end: number) {
      return read({ start, end: end - 1 });
    }
  }
  return new Promise((resolve, reject) =>
    yauzl.fromRandomAccessReader(new Reader(), size, { lazyEntries: true, autoClose: false }, (err, zip) =>
      err ? reject(err) : resolve(entriesOf(zip)),
    ),
  );
}

function entriesOf(zip: yauzl.ZipFile): Promise<UnzippedEntry[]> {
  const entries: UnzippedEntry[] = [];
  return new Promise((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      entries.push({
        name: entry.fileName,
        size: entry.uncompressedSize,
        crc32: entry.crc32,
        flags: entry.generalPurposeBitFlag,
        localHeaderOffset: entry.relativeOffsetOfLocalHeader,
        data: () =>
          new Promise((resolveData, rejectData) =>
            zip.openReadStream(entry, (err, stream) => (err ? rejectData(err) : buffer(stream).then(resolveData, rejectData))),
          ),
      });
      zip.readEntry();
    });
    zip.on("end", () => resolve(entries));
    zip.on("error", reject);
    zip.readEntry();
  });
}
