# trama (CLI)

Agent-first command line for Trama. One small binary (about 3 MB, no runtime) for macOS, Linux and Windows.
Use it when the [MCP server](../mcp/README.md) is unreachable or blocked, from scripts and CI, or simply
because a shell command is the cheapest tool a coding agent has: no tool schemas in the context, just `--help`
when it needs one.

**Every API route is a command.** The CLI is generated from the same catalog as the MCP server
(`mcp/src/tools.json`: every route with its parameters, enums and permissions), so the two can never drift apart:
a route added to the catalog appears here with its flags, types and allowed values. The CLI always has the full catalog;
the MCP server's shorter default tool list is a separate layer on top (`mcp/src/curated.json`) and never shrinks the CLI.

```bash
trama task list --open --priority urgent,high --fields key,title,status
trama task context AUTH-142              # markdown task context
trama artifact add --issue-id AUTH-142 --kind pull_request --title "Fix login" --url https://…
trama task create --kind bug --title "Login times out" --file body=notes.md
trama task update AUTH-142 --status in_progress --unset estimate
```

## Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/alessandrobrunoh/trama/main/cli/install/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/alessandrobrunoh/trama/main/cli/install/install.ps1 | iex

# from source (Rust toolchain)
cargo install --path cli --locked
```

Both scripts download the binary for your platform from the GitHub release and **verify it against the
release's `SHA256SUMS`** before installing (`~/.local/bin` or `%LOCALAPPDATA%\Programs\trama`; override with
`TRAMA_INSTALL_DIR`, pin with `TRAMA_VERSION`). Later: `trama update` (`--check` to only look).

Builds: `x86_64`/`aarch64` for Linux (glibc), macOS and Windows. Shell completion: `trama completion zsh|bash|fish|powershell`.

## Connect

```bash
trama login          # interactive: asks how to sign in
trama whoami         # workspace, role, permissions and caps of the key
trama doctor         # if anything fails: config, connectivity, key
```

A Trama API key is bound to **one workspace**; `login` saves it in a *profile*. To cover more than one workspace, add the keys to an *account* (`trama account add`) and read with `--account`, `--workspace` or `--all-workspaces`. Three ways in:

| | Command | Notes |
|---|---|---|
| Paste a key | `trama login` → 1, or `echo $KEY \| trama login --with-token --api-url https://trama.example.com` | Create it in Settings → API tokens (custom permissions, caps, expiry). Best for agents: give them the narrowest permissions that do the job. |
| Email + password | `trama login --email you@acme.com` (add `--workspace acme --scope write --expires-in 90d`) | Signs in once, **creates a key for this machine** in the workspace you pick, then signs out. The password is never stored (`--password-stdin` or `TRAMA_PASSWORD` to script it). |
| Browser | `trama login --web` | Opens the site so you can create a key, then you paste it. |

`--api-url` takes the site (`https://trama.example.com`), the API (`…/api`) or the MCP URL (`…/mcp`).
Plain `http://` is refused except for localhost (the key travels in every request); `TRAMA_ALLOW_INSECURE_HTTP=1` overrides it.

**No login at all** (CI, containers, agents): export the environment and run commands.

| Variable | |
|---|---|
| `TRAMA_API_KEY` | the key (`trm_…`); wins over any saved profile |
| `TRAMA_API_URL` | site or API URL (default `http://localhost:3000/api`) |
| `TRAMA_WORKSPACE` | workspace slug, to skip one lookup per run |
| `TRAMA_PROFILE`, `TRAMA_OUTPUT`, `TRAMA_NO_INPUT`, `TRAMA_YES` | profile name, default `-o`, never prompt, never confirm |

Profiles live in `~/.config/trama/config.json` (`%APPDATA%\trama` on Windows; `TRAMA_CONFIG_DIR` to move it),
written `0600`. Manage them with `trama profile list|use|show|remove`, `--profile <name>` per command, and
`trama logout [--revoke] [--all]` (`--revoke` also deletes the key on the server).

### Several workspaces

A key still belongs to exactly one workspace. An **account** is the name that groups the keys you add,
so one command can read all of them:

```bash
# keys you already created, one per line
printf '%s\n' "$KEY_ACME" "$KEY_BETA" | trama account add --with-token --api-url https://trama.example.com --name work

# or sign in once and mint a key in every workspace the account belongs to
trama account add --email you@acme.com --name work                 # add --workspace acme,beta to limit it

trama account list
trama task list --account work            # one row per task, each stamped with its workspace
trama task list --all-workspaces         # every saved profile
trama task list --workspace acme,beta
trama task get AUTH-142 --workspace acme  # a single workspace, by slug
```

Reads (`list`, `get`, `search`, the markdown briefings) run once per matching profile and merge the
results; each row gains `workspace` and `profile`, so a key that exists in two workspaces stays
distinguishable. A workspace that fails is reported and skipped. Writes stay on exactly one workspace:
a create or update with more than one match is refused, so nothing is ever created twice. `trama mcp`
uses the same selection (`trama mcp --account work`), and the hosted MCP server accepts several keys in
one header (`Authorization: Bearer trm_one,trm_two`). `TRAMA_API_KEY` is still a single key and wins
over every selection.

