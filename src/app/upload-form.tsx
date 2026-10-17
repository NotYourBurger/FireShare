"use client";

import { useState } from "react";
import { Upload } from "tus-js-client";
import { formatBytes } from "./format";

const CHUNK_SIZE = 64 * 1024 * 1024;
const PARALLEL_UPLOADS = 3;
// Keep in step with MAX_TITLE_LENGTH and MAX_MESSAGE_LENGTH in src/server/http.ts.
const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5000;

type State =
  | { step: "select" }
  | { step: "uploading"; progress: number }
  | { step: "done"; url: string }
  | { step: "failed"; message: string };

export function UploadForm() {
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<State>({ step: "select" });

  async function share() {
    if (files.length === 0) return;
    setState({ step: "uploading", progress: 0 });
    try {
      const created = await postJson("/api/shares", {
        title,
        message,
        files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
      });
      const total = files.reduce((sum, file) => sum + file.size, 0);
      const sent = files.map(() => 0);
      await inParallel(files, PARALLEL_UPLOADS, (file, i) =>
        upload(file, new URL(created.files[i].uploadUrl, location.href).href, (bytes) => {
          sent[i] = bytes;
          const done = sent.reduce((sum, n) => sum + n, 0);
          setState({ step: "uploading", progress: total ? done / total : 1 });
        }),
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
            setFiles([]);
            setTitle("");
            setMessage("");
            setState({ step: "select" });
          }}
        >
          Share more files
        </button>
      </div>
    );
  }

  const uploading = state.step === "uploading";
  return (
    <div className="card">
      <input
        type="file"
        multiple
        disabled={uploading}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          setFiles((current) => [...current, ...picked]);
          e.target.value = "";
        }}
        aria-label="Files to share"
      />
      {files.length > 0 && (
        <ul className="files">
          {files.map((file, i) => (
            <li key={i}>
              <div className="file-info">
                <span className="file-name">{file.name}</span>
                <span className="muted">{formatBytes(file.size)}</span>
              </div>
              <button
                className="secondary"
                disabled={uploading}
                onClick={() => setFiles((current) => current.filter((_, j) => j !== i))}
                aria-label={`Remove ${file.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span>
          Title <span className="muted">(optional)</span>
        </span>
        <input
          value={title}
          maxLength={MAX_TITLE_LENGTH}
          disabled={uploading}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        <span>
          Message <span className="muted">(optional)</span>
        </span>
        <textarea
          value={message}
          rows={3}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={uploading}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      {uploading && (
        <div>
          <progress value={state.progress} max={1} />
          <span className="muted">{Math.floor(state.progress * 100)}%</span>
        </div>
      )}
      {state.step === "failed" && <p className="error">Upload failed: {state.message}</p>}
      <button disabled={files.length === 0 || uploading} onClick={share}>
        {uploading ? "Uploading…" : "Upload and get link"}
      </button>
    </div>
  );
}

/** Runs `task` over `items` with at most `limit` running at once; stops at the first failure. */
async function inParallel<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await task(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function upload(file: File, uploadUrl: string, onProgress: (bytesSent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    new Upload(file, {
      uploadUrl,
      chunkSize: CHUNK_SIZE,
      retryDelays: [0, 1000, 3000, 5000],
      storeFingerprintForResuming: false,
      onProgress: (sent) => onProgress(sent),
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
