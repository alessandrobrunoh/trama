# trama-mcp

MCP server for Trama, written in Rust. It exposes the REST API as ~100 tools (plus `whoami` and a
path-restricted `api_request`) to any MCP client: Claude, Cursor, VS Code, or the in-app Assistant.

**It holds no data and no secrets.** Each client connects with its own API key
(Settings → API tokens → *Custom*). The server forwards that key to the API, which remains the only authority:
permissions (resource × action), the user's role and usage caps are all enforced there. The server only
hides the tools the key may not use.

## Run

```bash
docker compose -f server/docker-compose.yml up -d mcp        # production layout (behind Traefik at /mcp); see docker/README.md

docker build -f mcp/Dockerfile -t ghcr.io/alessandrobrunoh/trama-mcp .   # from the repo root
docker run --rm -p 8080:8080 -e TRAMA_API_URL=http://host.docker.internal:3000/api ghcr.io/alessandrobrunoh/trama-mcp

cd mcp && TRAMA_API_URL=http://localhost:3000/api cargo run   # local, listens on 127.0.0.1:8787
```

| Env | Default | |
|---|---|---|
| `TRAMA_API_URL` | `http://localhost:3000/api` | API base URL as seen from the server |
| `MCP_BIND` | `127.0.0.1:8787` | listen address (the Docker image sets `0.0.0.0:8080`) |
| `MCP_ALLOWED_ORIGINS` | none | comma-separated browser origins allowed (requests with any other `Origin` get 403) |
| `MCP_MAX_OUTPUT_BYTES` | `200000` | tool output beyond this is truncated |
| `MCP_UPSTREAM_TIMEOUT_SECS` | `30` | per API call |

## Connect a client

```bash
claude mcp add --transport http trama https://trama.alessandrobrunoh.it/mcp \
  --header "Authorization: Bearer nbl_…"
```

Streamable HTTP, stateless (`POST /mcp` only, JSON replies, no sessions). `--stdio` runs the same server over
stdin/stdout for local clients, with the key in `TRAMA_API_KEY`. The [`trama` CLI](../cli/README.md) embeds this protocol layer too:
`trama mcp` serves it over stdio using the CLI's saved login (`claude mcp add trama -- trama mcp`). `GET /healthz` is unauthenticated.

## Tools

`src/tools.json` is the catalog: one entry per route with its permission and a compact parameter spec (see
`src/catalog.rs`). To add a tool, add an entry; `server/src/auth/api-permissions.spec.ts` fails if a tool's
`permission` differs from what the API derives from its route, and `cargo test` validates the catalog.

Project-level tools: `get_project_context` (markdown "mega context" of a project: updates, milestones,
workstreams, issues, artifacts, decisions), `list_project_updates` / `get_project_update` /
`create_project_update` / `update_project_update` / `delete_project_update` (health + markdown status posts),
`list_project_artifacts` and `list_issue_artifacts`, and `create_artifact` with any of `projectId` / `issueId` / `workstreamId`.
Project routes are permissioned as `projects:*` and issue routes as `issues:*`.

## Security notes

- The key is never logged or cached (introspection is cached by its sha256 for 30 s).
- Redirects are never followed, so the key only goes to `TRAMA_API_URL`.
- `api_request` accepts plain workspace-relative paths only (no `..`, `%`, query, fragment) and always acts inside the key's workspace.
- Over-cap responses (HTTP 429) are surfaced to the model with an instruction to stop, not retry.
