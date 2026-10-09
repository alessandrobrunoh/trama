# Self-hosting Trama

One compose file, five containers: a Caddy proxy (TLS and routing), the web app, the API, the MCP server and
Postgres. Only the proxy publishes ports. You need Docker with the Compose plugin and, for HTTPS, a DNS name that
points at the host with ports 80 and 443 open.

> Trama is not yet considered production-ready (see [SECURITY.md](../SECURITY.md)). Back up before every upgrade.

## Install

```bash
git clone https://github.com/alessandrobrunoh/trama && cd trama
cp docker/selfhost.env.example .env
```

Fill in the three required values in `.env`. There are no defaults for them: `docker compose` refuses to start and
names the missing one.

| Variable | What | How |
|---|---|---|
| `TRAMA_PUBLIC_URL` | The address people use, e.g. `https://trama.example.com` | `http://localhost` for a local trial |
| `POSTGRES_PASSWORD` | Database password | `openssl rand -hex 24` (hex: it goes into a URL) |
| `TRAMA_ENCRYPTION_KEY` | Encrypts integration tokens and webhook secrets at rest | `openssl rand -base64 32` |

Also set `TRAMA_VERSION` to a release (for example `0.1.0`) instead of `latest`, then start:

```bash
docker compose -f docker-compose.selfhost.yml up -d --wait
```

Open `TRAMA_PUBLIC_URL`, sign up and create your workspace (you become its owner), then create tokens for your
agents under *Settings → API tokens*. The MCP server is at `TRAMA_PUBLIC_URL/mcp`.

Sign-up is open: anyone who can reach the URL can create an account and their own workspace (they cannot see yours).
If the instance should not be public, restrict access at the network level (VPN, firewall, an authenticating proxy
in front of the stack).

For a local trial where port 80 is taken: `TRAMA_PUBLIC_URL=http://localhost:8080` and `TRAMA_HTTP_PORT=8080`. The
session cookie is `Secure`; Chrome and Firefox accept it on `http://localhost`, Safari and any other plain-HTTP host
do not, so use HTTPS for anything beyond a trial.

## Configure

All settings live in `.env` (the compose file maps them to the containers).

| Variable | Default | Notes |
|---|---|---|
| `TRAMA_PUBLIC_URL` | required | Also used for CORS, links in emails and webhook URLs. A `https://` address makes Caddy obtain and renew a Let's Encrypt certificate |
| `TRAMA_TRUST_PROXY` | `1` | Proxy hops in front of the API, used to see real client addresses for rate limiting. `1` is the bundled Caddy. Behind Cloudflare or a cloud load balancer as well, use `2`. Wrong values make every client share one address |
| `TRAMA_ENCRYPTION_KEY` | required | Back it up with the database. Changing it makes stored integration secrets unreadable |
| `SMTP_URL`, `MAIL_FROM` | empty | `smtps://user:pass@host:465` or `smtp://user:pass@host:587`. Empty: invitations are not emailed, the link is shown in the UI |
| `AI_API_URL`, `AI_API_KEY`, `AI_MODEL` | empty | Optional AI suggestions and assistant, any OpenAI-compatible API. Empty: off. See [server/AI.md](../server/AI.md) |
| `VAPID_*` | empty | Optional browser push (`npx web-push generate-vapid-keys`) |
| `TRAMA_VERSION` | `latest` | Image tag of the three Trama images |
| `TRAMA_REGISTRY` | `ghcr.io/alessandrobrunoh` | Change it if you mirror or fork the images |
| `TRAMA_HTTP_PORT`, `TRAMA_HTTPS_PORT` | `80`, `443` | Published ports |

Already have a reverse proxy? Remove the `proxy` service, publish `web` (8080), `api` (3000) and `mcp` (8080) to it
and route `/api/*` to the API, `/mcp` to the MCP server and everything else to the web container, without response
buffering on `/api` (live updates use server-sent events). Set `TRAMA_TRUST_PROXY` to the number of proxies.

