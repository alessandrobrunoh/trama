---
name: trama-workflow
description: Use the task-first Trama workflow when starting, continuing, or closing work on one or more tasks. Search first, read each task's context, then report factual progress and artifacts.
---

# The Trama work cycle

This skill dispatches work to `trama` for concepts and rules, `trama-triage-tasks` for filing, `trama-start-work` for starting, and `trama-report-progress` for factual updates. Use `trama-cli` when MCP is unavailable.

## 1. Identify the workspace and find the task

Read `.trama` at the repository root first. If its repository matches the checkout, use the saved workspace and project ID to scope routine task lookups; if the file is missing or incomplete, follow `trama-project-context` to ask the user for setup details. Call `whoami` as needed to verify access. If several workspaces are connected, use `list_accounts` to select one for writes. Prefer `find_work` with the saved `projectId` over global `search`. Read the workspace stamp on every result. Reuse or update a matching task rather than creating a duplicate.

## 2. Read the task context

Read context for every task the work will touch with `get_context`. If the user names several tasks, work across them directly without adding another unit of execution or duplicating their status. A task's sub-tasks are part of its context (`get_context` with `subtasks: true` returns the tree; `find_work` with `parentId` lists the direct ones); sub-tasks keep independent statuses.

When the user describes work but names no task, search first. If nothing matches, create a task with `create_task` or follow the `trama-triage-tasks` workflow.

## 3. Start and implement

Start work on the relevant task with `start_work`. It loads the context and sets the task `in_progress`; pass a short `plan` to leave what you intend to do as a comment. Respect each task's actual state and do not overwrite a person's assignment or status without reason. Keep going on independent tasks when one is blocked.

## 4. Record progress and conclude

Record verifiable progress on the relevant task(s) with `report_progress`, `attach_artifact` or `update_task`: concise comments and the actual task status when it changes (`in_review` while a PR is open, `done` only once it is merged). Do not invent progress or duplicate status on another object. Keep full transcripts and execution details in the execution tools, not Trama.

If a person's judgment is needed, say so in a comment on the task and in your reply to the user; Attention surfaces reviews and failing CI on its own. Then continue work unaffected by it. Report remaining blockers and what was actually verified.
