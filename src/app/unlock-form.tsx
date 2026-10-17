"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Asks for the upload password once; the session cookie it gets lets this browser upload. */
export function UnlockForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/upload-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? `Request failed (${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  return (
    <form className="card" onSubmit={unlock}>
      <label className="field">
        <span>Upload password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <p className="muted">Needed once on this browser. People you send links to don&apos;t need it.</p>
      {error && <p className="error">{error}</p>}
      <button disabled={busy || password === ""}>Continue</button>
    </form>
  );
}
