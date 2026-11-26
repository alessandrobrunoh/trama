---
name: trama-cli
description: Work with Trama tasks and their thread record from the `trama` CLI when MCP is unavailable, when the user requests the shell interface, or when a CLI workflow is otherwise appropriate.
---

# Trama through the `trama` CLI

Use the CLI for the same flow described in `trama` (`/trama TRM-128`): a Task is the unit of work, your thread is attached to it as a record, and people own the status. Keep full transcripts in execution tools, not Trama.

## The flow, with short verbs

Read `.trama` first (below). For the task `<ID>` (`TRM-128`, `TRM-128.3`):

1. `trama show <ID> --json`: read the task, subtasks, decisions and record.
2. `trama link <ID> --thread <current>`: link this thread. If the task already links another thread it exits non-zero ("already linked"): ask the user, then `trama sub <ID> "<title>" --link` and continue on the new subtask.
3. `trama status <ID> in-progress`: the only status you ever set. Never set `in_review` or `done`.
4. After each turn that edits files: `trama sync <ID> --summary "…" --files-from-git`.
5. When you open a PR: `trama sync <ID> --pr <url>`.
6. Before touching a file: `trama decisions --path <file>`.
7. `trama sync` also sends your active minutes (`--minutes N`) as a suggested time entry for a person to accept.

The current thread is the environment variable `DELTA_THREAD_URL` (`link`, `sub --link` and `sync --all` read it when `--thread` is not given). If it is unset, ask the user once for the thread link. A bare `th_…` id needs `TRAMA_THREAD_URL_BASE`; otherwise pass the full http(s) URL.

## Short verbs

| Command | What it does |
|---|---|
| `trama show <id> [--json]` | Task, subtasks, decisions and record. `--json` (or `-o json`) prints `{ task, subtasks, decisions, record }`; `record` is null when never synced. |
| `trama ls --mine [--open]` | The signed-in person's open tasks. |
| `trama link <id> [--thread <url-or-id>]` | Link the thread. Exits non-zero when the task already links a different one and prints the `trama sub` hint. |
| `trama sub <id> <title> [--link] [--thread <url-or-id>]` | Create a subtask under `<id>` (same project and kind). `--link` links the thread to the new subtask. |
| `trama status <id> <status>` | Set the status. Accepts `in-progress` and `in_progress`, and the workspace's status labels. Use it only for in progress. |
| `trama sync <id> [--summary TEXT\|--summary-file F\|--summary -] [--decision "TEXT@path,path"]... [--file PATH]... [--files-from-git] [--pr URL] [--minutes N] [--turns N] [--thread URL]` | Update the record. The summary replaces the old one; files merge in; decisions append. `--pr` takes a URL or `owner/repo#123`. |
| `trama sync --all` | Sync every task linked to the current thread (`DELTA_THREAD_URL`). |
| `trama decisions [--path FILE] [--issue ID] [--limit N]` | Past decisions, newest first: `KEY  text  (paths)`. A path matches a decision on that file, a directory prefix or a glob. |
| `trama ask "<question>"` | Searches decisions and records and lists the matches with their task keys. It does not generate an answer. |
| `trama estimate <id>` | Suggested points, the reason and the similar finished tasks. It writes nothing; apply it with `trama task update <id> --estimate N` only when the person asks. |
| `trama time start <id>` | Same as `trama timer start <id>`. |
| `trama time log <id> <duration> [--at END] [--description TEXT]` | Log a finished entry ending now or at `--at`. Durations: `1h15`, `1h`, `45m`, `90` (minutes), `1:15`. |
| `trama time stop`, `trama time status` | Stop or show the running timer. |
| `trama time suggestions` | List suggested entries from `sync`; `trama time suggestions accept <entry-id>` accepts one (the owner only). |

Start or log time only when the user asks. Suggested entries count nothing until a person accepts them.

## Connect and discover

Everything else is a generated command, one per API operation:

