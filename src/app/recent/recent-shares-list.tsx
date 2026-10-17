"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "@/app/copy-field";
import { CrossIcon } from "@/app/icons";
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
      <div className="sheet">
        <div className="sheet-section">
          <p className="muted">
            No shares yet. Shares you create in this browser are listed here, except in private windows or when site
            data is blocked.
          </p>
          <div className="actions">
            <a className="button" href="/">
              Share files
            </a>
          </div>
        </div>
      </div>
    );
  }
  return (
    <>
      <ul className="sheet rows recent">
        {entries.map((entry) => {
          const status = statuses[entry.manageUrl] ?? "unknown";
          const name = entry.title ?? "Shared files";
          return (
            <li key={entry.manageUrl} className="row" data-status={status}>
              <div className="recent-main">
                {status === "active" ? (
                  <a className="row-name" href={entry.url} target="_blank" rel="noreferrer">
                    {name}
                  </a>
                ) : (
                  <span className="row-name">{name}</span>
                )}
                <span className="recent-status">
                  <span className="status-dot" aria-hidden="true" />
                  <EntryStatusText entry={entry} status={status} />
                </span>
              </div>
              <div className="recent-actions">
                {status === "active" && (
                  <CopyButton value={entry.url} label={`Copy share link for ${name}`}>
                    Copy link
                  </CopyButton>
                )}
                {status !== "gone" && (
                  <a className="button quiet" href={entry.manageUrl}>
                    Manage
                  </a>
                )}
                <button
                  className="icon"
                  onClick={() => onRemove(entry.manageUrl)}
                  aria-label={`Remove ${name} from this list`}
                  title="Remove from list"
                >
                  <CrossIcon />
                </button>
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