## Upgrade

Migrations run when the API boots, so an upgrade is a new tag.

```bash
# 1. back up (see below)
# 2. set the new version in .env, e.g. TRAMA_VERSION=0.2.0
docker compose -f docker-compose.selfhost.yml pull
docker compose -f docker-compose.selfhost.yml up -d --wait
```

Check the release notes for the new tag first. Releases are published when a `vX.Y.Z` tag is pushed, as
`ghcr.io/alessandrobrunoh/trama-frontend`, `trama-server` and `trama-mcp` for `linux/amd64` and `linux/arm64`
(tags `X.Y.Z`, `X.Y` and, for stable releases, `latest`).

## Back up and restore

Postgres holds everything. Back up the database and `TRAMA_ENCRYPTION_KEY` (keep the key somewhere other than the
backup file).

```bash
# back up: a compressed custom-format dump
docker compose -f docker-compose.selfhost.yml exec -T postgres \
  pg_dump -U trama -Fc trama > trama-$(date +%F).dump

# restore into the running stack: stop the writers, replace the data, start them again
docker compose -f docker-compose.selfhost.yml stop api mcp
docker compose -f docker-compose.selfhost.yml exec -T postgres \
  pg_restore -U trama -d trama --clean --if-exists --no-owner --single-transaction < trama-2026-10-09.dump
docker compose -f docker-compose.selfhost.yml start api mcp
```

To restore on a new host: install as above with the same `TRAMA_ENCRYPTION_KEY`, run
`docker compose -f docker-compose.selfhost.yml up -d postgres --wait`, then run the `stop`/`pg_restore`/`start`
steps (stopping `api` and `mcp` is harmless if they are not running yet). Run a backup on a schedule (cron) and
restore it somewhere once, so you know it works.

## Roll back

Images are immutable per tag, but **migrations are not reversed by starting an older image**. A newer schema under
an older API can fail or misbehave. So:

1. Before an upgrade, take a backup (above).
2. To roll back, stop the stack, restore that backup (data is replaced with the pre-upgrade state, so changes made
   since are lost), set the previous `TRAMA_VERSION` in `.env` and `up -d` again.

```bash
docker compose -f docker-compose.selfhost.yml stop api mcp
docker compose -f docker-compose.selfhost.yml exec -T postgres \
  pg_restore -U trama -d trama --clean --if-exists --no-owner --single-transaction < trama-before-upgrade.dump
# set TRAMA_VERSION=<previous> in .env
docker compose -f docker-compose.selfhost.yml up -d --wait
```

## Changing the database password

`POSTGRES_PASSWORD` is only applied when the data volume is first created. For an existing volume change it in the
database and in `.env`, then recreate the API:

```bash
docker compose -f docker-compose.selfhost.yml exec postgres \
  psql -U trama -d trama -c "ALTER USER trama PASSWORD 'the-new-hex-password'"
# update POSTGRES_PASSWORD in .env, then:
docker compose -f docker-compose.selfhost.yml up -d
```

## Health and logs

Every container has a healthcheck, so `docker compose -f docker-compose.selfhost.yml ps` shows `healthy` when the
stack is up. The API answers `GET /api/health` (database included). Logs: `docker compose -f docker-compose.selfhost.yml logs -f api`.

## Compared with `server/docker-compose.yml`

`server/docker-compose.yml` is the project author's own deployment and is kept as is.

| | `docker-compose.selfhost.yml` | `server/docker-compose.yml` |
|---|---|---|
| Routing and TLS | Bundled Caddy, any domain | Traefik on an external `proxy` network, fixed domain and labels |
| Postgres user / password | `trama` / required, no default | `delta` / `${POSTGRES_PASSWORD:-delta}` |
| Configuration | One `.env` next to the file | `../.env` and `server/.env.production` |
| Images | Pulled only, pinned with `TRAMA_VERSION` | Pulled `:latest` or built locally |
| Postgres volume | `trama-pgdata` | `delta-pgdata` (do not mix the two) |
