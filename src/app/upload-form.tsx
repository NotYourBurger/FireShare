"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { uploadFile } from "./chunked-upload";
import { CopyField } from "./copy-field";
import { formatBytes, formatExpiry } from "./format";
import {
  clearPendingUpload,
  loadPendingUpload,
  matchFiles,
  savePendingUpload,
  type PendingUpload,
} from "./pending-upload";
import { addRecentShare } from "./recent-shares";

// Keep in step with MAX_TITLE_LENGTH and MAX_MESSAGE_LENGTH in src/server/http.ts.
const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5000;
const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

type FileStatus = "waiting" | "uploading" | "retrying" | "done" | "failed" | "paused";

interface FileProgress {
  name: string;
  size: number;
  sent: number;
  status: FileStatus;
}

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
        className="card"
        initial={{ opacity: 0, y: 18, scale: 0.98, filter: "blur(8px)" }}
        animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
        transition={{ duration: 0.65, ease: EASE_OUT_EXPO }}
      >
        <div className="step-header">
          <span className="step-badge">Complete</span>
          <strong>Your link is ready</strong>
        </div>
        <CopyField value={state.url} label="Share link" />
        <span className="muted">It expires in {formatExpiry(state.expiry)}.</span>
        <ManagementLink url={state.manageUrl} />
        <motion.button
          whileHover={{ scale: 1.015, y: -1 }}
          whileTap={{ scale: 0.985 }}
          onClick={() => {
            setFiles([]);
            setTitle("");
            setMessage("");
            setExpiry(expiryDefault);
            setState({ step: "select" });
          }}
        >
          Share more files
        </motion.button>
      </motion.div>
    );
  }

  if (state.step === "uploading" || state.step === "failed") {
    return (
      <motion.div
        key="uploading"
        className="card"
        initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.55, ease: EASE_OUT_EXPO }}
      >
        <div className="step-header">
          <span className="step-badge">{state.step === "failed" ? "Interrupted" : "Transferring"}</span>
        </div>
        <UploadProgress progress={state.progress} />
        {state.step === "failed" && (
          <>
            <p className="error">Upload failed: {state.message}</p>
            <div className="actions">
              <button onClick={() => run(state.job)}>Try again</button>
              <button className="secondary" onClick={startOver}>
                Start over
              </button>
            </div>
          </>
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
        className="card"
        initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
      >
        <div className="step-header">
          <span className="step-badge">Resume upload</span>
          <strong>Finish your upload</strong>
          <p className="muted">
            {missing.length > 0
              ? "An upload from this browser didn't finish. Select the same files again to continue where it stopped."
              : "An upload from this browser didn't finish. Everything is ready to continue."}
          </p>
        </div>
        <label className="dropzone">
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
          <span className="dropzone-plus" aria-hidden="true">
            +
          </span>
          <span className="dropzone-title">Re-select files to resume</span>
          <span className="dropzone-hint">Resumes from the last verified chunk</span>
        </label>
        <ul className="files">
          {pending.files.map((file, i) => (
            <li key={i}>
              <span className="file-index" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="file-info">
                <span className="file-name">{file.name}</span>
                <span className="muted">
                  {offsets[i] >= file.size
                    ? `${formatBytes(file.size)} · uploaded`
                    : `${formatBytes(offsets[i])} of ${formatBytes(file.size)} uploaded · ${
                        picked[i] ? "ready to continue" : "select this file"
                      }`}
                </span>
              </div>
            </li>
          ))}
        </ul>
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
          <button className="secondary" onClick={startOver}>
            Discard
          </button>
        </div>
      </motion.div>
    );
  }

  const totalSelectedBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <motion.div
      key="select"
      className="card"
      initial={{ opacity: 0, y: 18, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.65, ease: EASE_OUT_EXPO }}
    >
      <motion.label
        className={`dropzone ${dragging ? "is-dragging" : ""}`}
        whileHover={{ scale: 1.008, y: -2 }}
        whileTap={{ scale: 0.994 }}
        transition={{ type: "spring", stiffness: 360, damping: 24 }}
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
        <motion.span
          className="dropzone-plus"
          aria-hidden="true"
          animate={dragging ? { rotate: 90, scale: 1.15 } : { rotate: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 320, damping: 18 }}
        >
          +
        </motion.span>
        <span className="dropzone-title">Drop files here, or click to browse</span>
        <span className="dropzone-hint">
          {files.length > 0
            ? `${files.length === 1 ? "1 file" : `${files.length} files`} selected · ${formatBytes(totalSelectedBytes)}`
            : "Resumable chunked transfer · Integrity verified"}
        </span>
      </motion.label>

      <AnimatePresence initial={false}>
        {files.length > 0 && (
          <motion.ul
            className="files"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
          >
            <AnimatePresence initial={false}>
              {files.map((file, i) => (
                <motion.li
                  key={`${file.name}-${file.size}-${i}`}
                  initial={{ opacity: 0, x: -12, filter: "blur(4px)" }}
                  animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, x: 12, filter: "blur(4px)" }}
                  transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
                >
                  <span className="file-index" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="file-info">
                    <span className="file-name">{file.name}</span>
                    <span className="muted">{formatBytes(file.size)}</span>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => setFiles((current) => current.filter((_, j) => j !== i))}
                    aria-label={`Remove ${file.name}`}
                  >
                    Remove
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </AnimatePresence>

      <div className="fields-grid">
        <label className="field">
          <span>
            Title <span className="muted">(optional)</span>
          </span>
          <input
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            placeholder="e.g. Dailies — Scene 04"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Link expires after</span>
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
        <span>
          Message <span className="muted">(optional)</span>
        </span>
        <textarea
          value={message}
          rows={2}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder="Add a note or context for the recipient…"
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>

      {state.error && <p className="error">Upload failed: {state.error}</p>}
      <motion.button
        disabled={files.length === 0}
        onClick={share}
        whileHover={files.length > 0 ? { scale: 1.012, y: -1 } : undefined}
        whileTap={files.length > 0 ? { scale: 0.988 } : undefined}
        transition={{ type: "spring", stiffness: 400, damping: 20 }}
      >
        Upload and get link
      </motion.button>
    </motion.div>
  );
}

