# Deployment guide

The [quick start](../README.md#quick-start) gets FireShare running on `http://localhost:3000`. This guide covers everything after that: HTTPS, reverse proxies, LAN installs, full-speed direct transfers, external databases and storage, and backups.

- [Why you need HTTPS](#why-you-need-https)
- [What every reverse proxy needs](#what-every-reverse-proxy-needs)
- [Choosing `TRUSTED_PROXIES`](#choosing-trusted_proxies)
- Recipes: [Caddy](#caddy-in-the-same-stack-recommended) · [nginx](#nginx-on-the-host) · [Traefik](#traefik) · [Synology DSM](#synology-dsm) · [Cloudflare Tunnel](#cloudflare-tunnel) · [LAN only](#lan-only-https)
- [Direct and auto modes (full LAN speed)](#direct-and-auto-modes-full-lan-speed)
- [Direct mode over plain HTTP (trusted LAN only)](#direct-mode-over-plain-http-trusted-lan-only)
- [Using your own PostgreSQL or S3](#using-your-own-postgresql-or-s3)
- [Portainer, Unraid and other UIs](#portainer-unraid-and-other-compose-uis)
- [Backups](#backups)
- [Resource use](#resource-use)

All examples assume you cloned the repo and run `docker compose` from its folder. Extra services and settings go in a **`compose.override.yaml`** next to `compose.yaml`. Compose merges that file in automatically, and `.gitignore` already ignores it, so `git pull` never conflicts with your changes.

---

## Why you need HTTPS

When uploading through the app (`proxy` mode, the default), the browser computes a SHA-256 of every chunk with the Web Crypto API, and the app verifies it before storing the chunk. Browsers only provide Web Crypto in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts): pages on `https://` or on `localhost` / `127.0.0.1`.

| How the page is opened | Downloads | Uploads |
|---|---|---|
| `http://localhost:3000` on the Docker host | ✅ | ✅ |
| `http://192.168.1.10:3000` from another machine | ✅ | ❌ "Uploading needs a secure connection" |
| `https://share.example.com` through a reverse proxy | ✅ | ✅ |
| `http://…` in `direct` mode (browser uploads straight to storage) | ✅ | ✅ but [unencrypted](#direct-mode-over-plain-http-trusted-lan-only) |

When the page isn't secure, the upload form says so up front and disables the upload button. HTTPS also protects the upload password, the session cookie and every share link in transit. **Use a reverse proxy with HTTPS for any install that someone other than you will use.**

## What every reverse proxy needs

Whatever proxy you use, it must:

1. **Forward to the app's port**: `http://app:3000` from a container in the stack, or `http://127.0.0.1:${APP_PORT}` from the host.
2. **Send `X-Forwarded-For` and `X-Forwarded-Proto`.** The app uses `X-Forwarded-For` for per-IP limits, allowlists and `auto` mode (only from `TRUSTED_PROXIES`). It uses `X-Forwarded-Proto: https` to mark the session cookie `Secure`.
3. **Accept request bodies at least as large as `UPLOAD_CHUNK_SIZE`** (64 MB by default). nginx's default limit is 1 MB, so uploads fail with **413** until you raise it.
4. **Stream, without buffering**, and allow long requests. Downloads can be tens of GB, and buffering them on the proxy's disk is slow or fails outright.
5. **Not cache** anything under `/d/`, `/m/` or `/api/`. The app already sends `Cache-Control: no-store` where it matters.

Then set `TRUSTED_PROXIES` in `.env`.

## Choosing `TRUSTED_PROXIES`

The app believes `X-Forwarded-For` **only** on connections that come from an address in `TRUSTED_PROXIES`. From anywhere else it ignores the header, so a client can't fake its IP. If you leave it empty behind a proxy, the app sees every visitor as the proxy, and one busy uploader can then use up the rate limit for everyone.

The address to list is the one **the app container sees the proxy connect from**:

| Proxy runs… | It connects from | Set |
|---|---|---|
| as a container on the stack's `public` network (Caddy, Traefik or cloudflared below) | its container IP, in Docker's private range | `TRUSTED_PROXIES=172.16.0.0/12` |
| on the Docker host (nginx, Synology DSM, …), forwarding to `127.0.0.1:3000` | the Docker network's gateway, e.g. `172.18.0.1` | `TRUSTED_PROXIES=172.16.0.0/12` |
| on another machine | that machine's LAN IP | `TRUSTED_PROXIES=192.168.1.5` |

`172.16.0.0/12` covers Docker's default network ranges. If your Docker uses a custom `default-address-pools` (or your LAN uses `172.16–31.x.x`), list the exact address or subnet instead. Only list addresses that clients can't connect from directly.

---

## Caddy in the same stack (recommended)

Caddy gets and renews certificates automatically, streams by default, sends the right headers and has no body-size limit. You need a domain name that points at your server, with ports 80 and 443 reachable.

`compose.override.yaml`:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    networks: [public]

  # Optional: stop publishing the app's own port, so it's reachable only through Caddy.
  # Needs Docker Compose 2.24 or newer.
  app:
    ports: !reset []

volumes:
  caddy-data: {}
```

`Caddyfile`:

```caddy
share.example.com {
	reverse_proxy app:3000
}
```

`.env`:

```sh
TRUSTED_PROXIES=172.16.0.0/12
```

Run `docker compose up -d`, then open `https://share.example.com`.

## nginx on the host

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name share.example.com;
    # ssl_certificate / ssl_certificate_key: e.g. from certbot

    client_max_body_size 0;          # or at least UPLOAD_CHUNK_SIZE
    proxy_request_buffering off;     # stream uploads to the app
    proxy_buffering off;             # stream downloads to the browser
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

In `.env`, set `APP_PORT=127.0.0.1:3000` so that only nginx can reach the app, and `TRUSTED_PROXIES=172.16.0.0/12`.

## Traefik

If Traefik already runs in its own stack, attach the app to Traefik's network and add labels in `compose.override.yaml`:

```yaml
services:
  app:
    networks: [public, internal, traefik]
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.fireshare.rule=Host(`share.example.com`)
      - traefik.http.routers.fireshare.entrypoints=websecure
      - traefik.http.routers.fireshare.tls.certresolver=letsencrypt
      - traefik.http.services.fireshare.loadbalancer.server.port=3000

networks:
  traefik:
    external: true
```

Traefik streams by default and sends `X-Forwarded-*`. Set `TRUSTED_PROXIES` to the Traefik network's subnet (`docker network inspect traefik`), or `172.16.0.0/12`.

## Synology DSM

1. **Container Manager → Project → Create.** Point it at the folder where you cloned FireShare (it needs `compose.yaml` *and* `storage/garage.toml`), and put your `.env` in that folder. If the clone was made from another machine, check that the `storage` folder exists.
2. In `.env`, set `APP_PORT` to a free port (DSM itself uses 5000 and 5001), for example `APP_PORT=3000`.
3. **Control Panel → Login Portal → Advanced → Reverse Proxy → Create:**
   - Source: HTTPS, hostname `share.example.com`, port 443.
   - Destination: HTTP, `localhost`, port `3000`.
   - Under **Custom Header**, add `X-Forwarded-Proto` = `$scheme` if it isn't already listed.
4. Under **Control Panel → Security → Certificate**, give `share.example.com` a certificate (Let's Encrypt works).
5. Set `TRUSTED_PROXIES=172.16.0.0/12` and run `docker compose up -d` (or rebuild the project).

If large chunks fail with **413**, DSM's proxy is limiting the request body size: lower `UPLOAD_CHUNK_SIZE` (e.g. `32MB`).

## Cloudflare Tunnel

No open ports needed. Add `cloudflared` in `compose.override.yaml`:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    networks: [public]
```

In the Cloudflare dashboard, set the tunnel's public hostname to the service `http://app:3000`, and set `TRUSTED_PROXIES=172.16.0.0/12`.

Cloudflare limits request bodies to **100 MB** on the Free and Pro plans, so keep `UPLOAD_CHUNK_SIZE` at `64MB` or below. Also check that serving large files fits [Cloudflare's terms](https://www.cloudflare.com/service-specific-terms-application-services/) for your plan.

## LAN-only HTTPS

You don't need a public domain to get a secure context. With Caddy's built-in certificate authority:

```caddy
fireshare.lan {
	tls internal
	reverse_proxy app:3000
}
```

Point `fireshare.lan` at the server in your router's DNS (or in each machine's hosts file). Then install Caddy's root certificate on each device so browsers trust it. It's in the `caddy-data` volume at `/data/caddy/pki/authorities/local/root.crt`. You can also use your own CA, or a real certificate from a DNS challenge for a subdomain you own (e.g. `share.lan.example.com`), which needs no certificate installs.

If you set `UPLOAD_ALLOWED_IPS=192.168.1.0/24`, people outside the LAN can still download, but only the LAN can upload.

---

## Direct and auto modes (full LAN speed)

In `proxy` mode, every byte goes through the app. That keeps storage hidden, but it costs CPU and caps speed at what the app can stream. In `direct` mode, the app hands out presigned storage URLs that are valid for 5 minutes, and browsers upload and download **straight to storage**. `auto` mode uses direct for `DIRECT_NETWORKS` (your LAN or VPN) and proxy for everyone else. This is the usual setup for a studio whose clients are on the internet.

Browsers need to reach Garage's S3 API at `STORAGE_DIRECT_ENDPOINT`. Garage is on the internal network with no published ports, so put a proxy in front of it **for your LAN only**:

- Use its own hostname, for example `storage.lan.example.com`, resolving **only inside your network** (split DNS, and no router port forward).
- Use HTTPS. A page on `https://` can't call an `http://` endpoint.
- **Forward the `Host` header unchanged.** Presigned URLs are signed for that hostname, and storage rejects them if the proxy rewrites it.
- Like the app, it needs no body-size limit and no buffering.

With Caddy (extending the [Caddy recipe](#caddy-in-the-same-stack-recommended)):

```yaml
services:
  caddy:
    networks: [public, internal]   # internal: to reach storage:3900
```

```caddy
share.example.com {
	reverse_proxy app:3000
}

storage.lan.example.com {
	# LAN only: refuse anything else, in case the name leaks.
	@outside not remote_ip private_ranges
	respond @outside 403
	reverse_proxy storage:3900
}
```

`.env`:

```sh
TRANSFER_MODE=auto
STORAGE_DIRECT_ENDPOINT=https://storage.lan.example.com
APP_ORIGIN=https://share.example.com
DIRECT_NETWORKS=192.168.1.0/24,10.8.0.0/16
TRUSTED_PROXIES=172.16.0.0/12
```

`storage.lan.example.com` needs a certificate too. For a name that only resolves on your LAN, Let's Encrypt's HTTP challenge can't reach it, so use a [DNS challenge](https://caddyserver.com/docs/automatic-https#dns-challenge) or `tls internal` (see [LAN-only HTTPS](#lan-only-https)).

The app sets the bucket's CORS rule itself: it allows `APP_ORIGIN` only, for GET, PUT and HEAD, and exposes `ETag`. You don't need to configure CORS on storage.

Things to know:

- Shares don't remember the path they took. A file uploaded directly downloads through the app for internet clients, and the other way round.
- An upload that started direct can only be **resumed** from `DIRECT_NETWORKS`. Uploads through the app resume from anywhere.
- Direct uploads skip the browser's SHA-256. The server checks sizes and ETags at finalize, and the worker computes CRC32s in the background. Until it has, **Download all** for that share works but can't be resumed.
- `DIRECT_NETWORKS` is matched against the client IP the app sees, so `TRUSTED_PROXIES` must be right.

## Direct mode over plain HTTP (trusted LAN only)

If FireShare never leaves a network you trust and you don't want certificates at all, you can run `direct` mode over plain HTTP. Uploads then work from `http://` pages, because direct mode needs no Web Crypto.

> [!WARNING]
> Everything travels unencrypted: the upload password, share links, and presigned URLs that grant access to files. Anyone who can watch your network traffic can read them. The app logs a warning at startup while this is on.

`compose.override.yaml` publishes Garage's S3 port. It joins `public` because Docker can't publish ports from an internal-only network:

```yaml
services:
  storage:
    networks: [internal, public]
    ports: ["3900:3900"]
```

`.env` (replace `192.168.1.10` with the server's LAN address):

```sh
TRANSFER_MODE=direct
STORAGE_DIRECT_ENDPOINT=http://192.168.1.10:3900
ALLOW_INSECURE_DIRECT_ENDPOINT=true
APP_ORIGIN=http://192.168.1.10:3000
```

The S3 API is then reachable by anyone on your LAN, though the bucket stays private and every request still needs a valid signature. Don't forward port 3900 on your router.

---

## Using your own PostgreSQL or S3

The app and worker images work with any PostgreSQL (13+) and any S3-compatible storage that accepts **path-style** requests: MinIO, AWS S3, Cloudflare R2, Backblaze B2, Wasabi, Ceph and so on. You don't need the bundled `db`, `storage`, `storage-volumes` or `storage-init` services. Here is a minimal stack without them:

```yaml
# compose.external.yaml — run with: docker compose -f compose.external.yaml up -d
x-env: &env
  DATABASE_URL: postgres://fireshare:secret@db.example.com:5432/fireshare
  S3_ENDPOINT: https://s3.eu-central-1.amazonaws.com
  S3_REGION: eu-central-1
  S3_BUCKET: my-fireshare-bucket
  S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
  S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY}

services:
  app:
    image: ghcr.io/notyourburger/fireshare:latest
    restart: unless-stopped
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    ports: ["3000:3000"]
    environment:
      <<: *env
      UPLOAD_PASSWORD: ${UPLOAD_PASSWORD}
      # …any other app setting from docs/configuration.md

  worker:
    image: ghcr.io/notyourburger/fireshare-worker:latest
    restart: unless-stopped
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    environment:
      <<: *env
      DELETE_GRACE: 1h
      PENDING_TTL: 24h
```

- **Run exactly one worker.** The app is stateless apart from its in-memory rate-limit counters, so you can also run it on Kubernetes or any other container platform with the same variables.
- The app creates the bucket on first start if it doesn't exist. If the key can't create buckets, or on AWS outside `us-east-1`, create the bucket yourself first and keep it **private** (no public access).
- The storage key needs object read, write and delete on that bucket, plus multipart upload operations (create, upload part, list parts, complete, abort). It also needs `HeadBucket`, and `PutBucketCors` in direct and auto modes. Don't give it access to anything else.
- The database user needs to create tables in its database: the app runs migrations on start.

## Portainer, Unraid and other Compose UIs

FireShare is an ordinary Compose project. Deploy it as a stack from the Git repository, or by pasting `compose.yaml`, and add the variables from `.env.example` in the UI's environment section. The one catch is that the `storage` service mounts `./storage/garage.toml`, so the UI must deploy **from the repository** (Portainer: *Repository* build method), not from a pasted file. If you can only paste a file, use [your own S3](#using-your-own-postgresql-or-s3), or copy `garage.toml` to a fixed host path and change that mount.

## Backups

All state lives in three named volumes (prefixed with the Compose project name, usually `fireshare_`):

| Volume | Holds | Without it |
|---|---|---|
| `db-data` | Shares, files, link hashes, quotas | Every link stops working |
| `storage-data` | File contents (Garage data and metadata) | Files are gone |
| `storage-credentials` | A copy of the app's storage key | Nothing: `storage-init` writes it again from Garage on every start |

Back up `db-data` and `storage-data` **together, with the stack stopped**, so they match:

```sh
docker compose stop
for v in db-data storage-data; do
  docker run --rm -v fireshare_$v:/v:ro -v "$PWD":/backup alpine tar czf /backup/$v.tgz -C /v .
done
docker compose start
```

Shares are temporary by design, so many installs only back up `.env`. Losing the volumes then just means every current link stops working.

## Resource use

Container memory limits are set in `compose.yaml`: app 1 GB, worker 512 MB, PostgreSQL 512 MB, Garage 512 MB. Idle, the stack uses far less. Garage needs about 4 MB idle and about 320 MB with ten downloads at once. In proxy mode the app streams everything, so its memory stays flat whatever the file size. Disk use levels off at roughly *daily upload volume × average retention × 1.5*, since files expire.
