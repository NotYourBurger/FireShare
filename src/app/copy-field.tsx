"use client";

import { useState } from "react";

/** A read-only link with a button that copies it. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="link">
      <input readOnly value={value} onFocus={(e) => e.target.select()} aria-label={label} />
      <button
        onClick={() =>
          navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
