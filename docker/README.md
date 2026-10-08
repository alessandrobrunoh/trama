# Docker images

| Image | Source | Base | Size | Serves |
|---|---|---|---|---|
| `ghcr.io/alessandrobrunoh/trama-frontend` | `Dockerfile` (repo root) | nginx-unprivileged (alpine) | ~55 MB | the Angular app, port 8080 |
| `ghcr.io/alessandrobrunoh/trama-server` | `server/Dockerfile` | node:22-bookworm-slim | ~270 MB | the API, port 3000 |
| `ghcr.io/alessandrobrunoh/trama-mcp` | `mcp/Dockerfile` | distroless/cc (nonroot) | ~40 MB | the MCP server, port 8080 |

All images are built with the **repository root as the build context**, each with its own
`<Dockerfile>.dockerignore` allow-list (this is also how the deploy pipeline calls them):

```bash
docker build -t ghcr.io/alessandrobrunoh/trama-frontend:latest .
docker build -f server/Dockerfile -t ghcr.io/alessandrobrunoh/trama-server:latest .
docker build -f mcp/Dockerfile -t ghcr.io/alessandrobrunoh/trama-mcp:latest .
# optional: --build-arg VERSION=1.2.3 sets the org.opencontainers.image.version label
```

Production stack: `server/docker-compose.yml` (frontend, app, mcp, postgres) behind Traefik. Routing on
`trama.alessandrobrunoh.it`: `/api` → app, `/mcp` → mcp, everything else → frontend. Copy
`server/.env.production.example` to `server/.env.production` and fill in the `CHANGE_ME` values, then
`docker compose -f server/docker-compose.yml up -d`. With a deploy tool (Komodo, Portainer…) you can instead define the
same variables in the stack's environment: the tool writes them to `.env` in the repository root, which the `app` service
also reads (`server/.env.production`, if present, overrides it). The API will not start in production without at least
`DATABASE_URL` (host `postgres`, password = `POSTGRES_PASSWORD`, default `delta`) and `TRAMA_ENCRYPTION_KEY`.

**Postgres password.** Define `POSTGRES_PASSWORD` in the stack's environment (the compose file reads it through
`--env-file`, or pass `--env-file server/.env.production` when running by hand) and put the same value in
`DATABASE_URL`. Postgres applies it only when the data volume is created. For a volume that already exists, change it
once in the database, then redeploy:

```bash
docker exec delta-postgres psql -U delta -d trama -c "ALTER USER delta PASSWORD 'the-new-password'"
```

`npm run db:up` (development) starts only Postgres, published on `localhost:5434` by `server/docker-compose.dev.yml`.
In production Postgres has **no** host port: only the API (same compose network) can reach it.

## Publishing and pulling the images (ghcr.io)

The compose file pulls `ghcr.io/alessandrobrunoh/trama-frontend`, `trama-server` and `trama-mcp`. The names must match
exactly: an image pushed under another name (for example the old `trama-web`) is never picked up.

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u alessandrobrunoh --password-stdin   # token with write:packages
docker push ghcr.io/alessandrobrunoh/trama-frontend:latest   # likewise trama-server and trama-mcp
```

New packages on GitHub are **private**. Until the deploy host can read them, `docker compose pull` fails with
`error from registry: denied` and the deploy stops before the stack starts. Pick one:

- **Make the packages public** (GitHub → the package → *Package settings* → *Change visibility*). Simplest; fine for a
  source-available project, since the images contain no secrets (those come from the environment at runtime).
- **Give the host read access.** Create a token (classic, scope `read:packages`) and either add it in Komodo as a
  *Docker registry account* for `ghcr.io` and select it on the stack, or log in once on the host:
  `echo "$TOKEN" | docker login ghcr.io -u alessandrobrunoh --password-stdin`.

## What makes them small and safe
- Multi-stage builds with dependency layers cached separately (npm / cargo caches via BuildKit).
- Allow-list `.dockerignore` files: only what the build needs reaches the daemon; no `.env`, no `node_modules`.
- All three run as non-root, with `cap_drop: ALL`, `no-new-privileges`, and a read-only root filesystem in compose.
- Web: assets pre-gzipped at build time (`gzip_static`), content-hashed files cached for a year, `index.html` and
  service-worker metadata never cached, security headers on every response, `/api` and `/mcp` never answered with the SPA shell.
- API: production dependencies only, with source maps, type declarations and docs stripped; healthcheck on `/api/health`.
- MCP: LTO + stripped binary on distroless; `trama-mcp --healthcheck` replaces curl.

## Notes
- The optional Grok Build CLI (see `server/AI.md`) is not in the API image; extend it with
  `FROM ghcr.io/alessandrobrunoh/trama-server` and `npm install -g @xai-official/grok` if you need it.
- The Angular initial-bundle budget was raised to 1.75 MB (warning) / 2 MB (error): the app is now at ~1.6 MB raw
  (~265 kB gzipped), mostly the icon library (`@lucide/angular`, ~620 kB raw). Trimming it is a follow-up.
- Images are not published by any workflow yet; build and push them by hand or add a CI job.
