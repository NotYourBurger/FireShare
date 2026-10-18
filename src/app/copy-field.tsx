"use client";

import { useEffect, useState } from "react";

/** Copies `value` to the clipboard, falling back to `execCommand("copy")` over non-HTTPS origins. */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to legacy execCommand fallback.
    }
  }
  if (typeof document === "undefined" || !document.body) return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    active?.focus?.();
  }
}

/** Copies `value` to the clipboard; `copied` stays true for a moment afterwards. */
function useCopy(value: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void copyToClipboard(value).then(
      (ok) => setCopied(ok),
      () => setCopied(false),
    );
  };
  return { copied, copy };
}

/** A read-only link with a button that copies it. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useCopy(value);
  return (
    <div className="link">
      <input readOnly value={value} onFocus={(e) => e.target.select()} aria-label={label} />
      <button type="button" className="quiet" data-copied={copied || undefined} onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Just the copy button, for places where the link itself isn't shown. */
export function CopyButton({ value, label, children }: { value: string; label: string; children: string }) {
  const { copied, copy } = useCopy(value);
  return (
    <button type="button" className="quiet" data-copied={copied || undefined} onClick={copy} aria-label={label}>
      {copied ? "Copied" : children}
    </button>
  );
}

/** The share link set large, host quiet and path prominent, with a copy button. */
export function LinkSlab({ value }: { value: string }) {
  const { copied, copy } = useCopy(value);
  const url = URL.canParse(value) ? new URL(value) : null;
  return (
    <div className="slab" data-copied={copied || undefined}>
      <a className="slab-url" href={value} target="_blank" rel="noreferrer">
        {url ? (
          <>
            <span className="slab-host">{url.host}</span>
            <span className="slab-path">{url.pathname}</span>
          </>
        ) : (
          value
        )}
      </a>
      <button type="button" onClick={copy} aria-label="Copy share link">
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