/** The management link, shown this one time only. */
export function ManagementLink({ url }: { url: string }) {
  return (
    <div className="save-link" role="note">
      <strong>Save your management link</strong>
      <p className="muted">
        It lets you check on this share or delete it early. Keep it private, and save it now: it&apos;s shown only
        this once. This browser also lists it under <a href="/recent">Recent shares</a>, unless it&apos;s a private
        window.
      </p>
      <CopyField value={url} label="Management link" />
    </div>
  );
}

const STATUS_LABEL: Record<FileStatus, string> = {
  waiting: "Waiting",
  uploading: "Uploading",
  retrying: "Retrying…",
  done: "Done",
  failed: "Failed",
  paused: "Paused",
};

/** Overall progress, then each file's state and progress. */
export function UploadProgress({ progress }: { progress: FileProgress[] }) {
  const total = progress.reduce((sum, file) => sum + file.size, 0);
  const sent = progress.reduce((sum, file) => sum + file.sent, 0);
  const fraction = total ? sent / total : progress.every((file) => file.status === "done") ? 1 : 0;
  return (
    <>
      <div className="progress-overview">
        <progress value={fraction} max={1} aria-label="Overall progress" />
        <span className="muted">
          {Math.floor(fraction * 100)}% · {formatBytes(sent)} of {formatBytes(total)}
        </span>
      </div>
      <ul className="files">
        {progress.map((file, i) => (
          <li key={i} data-status={file.status}>
            <div className="file-info">
              <span className="file-name">{file.name}</span>
              <progress value={file.size ? file.sent / file.size : file.status === "done" ? 1 : 0} max={1} />
              <span className="muted">
                {STATUS_LABEL[file.status]}
                {file.status !== "done" && file.size > 0 && ` · ${Math.floor((file.sent / file.size) * 100)}%`}
              </span>
            </div>
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