## Use

```
trama <resource> <verb> [ID_OR_KEY] [--flag value …]
```

Resources: `task` `artifact` `comment` `project`
`milestone` `member` `agent` `token` `view` `attention` `event` `integration`
`outgoing-webhook` `snapshot` `workspace`, and `search`; plus `timer` (hand-written, see
[Subtasks, estimates and timer](#subtasks-estimates-and-timer)). Verbs: `list` `get` `create` `update` `delete`
plus actions (`task context`, `task artifacts`, `task subtasks`, …).
Aliases: `tasks`, `webhook`; `ls`, `show`, `rm`; `artifact add` (= `create`). Items are addressed by id or key (`CORA-142`, `AUTH`).

```bash
trama commands                      # every command with its HTTP route and permission
trama commands task --detail       # …with every flag, type and allowed value
trama schema task create           # JSON input schema (the MCP tool name works too: create_task)
trama task create --help
trama api GET /integrations -Q limit=5      # any route without a dedicated command
```

How flags are built from the catalog:

- path parameters are positional (`trama task update AUTH-142 --status in_progress`); everything else is `--kebab-case`;
- enums are validated before sending; lists are comma-separated (`--label a,b`); booleans can be bare (`--open`) or explicit (`--open false`);
- objects accept `type:id` for subjects (`--subject issue:iss_1`), `k=v,k=v`, JSON, or `@file`;
- `--data '{…}'` / `@file.json` / `-` supplies a whole JSON body; explicit flags win over it;
- `--file body=notes.md` (or `-` for stdin) reads long text, so nobody has to shell-escape a paragraph;
- `--unset a,b` sends `null` for optional fields of an update (clears them).

### Subtasks, estimates and timer

Tasks nest to any depth through `parentId`, carry a story-point `estimate` and a `threadUrl` (the link to the
thread that works on the task). These are plain flags of the generated commands:

```bash
trama task create --kind feature --title "Add SSO button" --parent-id AUTH-142 --estimate 3 \
  --thread-url https://delta.example/thread/abc          # a subtask with an estimate and a thread link
trama task update AUTH-143 --estimate 5 --milestone-ids ms_1
trama task update AUTH-143 --unset estimate,threadUrl   # clear them
trama task update AUTH-143 --parent-id AUTH-100         # move under another task (--unset parentId = a root task)
trama task get AUTH-142 --fields key,status,estimate,threadUrl,parentId
```

The API has no parent filter, so these two read the newest 500 tasks once and filter here (a warning says when
that limit was reached; narrow with `--project-id`):

```bash
trama task subtasks AUTH-142                  # the whole tree: indented text in a terminal or with -o table, nested JSON when piped
trama task subtasks AUTH-142 --depth 1        # direct subtasks only
trama task list --parent AUTH-142 --open      # direct subtasks as a normal list (newest first)
trama project list --repository acme/web      # the API does not filter by repository; matched here (owner/name or URL, case-insensitive)
```

The timer is the signed-in person's own (other people's entries are never listed or changed). It needs a login that
acts as a person; **custom** tokens are refused by the API for it. Instants are ISO-8601 **with a zone**
(`2026-05-01T09:30:00Z`, `…+02:00`); a task key is resolved to its id for you.

```bash
trama timer start AUTH-142 --description "login fix"   # stops a timer that is already running (the output names it)
trama timer status                                     # the running timer, elapsed time and its task
trama timer stop
trama timer list AUTH-142                              # that task's entries (of your 100 latest), with durations
trama timer add AUTH-142 --started-at 2026-05-01T09:00:00Z --ended-at 2026-05-01T10:15:00Z
trama timer delete te_123
```

### The `/trama` verbs

Short, hand-written commands for the agent flow of the `trama-cli` skill. A task links **one** thread
(`DELTA_THREAD_URL` names the current one); an agent keeps a *record* of it with `sync`. In a terminal (or with
`-o table`) they print one-line results (`✓ summary · 2 decisions · 3 files · 47m suggested`); piped, JSON that also
carries the line as `message`. Every verb honours `--dry-run`.

```bash
trama show AUTH-142 [--json]                  # task, subtasks (any depth), decisions, record: { task, subtasks, decisions, record }
trama ls [--mine] [--open|--all] [--limit N]  # open tasks; --mine needs a key that acts as a person
trama link AUTH-142 [--thread URL_OR_ID]      # default: DELTA_THREAD_URL; exit 6 when another thread is linked (names it)
trama sub AUTH-142 "Retry metrics" [--link] [--thread URL_OR_ID]   # subtask in the parent's project and kind
trama status AUTH-142 in-progress             # in-progress / in_progress / a workspace status name; people own the rest
trama sync AUTH-142 --summary "Alert wired" --decision "Alert after 3 failures@src/auth/" \
  --files-from-git --pr acme/web#423 --minutes 47 [--file PATH]... [--turns N] [--thread URL] [--summary-file F|-]
trama sync --all --summary "…"                # every task linked to the current thread
trama decisions [--path FILE] [--issue ID] [--limit N]   # newest first; a path matches the file, a directory above it or a glob
trama ask "refresh tokens"                    # decisions and records that match; lists them, does not answer
trama estimate AUTH-142                       # suggested points and the finished tasks behind them; writes nothing
trama time start AUTH-142 | stop | status     # same requests as `trama timer`
trama time log AUTH-142 1h15 [--at END] [--description T]   # 1h15, 1h, 45m, 90 (minutes) or 1:15
trama time suggestions                        # entries `sync --minutes` suggested; `accept <id>` (or `time accept <id>`) takes one
```

`--decision "TEXT@path,path"` takes the paths after the last `@` (no spaces); end a text with a lone `@` to keep an
@handle. `--files-from-git` adds the working-tree changes and the branch's changes since it left the default branch,
and only warns outside a repository. A bare thread id (`th_…`) needs `TRAMA_THREAD_URL_BASE`, or is joined to
the directory of `DELTA_THREAD_URL`. `--pr owner/repo#123` is read as GitHub when the project's repository is.

`trama commands` lists all of these next to the generated commands. Project `health` is not a flag: the API still
stores it, but it duplicates the project status, so the CLI and MCP no longer expose it.

## Agent mode

Everything is predictable so an agent can use it without reading docs twice.

- **Output.** Compact JSON on stdout when piped, a table (lists) or indented JSON (objects) in a terminal.
  `-o json|pretty|jsonl|table|raw`; `--fields id,assignee.name` keeps only what you need (dot paths, arrays and
  `{"results":[…]}` envelopes handled). Terminal control characters in human-readable tables, Markdown context
  briefings, and text errors are escaped visibly to prevent terminal control/spoofing sequences. Explicit
  `-o raw`, JSON output modes, and JSON errors (`TRAMA_ERRORS=json`) remain machine-oriented and unescaped.
- **Task artifacts.** `trama task get AUTH-142 --fields key,title,status,artifactCount` includes a count for callers with
  `artifacts:read`; zero means skip `trama task artifacts`. The field is absent without artifact access.
- **Errors.** JSON on stderr: `{"error":{"code","message","status","hint"}}` (plain text in a terminal), and a stable exit code:

  | exit | code | |
  |---|---|---|
  | 0 | | success |
  | 2 | `usage` | bad command line or local input |
  | 3 | `auth` | no/invalid key (401), or missing permission (403) |
  | 4 | `not_found` | 404 |
  | 5 | `rate_limited` | 429: **stop, never retry in a loop** (the CLI itself never retries a 429) |
  | 6 | `conflict` | 409 |
  | 7 | `network` | unreachable, timeout, 5xx (reads are retried twice, writes never) |
  | 8 | `validation` | the API rejected the input |
  | 1 | `internal` | anything else |

- **Safe by default.** No prompts when stdin is not a terminal (`TRAMA_NO_INPUT=1` forces it). `--dry-run`
  prints method, URL and body without sending. In a terminal, deletes ask for confirmation unless `--yes`.
- **Live.** `trama event watch --entity issue --count 1 --for 300` streams workspace events as JSON lines, then exits.
- **Teach the agent.** `trama skill install` writes the `trama-cli` skill to `~/.claude/skills`
  (`--target agents` → `.agents/skills`, `--scope project`, `--dir`). `trama skill show` prints it for an `AGENTS.md`.
- **MCP bridge.** `trama mcp` is an MCP server over stdio using your saved login, with the same tools as the hosted one:
  `claude mcp add trama -- trama mcp`. It lists the short task-level `core` set by default; `trama mcp --tools full` (or `TRAMA_MCP_PROFILE=full`) lists every catalog tool, and `list_capabilities` + `run_tool` reach the rest of the catalog from `core`. `trama mcp config --client claude|cursor|vscode|codex [--transport http]` prints the snippet for each client.

## Development

```bash
cd cli
cargo test            # unit tests + end-to-end tests against an in-process fake API
cargo run -- --help
```

- `src/cmdtree.rs` turns the catalog into the command tree; `src/auth.rs` is login/logout/profiles; `src/http.rs`,
  `src/output.rs`, `src/error.rs` are the client, formatting and exit codes. Hand-written commands live in
  `src/builtin.rs`, `src/events.rs`, `src/mcp_cmd.rs`, `src/skill.rs`, `src/update.rs`, and `src/workcmd.rs` (the
  subtask tree, `timer` and the `--parent` / `--repository` filters; their routes are outside the API
  permission catalog, so they are not in `tools.json`).
- **Shared with the MCP server, not copied:** `mcp/src/{catalog,composite,generic,profile,protocol,upstream,work}.rs`, `tools.json` and `curated.json`
  are compiled into this crate (`#[path]` in `src/main.rs`). Change them and both binaries move together.
- `tests/cli.rs` also checks that **every example in `skills/trama-cli/SKILL.md` parses** as a real command.
  When you edit that skill, run the tests.
- Release: bump `version` in `Cargo.toml`, then `git tag cli-vX.Y.Z && git push origin cli-vX.Y.Z`.
  `.github/workflows/cli-release.yml` builds the six targets, writes `SHA256SUMS` and publishes the GitHub release
  that `trama update` and the install scripts read.
