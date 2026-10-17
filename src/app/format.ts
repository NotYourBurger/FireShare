const UNITS = ["KB", "MB", "GB", "TB"];

/** A human-readable size in decimal units, e.g. "1.5 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  // Round first so 999,950 bytes reads "1 MB", not "1000 KB".
  if (Number(value.toPrecision(3)) >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${Number(value.toPrecision(3))} ${UNITS[unit]}`;
}
