import { formatBytes } from "@/app/format";
import type { SharePage } from "@/server/shares";

/** The recipient page. Everything the sender wrote is rendered as plain text. */
export function ShareView({
  token,
  share,
  children,
}: {
  token: string;
  share: SharePage;
  /** Shown below the files. */
  children?: React.ReactNode;
}) {
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
      {share.message && <p className="card message">{share.message}</p>}
      {share.downloadAll && share.files.length > 1 && (
        <div className="download-all-bar">
          <a className="button" href={`/d/${token}/all`}>
            Download all as zip
          </a>
        </div>
      )}
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
            <a
              className="button"
              href={`/d/${token}/files/${file.id}`}
              aria-label={`Download ${file.name}`}
            >
              Download
            </a>
          </li>
        ))}
      </ul>
      {children}
    </main>
  );
}

/** Shown in place of the files once the share's link has expired or been deleted. */
export function ShareUnavailable() {
  return (
    <main>
      <div className="page-heading">
        <h1>This link is no longer available</h1>
      </div>
      <div className="card">
        <p className="muted">
          It has expired or the sender deleted it, so its files can&apos;t be downloaded. Ask the sender for a new link.
        </p>
      </div>
    </main>
  );
}
