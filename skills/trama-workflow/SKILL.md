---
name: trama-workflow
description: Use the task-first Trama workflow when starting, continuing, or finishing work on one or more tasks. Read the task, link the thread, set in progress, sync the record after each turn, attach the PR.
---

# The Trama work cycle

This skill dispatches work to `trama` for concepts and the 7-step flow, `trama-triage-tasks` for filing, `trama-start-work` for starting, and `trama-report-progress` for the record. Use `trama-cli` when MCP is unavailable.

## 1. Identify the workspace and find the task

Read `.trama` at the repository root first. If its repository matches the checkout, use the saved workspace and project ID to scope routine lookups; if the file is missing or incomplete, follow `trama-project-context`. Call `whoami` as needed. If several workspaces are connected, use `list_accounts` to select one for writes. Prefer `find_work` with the saved `projectId` over global `search`. Reuse a matching task rather than creating a duplicate.

## 2. Read the task

Read every task the work touches: `trama show <ID> --json` or `get_context` with `subtasks: true`, plus its decisions (`find_decisions {issue}`). If the user names several tasks, work across them directly; subtasks keep independent statuses.

When the user describes work but names no task, search first. If nothing matches, create one through `trama-triage-tasks`.

## 3. Link and start

Link the current thread (`trama link <ID> --thread <current>`, MCP `link_thread`). One task has one thread: if it is linked to another, ask the user, then create a subtask with `trama sub <ID> "<title>" --link`. Then `trama status <ID> in-progress` (MCP `start_work`). Respect each task's state; keep going on independent tasks when one is blocked.

## 4. Work and sync

Before touching a file, `trama decisions --path <file>`. After each turn that edits files, `trama sync <ID> --summary "…" --files-from-git` (MCP `sync_thread`). When you open a PR, `trama sync <ID> --pr <url>`. Active time goes along as a suggestion (`--minutes`) for the person to accept.

## 5. Hand over

Do not set `in_review` or `done`: the person reviews the PR and moves the task. If a person's judgment is needed, say so in your reply and in a comment on the task; Attention surfaces reviews and failing CI on its own. Report remaining blockers and what was actually verified. Keep full transcripts in execution tools, not Trama.
