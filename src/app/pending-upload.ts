/**
 * The share this browser is uploading, remembered so that reopening the page
 * after a closed tab or a crash can pick up where it stopped. Browsers can't
 * reopen files by themselves, so the uploader selects them again and they are
 * matched by name, size and modification time.
 */
export interface PendingUpload {
  shareId: string;
  /** The expiry preset chosen, to show once the link is ready. */
  expiry: string;
  files: PendingFile[];
}

export interface PendingFile {
  name: string;
  size: number;
  lastModified: number;
  /** Absolute tus upload URL. */
  uploadUrl: string;
}

const KEY = "fireshare.pendingUpload";

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage, or null where it's blocked (private windows, disabled site data). */
function browserStorage(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function savePendingUpload(pending: PendingUpload, store = browserStorage()) {
  try {
    store?.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Without storage the upload still works; it just can't be resumed.
  }
}

export function loadPendingUpload(store = browserStorage()): PendingUpload | null {
  try {
    const value: unknown = JSON.parse(store?.getItem(KEY) ?? "null");
    return isPendingUpload(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearPendingUpload(store = browserStorage()) {
  try {
    store?.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}

/** For each pending file, the picked file that is the same file, if any. */
export function matchFiles(pending: PendingUpload, picked: File[]): (File | undefined)[] {
  return pending.files.map((file) =>
    picked.find(
      (candidate) =>
        candidate.name === file.name && candidate.size === file.size && candidate.lastModified === file.lastModified,
    ),
  );
}

function isPendingUpload(value: unknown): value is PendingUpload {
  if (typeof value !== "object" || value === null) return false;
  const { shareId, expiry, files } = value as Record<string, unknown>;
  return (
    typeof shareId === "string" &&
    typeof expiry === "string" &&
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        typeof file.name === "string" &&
        typeof file.size === "number" &&
        typeof file.lastModified === "number" &&
        typeof file.uploadUrl === "string",
    )
  );
}
