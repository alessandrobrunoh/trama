---
name: trama-cli
description: Work with Trama tasks and their context from the `trama` CLI when MCP is unavailable, when the user requests the shell interface, or when a CLI workflow is otherwise appropriate.
---

# Trama through the `trama` CLI

Use the CLI for the same task-first workflow described in `trama`: a Task is the unit of work, with sub-tasks, comments and artifacts, and it can belong to a Project. Agents can work across multiple tasks directly. Keep full transcripts in execution tools, not Trama.

## Connect and discover

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
trama task create --kind bug --title "Reproduce on Safari" --parent-id BUG-142 --estimate 2 --thread-url https://delta.example/thread/abc
trama task update BUG-142 --estimate 5 --thread-url https://delta.example/thread/abc
trama task update BUG-142 --unset estimate,threadUrl
trama task subtasks BUG-142
trama task list --parent BUG-142 --open
trama timer start BUG-142
trama timer status
trama timer stop
trama timer list BUG-142
trama timer add BUG-142 --started-at 2026-05-01T09:00:00Z --ended-at 2026-05-01T10:15:00Z
trama timer delete te_1
trama lunagest projects
trama lunagest import lg_1
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

Find matching tasks within the saved project scope and read their context before creating or updating anything. When the user names multiple tasks, read each one and update the ones affected.

Use the CLI's current search and task context operations as exposed by `trama commands`. Do not assume that a command exists just because an older skill or client named it.

## Write carefully

Use the discovered task create/update operations. Include clear task context, valid catalog values, and only justified optional fields. Attach artifacts to the relevant task(s), and record concise factual progress as comments. If a person's input is needed, say so in a comment on the task. Set `in_review` while a PR is open and `done` only once the change is merged and verified.

Preview writes with `--dry-run` when the command supports it. Confirm the result with a read. Do not delete tasks or silently overwrite another person's assignment.

## Subtasks, estimates, thread link and time

- A subtask is a task created with `--parent-id <key>`; subtasks nest to any depth and keep their own status. `trama task subtasks <key>` prints the whole tree (indented text in a terminal or with `-o table`, nested JSON when piped; `--depth 1` for direct children), and `trama task list --parent <key>` filters a normal list. The API has no parent filter, so both read the newest 500 tasks and warn when that limit is reached (narrow with `--project-id`).
- `--estimate <points>` sets the estimate (use the scale from `trama workspace get`); `--thread-url <http(s) url>` links the thread working on the task. Both come back on `trama task get`; clear them with `--unset estimate,threadUrl`.
- `trama timer` is the signed-in person's own timer: `start [KEY]` (stops a running one), `status`, `stop`, `list [KEY]`, `add [KEY] --started-at … --ended-at …` (ISO-8601 with a zone) and `delete <entry id>`. Start it only when the user asks to track time. Custom tokens are refused.
- `trama lunagest projects` lists the importable LunaGest projects and `trama lunagest import <id>…` imports the chosen ones with their tasks (1 to 25, idempotent). Do it only when the user asks; it needs project-management rights and permission to create tasks.

## Errors and limits

Read structured error details. On authentication or permission failure, tell the user rather than seeking a workaround. On rate limiting, stop and tell the user; never retry in a loop. For validation errors, inspect the current schema and correct only the rejected input.

For exact task, artifact, comment and project operations, rely on the installed CLI command catalog and schemas. This skill intentionally does not prescribe API parameter names that may not exist in the deployed version.
