# Docker images

| Image | Source | Base | Size | Serves |
|---|---|---|---|---|
| `ghcr.io/alessandrobrunoh/trama-web` | `Dockerfile` (repo root) | nginx-unprivileged (alpine) | ~55 MB | the Angular app, port 8080 |
| `ghcr.io/alessandrobrunoh/trama-server` | `server/Dockerfile` | node:22-bookworm-slim | ~270 MB | the API, port 3000 |
| `ghcr.io/alessandrobrunoh/trama-mcp` | `mcp/Dockerfile` | distroless/cc (nonroot) | ~40 MB | the MCP server, port 8080 |

All images are built with the **repository root as the build context**, each with its own
`<Dockerfile>.dockerignore` allow-list (this is also how the deploy pipeline calls them):

```bash
docker build -t ghcr.io/alessandrobrunoh/trama-web:latest .
docker build -f server/Dockerfile -t ghcr.io/alessandrobrunoh/trama-server:latest .
docker build -f mcp/Dockerfile -t ghcr.io/alessandrobrunoh/trama-mcp:latest .
# optional: --build-arg VERSION=1.2.3 sets the org.opencontainers.image.version label
```

Production stack: `server/docker-compose.yml` (web, app, mcp, postgres) behind Traefik. Routing on
`trama.alessandrobrunoh.it`: `/api` → app, `/mcp` → mcp, everything else → web. Copy
`server/.env.production.example` to `server/.env.production` and fill in the `CHANGE_ME` values, then
`docker compose -f server/docker-compose.yml up -d`.
`npm run db:up` (development) starts only Postgres.

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
