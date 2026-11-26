# trama-mcp

MCP server for Trama, written in Rust. It exposes the REST API to any MCP client (Claude, Cursor, VS Code, or the
in-app Assistant) with <!-- mcp-tools-count:start -->22 task-oriented tools by default (the `core` profile; the whole catalog stays one switch away)<!-- mcp-tools-count:end -->. The whole catalog is still reachable: see [Tool profiles](#tool-profiles).

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
| `TRAMA_API_URL` | `http://localhost:3000/api` | API base URL as seen from the server. HTTPS is required except for loopback; URLs with userinfo, query, or fragment are rejected. |
| `TRAMA_MCP_ALLOW_INTERNAL_HTTP` | unset | Set to `true` only for an API on a trusted private network, such as the isolated self-host Compose network. Bearer keys are unencrypted over HTTP. |
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

The HTTP listener does not provide TLS. For any network-accessible deployment, terminate TLS at a trusted reverse proxy and forward to MCP over a private network. Do not publish the MCP container port directly to an untrusted network. The self-host Compose stack publishes only Caddy proxy ports; its MCP service has no `ports:` mapping and is reached internally.

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
| `get_context` | Read task or artifact context by key or id |
| `find_work` | Find tasks with filters (assignee `me`, status, project…) |
| `search` | Full-text search across every object type; run it before creating anything |
| `get_insights` | Where the problems are: stale or overdue tasks, bottlenecks, stuck PRs, flow metrics, agent failures |
| `get_workspace` | Workspace settings: label ids, estimate scale |
| `list_projects` | Projects; filter by repository string to find the project of a checkout |
| `create_task` | File a task (duplicate-checked) |
| `update_task` | Change a task's status, priority, assignee, labels, parent, duplicate marker… |
| `start_work` | Pick up a task: context, safety checks, marks the start |
| `report_progress` | Record artifacts, task status and a comment |
| `link_thread` | Link the thread you work in to a task (one thread per task) |
| `sync_thread` | Update the task's thread record: summary, decisions, files, PR, active minutes |
| `find_decisions` | Past decisions, by file path or task: read them before touching a file |
| `suggest_estimate` | Suggest points from similar finished tasks; you never set the estimate |
| `track_time` | Your timer: start or stop it on a task, see what runs, list, add or delete entries |
| `attach_artifact` | Attach or update a PR, build or link on a task |
| `add_comment` | Comment on any object by key or id |
| `triage_tasks` | Triage up to 25 tasks in one call (priority, duplicates, grouping) |
| `list_capabilities` | Discover the full catalog: search it, get a tool's schema and how to call it |
| `run_tool` | Run any catalog operation by name, with the usual validation and permissions |
| `api_request` | Escape hatch: call any workspace REST route that has no tool (path-restricted) |
<!-- mcp-tools-table:end -->

`list_accounts` is added when several keys are connected. The composite tools (`get_context`, `find_work`, `list_projects`,
`start_work`, `report_progress`, `link_thread`, `sync_thread`, `find_decisions`, `suggest_estimate`, `track_time`,
`attach_artifact`, `add_comment`, `triage_tasks`, `create_task`) orchestrate several API calls with the caller's own key, check each step's permission and validate every
argument, so they can do nothing a plain tool could not. A tool whose permissions the key lacks is hidden.

What the task-level tools cover beyond plain CRUD:

- **Subtasks** nest to any depth (`parentId`). `get_context {id, subtasks:true}` returns the task's whole subtask tree
  (`subtasks`, each node's `subtasks` holding its children; `depth` limits the levels) and `find_work {parentId}` lists
  only its direct subtasks. The API has no parent filter, so both read the newest 500 tasks once and build the answer
  here (a hint says when that limit was reached). `create_task {parentId}` creates a subtask; `update_task {parentId}` moves one.
- **Estimates and thread link**: `create_task` / `update_task` take `estimate` (points) and `threadUrl` (the link to the
  thread working on the task); `null` clears them on update. Both come back on every task read.
- **`track_time`** is the signed-in person's timer: `action` `start` (on a task key or id; a running timer is stopped and
  named), `stop`, `status` (running timer plus its task), `list` (your 100 latest entries, optionally of one task, with
  durations and a total), `add` (`startedAt`/`endedAt` as ISO-8601 with a zone) and `delete` (`entryId`). It needs a key
  that acts as a user; the API refuses these routes to `custom` tokens and the tool reports that.
- **`list_projects {repository}`** matches the repository string itself (owner/name or URL, any spelling of the same
  repository), because the API does not filter by it. Project `health` is not exposed in any schema: it duplicates the
  project status (the API still stores it).

- **Thread records** (the `/trama` flow, same behaviour as the `trama show|link|sync|decisions|estimate` CLI verbs).
  A task links **one** thread. `link_thread {issue, threadUrl}` sets it (idempotent for the same URL); when the task
  already links a different one it answers an error with `code: "thread_already_linked"`, the `threadUrl` it has and the
  advice to ask the person and continue on a new subtask (`create_task {parentId, threadUrl}`), and it never replaces it.
  `sync_thread {issue, summary?, decisions?, files?, pullRequestUrl?, activeMinutes?, turns?, threadUrl?}` sends what a
  thread did in one request: the summary replaces the last one, decisions append (`{text, paths?}` where a path is a file,
  a directory like `src/auth/` or a glob like `src/auth/*`), files merge, the PR is attached to the task and
  `activeMinutes` becomes a *suggested* time entry a person accepts (`trama time accept`). It never changes the task
  status. `find_decisions {path?, issue?, limit?}` lists past decisions, newest first; call it before editing a file.
  `suggest_estimate {issue}` reads the points suggested from similar finished tasks and writes nothing. `get_context`
  also returns the task's `decisions`.

`track_time` calls routes outside the API permission catalog, so it is a composite with its own
code (`src/composite.rs`, request building in `src/work.rs`) rather than a `tools.json` entry; the `full` profile, which is
the plain catalog, does not list it (it stays callable by name, and `api_request` reaches the same routes).

**The long tail stays reachable.** `list_capabilities` searches the whole catalog (`{"q":"milestone"}`, `{"group":"tasks"}`)
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

The URL beats the header, the header beats the server default. `full` lists every `tools.json` entry (73 catalog operations,
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

Artifact tools: `list_task_artifacts` and `create_artifact`, which attaches a PR, build or link to a task by `issueId`
(the wire field for a task is still `issueId`). Project routes are permissioned as `projects:*` and task routes as `tasks:*`.

## Security notes

- The key is never logged or cached (introspection is cached by its sha256 for 30 s).
- Redirects are never followed, so the key only goes to `TRAMA_API_URL`.
- `api_request` accepts plain workspace-relative paths only (no `..`, `%`, query, fragment) and always acts inside the key's workspace.
- Over-cap responses (HTTP 429) are surfaced to the model with an instruction to stop, not retry.
