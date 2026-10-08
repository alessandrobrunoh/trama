# trama (CLI)

Agent-first command line for Trama. One small binary (about 3 MB, no runtime) for macOS, Linux and Windows.
Use it when the [MCP server](../mcp/README.md) is unreachable or blocked, from scripts and CI, or simply
because a shell command is the cheapest tool a coding agent has: no tool schemas in the context, just `--help`
when it needs one.

**Every API route is a command.** The CLI is generated from the same catalog as the MCP server
(`mcp/src/tools.json`: 107 routes with parameters, enums and permissions), so the two can never drift apart:
a route added to the catalog appears here with its flags, types and allowed values.

```bash
trama issue list --open --priority urgent,high --fields key,title,status
trama workstream context AUTH-42          # markdown briefing
trama project context prj_…               # markdown "mega context" of a whole project
trama project-update post prj_… --health on_track --file body=update.md
trama artifact add --issue-id BUG-142 --kind pull_request --title "Fix login" --url https://…
trama issue create --kind bug --title "Login times out" --file body=notes.md
trama issue update BUG-142 --status in_progress --unset estimate
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
| `TRAMA_API_KEY` | the key (`nbl_…`); wins over any saved profile |
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
trama issue list --account work            # one row per issue, each stamped with its workspace
trama issue list --all-workspaces         # every saved profile
trama issue list --workspace acme,beta
trama issue get BUG-142 --workspace acme   # a single workspace, by slug
```

Reads (`list`, `get`, `search`, the markdown briefings) run once per matching profile and merge the
results; each row gains `workspace` and `profile`, so a key that exists in two workspaces stays
distinguishable. A workspace that fails is reported and skipped. Writes stay on exactly one workspace:
a create or update with more than one match is refused, so nothing is ever created twice. `trama mcp`
uses the same selection (`trama mcp --account work`), and the hosted MCP server accepts several keys in
one header (`Authorization: Bearer nbl_one,nbl_two`). `TRAMA_API_KEY` is still a single key and wins
over every selection.

## Use

```
trama <resource> <verb> [ID_OR_KEY] [--flag value …]
```

Resources: `issue` `workstream` `criterion` `decision` `artifact` `input-request` `comment` `project`
`project-update` `milestone` `dependency` `team` `repository` `member` `agent` `token` `view` `attention` `event` `integration`
`outgoing-webhook` `graph` `snapshot` `workspace`, and `search`. Verbs: `list` `get` `create` `update` `delete`
plus actions (`issue link`, `decision accept`, `input-request answer`, `workstream context`, `project context`, `project artifacts`, …).
Aliases: `issues`, `ws`, `repo`, `webhook`; `ls`, `show`, `rm`; `project-update post|edit` (= `create|update`), `artifact add` (= `create`). Items are addressed by id or key (`BUG-142`, `AUTH-42`, `ADR-21`).

```bash
trama commands                      # every command with its HTTP route and permission
trama commands issue --detail       # …with every flag, type and allowed value
trama schema issue create           # JSON input schema (the MCP tool name works too: create_issue)
trama issue create --help
trama api GET /integrations -Q limit=5      # any route without a dedicated command
```

How flags are built from the catalog:

- path parameters are positional (`trama criterion update AUTH-42 crit_1 --state met`); everything else is `--kebab-case`;
- enums are validated before sending; lists are comma-separated (`--label a,b`); booleans can be bare (`--open`) or explicit (`--open false`);
- objects accept `type:id` for subjects (`--subject issue:iss_1`), `k=v,k=v`, JSON, or `@file`;
- `--data '{…}'` / `@file.json` / `-` supplies a whole JSON body; explicit flags win over it;
- `--file body=notes.md` (or `-` for stdin) reads long text, so nobody has to shell-escape a paragraph;
- `--unset a,b` sends `null` for optional fields of an update (clears them).

## Agent mode

Everything is predictable so an agent can use it without reading docs twice.

- **Output.** Compact JSON on stdout when piped, a table (lists) or indented JSON (objects) in a terminal.
  `-o json|pretty|jsonl|table|raw`; `--fields id,assignee.name` keeps only what you need (dot paths, arrays and
  `{"results":[…]}` envelopes handled). The markdown briefings (`workstream context`, `project context`) are passed through as is.
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
  `claude mcp add trama -- trama mcp`. `trama mcp config --client claude|cursor|vscode|codex [--transport http]` prints the snippet for each client.

## Development

```bash
cd cli
cargo test            # unit tests + end-to-end tests against an in-process fake API
cargo run -- --help
```

- `src/cmdtree.rs` turns the catalog into the command tree; `src/auth.rs` is login/logout/profiles; `src/http.rs`,
  `src/output.rs`, `src/error.rs` are the client, formatting and exit codes. Hand-written commands live in
  `src/builtin.rs`, `src/events.rs`, `src/mcp_cmd.rs`, `src/skill.rs`, `src/update.rs`.
- **Shared with the MCP server, not copied:** `mcp/src/{catalog,generic,protocol,upstream}.rs` and `tools.json`
  are compiled into this crate (`#[path]` in `src/main.rs`). Change them and both binaries move together.
- `tests/cli.rs` also checks that **every example in `skills/trama-cli/SKILL.md` parses** as a real command.
  When you edit that skill, run the tests.
- Release: bump `version` in `Cargo.toml`, then `git tag cli-vX.Y.Z && git push origin cli-vX.Y.Z`.
  `.github/workflows/cli-release.yml` builds the six targets, writes `SHA256SUMS` and publishes the GitHub release
  that `trama update` and the install scripts read.
