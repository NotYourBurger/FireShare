# Contributing to FireShare

Thanks for helping! Bug reports, docs fixes and pull requests are all welcome.

- **Bugs and ideas:** [open an issue](https://github.com/NotYourBurger/FireShare/issues/new/choose). For anything bigger than a small fix, please open an issue before writing code, so we can agree on the approach. FireShare deliberately stays small (see the non-goals in [vision.md](vision.md#non-goals)).
- **Security problems:** don't open an issue. See [SECURITY.md](SECURITY.md).

## Setup

You need Node.js 22, pnpm (`corepack enable` gives you the version pinned in `package.json`) and Docker.

```sh
pnpm install
pnpm test        # unit and integration tests: no database or storage needed
pnpm typecheck
```

The tests run against an in-process PostgreSQL ([PGlite](https://pglite.dev)) and an in-memory S3, so they need no setup.

### Running the app locally

`pnpm dev` needs a real PostgreSQL and S3. The easiest way is the bundled ones, published on localhost by [`compose.dev.yaml`](compose.dev.yaml):

```sh
cp .env.example .env             # set the change-me values as in the README
docker compose -f compose.yaml -f compose.dev.yaml up -d db storage-init

# The app's storage key, created by storage-init:
docker run --rm -v fireshare_storage-credentials:/c alpine sh -c 'cat /c/s3-access-key-id; echo; cat /c/s3-secret-access-key'
```

Then add these lines to `.env`, using your `POSTGRES_PASSWORD` and the key printed above:

```sh
DATABASE_URL=postgres://fireshare:<POSTGRES_PASSWORD>@localhost:5432/fireshare
S3_ENDPOINT=http://localhost:3900
S3_REGION=garage
S3_ACCESS_KEY_ID=<first line>
S3_SECRET_ACCESS_KEY=<second line>
```

Run `pnpm dev` and open <http://localhost:3000>. To work on the cleanup worker, build it with `pnpm build:worker`, then run `node --env-file=.env dist/worker.cjs`.

The volume is named after the Compose project. If your folder isn't called `FireShare`, check the name with `docker volume ls`.

### Testing the images

```sh
docker compose up -d --build
```

## Code layout

| Path | What's there |
|---|---|
| `src/app/` | Next.js pages, route handlers and browser code (upload form, resumable uploads) |
| `src/server/` | Framework-independent server logic: config, shares, HTTP handlers, storage adapter, cleanup. Route files only forward to `src/server/http.ts`. |
| `src/worker/` | The cleanup worker's entry point |
| `src/storage-init/` | The one-off setup for the bundled Garage storage |
| `drizzle/` | SQL migrations, generated with `pnpm db:generate` after changing `src/server/db/schema.ts` |
| `vision.md` | Product vision, architecture and roadmap |

## Pull requests

- Keep each PR to one change, and add tests for new behaviour. The existing `*.test.ts` files show the style.
- `pnpm typecheck` and `pnpm test` must pass. CI runs both, and builds the images.
- A **new setting** must go into `src/server/config.ts` (validated, with a clear error message), `compose.yaml`, `.env.example` and [docs/configuration.md](docs/configuration.md).
- Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org) style used in the history, e.g. `fix(upload): resume after a 409`. Add a line to `CHANGELOG.md` under **Unreleased** for anything users will notice.
- Match the surrounding code: small functions, comments that say *why*, and messages that tell the user what to do.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
