---
name: trama-start-work
description: How to pick up and begin work on a Trama task. Use when the user asks you to work on or continue one or more tasks, or asks what remains on a task.
---

# Start work on a task

Understand the task, read its context and decisions, link your thread, then implement. The flow is the one in `trama`: show, link, status, sync.

## 1. Load context

Call `whoami`, then read the task: CLI `trama show <ID> --json`, MCP `get_context {id, subtasks: true, comments: true}` plus `find_decisions {issue}`. If the user names several tasks, read each one. Check its comments, subtasks, artifacts, estimate, `threadUrl`, past decisions and project. The title alone is not a briefing. Past decisions with paths are rules for the files they name.

If the user only describes the work, use `find_work` or `search` for matching tasks and reuse them. If none matches, file one through `trama-triage-tasks`. When several workspaces are connected, identify the workspace for each write.

## 2. Link your thread

CLI `trama link <ID> --thread <current>`; MCP `link_thread {issue, threadUrl}`. The current thread is `DELTA_THREAD_URL`; if unset, ask the user for the link once.

A task links one thread. If it is linked to another one (409 `thread_already_linked`), do not relink. Ask the user whether to create a subtask for your work; once they agree, `trama sub <ID> "<title>" --link` or `create_task {parentId, title, threadUrl}`, and work on the subtask from then on.

## 3. Mark the start

CLI `trama status <ID> in-progress`; MCP `start_work {key}` (it loads the context and sets the task `in_progress`; completed and canceled tasks are left unchanged). Pass `plan` only to leave a one or two sentence comment for people. Respect the task's state: do not overwrite a person's assignment or status, and read recent comments for instructions or open questions before coding. In progress is the only status you set.

If the work depends on an answer only a person can give, ask the user in your reply and leave a comment on the task stating the open question. Continue with independent work meanwhile.

## 4. Work and keep the record

Before touching a file, run `trama decisions --path <file>` (MCP `find_decisions {path}`). After each turn that edits files, run `trama sync <ID> --summary "…" --files-from-git` (MCP `sync_thread`); see `trama-report-progress`. Keep full transcripts in execution tools, not Trama.

For non-trivial work (several areas, a design or data-model choice, a migration), split it into subtasks with `create_task` and `parentId`, or `trama sub`. Subtasks keep independent statuses and can nest. To size the work, `trama estimate <ID>` (MCP `suggest_estimate`) suggests points from similar finished tasks; relay it, the person decides. Start a timer (`track_time`, `trama time start <ID>`) only when the user asks.

## Pitfalls

- Starting from a title without reading context and decisions.
- Relinking a task that already has a thread, or linking one thread to several tasks without asking.
- Setting `in_review` or `done`. Open a PR and attach it with `sync --pr`; the person moves the task.
- Blocking all work because one task has an open question when other tasks are independent.
- Assuming fields or tools without inspecting current capabilities or schemas.
- Copying full conversation transcripts into Trama.
