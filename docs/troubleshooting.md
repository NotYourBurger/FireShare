# Troubleshooting

Start with the logs. The containers say what's wrong:

```sh
docker compose ps                                   # what's running, what exited
docker compose logs app worker storage storage-init # why
```

## The app won't start

### "FireShare can't start. Fix these settings in .env"

The app (or "The cleanup worker") checked your settings and found problems. It lists **every** bad variable with the fix, for example:

```
FireShare can't start. Fix these 2 settings in .env:
  - Missing UPLOAD_PASSWORD: set an upload password, or set ALLOW_PUBLIC_UPLOAD=true to let anyone upload
  - Invalid EXPIRY_DEFAULT "7d": must be one of EXPIRY_OPTIONS (1d, 3d)
```

Fix them in `.env` and run `docker compose up -d`. [configuration.md](configuration.md) lists the allowed values for each variable. The most common ones:

| Message starts with | Why |
|---|---|
| `Missing UPLOAD_PASSWORD` | There's no password and public uploads aren't turned on. This is deliberate: FireShare won't run wide open by accident. |
| `UPLOAD_PASSWORD is set but ALLOW_PUBLIC_UPLOAD=true would ignore it` | Pick one: a password, or public uploads. |
| `Missing ABUSE_CONTACT` | Public uploads need an abuse contact, which is shown on download pages. |
| `Missing STORAGE_DIRECT_ENDPOINT` / `Invalid STORAGE_DIRECT_ENDPOINT` | `direct` and `auto` modes need an `https://` storage URL, or `http://` together with `ALLOW_INSECURE_DIRECT_ENDPOINT=true`. |
| `DIRECT_NETWORKS is set but TRANSFER_MODE=…` | `DIRECT_NETWORKS` only means something with `TRANSFER_MODE=auto`. |
| `Invalid … "…": use …` | The value isn't in the expected format. The message shows an example. |

### `set POSTGRES_PASSWORD in .env` (or `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`)

Compose itself refuses to start without these. Did you `cp .env.example .env`, and are you running `docker compose` from the FireShare folder?

### Storage doesn't start: "Invalid RPC secret" or similar

`GARAGE_RPC_SECRET` must be **exactly 64 hex characters**. Generate it with `openssl rand -hex 32`.

### `storage-init` exits: "Waiting for storage (60/60)" → "Storage setup failed"

`storage-init` couldn't reach Garage's admin API within about a minute. Check `docker compose logs storage`. Usually Garage itself failed (see above), or the `storage-data` volume isn't writable. The `storage-volumes` container fixes ownership on every start, so a failure there shows up in `docker compose logs storage-volumes`.

### Port already in use

Something else uses `APP_PORT` (3000 by default). Set `APP_PORT=8080` (or another free port) in `.env`.

### Images can't be pulled

Compose falls back to building them from the source in your checkout, which takes a few minutes. To run images built from your own checkout on purpose, run `docker compose up -d --build`.

## Uploading

### "Uploading needs a secure connection" / the upload button is disabled

You opened FireShare over plain `http://` from a machine other than the server. Browsers only allow the hashing that proxy-mode uploads need on `https://` or `localhost`. See [why you need HTTPS](deployment.md#why-you-need-https) for the options.

### The password is right but uploading keeps asking for it

The session cookie isn't being saved. Usually your proxy sends `X-Forwarded-Proto: https` while the page is actually plain `http://`, so the cookie is marked `Secure` and the browser drops it. Serve the page over HTTPS, or fix the proxy header. Changing `UPLOAD_PASSWORD` also ends every session, by design.

### "Too many wrong passwords. Try again later."

There were 10 wrong passwords from the same client IP within 15 minutes. Wait, or restart the app to clear the counter. If *everyone* is locked out together, the app is seeing every visitor as your proxy: set [`TRUSTED_PROXIES`](deployment.md#choosing-trusted_proxies).

### "Too many requests from your network"

You've hit `RATE_LIMIT_UPLOAD` or `RATE_LIMIT_DOWNLOAD`. On a fast connection, each chunk is one request: at 1 Gbit/s with 64 MB chunks, that's about 110 requests per minute per file being uploaded. Raise the limit or `UPLOAD_CHUNK_SIZE`. Also check `TRUSTED_PROXIES`, as above.

### Upload fails with 413 / "Request Entity Too Large"

Your reverse proxy limits request body size below `UPLOAD_CHUNK_SIZE`. Raise the proxy's limit (nginx: `client_max_body_size 0;`), or lower `UPLOAD_CHUNK_SIZE` (minimum `5MB`).

### Upload is refused before it starts

The message shown names the limit: share size, file count, total storage, per-IP quota or active shares. These come from the [limits](configuration.md#limits-and-quotas) in `.env`.

### "Uploads aren't allowed from your network"

Your IP isn't in `UPLOAD_ALLOWED_IPS`. Behind a proxy, check `TRUSTED_PROXIES` too: otherwise the app checks the proxy's address, not yours.

### Direct mode: "Part upload failed (0)" or uploads stall at 0%

The browser couldn't reach storage, or storage refused the CORS request. Check, in order:

1. Open `STORAGE_DIRECT_ENDPOINT` in the same browser. You should get an S3 XML error (`AccessDenied` or similar). That's fine: it proves storage is reachable. A certificate warning or a timeout is not fine.
2. `APP_ORIGIN` is exactly the address in the browser's address bar: scheme, host and port, with no trailing slash.
3. The proxy in front of storage forwards the original `Host` header. Presigned URLs are signed for that hostname.
4. The page and the endpoint use the same scheme. A page on `https://` can't call an `http://` endpoint, because browsers block mixed content.

### "This upload went straight to storage, which only works from the network it began on"

In `auto` mode, a direct upload can only be resumed from `DIRECT_NETWORKS`. Reconnect to the LAN or VPN to resume it, or start again.

## Downloading

### The link says the share is unavailable or not found

The share has expired or was deleted, or its upload never finished. Links stop working the moment a share expires, and nothing can bring them back.

### "The stored file has changed since it was shared"

The file in storage no longer matches the fingerprint recorded when it was shared, so FireShare refuses to serve it. Something modified the storage outside FireShare. Investigate before trusting that storage.

### Download all can't be resumed

For shares uploaded in direct mode, the worker computes checksums in the background (every 5 minutes, and it takes longer for big files). Until it's done, Download all works but can't be resumed. Individual files always resume.

## Storage and cleanup

### The disk keeps filling up

- Expired files are deleted `DELETE_GRACE` (1h by default) after expiry, by the **worker**. Check that the worker is running: `docker compose logs worker` should show a `Cleanup removed …` line every 5 minutes.
- Set `MAX_TOTAL_STORAGE` so that uploads are refused before the disk is full.

### Worker logs "Cleanup run failed" right after an install or update

The app runs database migrations on start. Until it has, the worker's runs fail and are retried. The errors stop once the app is up.

## Still stuck?

Open an [issue](https://github.com/NotYourBurger/FireShare/issues/new/choose) and include `docker compose ps`, the relevant logs, and your `.env` **with every secret removed**.
