# trama-mcp

MCP server for Trama, written in Rust. It exposes the REST API to any MCP client (Claude, Cursor, VS Code, or the
in-app Assistant) with <!-- mcp-tools-count:start -->21 task-oriented tools by default (the `core` profile; the whole catalog stays one switch away)<!-- mcp-tools-count:end -->. The whole catalog is still reachable: see [Tool profiles](#tool-profiles).

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
| `TRAMA_MCP_PROFILE` | `core` | tool set listed to clients: `core` (task-oriented) or `full` (every catalog tool); see [Tool profiles](#tool-profiles) |

## Connect a client

```bash
claude mcp add --transport http trama https://trama.alessandrobrunoh.it/mcp \
  --header "Authorization: Bearer trm_…"
```

Streamable HTTP, stateless (`POST /mcp` only, JSON replies, no sessions). `--stdio` runs the same server over
stdin/stdout for local clients, with the key in `TRAMA_API_KEY`. The [`trama` CLI](../cli/README.md) embeds this protocol layer too:
`trama mcp` serves it over stdio using the CLI's saved login (`claude mcp add trama -- trama mcp`). `GET /healthz` is unauthenticated.

### Several workspaces

Each key is still bound to one workspace. To cover more than one, connect several keys:

- HTTP: `Authorization: Bearer trm_one,trm_two` (or the extras in `X-Trama-Api-Keys` when the client allows only one Authorization header).
- `--stdio`: `TRAMA_API_KEYS=trm_one,trm_two` alongside `TRAMA_API_KEY`.
- `trama mcp`: every saved profile, narrowed with the same `--account`, `--workspace`, `--profile` or `--all-workspaces` flags as the CLI.

With more than one key every tool gains an optional `workspace` argument and a `list_accounts` tool lists the connected workspaces. Omit `workspace` on a read and the call runs in every connected workspace, each result stamped with the workspace it came from. A write needs exactly one: without `workspace` it is refused, so it can never land in every workspace at once. A single key is unchanged: no `workspace` argument, no `list_accounts`.

## Tool profiles

Agents choose better, and spend less context, with a short list of task-level tools than with one tool per REST
route. So the server lists the **`core`** profile by default and keeps the **`full`** catalog available.

<!-- mcp-tools-table:start -->
| Tool | What it does |
|---|---|
| `whoami` | Which workspace and permissions this API key has, its caps and expiry |
| `get_context` | Read everything about one workstream, issue, project, decision or input request by key or id |
| `find_work` | Find issues, workstreams, input requests or decisions with filters (assignee `me`, status, project…) |
| `search` | Full-text search across every object type; run it before creating anything |
| `get_insights` | Where the problems are: blocked or stale work, bottlenecks, stuck PRs, flow metrics, agent failures |
| `get_workspace` | Workspace settings: label ids, estimate scale |
| `list_repositories` | Registered git repositories (maps a checkout to its project) |
| `list_projects` | Projects; filter by repository to find the project of a checkout |
| `create_issue` | File an issue (duplicate-checked, optionally grouped into a workstream) |
| `update_issue` | Change an issue's status, priority, assignee, labels, duplicate marker… |
| `link_issue` | Group an issue under existing or new workstreams |
| `start_work` | Pick up a workstream or issue: briefing, safety checks, marks the start |
| `report_progress` | Record criteria, PR/build artifacts, issue status, project update and a comment in one call |
| `ask_human` | Ask a person one question (an input request), once |
| `record_decision` | Propose a lasting decision (a person accepts it) |
| `attach_artifact` | Attach or update a PR, build, document or link on a workstream, issue or project |
| `add_comment` | Comment on any object by key or id |
| `triage_issues` | Triage up to 25 issues in one call (priority, duplicates, grouping) |
| `list_capabilities` | Discover the full catalog: search it, get a tool's schema and how to call it |
| `run_tool` | Run any catalog operation by name, with the usual validation and permissions |
| `api_request` | Escape hatch: call any workspace REST route that has no tool (path-restricted) |
<!-- mcp-tools-table:end -->

`list_accounts` is added when several keys are connected. The composite tools (`get_context`, `find_work`, `start_work`,
`report_progress`, `ask_human`, `record_decision`, `attach_artifact`, `add_comment`, `triage_issues`, `create_issue`)
orchestrate several API calls with the caller's own key, check each step's permission and validate every argument, so
they can do nothing a plain tool could not. A tool whose permissions the key lacks is hidden.

**The long tail stays reachable.** `list_capabilities` searches the whole catalog (`{"q":"milestone"}`, `{"group":"teams"}`)
and returns the exact schema of one tool (`{"tool":"create_milestone"}`); `run_tool` runs it by name with the same
validation and permission checks as a listed tool; `api_request` reaches routes that have no tool at all. Tools that a
profile does not list can also still be called by name, so existing prompts keep working.

### Choosing a profile

| How | Example |
|---|---|
| Environment (server default) | `TRAMA_MCP_PROFILE=full` |
| Command line | `trama-mcp --profile full` (also `trama mcp --tools full`) |
| Per connection, header | `--header "X-Trama-Profile: full"` |
| Per connection, URL | `https://<host>/mcp?profile=full` |

The URL beats the header, the header beats the server default. `full` lists every `tools.json` entry (about a hundred,
with a much larger context cost); `core` is the default. Neither changes what a key may do: the API enforces permissions.

## Catalog

`src/tools.json` is the full catalog: one entry per route with its permission and a compact parameter spec (see
`src/catalog.rs`). It also drives the [`trama` CLI](../cli/README.md), which therefore always has every command. To add a
tool, add an entry; `server/src/auth/api-permissions.spec.ts` fails if a tool's `permission` differs from what the API
derives from its route, and `cargo test` validates the catalog. A new catalog tool is automatically in `full`, in
`list_capabilities` and reachable with `run_tool`; it joins `core` only if you list it in `src/curated.json`.

The curated layer is separate on purpose, so catalog changes and curation changes do not collide:

- `src/curated.json`: the `core` profile, in listing order. `kind: "catalog"` re-lists a catalog tool with a sharper
  description; `kind: "composite"` defines a task-level tool (description, JSON schema, `visibleIf` permissions and the
  catalog tools it may call in `uses`).
- `src/composite.rs`: how each composite maps its arguments onto catalog calls.
- `src/profile.rs`: profile selection, `list_capabilities`, validation of `curated.json` against the catalog.

`cargo test` fails when the tool count or table above is stale; refresh them with
`UPDATE_MCP_DOCS=1 cargo test generated_tool_docs_are_current`.

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
