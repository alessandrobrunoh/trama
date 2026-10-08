---
name: trama-cli
description: Work in Trama (issues, workstreams, decisions, artifacts, input requests) from the shell with the `trama` CLI. Use when the Trama MCP tools are unavailable, when the user tells you to use the `trama` command, or whenever `trama` is on PATH and the user mentions a workstream like AUTH-42, an issue like BUG-142 or a decision like ADR-21.
---

# Trama through the `trama` CLI

The CLI exposes the same API as the Trama MCP tools, so the concepts and rules of the `trama` skills (issues are demand, workstreams are outcomes, you propose decisions but never accept them) apply unchanged. Only the interface differs: every MCP tool is a shell command.

## Connect once

```bash
trama whoami            # which workspace, role and permissions this key has
trama doctor            # if something fails: config, connectivity, key
```

If `whoami` says you are not signed in, ask the user to run `trama login` (they pick a method), or use environment variables:

```bash
export TRAMA_API_KEY=nbl_…            # a key from Settings → API tokens
export TRAMA_API_URL=https://<host>   # site or API URL
```

Never print, log or commit the key. Use the narrowest permissions that do the job.

## Command shape

```
trama <resource> <verb> [ID_OR_KEY] [--flag value …]
```

Resources: `issue` `workstream` `criterion` `decision` `artifact` `input-request` `comment` `project` `project-update` `milestone` `dependency` `team` `repository` `member` `agent` `token` `view` `attention` `event` `integration` `outgoing-webhook` `graph` `snapshot` `workspace`, plus `search`.
Verbs: `list` `get` `create` `update` `delete` and action verbs (`link`, `accept`, `answer`, `dismiss`, `context`, …).

**Discover instead of guessing:**

```bash
trama commands                     # every command: HTTP route, permission, summary
trama commands issue --detail      # with every flag, its type and allowed values
trama schema issue create          # JSON input schema of one command
trama issue create --help
```

Items are addressed by id (`iss_…`, `wk_…`) or by key (`BUG-142`, `AUTH-42`, `ADR-21`, team key `AUTH`).

## Reading

```bash
trama search --q "login timeout"
trama issue list --open --priority urgent,high --fields key,title,status,assigneeId
trama issue get BUG-142
trama workstream get AUTH-42
trama workstream context AUTH-42          # markdown briefing: read this before starting work
trama project context prj_…               # markdown "mega context" of a whole project: read before reporting on it
trama project-update list prj_…
trama project artifacts prj_…
trama issue artifacts BUG-142
trama workstream list --status working --team-id tm_…
trama event list --workstream-id wk_… --limit 20
```

Output is compact JSON when piped. Keep it small with `--fields a,b.c` (dot paths work on arrays too); `-o table` for a human view, `-o jsonl` for one object per line, `-o raw` for the exact reply. Avoid `trama snapshot get`: it is huge.

## Writing

```bash
trama issue create --kind bug --title "Login times out" --priority high
trama issue update BUG-142 --status in_progress --assignee-id usr_…
trama issue update BUG-142 --unset estimate          # null clears an optional field
trama issue link BUG-142 --workstream-ids wk_…
trama comment create --subject issue:iss_… --body "Reproduced on main."
trama criterion update AUTH-42 crit_… --state met
trama input-request create --workstream-id wk_… --question "Keep the old endpoint?" --options "yes,no"
trama decision create --title "Use OAuth device flow" --statement "…" --rationale "…" --status proposed
```

### Project updates and artifacts

```bash
trama project-update post prj_… --health at_risk --file body=notes.md   # alias of `create`; health: on_track | at_risk | off_track
trama project-update edit prj_… pu_… --body "Corrected: the importer is merged."   # alias of `update`
trama project update prj_… --icon rocket                  # icon: Lucide name or one emoji; --unset icon clears it
trama artifact add --project-id prj_… --kind link --title "Launch plan" --url https://example.com/plan   # alias of `create`
trama artifact add --issue-id BUG-142 --kind pull_request --title "Fix login timeout" --state open
```

An artifact needs at least one of `--project-id`, `--issue-id`, `--workstream-id`. Write the update after reading `project context`, base `--health` on facts, and prefer `at_risk` over a rosy guess.

- Long text: `--file body=notes.md` (or `--file body=-` to read stdin), never shell-escape paragraphs.
- Whole bodies as JSON: `--data '{"kind":"bug","title":"…"}'`, `--data @payload.json` or `--data -`. Explicit flags win over `--data`.
- List flags take comma-separated values: `--label a,b`. Boolean flags can be bare (`--open`) or explicit (`--open false`).
- **Preview any write first with `--dry-run`**: it prints method, URL and body and sends nothing.
- A route with no dedicated command: `trama api GET /integrations`, `trama api POST /outgoing-webhooks/ow_…/test -d '{}'`.

## Results and errors

Success: JSON on stdout (`{"ok":true}` for deletes). Failure: JSON on stderr, `{"error":{"code","message","status","hint"}}`, and a stable exit code:

| exit | code | what to do |
|---|---|---|
| 2 | `usage` | fix the command; `trama <cmd> --help` |
| 3 | `auth` | not signed in, key revoked, or permission missing (`trama whoami` lists permissions). Do not look for workarounds; tell the user |
| 4 | `not_found` | wrong key, or not visible to this key |
| 5 | `rate_limited` | **stop and tell the user. Never retry in a loop** |
| 6 | `conflict` | duplicate key, bad state transition: read the message |
| 7 | `network` | API unreachable or failing; retry once later |
| 8 | `validation` | the API rejected a field; `trama schema <cmd>` |

## Ground rules

1. `whoami` first; read before you write (`workstream context`, `search`, targeted `list`/`get`).
2. Never set a workstream's status yourself: it is derived from criteria, artifacts and input requests. Leave `--status-override` alone unless the user asks.
3. Report facts only (criteria met, PR state, CI result), never guesses or percentages.
4. You cannot accept decisions: create them as `draft` or `proposed`.
5. If a human must choose, open an `input-request` instead of guessing or stalling.
6. Search before creating, to avoid duplicates. Write once, not in a loop: keys have per-minute and per-day write caps.

## Wake up on activity

```bash
trama event watch --entity issue --count 1 --for 300   # one JSON line per change, then exit
```

Each line is a pointer (`entity`, `id`, `type`); read the object with the matching `get` command.

## From MCP tool names

An MCP tool `create_issue` is `trama issue create`; `get_workstream_context` is `trama workstream context`; `get_project_context` is `trama project context`; `create_project_update` is `trama project-update create` (alias `post`); `list_project_artifacts` is `trama project artifacts`; `answer_input_request` is `trama input-request answer`; `list_webhook_deliveries` is `trama outgoing-webhook deliveries`. `trama schema create_issue` accepts the MCP name too.
