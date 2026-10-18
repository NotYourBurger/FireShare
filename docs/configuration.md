# Configuration reference

FireShare is configured entirely through environment variables. With Docker Compose, you set them in `.env`, and [`compose.yaml`](../compose.yaml) passes them to the right container. [`.env.example`](../.env.example) is a ready-to-edit copy with comments.

- **Validated at startup.** The app and the cleanup worker check every setting they read before doing anything else. If any setting is invalid, they exit and list every bad variable at once, along with what to change (see `docker compose logs app worker`).
- **Empty means default.** A variable that is unset, or set to an empty value, takes its default. For the [limits](#limits-and-quotas), empty means *no limit*.
- **Sizes** are written as a whole number followed by `KB`, `MB`, `GB` or `TB`, and they are binary: `1MB` = 1024 × 1024 bytes. **Durations** use `m`, `h` or `d`. **Network lists** are comma-separated IPv4 or IPv6 addresses or CIDR ranges, like `192.168.1.0/24,10.8.0.0/16,fd00::/8`.
- **Applying changes:** after editing `.env`, run `docker compose up -d`. Compose recreates only the containers whose settings changed.

Containers: **app** is the web app, **worker** is the cleanup worker, **init** is the one-off `storage-init` container, and **compose** means the variable is used by `compose.yaml` itself.

## Deployment

| Variable | Default | Read by | Description |
|---|---|---|---|
| `FIRESHARE_VERSION` | `latest` | compose | Image tag to run: `latest` (the newest release), `1.2` or `1.2.3`, or `main` (the newest build of the main branch). |
| `APP_PORT` | `3000` | compose | Host port the app is published on. Inside the container it always listens on 3000. To publish it to only one interface, use, for example, `127.0.0.1:3000` so that only a reverse proxy on the same host can reach it. |
| `POSTGRES_PASSWORD` | **required** | compose | Password for the bundled PostgreSQL. It is used to build `DATABASE_URL`. |
| `GARAGE_RPC_SECRET` | **required** | compose | Garage's internal RPC secret. It **must** be exactly 64 hex characters (`openssl rand -hex 32`). |
| `GARAGE_ADMIN_TOKEN` | **required** | compose, init | Garage admin API token. Only `storage-init` uses it, to create the bucket and the app's key. The app and the worker never see it. |
| `S3_BUCKET` | `fireshare` | app, worker, init | Bucket that holds the files. It is created on first start and is private. It must be 3 to 63 lowercase letters, digits, dots and hyphens. |

## Who can upload

Downloads never need any of these: a share link is all a recipient needs.

| Variable | Default | Read by | Description |
|---|---|---|---|
| `UPLOAD_PASSWORD` | **required** unless public | app | Uploaders enter it once per browser. They then get a signed session cookie that lasts **30 days**. Changing the password ends every existing session. Wrong guesses are limited to **10 per client IP per 15 minutes** (fixed). |
| `ALLOW_PUBLIC_UPLOAD` | `false` | app | `true` lets anyone upload without a password. In that case, leave `UPLOAD_PASSWORD` empty (setting both is an error) and set `ABUSE_CONTACT`. You should also set quotas: the app warns at startup if none are set. |
| `ABUSE_CONTACT` | — | app | Required when `ALLOW_PUBLIC_UPLOAD=true`. It is an email address or http(s) URL, and every download page links to it as "Report abuse". |
| `UPLOAD_ALLOWED_IPS` | any | app | Only accept uploads, and the password, from these networks. Everyone else sees "Uploads aren't allowed from your network". |
| `TRUSTED_PROXIES` | none | app | The reverse proxies in front of the app. The app believes `X-Forwarded-For` only on requests that come from one of these addresses; from anywhere else it ignores the header. **Set this whenever you use a reverse proxy.** Without it, every client looks like the proxy, so per-IP limits, `UPLOAD_ALLOWED_IPS` and `auto` mode all see a single address. See [choosing `TRUSTED_PROXIES`](deployment.md#choosing-trusted_proxies). |

## Expiry and cleanup

| Variable | Default | Read by | Description |
|---|---|---|---|
| `EXPIRY_OPTIONS` | `1d,3d,7d,14d,30d` | app | The expiry presets uploaders choose from, as whole hours or days (`12h`, `7d`, up to 4 digits). Expiry is counted from when the upload finished. It can't be extended later. |
| `EXPIRY_DEFAULT` | `7d` | app | The preset selected by default. It must be one of `EXPIRY_OPTIONS`. |
| `DELETE_GRACE` | `1h` | worker | After a share expires or is deleted, its link stops working immediately, but its files stay in storage for this long so that downloads already in progress can finish. `0m` deletes them on the next cleanup run. |
| `PENDING_TTL` | `24h` | worker | Uploads that were never finished are removed, with everything they stored, once they are this old. |

The cleanup worker runs **every 5 minutes** (fixed). On each run it also computes CRC32 checksums for files uploaded in direct mode, so that "Download all" can resume for those shares too.

## Uploads

| Variable | Default | Read by | Description |
|---|---|---|---|
| `UPLOAD_CHUNK_SIZE` | `64MB` | app | Browsers upload each file in chunks of this size, from `5MB` to `5GB`. An interrupted upload resumes from its last completed chunk. **Keep it under your reverse proxy's request-body limit** (nginx defaults to 1 MB, and Cloudflare allows 100 MB). |
| `UPLOAD_PARALLEL_FILES` | `3` | app | How many files a browser uploads at the same time, from 1 to 10. |

## Limits and quotas

Each limit is **off when empty**. Uploads that would go over a limit are refused before any bytes are sent, and the uploader is shown the reason. Shares that are still uploading count towards the limits, so parallel uploads can't race past one.

| Variable | `.env.example` value | Read by | Description |
|---|---|---|---|
| `MAX_SHARE_SIZE` | `50GB` | app | Total size of one share. |
| `MAX_FILES_PER_SHARE` | `500` | app | Number of files in one share. |
| `MAX_TOTAL_STORAGE` | off | app | Total size of all shares that are still uploading or not yet expired. Use it to keep FireShare from filling the disk. |
| `UPLOAD_QUOTA_PER_IP` | off | app | Bytes one client IP may upload in any 24 hours. |
| `MAX_ACTIVE_SHARES_PER_IP` | off | app | Shares per client IP that are still uploading or not yet expired. |
| `RATE_LIMIT_UPLOAD` | `600` | app | Upload API requests per minute per client IP. Each chunk is one request, so keep this well above `(upload speed ÷ UPLOAD_CHUNK_SIZE) × 60`. |
| `RATE_LIMIT_DOWNLOAD` | `300` | app | File downloads per minute per client IP. Each resume of a download counts as one. |

> If you delete one of these lines from `.env` entirely, Compose passes an empty value, and that limit is then **off** rather than set to the value shown above. The `.env.example` values are recommended starting points.

Rate-limit and password-lockout counters are kept **in memory**, so they reset when the app restarts. Per-IP limits are only as accurate as the client IP the app sees, so set `TRUSTED_PROXIES` correctly.

## Transfer mode

How file bytes travel. See [deployment: direct and auto modes](deployment.md#direct-and-auto-modes-full-lan-speed) for a complete setup.

| Variable | Default | Read by | Description |
|---|---|---|---|
| `TRANSFER_MODE` | `proxy` | app | `proxy`: every upload and download streams through the app, and storage stays fully internal. `direct`: browsers transfer straight to and from storage, using presigned URLs that are valid for 5 minutes. `auto`: direct for clients in `DIRECT_NETWORKS`, proxy for everyone else, chosen per request. |
| `STORAGE_DIRECT_ENDPOINT` | — | app | Required for `direct` and `auto`. The URL at which **browsers** reach the S3 API, for example `https://storage.lan.example.com`. It must be `https://` unless `ALLOW_INSECURE_DIRECT_ENDPOINT=true`. It may include a path prefix, but not credentials, a query or a fragment. |
| `APP_ORIGIN` | the request's origin | app | The address people open FireShare at, for example `https://share.example.com`. In direct and auto modes the app sets the bucket's CORS rule to allow only this origin. **Set it in direct and auto modes:** behind a reverse proxy, the origin the app sees may not be the public one. The app warns at startup if it is missing. |
| `DIRECT_NETWORKS` | — | app | Required for `auto`, and only allowed with `auto`. These are the client networks that transfer directly, and they must be able to reach `STORAGE_DIRECT_ENDPOINT`. An upload that started direct can only be resumed from these networks. |
| `ALLOW_INSECURE_DIRECT_ENDPOINT` | `false` | app | `true` allows an `http://` `STORAGE_DIRECT_ENDPOINT`. **Only use it on a network you trust:** presigned URLs, which grant access to files, then travel unencrypted. Also, a page served over `https://` can't reach an `http://` endpoint, because browsers block mixed content. The app warns at startup when this is on. |

Direct uploads skip the browser's per-chunk SHA-256. Instead, the server checks each part's size and ETag when the upload is finalized, and the worker later computes CRC32 checksums. Direct mode therefore also works from pages served over plain HTTP.

## Privacy

| Variable | Default | Read by | Description |
|---|---|---|---|
| `QUOTES` | `live` | app | Every page shows a quote. With `live`, the app server fetches quotes from `https://zenquotes.io` (at most once a minute) and mixes them with built-in ones. With `offline`, it shows only the built-in quotes and the app makes **no outbound requests**. Visitors' browsers never contact anyone but FireShare in either mode. |

## Database and storage connection

`compose.yaml` sets these for the bundled services. Set them yourself only when you run the app or worker outside Compose (`pnpm dev`, Kubernetes, …), or when you use [your own PostgreSQL or S3](deployment.md#using-your-own-postgresql-or-s3).

| Variable | Compose sets | Read by | Description |
|---|---|---|---|
| `DATABASE_URL` | `postgres://fireshare:…@db:5432/fireshare` | app, worker | A PostgreSQL connection URL (`postgres://` or `postgresql://`). The app runs migrations on start. |
| `S3_ENDPOINT` | `http://storage:3900` | app, worker | The http(s) URL of the S3 API, as the **server** reaches it. |
| `S3_REGION` | `garage` | app, worker | The S3 region. If unset, it defaults to `us-east-1`. For Garage, it must match `s3_region` in `storage/garage.toml`. |
| `S3_ACCESS_KEY_ID` | — | app, worker | Storage access key. Give it access to `S3_BUCKET` only. |
| `S3_SECRET_ACCESS_KEY` | — | app, worker | Its secret. |
| `S3_ACCESS_KEY_ID_FILE`, `S3_SECRET_ACCESS_KEY_FILE` | `/credentials/s3-…` | app, worker | Paths of files that hold the key, as an alternative to the two variables above, for example Docker secrets. If both are set, the variable wins. |
| `GARAGE_ADMIN_URL` | `http://storage:3903` | init | Garage's admin API. |
| `CREDENTIALS_DIR` | `/credentials` | init | Where `storage-init` writes the app's key. |

Also set in the image: `PORT=3000` and `HOSTNAME=0.0.0.0` (where the app listens), `NODE_ENV=production`, and `NEXT_TELEMETRY_DISABLED=1`.

## Fixed behaviour

These can't be configured, so you know what to expect:

| Behaviour | Value |
|---|---|
| Upload session cookie (`fireshare_upload`) | 30 days, `HttpOnly`, `SameSite=Lax`, and `Secure` when the request arrives over HTTPS (directly, or with `X-Forwarded-Proto: https` from your proxy) |
| Wrong upload passwords | 10 per client IP per 15 minutes |
| Rate limit window | 1 minute; counters are in memory |
| Presigned URL lifetime (direct mode) | 5 minutes |
| Cleanup worker interval | 5 minutes |
| Link tokens | 128-bit random; only their SHA-256 hashes are stored |
| Title and message length | 200 and 5000 characters |