```bash
trama whoami
trama doctor
trama commands
trama schema task create
trama task list --open --project-id prj_1 --priority urgent,high --fields key,title,status
trama task context BUG-142
trama task get BUG-142
trama task create --kind bug --title "Login timeout"
trama task update BUG-142 --priority high
trama task create --kind bug --title "Reproduce on Safari" --parent-id BUG-142 --estimate 2
trama task update BUG-142 --estimate 5
trama task update BUG-142 --unset estimate
trama task subtasks BUG-142
trama task list --parent BUG-142 --open
trama timer start BUG-142
trama timer status
trama timer stop
trama timer list BUG-142
trama timer add BUG-142 --started-at 2026-05-01T09:00:00Z --ended-at 2026-05-01T10:15:00Z
trama timer delete te_1
trama comment list --subject-type issue --subject-id in_1
trama artifact list
trama artifact create --issue-id in_1 --kind pull_request --title "Fix login" --url https://example.test/pr/1
trama attention list --scope mine
trama search --q "login timeout" --types issue,project
trama project list --q billing
trama project list --repository owner/name
trama view list
trama milestone list --project-id prj_1
trama snapshot get
trama workspace get
```

If not signed in, ask the user to authenticate. Never print, log, or commit credentials. Consult `trama commands`, per-command help, and `trama schema` for current names, flags, fields, and lifecycle actions. Do not guess commands from earlier API versions.

## Read before writing

At the Git repository root, read `.trama` before looking up tasks. It is TOML. If it matches the current checkout, use its `workspace` and `project_id` rather than searching every project. Scope CLI task lists with `--project-id` (and `--workspace` when needed), for example `trama task list --project-id prj_1 --q "login timeout"`. If `.trama` is missing or incomplete, ask the user for the workspace, project ID, and confirmation of the repository remote before creating it (`trama project list --repository owner/name` finds the project whose repository matches). After they reply, create `.trama` using this format:

```toml
schema_version = 1
workspace = "workspace-slug"
repository = "github.com/owner/repository"
project_id = "prj_project-id"
project_name = "Project name"
```

Use the `trama-project-context` skill when available. Never save credentials in `.trama`, and do not silently replace a stale mapping.

Find matching tasks within the saved project scope and read their context (`trama show`) before creating or updating anything. When the user names multiple tasks, read each one and update the ones affected.

## Write carefully

Record progress with `trama sync`, not with comments: the summary, files, decisions and PR belong to the record. Use comments (`trama comment create`) only for a question or note a person must see, such as an open decision or a blocker. Include clear task context, valid catalog values, and only justified optional fields in task create/update. Attach other artifacts (builds, test reports) to the relevant task with `trama artifact create`. Do not set `in_review` or `done`: the person moves the task after reviewing the PR you attached with `sync --pr`.

Preview writes with `--dry-run` when the command supports it. Confirm the result with a read. Do not delete tasks or silently overwrite another person's assignment.

## Subtasks, estimates and time

- A subtask is a task created with `trama sub <ID> "<title>"` or `--parent-id <key>`; subtasks nest to any depth and keep their own status. `trama task subtasks <key>` prints the whole tree (indented text in a terminal or with `-o table`, nested JSON when piped; `--depth 1` for direct children), and `trama task list --parent <key>` filters a normal list. The API has no parent filter, so both read the newest 500 tasks and warn when that limit is reached (narrow with `--project-id`).
- `--estimate <points>` sets the estimate (use the scale from `trama workspace get`). Link a thread with `trama link`, not `--thread-url`: it refuses to replace a different thread.
- `trama timer` is the signed-in person's own timer: `start [KEY]` (stops a running one), `status`, `stop`, `list [KEY]`, `add [KEY] --started-at … --ended-at …` (ISO-8601 with a zone) and `delete <entry id>`. Start it only when the user asks to track time. Custom tokens are refused.

## Errors and limits

Read structured error details. On authentication or permission failure, tell the user rather than seeking a workaround. On rate limiting, stop and tell the user; never retry in a loop. For validation errors, inspect the current schema and correct only the rejected input.

For exact task, artifact, comment and project operations, rely on the installed CLI command catalog and schemas. This skill intentionally does not prescribe API parameter names that may not exist in the deployed version.
