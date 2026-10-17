"use client";

import { useEffect, useState } from "react";
import { CopyField } from "@/app/copy-field";
import { LocalTime } from "@/app/local-time";
import { loadRecentShares, managementToken, removeRecentShare, type RecentShare } from "@/app/recent-shares";
import type { ShareStatus } from "@/server/shares";

/** What the server says about an entry: its status, "gone" when it no longer knows the share, or unknown yet. */
export type EntryStatus = ShareStatus | "gone" | "unknown";

export function RecentSharesList() {
  const [entries, setEntries] = useState<RecentShare[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, EntryStatus>>({});

  useEffect(() => {
    const loaded = loadRecentShares();
    setEntries(loaded);
    let cancelled = false;
    for (const entry of loaded) {
      fetchStatus(entry).then((status) => {
        if (!cancelled) setStatuses((current) => ({ ...current, [entry.manageUrl]: status }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (entries === null) return null;
  return (
    <RecentSharesView
      entries={entries}
      statuses={statuses}
      onRemove={(manageUrl) => {
        removeRecentShare(manageUrl);
        setEntries((current) => current?.filter((entry) => entry.manageUrl !== manageUrl) ?? null);
      }}
    />
  );
}

export function RecentSharesView({
  entries,
  statuses,
  onRemove,
}: {
  entries: RecentShare[];
  statuses: Record<string, EntryStatus>;
  onRemove: (manageUrl: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="card">
        <p className="muted">
          No shares yet. Shares you create in this browser are listed here, except in private windows or when site data
          is blocked.
        </p>
      </div>
    );
  }
  return (
    <>
      <ul className="card files recent">
        {entries.map((entry) => {
          const status = statuses[entry.manageUrl] ?? "unknown";
          return (
            <li key={entry.manageUrl}>
              <div className="file-info">
                <span className="file-name">{entry.title ?? "Shared files"}</span>
                <span className="muted">
                  <EntryStatusText entry={entry} status={status} />
                </span>
                {status === "active" && <CopyField value={entry.url} label="Share link" />}
                <div className="actions">
                  {status !== "gone" && (
                    <a className="button secondary" href={entry.manageUrl}>
                      Manage
                    </a>
                  )}
                  <button
                    className="secondary"
                    onClick={() => onRemove(entry.manageUrl)}
                    aria-label={`Remove ${entry.title ?? "Shared files"} from this list`}
                  >
                    Remove from list
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="muted note">Removing a share from this list doesn&apos;t delete it. Use Manage for that.</p>
    </>
  );
}

function EntryStatusText({ entry, status }: { entry: RecentShare; status: EntryStatus }) {
  switch (status) {
    case "active":
      return (
        <>
          Active · expires <LocalTime value={entry.expiresAt} />
        </>
      );
    case "expired":
      return (
        <>
          Expired <LocalTime value={entry.expiresAt} />
        </>
      );
    case "deleted":
      return <>Deleted</>;
    case "gone":
      return <>No longer available</>;
    case "unknown":
      // Until the server answers, go by the expiry this browser remembers.
      return Date.parse(entry.expiresAt) <= Date.now() ? (
        <>
          Expired <LocalTime value={entry.expiresAt} />
        </>
      ) : (
        <>
          Expires <LocalTime value={entry.expiresAt} />
        </>
      );
  }
}

async function fetchStatus(entry: RecentShare): Promise<EntryStatus> {
  try {
    const res = await fetch(`/api/manage/${managementToken(entry.manageUrl)}`, { cache: "no-store" });
    if (res.status === 404) return "gone";
    if (!res.ok) return "unknown";
    const { status } = (await res.json()) as { status: ShareStatus };
    return status;
  } catch {
    return "unknown";
  }
}
