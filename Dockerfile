# syntax=docker/dockerfile:1

# Dependencies and builds run on the build machine's own platform: their output
# is platform-independent JavaScript, so only the final images below are built
# per platform. Installing under emulation (QEMU, for arm64 in CI) was slow
# enough to hang. Nothing native ships in the images (see pnpm-workspace.yaml).
FROM --platform=$BUILDPLATFORM node:26-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /app
RUN corepack enable
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build && pnpm build:worker

# The cleanup worker, and the bundled storage's one-off setup (storage-init):
# one bundled file each, built with `--target worker`.
FROM node:26-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/dist/worker.cjs /app/dist/storage-init.cjs ./
USER node
CMD ["node", "worker.cjs"]

# The web app; the last stage, so it's the default target.
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/drizzle ./drizzle
USER node
EXPOSE 3000
CMD ["node", "server.js"]
