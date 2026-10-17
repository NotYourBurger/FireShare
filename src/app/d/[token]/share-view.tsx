import { formatBytes } from "@/app/format";
import type { SharePage } from "@/server/shares";

/** The recipient page. Everything the sender wrote is rendered as plain text. */
export function ShareView({ token, share }: { token: string; share: SharePage }) {
  const total = share.files.reduce((sum, file) => sum + file.size, 0);
  const count = share.files.length === 1 ? "1 file" : `${share.files.length} files`;
  return (
    <main>
      <h1 className="share-title">{share.title ?? "Shared files"}</h1>
      <p className="tagline">
        {count} · {formatBytes(total)}
      </p>
      {share.message && <p className="card message">{share.message}</p>}
      {share.downloadAll && share.files.length > 1 && (
        <p>
          <a className="button" href={`/d/${token}/all`}>
            Download all as zip
          </a>
        </p>
      )}
      <ul className="card files">
        {share.files.map((file) => (
          <li key={file.id}>
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
    </main>
  );
}

/** Shown in place of the files once the share's link has expired or been deleted. */
export function ShareUnavailable() {
  return (
    <main>
      <h1>This link is no longer available</h1>
      <p className="muted">
        It has expired or the sender deleted it, so its files can&apos;t be downloaded. Ask the sender for a new link.
      </p>
    </main>
  );
}
