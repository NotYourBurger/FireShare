"use client";

import { useEffect, useState } from "react";

/** Shown on download pages when anyone may upload. An email report names the page it came from. */
export function AbuseReportLink({ url }: { url: string }) {
  const [href, setHref] = useState(url);
  useEffect(() => {
    if (url.startsWith("mailto:")) setHref(`${url}&body=${encodeURIComponent(`Link: ${location.href}\n\n`)}`);
  }, [url]);
  return (
    <p className="muted abuse">
      <a href={href} rel="noopener">
        Report abuse
      </a>
    </p>
  );
}
