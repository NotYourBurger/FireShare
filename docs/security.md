# Security model

This page explains what FireShare protects, how it does it, which settings control each layer, and where the protection ends. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What FireShare is for

FireShare lets a known group of uploaders send files to anyone through unguessable, expiring links. It assumes:

- **Uploaders** are trusted enough to hold the upload password (or come from an allowed network). With `ALLOW_PUBLIC_UPLOAD=true`, anyone on the internet can upload.
- **Recipients** are anyone who has a link. A share link *is* the permission: there's no per-recipient login.
- **The operator** (you) controls the host, `.env` and the reverse proxy.

It does **not** encrypt files end to end. The server can read what is stored, so whoever controls the host or the storage can read the files. Files are stored compressed but not encrypted at rest; use disk encryption on the host if you need that. End-to-end encryption is on the [roadmap](../vision.md#roadmap).

## Layers, and what controls them

### Who can upload

| Layer | Controlled by | Notes |
|---|---|---|
| Upload password, required by default | `UPLOAD_PASSWORD` | The app **won't start** without it unless `ALLOW_PUBLIC_UPLOAD=true` is set explicitly. It is compared in constant time. |
| Signed session cookie | fixed | `fireshare_upload`: an HMAC-signed expiry, valid for 30 days, `HttpOnly` and `SameSite=Lax`. It is `Secure` over HTTPS, which needs your proxy to send `X-Forwarded-Proto: https`. Changing the password ends every session. |
| Password guessing limit | fixed | 10 wrong passwords per client IP per 15 minutes. |
| Upload network allowlist | `UPLOAD_ALLOWED_IPS` | Optional. It applies to the password form and every upload request. Downloads still work from anywhere. |
| Public uploads | `ALLOW_PUBLIC_UPLOAD`, `ABUSE_CONTACT` | When uploads are public, every download page shows a "Report abuse" link, and the app warns at startup if no quota is set. |

### Abuse and resource limits

| Layer | Controlled by |
|---|---|
| Size of one share, number of files | `MAX_SHARE_SIZE`, `MAX_FILES_PER_SHARE` |
| Total storage | `MAX_TOTAL_STORAGE` |
| Per-IP upload volume (24 h) and active shares | `UPLOAD_QUOTA_PER_IP`, `MAX_ACTIVE_SHARES_PER_IP` |
| Per-IP request rate | `RATE_LIMIT_UPLOAD`, `RATE_LIMIT_DOWNLOAD` |
| Real client IP behind a proxy | `TRUSTED_PROXIES` |

Every limit is checked **before** any bytes are accepted, and shares that are still uploading count, so parallel uploads can't race past a limit. A client that sends more than it declared is cut off, and its share fails. Rate-limit counters live in memory and reset when the app restarts. Without `TRUSTED_PROXIES`, `X-Forwarded-For` is ignored entirely, so clients can't fake their IP, but behind a proxy everyone then counts as one client.

### Upload integrity

- **Authorization first:** no upload starts until access, rate limits, quotas, and the size and file-count limits all pass.
- **Server-chosen storage keys:** each file gets a random storage key. Filenames are metadata only, so they can never become storage paths.
- **Chunk verification (proxy mode):** the browser sends a SHA-256 with each chunk, and the app checks it before writing. This is why proxy-mode uploads need a [secure context](deployment.md#why-you-need-https).
- **Quarantine until finalize:** files in an unfinished share can't be shared or downloaded. At finalize the server checks every file's real size, and a share becomes available only when **all** of its files pass.
- **Tamper detection:** each file's fingerprint is recorded at finalize and checked before every download. If the stored object has changed, the download is refused.
- **Abandoned uploads** are removed after `PENDING_TTL`, together with their incomplete multipart uploads.

### Links and downloads

- **Unguessable links:** share and management links use 128-bit random tokens. Nothing about them is sequential.
- **Hashed at rest:** only SHA-256 hashes of link tokens are stored, so a database leak exposes no working links. A lost management link can't be recovered either.
- **Safe downloads:** files are always served as attachments, with `X-Content-Type-Options: nosniff`, so an uploaded HTML or SVG file can't run as a page on your domain.
- **No referrer:** pages and downloads use the `no-referrer` policy, so share links don't leak to other sites.
- **Immediate revocation:** expired and deleted shares stop serving at once. The bytes are removed after `DELETE_GRACE`.

### Platform

- **Storage is never public.** The S3 and admin APIs are only on an internal Docker network with no route in or out (`internal: true`). In direct mode, you add a separate LAN-only endpoint.
- **Private bucket:** no anonymous reads, writes or listing.
- **Least-privilege key:** `storage-init` creates the app's own key, which can access only the one bucket. The admin token is never given to the app or the worker.
- **Direct mode:** presigned URLs are scoped to one object, one action and 5 minutes. The bucket's CORS rule allows only `APP_ORIGIN`. Without `ALLOW_INSECURE_DIRECT_ENDPOINT=true`, the app refuses to start with a non-HTTPS endpoint.
- **Hardened containers:** non-root users, `no-new-privileges`, all Linux capabilities dropped, and memory limits. The one-off `storage-volumes` container holds only `CAP_CHOWN` and has no network.
- **Validated configuration:** contradictory or unsafe settings stop the app at startup with a clear message, and risky but valid settings are logged as warnings.

## Outbound connections

| From | To | When | Turn off |
|---|---|---|---|
| App server | `https://zenquotes.io/api/random` | At most once a minute, while pages are being viewed | `QUOTES=offline` |
| Browsers | nothing but FireShare | — | — |

Fonts and backdrop photos are bundled into the image. There's no analytics, telemetry or update check, and Next.js telemetry is disabled in the image.

## Known limits

- **Plain HTTP:** without HTTPS, the password, cookie and links can be read by anyone on the network path. In proxy mode, uploads are refused anyway.
- **Anyone with a link can download.** Treat share links like passwords. Link passwords and download limits are on the roadmap.
- **No malware scanning.** FireShare doesn't inspect what's uploaded. Use public uploads with care.
- **Single app instance assumed** for rate limits and lockouts, because the counters aren't shared between instances.
- **Garage runs as a single node** with one copy of each file. Keep backups if the files matter (see [backups](deployment.md#backups)).

## Hardening checklist

- [ ] HTTPS reverse proxy in front, and `TRUSTED_PROXIES` set to it.
- [ ] `APP_PORT=127.0.0.1:3000` (or no published port) so the proxy can't be bypassed.
- [ ] Long random values for every secret in `.env`, and `.env` readable only by you (`chmod 600 .env`).
- [ ] `MAX_TOTAL_STORAGE` below your free disk space.
- [ ] With public uploads: `UPLOAD_QUOTA_PER_IP`, `MAX_ACTIVE_SHARES_PER_IP`, and a working `ABUSE_CONTACT`.
- [ ] `UPLOAD_ALLOWED_IPS` if only your office or VPN should upload.
- [ ] `QUOTES=offline` if the host shouldn't make outbound requests.
- [ ] Watch `docker compose logs app worker` for `Warning:` lines after every change.
- [ ] Pin `FIRESHARE_VERSION` to a release, and update when one comes out.
