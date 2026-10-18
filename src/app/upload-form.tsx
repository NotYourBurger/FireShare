"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { uploadFile } from "./chunked-upload";
import { CopyField, LinkSlab } from "./copy-field";
import { formatBytes, formatExpiry } from "./format";
import { CrossIcon, PlusIcon } from "./icons";
import {
  clearPendingUpload,
  loadPendingUpload,
  matchFiles,
  savePendingUpload,
  type PendingUpload,
} from "./pending-upload";
import { addRecentShare } from "./recent-shares";
import { fileStatusText, UploadDial, type FileProgress } from "./upload-dial";

// Keep in step with MAX_TITLE_LENGTH and MAX_MESSAGE_LENGTH in src/server/http.ts.
const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5000;
const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** A created share being uploaded; a null file has already fully arrived. */
interface Job {
  pending: PendingUpload;
  files: (File | null)[];
  partUrls?: (string[] | undefined)[];
}

type State =
  | { step: "select"; error?: string }
  | { step: "resume"; pending: PendingUpload; offsets: number[]; picked: (File | undefined)[]; error?: string }
  | { step: "uploading"; progress: FileProgress[] }
  | { step: "failed"; job: Job; progress: FileProgress[]; message: string }
  | { step: "done"; url: string; manageUrl: string; expiry: string };

