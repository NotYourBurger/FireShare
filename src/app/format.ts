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

/** An expiry preset such as "7d" or "12h" in words, e.g. "7 days". */
export function formatExpiry(value: string): string {
  const match = /^(\d+)([hd])$/.exec(value);
  if (!match) return value;
  const n = Number(match[1]);
  const unit = match[2] === "h" ? "hour" : "day";
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * A moment as a short date and time, e.g. "17 Oct 2026, 13:32". Without a
 * time zone it's the viewer's own; servers pass "UTC", which is then named.
 */
export function formatDateTime(date: Date | string, timeZone?: string): string {
  const text = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(
    new Date(date),
  );
  return timeZone === "UTC" ? `${text} UTC` : text;
}
