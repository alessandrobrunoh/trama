# syntax=docker/dockerfile:1.7
# Trama API (NestJS). Build context: the repository root (the Dockerfile lives in server/):
#   docker build -f server/Dockerfile -t ghcr.io/alessandrobrunoh/trama:latest .

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# All dependencies (build tools included): re-run only when the lockfile changes.
FROM base AS deps
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS build
COPY server/nest-cli.json server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build

# Production dependencies only (argon2 ships a prebuilt binary for glibc, so no compiler is needed).
FROM base AS prod-deps
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
 # runtime never reads source maps, type declarations or docs
 && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
      -o -iname 'readme*' -o -iname 'changelog*' -o -iname 'history.md' \) -delete

FROM node:22-bookworm-slim AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="trama" org.opencontainers.image.version="${VERSION}" org.opencontainers.image.source="https://github.com/alessandrobrunoh/trama"
ENV NODE_ENV=production PORT=3000 NODE_OPTIONS=--max-old-space-size=512
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server/package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Nest handles SIGTERM (enableShutdownHooks); run with `init: true` so signals and zombies are handled.
CMD ["node", "dist/main.js"]
