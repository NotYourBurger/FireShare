# Changelog

Notable changes to FireShare. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version may include breaking changes. When it does, they are listed here with upgrade steps.

## Unreleased: 0.1.0, the first public release

### Features
- Multi-file shares behind one link, with an optional title and message. A share becomes available only once every file has arrived and been verified.
- Expiry presets (`EXPIRY_OPTIONS`). A link stops working the moment its share expires or is deleted, and the cleanup worker then removes its files.
- Resumable, verified uploads (tus with a SHA-256 for each chunk), resumable downloads, and Download all as a resumable ZIP64.
- A management link for each share, and in-browser Recent shares, with no accounts.
- Upload password, IP allowlist, public-upload mode with an abuse contact, per-IP quotas, rate limits and storage limits.
- Transfer modes `proxy`, `direct` and `auto`, for full-speed LAN transfers, including `ALLOW_INSECURE_DIRECT_ENDPOINT` for trusted HTTP-only networks.
- Docker Compose with PostgreSQL and Garage (zstd-compressed), hardened containers, and multi-arch images.
- `QUOTES=offline` stops the app making any outbound request.
- Startup validation that names every bad setting, plus warnings for settings that are valid but risky.
- The upload form warns up front when the page isn't secure and uploads can't work.

### Upgrading from pre-release builds with RustFS storage

The bundled storage is now [Garage](https://garagehq.deuxfleurs.fr), which needs far less memory. Files already shared aren't moved over.

1. Let your current shares expire.
2. In `.env`, set `GARAGE_RPC_SECRET` (`openssl rand -hex 32`) and `GARAGE_ADMIN_TOKEN`, and remove the `RUSTFS_*`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_REGION` lines. The app's storage key is now created for you.
3. Run `docker compose up -d --remove-orphans`.
4. Once it works, `docker volume rm` the old storage volume to free its space (`docker volume ls` shows its name).
