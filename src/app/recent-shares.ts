import { browserStorage } from "./browser-storage";

/**
 * A share this browser created, remembered so the uploader can find and
 * manage it again without an account. Only this browser ever sees the list.
 */
export interface RecentShare {
  /** Absolute share link. */
  url: string;
  /** Absolute management link; also identifies the entry. */
  manageUrl: string;
  title: string | null;
  /** ISO 8601. */
  expiresAt: string;
}

const KEY = "fireshare.recentShares";
/** Oldest entries are forgotten beyond this, so the list can't grow without bound. */
const MAX_ENTRIES = 100;

/** Newest first. Empty where storage is unavailable or holds something else. */
export function loadRecentShares(store = browserStorage()): RecentShare[] {
  try {
    const value: unknown = JSON.parse(store?.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(isRecentShare) : [];
  } catch {
    return [];
  }
}

export function addRecentShare(share: RecentShare, store = browserStorage()) {
  const others = loadRecentShares(store).filter((entry) => entry.manageUrl !== share.manageUrl);
  save([share, ...others].slice(0, MAX_ENTRIES), store);
}

/** Forgets the entry in this browser only; the share itself is untouched. */
export function removeRecentShare(manageUrl: string, store = browserStorage()) {
  save(loadRecentShares(store).filter((entry) => entry.manageUrl !== manageUrl), store);
}

function save(entries: RecentShare[], store: ReturnType<typeof browserStorage>) {
  try {
    store?.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Without storage, sharing still works; the share just isn't listed here.
  }
}

/** The management token in a management link. */
export function managementToken(manageUrl: string): string {
  return new URL(manageUrl).pathname.split("/").pop() ?? "";
}

function isRecentShare(value: unknown): value is RecentShare {
  if (typeof value !== "object" || value === null) return false;
  const { url, manageUrl, title, expiresAt } = value as Record<string, unknown>;
  return (
    typeof url === "string" &&
    typeof manageUrl === "string" &&
    URL.canParse(manageUrl) &&
    (title === null || typeof title === "string") &&
    typeof expiresAt === "string" &&
    !Number.isNaN(Date.parse(expiresAt))
  );
}
