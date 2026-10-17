# FireShare

**Self-hosted temporary file sharing. Upload files, get one link, and the files delete themselves when the link expires.**

FireShare lets a user upload a bundle of files to S3-compatible storage and get back a short, unguessable link. Anyone with the link can download the files, one at a time or all together as a single zip, until the link expires. After that the files are deleted automatically.

It runs on your own hardware, from a small NAS to a cloud server, with one Docker Compose file. It is fast on the local network and locked down on the public internet.

---

## Why FireShare

Services like WeTransfer and SendGB are convenient, but your files sit on someone else's servers, size limits and retention are set by them, and large transfers often require a paid plan.

FireShare gives teams the same simple upload-and-share experience while keeping the files, the access rules and the limits under their own control.

**First deployment:** FireDrum Studios uses FireShare to send large production files (VFX, 3D, video) between staff and clients. It is hosted on the studio's Synology NAS and reachable through a company subdomain.

---

## Goals

- **Simple to use:** upload, get a link, share. Recipients never need an account.
- **Simple to host:** one `docker compose up` on any x86_64 or ARM64 machine.
- **Built for large files:** shares up to 50 GB (configurable), with uploads and downloads that resume after interruptions.
- **Fast inside, safe outside:** local network users can transfer directly to storage at full disk speed, while internet users always go through the app and never see the storage server.
- **Temporary by design:** every share has an expiry, and expired files are removed automatically.
- **Secure by default:** safe settings out of the box. Opening up access is an explicit choice.
- **Configurable:** transfer mode, limits, quotas and expiry options are set in `.env`, not code.

## Non-goals

- Not a cloud drive or sync tool (no folders, versioning or permanent storage).
- Not a collaboration or file-preview platform.
- Not a multi-tenant SaaS (one deployment serves one organization).

---

## Core Concepts

- **Share:** one upload of one or more files behind one link. A share has an expiry, an optional title and message, and a status (`pending`, `ready`, `expired`, `deleted`). Once a share is created, no files can be added to it.
- **Share link:** `share.example.com/d/<token>` is what the uploader sends to recipients.
- **Management link:** a second, secret link shown once at creation. Whoever holds it can see the share's status and delete it early.
- **Recent shares:** the uploader's browser remembers the share and management links it created, so they can be found again without an account.

---

## Core Flow

1. **Select:** the uploader picks files, an expiry from the configured presets, and an optional title and message.
2. **Authorize:** the server checks upload access (upload password or allowed IPs), rate limits, quotas and the size and file-count limits. Only then does it create a `pending` share with a random storage key for each file.
3. **Transfer:** files upload in chunks, several at a time, either through the app or directly to storage (see Transfer Modes). Uploads interrupted by a closed tab or a dropped connection resume from the last completed chunk in the same browser.
4. **Finalize:** the server checks every file's size and integrity and records its fingerprint. A share becomes `ready` only when **all** of its files have passed. The uploader then gets the share link and the management link.
5. **Download:** the recipient opens the link and sees the sender's message and the file list with sizes. Each file can be downloaded on its own, or everything together with **Download all** as one zip. Before any bytes are served, the server checks expiry and the stored file's fingerprint.
6. **Expire:** at expiry, or on early deletion, the link stops working immediately. After a short grace period, so downloads already in progress can finish, the cleanup worker deletes the files from storage.

---

## Transfer Modes

`TRANSFER_MODE` decides how file bytes travel. In every mode the server authorizes each transfer first, and the storage API is never reachable from the internet.

| Mode | Data path | Use |
|---|---|---|
| `proxy` **(default)** | Browser ↔ app ↔ storage, streamed | Public access. Storage stays fully internal, and the app verifies every chunk. |
| `direct` | Browser ↔ storage, through short-lived server-signed URLs | Internal-only deployments that want full local network speed. |
| `auto` | `direct` for clients on `DIRECT_NETWORKS`, `proxy` for everyone else | Studio setup: staff on the LAN or VPN get full speed, clients on the internet get the locked-down path. |

