# FireShare

Self-hosted temporary file sharing: upload files, get a link, send it. Recipients need no account, every share expires, and expired files are removed automatically. Built for large files (up to 50 GB per share by default) with uploads and downloads that resume after interruptions.

See [`vision.md`](vision.md) for the product vision and architecture.

## Quick start

You need Docker with Compose v2, on any x86_64 or ARM64 machine.

1. Get the code and create your settings file:

   ```sh
   git clone https://github.com/NotYourBurger/FireShare.git
   cd FireShare
   cp .env.example .env
   ```

2. Open `.env` and replace every `change-me…` value with its own long random secret, for example the output of `openssl rand -hex 24`. `UPLOAD_PASSWORD` is the password uploaders type in, so pick something you can share with them.

3. Start it:

   ```sh
   docker compose up -d
   ```

   This pulls the published images (or builds them from source if it can't pull them), creates the database, the private storage bucket and the app's own storage key, and starts everything.

4. Open <http://localhost:3000>, enter the upload password, pick some files and press upload. You get a **share link** to send to recipients, and a **management link** to keep for yourself: it shows the share's status and lets you delete it early.

If the app doesn't come up, `docker compose logs app worker storage-init` tells you why. A bad setting stops the app at startup with a list of each variable to fix.

## Configuration

Everything is set in `.env`; [`.env.example`](.env.example) lists every setting with a comment explaining it. The main ones:

- **Who can upload:** `UPLOAD_PASSWORD`, or `ALLOW_PUBLIC_UPLOAD=true` with an `ABUSE_CONTACT`; optionally `UPLOAD_ALLOWED_IPS`.
- **Expiry:** `EXPIRY_OPTIONS` and `EXPIRY_DEFAULT`.
- **Limits and quotas:** `MAX_SHARE_SIZE`, `MAX_FILES_PER_SHARE`, `MAX_TOTAL_STORAGE`, per-IP quotas and rate limits.
- **Transfer mode:** `TRANSFER_MODE=proxy` (default), `direct` or `auto`, for full-speed transfers straight to storage on your local network.

After changing `.env`, apply it with `docker compose up -d`.

### Putting it on the internet

Run FireShare behind a reverse proxy that provides HTTPS (Caddy, nginx, Traefik, Synology DSM, …) and forwards to `APP_PORT`. Set `TRUSTED_PROXIES` to the proxy's address so per-IP limits see the real client address.

## Updating

```sh
git pull
docker compose pull
docker compose up -d
```

Database migrations run automatically when the app starts. Pin a release with `FIRESHARE_VERSION` in `.env`, or set it to `main` to follow the newest build. To build the images from your checkout instead, run `docker compose up -d --build`.

**Upgrading from a version without `RUSTFS_ROOT_ACCESS_KEY`:** the app now has its own storage key. Move your old `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` values to `RUSTFS_ROOT_ACCESS_KEY` and `RUSTFS_ROOT_SECRET_KEY`, then set `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` to a new key name and secret.

## Security

- The storage API is never published: it's only on an internal Docker network with no route in or out (plus, in direct mode, the LAN-only HTTPS endpoint you configure).
- The bucket is private, and the app's storage key can access only that bucket. The storage root key is used only by the one-off `storage-init` container.
- Every container runs as a non-root user with `no-new-privileges`, no Linux capabilities and a memory limit.
- Uploads need a password unless you explicitly make them public.

## Development

```sh
pnpm install
pnpm dev        # needs DATABASE_URL and S3_* in .env, see .env.example
pnpm test
pnpm typecheck
```

Images for amd64 and arm64 are built by CI and published to `ghcr.io/notyourburger/fireshare` and `ghcr.io/notyourburger/fireshare-worker`.

## License

MIT
