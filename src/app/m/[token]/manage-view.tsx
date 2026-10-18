import { formatBytes } from "@/app/format";
import { LocalTime } from "@/app/local-time";
import type { ManagedShare, ShareStatus } from "@/server/shares";
import { DeleteShare } from "./delete-share";

/** A {@link ManagedShare} as it crosses from server to browser. */
export type ManagedShareData = Omit<ManagedShare, "expiresAt" | "deletedAt"> & {
  expiresAt: string;
  deletedAt: string | null;
};

export const STATUS_LABEL: Record<ShareStatus, string> = {
  active: "Active",
  expired: "Expired",
  deleted: "Deleted",
};

/** The management page. Everything the sender wrote is rendered as plain text. */
export function ManageView({ token, share }: { token: string; share: ManagedShareData }) {
  const total = share.files.reduce((sum, file) => sum + file.size, 0);
  const count = share.files.length === 1 ? "1 file" : `${share.files.length} files`;
  const padDigits = Math.max(2, String(share.files.length).length);
  return (
    <main>
      <div className="page-heading">
        <h1 className="share-title">{share.title ?? "Shared files"}</h1>
        <p className="tagline">
          {count} · {formatBytes(total)}
        </p>
      </div>
      <div className="card">
        <p className="status-row">
          <span className="status" data-status={share.status}>
            {STATUS_LABEL[share.status]}
          </span>{" "}
          {share.status === "active" && (
            <>
              Expires <LocalTime value={share.expiresAt} />
            </>
          )}
          {share.status === "expired" && (
            <>
              Expired <LocalTime value={share.expiresAt} />
            </>
          )}
          {share.status === "deleted" && share.deletedAt && (
            <>
              Deleted <LocalTime value={share.deletedAt} />
            </>
          )}
        </p>
        <p className="muted">
          {share.status === "active"
            ? "Anyone with the share link can download these files until then."
            : "The share link no longer works, and the files will be removed from storage."}
        </p>
        {share.status === "active" && <DeleteShare token={token} />}
      </div>
      {share.message && <p className="card message">{share.message}</p>}
      <ul className="card files">
        {share.files.map((file, i) => (
          <li key={file.id}>
            <span className="file-index" aria-hidden="true">
              {String(i + 1).padStart(padDigits, "0")}
            </span>
            <div className="file-info">
              <span className="file-name">{file.name}</span>
              <span className="muted">{formatBytes(file.size)}</span>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