**Proxy mode**
- Uploads use the [tus](https://tus.io) resumable protocol, with chunks of about 64 MB. The app streams each chunk straight into a storage multipart part and never buffers whole files.
- The browser sends a SHA-256 hash with each chunk. The app checks it before writing, and a chunk that fails the check is retried on its own.
- The app also computes a CRC32 for each chunk as it passes. Because of this, Download all has a known size up front and can resume like any other download.
- Downloads are streamed from storage with HTTP Range support, so interrupted downloads resume.

**Direct mode**
- The server issues presigned URLs, each scoped to one random storage key, one action and a few minutes. Without a valid signature, storage rejects every request, so the bucket can't be written to or listed.
- The browser does no hashing. At finalize the server checks each file's size and ETag.
- The cleanup worker computes each file's CRC32 in the background. Until that finishes, Download all still works but can't be resumed.
- Storage is reached at `STORAGE_DIRECT_ENDPOINT`. That hostname must use HTTPS, resolve only inside the local network (split DNS, no router port forward), and allow only the app's origin in its CORS rules. The app refuses to start if direct or auto mode is set without a valid HTTPS endpoint.

**Client network detection (`auto`)**
- The client IP is taken from `X-Forwarded-For` only when the request comes from a proxy listed in `TRUSTED_PROXIES` (for example DSM's reverse proxy). This stops clients from forging a LAN address.

---

## Architecture

| Component | Role |
|---|---|
| **Web app** (Next.js) | UI and API: upload sessions (tus), finalize, share and management pages, streaming downloads and zips, presigned URLs in direct mode |
| **Cleanup worker** (Node.js) | Scheduled jobs: deletes expired and deleted shares after the grace period, removes abandoned pending uploads and their incomplete multipart uploads, computes CRC32s for direct-mode files |
| **Database** (PostgreSQL) | Shares, files, chunk hashes and fingerprints, link token hashes, quota counters |
| **Object storage** (S3 API) | The file bytes: RustFS by default, or any S3-compatible service |

### Design principles

- **Server-authorized transfers:** no byte is written or read without the server first checking access, limits and expiry.
- **Storage never public:** the storage API is only on the internal Docker network, plus an optional LAN-only HTTPS endpoint for direct mode.
- **Streams, never buffers:** in proxy mode, app memory stays flat no matter how big the file is.
- **All or nothing:** a share is either complete and verified, or it doesn't exist.
- **Stateless app:** all state lives in PostgreSQL and storage. App containers can be rebuilt, updated or moved without losing data.
- **Storage adapter:** all storage access goes through one interface (`createUpload`, `writePart`, `completeUpload`, `getReadStream`, `getPresignedUrl`, `head`, `delete`). The v1 driver is `s3`.
- **Expiry enforced twice:** links are checked at download time; the cleanup worker only reclaims disk space.
- **Configuration through environment:** one `.env` file defines domains, secrets, transfer mode, limits and storage.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Web app & API | Next.js (standalone build) |
| Resumable uploads | tus protocol (tus server in the app, tus client in the browser) |
| Worker | Node.js |
| Database | PostgreSQL |
| Storage | RustFS (default, bundled in Compose), or any S3-compatible API |
| Deployment | Docker Compose, multi-arch images (amd64 / arm64) |

**FireDrum Studios deployment:** a Synology NAS runs the stack in Container Manager with RustFS on the internal network. DSM's reverse proxy provides HTTPS for the public app domain and for a LAN-only storage hostname. `TRANSFER_MODE=auto` gives studio staff direct transfers while clients go through proxy mode.

---

## Security

### Upload access (v1)

v1 has no user accounts. Upload access is controlled by:

- **Upload password** (`UPLOAD_PASSWORD`): required by default. Uploaders enter it once and get a signed session cookie. Recipients never need it. The app refuses to start without one unless `ALLOW_PUBLIC_UPLOAD=true` is set explicitly.
- **IP allowlist** (`UPLOAD_ALLOWED_IPS`): optional. Restricts uploads to given networks, for example the office and VPN.

Downloads always need only the share link.

### Always on

**Upload integrity**
- **Server authorization first:** no upload starts until access, rate limits, quotas, and the size and file-count limits pass.
- **Server-chosen storage keys:** each file gets a random storage key. Client filenames are stored as metadata only and never become storage paths.
- **Chunk verification (proxy):** each chunk's SHA-256 is checked before it is written.
- **Quarantine until finalize:** files in `pending` shares can't be shared or downloaded. At finalize the server checks real sizes, deletes anything that fails, and only then marks the share `ready`.
- **Tamper detection:** each file's fingerprint is recorded at finalize and checked before every download. If the stored object has changed, the download is refused.
- **Abandoned upload cleanup:** pending shares older than `PENDING_TTL` (default 24h) are removed together with their incomplete multipart uploads.

**Links and downloads**
- **Unguessable links:** 128-bit random tokens (about 22 characters) for both share and management links, never sequential IDs.
- **Token hashing:** only hashes of link tokens are stored, so a database leak exposes no working links.
- **Safe downloads:** files are always served as attachments with `nosniff`, so uploaded HTML or SVG never renders as a page.
- **Immediate revocation:** expired and deleted shares stop serving at once. Bytes are removed after `DELETE_GRACE` (default 1h).

**Platform**
- **Private bucket:** no anonymous reads, writes or listing.
- **Internal storage:** the storage API and admin console are never published to the internet. Direct mode uses a separate LAN-only HTTPS hostname.
- **Trusted proxies only:** client IPs for rate limits, quotas and `auto` mode come from forwarded headers only when the request arrives through `TRUSTED_PROXIES`.
- **Rate limiting per IP:** on uploads and downloads, in the app and at the reverse proxy.
- **Least-privilege storage key:** the app's storage key can access one bucket only, and the secret never leaves the server.
- **Hardened containers:** non-root users, `no-new-privileges`, memory limits.

### Limits and quotas

All of these are set in `.env`. Each is optional and is turned off when left empty.

| Variable | Purpose | Reference default |
|---|---|---|
| `MAX_SHARE_SIZE` | Total size of one share | `50GB` |
| `MAX_FILES_PER_SHARE` | Files in one share | `500` |
| `MAX_TOTAL_STORAGE` | Total size of all active shares (ready + pending), counted from the database | off |
| `UPLOAD_QUOTA_PER_IP` | Bytes uploaded per IP per 24h | off |
| `MAX_ACTIVE_SHARES_PER_IP` | Unexpired shares per IP | off |
| `RATE_LIMIT_UPLOAD` / `RATE_LIMIT_DOWNLOAD` | Requests per minute per IP | on |
| `EXPIRY_OPTIONS` / `EXPIRY_DEFAULT` | Expiry presets shown to uploaders | `1d,3d,7d,14d,30d` / `7d` |

Limits are checked when an upload is authorized, before any bytes are sent; pending shares count, so parallel uploads can't race past one. A client that sends more bytes than it declared is cut off and its share fails.

When `ALLOW_PUBLIC_UPLOAD=true`, quotas and rate limits are strongly recommended, and every download page shows an abuse-report link.

---

## Storage & Scaling

Storage needed levels off at roughly **daily upload volume × average retention × 1.5**, because files expire. Growth path:

1. **Scale up:** larger disks or volume expansion on a single node.
2. **Scale out:** a multi-node storage cluster with replication across machines.
3. **Multiple backends (v2):** route uploads by rule to on-premise or cloud storage. Every file records which backend holds it, so old backends empty out naturally as their files expire.

---

## Roadmap

**v1: Core**
- Multi-file shares with one link, all-or-nothing finalize, title and message
- Recipient page: file list with sizes, per-file downloads, resumable Download all zip
- Transfer modes `proxy`, `direct` and `auto`, with tus resumable uploads and Range downloads
- Chunk verification, fingerprint checks, background CRC32 for direct mode
- Management link and in-browser Recent shares
- Upload password, IP allowlist, limits and quotas set in `.env`
- Cleanup worker (expiry with grace period, abandoned uploads)
- Always-on security layer
- Docker Compose with RustFS, `.env.example`, multi-arch images

**v1.1: Accounts**
- Optional user accounts (invite-only by default, `ALLOW_SIGNUP=false`); signed-in users skip the upload password
- Server-side **My shares** page, and claiming shares from the browser's Recent shares into an account
- Link password (argon2-hashed)
- Download limit: each file download and each Download all counts as one; resuming a download does not count

**v1.x: Control**
- Admin dashboard: active shares, storage usage, revoke links, audit log
- CAPTCHA (ALTCHA self-hosted, or Cloudflare Turnstile) for public uploads
- `local` storage driver (mounted folder, proxy mode only)
- Per-user quotas

**v2: Scale & privacy**
- Multiple storage backends with routing rules
- Optional end-to-end encryption (key kept in the URL fragment; the server never sees it)
- Virus scanning (ClamAV, as an optional container)
- Email notifications and sending links by email

---

## Decisions

- **Storage server:** RustFS (Apache-2.0, 1.0 GA in September 2026). It is light enough for a NAS and is bundled in the Compose file. Any other S3-compatible service works through the same adapter.
- **License:** MIT.
- **Default limits:** see Limits and quotas above.