export function UploadForm({
  expiryOptions,
  expiryDefault,
  chunkSize,
  parallelFiles,
}: {
  expiryOptions: string[];
  expiryDefault: string;
  chunkSize: number;
  parallelFiles: number;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [expiry, setExpiry] = useState(expiryDefault);
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<State>({ step: "select" });

  // Offer to resume an upload this browser didn't finish.
  useEffect(() => {
    const pending = loadPendingUpload();
    if (!pending) return;
    let cancelled = false;
    Promise.all(pending.files.map((file) => uploadOffset(file.uploadUrl)))
      .then((offsets) => {
        if (cancelled) return;
        if (offsets.some((offset) => offset === null)) {
          // The share was finalized or removed in the meantime.
          clearPendingUpload();
          return;
        }
        setState({ step: "resume", pending, offsets: offsets as number[], picked: pending.files.map(() => undefined) });
      })
      .catch(() => {
        // Server unreachable: keep the record for the next visit.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function share() {
    if (files.length === 0) return;
    setState({
      step: "uploading",
      progress: files.map(({ name, size }) => ({ name, size, sent: 0, status: "waiting" })),
    });
    let created;
    try {
      created = await postJson("/api/shares", {
        title,
        message,
        expiry,
        files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
      });
    } catch (err) {
      setState({ step: "select", error: errorMessage(err) });
      return;
    }
    const direct = Array.isArray(created.files[0]?.partUrls);
    const pending: PendingUpload = {
      shareId: created.id,
      expiry,
      title: title.trim() || null,
      ...(direct ? { direct: true } : {}),
      files: files.map((file, i) => ({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        uploadUrl: new URL(created.files[i].uploadUrl, location.href).href,
      })),
    };
    savePendingUpload(pending);
    await run({
      pending,
      files,
      partUrls: direct ? created.files.map((f: { partUrls?: string[] }) => f.partUrls) : undefined,
    });
  }

  /** Uploads every file of the job that hasn't fully arrived, then finalizes the share. */
  async function run(job: Job) {
    const progress: FileProgress[] = job.pending.files.map(({ name, size }, i) => ({
      name,
      size,
      sent: job.files[i] ? 0 : size,
      status: job.files[i] ? "waiting" : "done",
    }));
    // One failed file stops the others; "Try again" resumes them all.
    const abort = new AbortController();
    const update = (i: number, change: Partial<FileProgress>) => {
      if (abort.signal.aborted) return;
      progress[i] = { ...progress[i], ...change };
      setState({ step: "uploading", progress: [...progress] });
    };
    setState({ step: "uploading", progress: [...progress] });

    const queue = job.files.flatMap((file, i) => (file ? [i] : []));
    async function worker() {
      for (let i = queue.shift(); i !== undefined && !abort.signal.aborted; i = queue.shift()) {
        update(i, { status: "uploading" });
        try {
          await uploadFile(job.files[i]!, job.pending.files[i].uploadUrl, {
            chunkSize,
            direct: job.pending.direct,
            partUrls: job.partUrls?.[i],
            signal: abort.signal,
            onProgress: (sent) => update(i, { sent }),
            onRetry: () => update(i, { status: "retrying" }),
            onChunkAccepted: () => update(i, { status: "uploading" }),
          });
          update(i, { status: "done", sent: progress[i].size });
        } catch (err) {
          update(i, { status: "failed" });
          abort.abort(err);
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(parallelFiles, queue.length) }, worker));
      if (abort.signal.aborted) throw abort.signal.reason;
      const { path, managementPath, expiresAt } = await postJson(`/api/shares/${job.pending.shareId}/finalize`);
      const url = new URL(path, location.href).href;
      const manageUrl = new URL(managementPath, location.href).href;
      clearPendingUpload();
      addRecentShare({ url, manageUrl, title: job.pending.title ?? null, expiresAt });
      setState({ step: "done", url, manageUrl, expiry: job.pending.expiry });
    } catch (err) {
      const stopped = progress.map((file) =>
        file.status === "done" || file.status === "failed" ? file : { ...file, status: "paused" as const },
      );
      setState({
        step: "failed",
        job: { pending: job.pending, files: job.files },
        progress: stopped,
        message: errorMessage(err),
      });
    }
  }

  function startOver() {
    clearPendingUpload();
    setState({ step: "select" });
  }

  if (state.step === "done") {
    return (
      <motion.div
        key="done"
        className="sheet"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: EASE_OUT_EXPO }}
      >
        <div className="sheet-section">
          <div className="sheet-head">
            <h2>Your link is ready</h2>
            <span className="muted">Expires in {formatExpiry(state.expiry)}</span>
          </div>
          <LinkSlab value={state.url} />
        </div>
        <ManagementLink url={state.manageUrl} />
        <div className="sheet-section sheet-foot">
          <button
            className="quiet"
            onClick={() => {
              setFiles([]);
              setTitle("");
              setMessage("");
              setExpiry(expiryDefault);
              setState({ step: "select" });
            }}
          >
            Share more files
          </button>
        </div>
      </motion.div>
    );
  }

  if (state.step === "uploading" || state.step === "failed") {
    return (
      <motion.div
        key="uploading"
        className="sheet"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE_OUT_EXPO }}
      >
        <UploadProgress progress={state.progress} stopped={state.step === "failed"} />
        {state.step === "failed" && (
          <div className="sheet-section">
            <p className="error">Upload failed: {state.message}</p>
            <div className="actions">
              <button onClick={() => run(state.job)}>Try again</button>
              <button className="quiet" onClick={startOver}>
                Start over
              </button>
            </div>
          </div>
        )}
      </motion.div>
    );
  }

  if (state.step === "resume") {
    const { pending, offsets, picked } = state;
    const missing = pending.files.filter((file, i) => offsets[i] < file.size && !picked[i]);
    return (
      <motion.div
        key="resume"
        className="sheet"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: EASE_OUT_EXPO }}
      >
        <div className="sheet-section">
          <div className="sheet-head">
            <h2>Finish your upload</h2>
          </div>
          <p className="muted">
            {missing.length > 0
              ? "An upload from this browser didn't finish. Select the same files again to continue where it stopped."
              : "An upload from this browser didn't finish. Everything is ready to continue."}
          </p>
          {missing.length > 0 && (
            <label className="drop">
              <input
                type="file"
                multiple
                onChange={(e) => {
                  const chosen = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  const matched = matchFiles(pending, chosen);
                  const unknown = chosen.filter((file) => !matched.includes(file));
                  setState({
                    ...state,
                    picked: picked.map((file, i) => matched[i] ?? file),
                    error: unknown.length
                      ? `Not part of this upload, or changed since: ${unknown.map((file) => file.name).join(", ")}`
                      : undefined,
                  });
                }}
                aria-label="Select the same files again"
              />
              <span className="drop-icon" aria-hidden="true">
                <PlusIcon />
              </span>
              <span className="drop-text">
                <span className="drop-title">Select the same files again</span>
                <span className="drop-hint">It continues from the last verified chunk</span>
              </span>
            </label>
          )}
        </div>
        <ul className="rows">
          {pending.files.map((file, i) => (
            <li key={i} className="row row-progress">
              <span className="row-index" aria-hidden="true">
                {String(i + 1).padStart(Math.max(2, String(pending.files.length).length), "0")}
              </span>
              <span className="row-name">{file.name}</span>
              <span className="row-meta">
                {offsets[i] >= file.size
                  ? `${formatBytes(file.size)}, uploaded`
                  : `${formatBytes(offsets[i])} of ${formatBytes(file.size)}${
                      picked[i] ? ", ready to continue" : ", select this file"
                    }`}
              </span>
            </li>
          ))}
        </ul>
        <div className="sheet-section">
          {state.error && <p className="error">{state.error}</p>}
          <div className="actions">
            <button
              disabled={missing.length > 0}
              onClick={() =>
                run({ pending, files: pending.files.map((file, i) => (offsets[i] < file.size ? picked[i]! : null)) })
              }
            >
              Continue upload
            </button>
            <button className="quiet" onClick={startOver}>
              Discard
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  const totalSelectedBytes = files.reduce((sum, file) => sum + file.size, 0);
  const padDigits = Math.max(2, String(files.length).length);

  return (
    <motion.div
      key="select"
      className="sheet"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
    >
      <div className="sheet-section">
        <label
          className={`drop ${dragging ? "is-dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = Array.from(e.dataTransfer?.files ?? []);
            if (dropped.length > 0) {
              setFiles((current) => [...current, ...dropped]);
            }
          }}
        >
          <input
            type="file"
            multiple
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              setFiles((current) => [...current, ...picked]);
              e.target.value = "";
            }}
            aria-label="Files to share"
          />
          <span className="drop-icon" aria-hidden="true">
            <PlusIcon />
          </span>
          <span className="drop-text">
            <span className="drop-title">{files.length > 0 ? "Add more files" : "Drop files, or click to browse"}</span>
            <span className="drop-hint">
              {files.length > 0
                ? `${files.length === 1 ? "1 file" : `${files.length} files`}, ${formatBytes(totalSelectedBytes)}`
                : "Large uploads pick up where they left off if interrupted"}
            </span>
          </span>
        </label>
      </div>

      <AnimatePresence initial={false}>
        {files.length > 0 && (
          <motion.div
            className="rows-section"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
          >
            {files.length > 1 && (
              <div className="rows-bar">
                <span className="rows-summary">
                  {files.length} files · {formatBytes(totalSelectedBytes)}
                </span>
                <button
                  type="button"
                  className="quiet rows-clear"
                  onClick={() => setFiles([])}
                  aria-label="Clear all selected files"
                >
                  Clear all
                </button>
              </div>
            )}
            <ul className="rows">
              {files.map((file, i) => (
                <li key={`${file.name}-${file.size}-${i}`} className="row row-selected">
                  <span className="row-index" aria-hidden="true">
                    {String(i + 1).padStart(padDigits, "0")}
                  </span>
                  <span className="row-name">{file.name}</span>
                  <span className="row-meta">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    className="icon"
                    onClick={() => setFiles((current) => current.filter((_, j) => j !== i))}
                    aria-label={`Remove ${file.name}`}
                    title="Remove"
                  >
                    <CrossIcon />
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="sheet-section">
        <div className="fields-grid">
          <label className="field">
            <span>Title</span>
            <input
              value={title}
              maxLength={MAX_TITLE_LENGTH}
              placeholder="Optional"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Expires after</span>
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {expiryOptions.map((option) => (
                <option key={option} value={option}>
                  {formatExpiry(option)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Message</span>
          <textarea
            value={message}
            rows={2}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="Optional note for the recipient"
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        {state.error && <p className="error">Upload failed: {state.error}</p>}
        <button className="primary-wide" disabled={files.length === 0} onClick={share}>
          Upload and get link
        </button>
      </div>
    </motion.div>
  );
}

/** The management link, shown this one time only. */
export function ManagementLink({ url }: { url: string }) {
  return (
    <div className="sheet-section manage-link" role="note">
      <div className="sheet-head">
        <h3>Save your management link</h3>
      </div>
      <CopyField value={url} label="Management link" />
      <p className="muted">
        Use it to check on this share or delete it early. Keep it private and save it now: it&apos;s shown only this
        once. This browser also keeps it under <a href="/recent">Recent shares</a>, except in private windows.
      </p>
    </div>
  );
}

/** The dial for the whole upload, then each file's state. */
export function UploadProgress({ progress, stopped = false }: { progress: FileProgress[]; stopped?: boolean }) {
  const padDigits = Math.max(2, String(progress.length).length);
  return (
    <>
      <UploadDial progress={progress} stopped={stopped} />
      <ul className="rows">
        {progress.map((file, i) => (
          <li key={i} className="row row-progress" data-status={file.status}>
            <span className="row-index" aria-hidden="true">
              {String(i + 1).padStart(padDigits, "0")}
            </span>
            <span className="row-name">{file.name}</span>
            <span className="row-meta">{fileStatusText(file)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** How many bytes of a pending upload the server has, or null if it no longer exists. */
async function uploadOffset(uploadUrl: string): Promise<number | null> {
  const res = await fetch(uploadUrl, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" }, cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return Number(res.headers.get("Upload-Offset"));
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
