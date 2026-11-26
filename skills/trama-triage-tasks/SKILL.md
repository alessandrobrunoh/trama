---
name: trama-triage-tasks
description: File, deduplicate, and classify Trama tasks. Use when a user reports a bug, request, or idea to log, asks you to triage tasks, or asks where existing tasks are.
---

# File and triage tasks

A Task is the unit of work. One task should describe one problem or request. Agents may work across multiple tasks directly.

## Search before creating

Read `.trama` at the repository root first. If it matches the checkout, search within its saved project scope instead of searching every project. If it is missing or incomplete, follow `trama-project-context` to ask the user and create it after they reply. Use `find_work` with the saved `projectId`; use global `search` only when the user asks for a cross-project search. If a matching task exists, use `update_task` or add a concise comment rather than creating a duplicate. For a true duplicate, mark it with `duplicateOfId` on `update_task` (or `duplicateOf` in `triage_tasks`) instead of deleting the task.

## Create a task

Read workspace settings with `get_workspace` first: it lists the label ids and the estimate scale. Then call `create_task`; it refuses to create a task when an open one has the same title, unless you pass `force`.

Include a clear `title` and a concise `body`, and a `kind` (`bug`, `feature`, `incident`, `tech_debt`, `feedback`, `idea` or `security`). For bugs, capture steps to reproduce, expected versus actual behavior, and relevant environment. Use only valid priorities, statuses and label ids (ids, never names). Pass `projectId` from the saved scope, and `parentId` (key or id) to create a sub-task under any task; sub-tasks nest to any depth. Add an `estimate` only when the size is clear and fits the workspace scale from `get_workspace`. A new task may carry the `threadUrl` of the thread that is about to work on it; to link an existing task use `link_thread` (`trama link`), which refuses a task that already has a different thread. For work that belongs under a task another thread already owns, create a subtask (`parentId`, or `trama sub <ID> "<title>" --link`). Set optional fields only when justified.

Do not put secrets, tokens, customer data, or full execution transcripts in a task. Keep transcripts in execution tools.

## Triage

1. Find relevant tasks within the saved project scope using `find_work`.
2. Review duplicates, stale reports, missing information, priority, and classification.
3. Present a concise proposed set of changes before making broad or ambiguous edits.
4. Apply agreed changes with `triage_tasks` (up to 25 tasks per call: priority, kind, status, labels, assignee, project, estimate, title, duplicate marker and a comment; items fail independently), `create_task` or `update_task` as appropriate, and verify their results.

Do not delete tasks. Do not change another person's assignment, estimate, or priority without authorization. Triage may fix classification (priority, kind, labels, duplicates), but never moves a task to `in_review` or `done`; people own those statuses. To suggest points, run `trama estimate <ID>` (MCP `suggest_estimate`) and let the person decide. Leave unsupported or uncertain optional fields unset.
