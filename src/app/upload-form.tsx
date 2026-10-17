"use client";

import { useState } from "react";
import { Upload } from "tus-js-client";

const CHUNK_SIZE = 64 * 1024 * 1024;

type State =
  | { step: "select" }
  | { step: "uploading"; progress: number }
  | { step: "done"; url: string }
  | { step: "failed"; message: string };

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<State>({ step: "select" });

  async function share() {
    if (!file) return;
    setState({ step: "uploading", progress: 0 });
    try {
      const created = await postJson("/api/shares", {
        files: [{ name: file.name, size: file.size, type: file.type }],
      });
      await upload(file, new URL(created.files[0].uploadUrl, location.href).href, (progress) =>
        setState({ step: "uploading", progress }),
      );
      const { path } = await postJson(`/api/shares/${created.id}/finalize`);
      setState({ step: "done", url: new URL(path, location.href).href });
    } catch (err) {
      setState({ step: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (state.step === "done") {
    return (
      <div className="card">
        <strong>Your link is ready</strong>
        <div className="link">
          <input readOnly value={state.url} onFocus={(e) => e.target.select()} aria-label="Share link" />
          <button onClick={() => navigator.clipboard.writeText(state.url)}>Copy</button>
        </div>
        <button
          onClick={() => {
            setFile(null);
            setState({ step: "select" });
          }}
        >
          Share another file
        </button>
      </div>
    );
  }

  const uploading = state.step === "uploading";
  return (
    <div className="card">
      <input
        type="file"
        disabled={uploading}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        aria-label="File to share"
      />
      {uploading && (
        <div>
          <progress value={state.progress} max={1} />
          <span className="muted">{Math.floor(state.progress * 100)}%</span>
        </div>
      )}
      {state.step === "failed" && <p className="error">Upload failed: {state.message}</p>}
      <button disabled={!file || uploading} onClick={share}>
        {uploading ? "Uploading…" : "Upload and get link"}
      </button>
    </div>
  );
}

function upload(file: File, uploadUrl: string, onProgress: (fraction: number) => void) {
  return new Promise<void>((resolve, reject) => {
    new Upload(file, {
      uploadUrl,
      chunkSize: CHUNK_SIZE,
      retryDelays: [0, 1000, 3000, 5000],
      storeFingerprintForResuming: false,
      onProgress: (sent, total) => onProgress(total ? sent / total : 1),
      onSuccess: () => resolve(),
      onError: reject,
    }).start();
  });
}

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
