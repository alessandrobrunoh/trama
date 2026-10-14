---
name: trama-cli
description: Work with Trama issues and their context from the `trama` CLI when MCP is unavailable, when the user requests the shell interface, or when a CLI workflow is otherwise appropriate.
---

# Trama through the `trama` CLI

Use the CLI for the same Issue-first workflow described in `trama`: an Issue is the unit of work; a Goal is optional context; Plans are optional; and Human input on an Issue has Question and Decision modes with distinct lifecycles. Agents can work across multiple issues directly. Keep full transcripts in execution tools, not Trama.

## Connect and discover

```bash
trama whoami
trama doctor
trama commands
trama schema issue create
trama issue list --open --priority urgent,high --fields key,title,status
trama issue context BUG-142
trama issue get BUG-142
trama issue create --kind bug --title "Login timeout" --goal "Login eventually succeeds"
trama issue update BUG-142 --priority high
trama input-request list --issue-id BUG-142
trama input-request create --issue-id in_1 --question "Should this behavior remain?"
trama input-request answer ir_1 --answer "Keep the current behavior"
trama decision list --issue-id BUG-142
trama decision create --origin-issue-id in_1 --title "Keep login policy" --statement "Use the current policy" --status proposed
trama decision get ADR-21
trama artifact list
trama artifact create --issue-id in_1 --kind pull_request --title "Fix login" --url https://example.test/pr/1
trama attention list --scope mine
trama search --q "login timeout" --types issue,decision
trama project list --q billing
trama project context prj_1
trama project artifacts prj_1
trama repository list
trama team list
trama view list
trama milestone list --project-id prj_1
trama snapshot get
trama workspace get
trama project-update create prj_1 --health on_track --body "Latest status"
```

If not signed in, ask the user to authenticate. Never print, log, or commit credentials. Consult `trama commands`, per-command help, and `trama schema` for current names, flags, fields, and lifecycle actions. Do not guess commands from earlier API versions.

## Read before writing

Search for matching issues and read their context before creating or updating anything. When the user names multiple issues, read each one and update the ones affected. Resolve an optional Goal only when the repository mapping or user makes it clear; ask when there are multiple plausible choices.

Use the CLI's current search, issue context, and Goal context operations as exposed by `trama commands`. Do not assume that a command exists just because an older skill or client named it.

## Write carefully

Use the discovered issue create/update operations. Include clear issue context, valid catalog values, and only justified optional fields. Attach artifacts to the relevant issue(s), and record concise factual progress. The Issue's Human input feature is the supported location for person-dependent input: use Question mode for an answer and Decision mode for a durable conclusion. A Decision has one primary Issue and may reference related Issues.

Preview writes with `--dry-run` when the command supports it. Confirm the result with a read. Do not delete issues or silently overwrite another person's assignment or input.

## Errors and limits

Read structured error details. On authentication or permission failure, tell the user rather than seeking a workaround. On rate limiting, stop and tell the user; never retry in a loop. For validation errors, inspect the current schema and correct only the rejected input.

For exact issue, artifact, Goal, Plan, Question, and Decision operations, rely on the installed CLI command catalog and schemas. This skill intentionally does not prescribe API parameter names that may not exist in the deployed version.
