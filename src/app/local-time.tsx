"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "./format";

/**
 * A moment in the viewer's time zone. The server doesn't know that zone, so
 * the first render shows UTC and the browser switches it once mounted.
 */
export function LocalTime({ value }: { value: string }) {
  const [text, setText] = useState(() => formatDateTime(value, "UTC"));
  useEffect(() => setText(formatDateTime(value)), [value]);
  return <time dateTime={value}>{text}</time>;
}
