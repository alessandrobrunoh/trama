---
name: trama-start-work
description: How to pick up and begin work on a Trama task. Use when the user asks you to work on or continue one or more tasks, or asks what remains on a task.
---

# Start work on a task

Understand the task, read its context, and check its state before implementation. Tasks are the units of work; work directly across as many tasks as needed.

## 1. Load context

Call `whoami`, then use `get_context` to read the task context before acting. Pass `comments: true` to include the thread. If the user provides multiple tasks, read each one. Check its goal, sub-tasks, comments, related artifacts and the project it belongs to. The task title alone is not a sufficient briefing.

If the user only describes the work, use `find_work` or `search` for matching tasks and reuse them. If no task matches, use `create_task` through `trama-triage-tasks`. When several workspaces are connected, identify the workspace for each write.

## 2. Check whether to proceed

Use `start_work` with the task key. It loads the context and sets the task `in_progress`; completed and canceled tasks are left unchanged. Pass `plan` with one or two sentences about what you will do and it is stored as a comment. Respect the task's state: do not overwrite a person's assignment or status without reason, and read recent comments for instructions or open questions before coding.

If the work depends on an answer only a person can give, ask the user in your reply and leave a comment on the task stating the open question. Continue with independent work meanwhile.

## 3. Work and preserve context boundaries

Implement in the repository and keep full transcripts in execution tools, not Trama. Record concise, useful facts on the task: what changed, relevant artifact links, what remains, and what was verified.

For non-trivial work (several areas, a design or data-model choice, a migration), split it into sub-tasks with `create_task` and `parentId` when that helps. Sub-tasks keep independent statuses.

## Pitfalls

- Starting from a title without reading task context.
- Blocking all work because one task has an open question when other tasks are independent.
- Setting `done` before the change is merged and verified.
- Assuming fields or state transitions without inspecting current tool capabilities or schemas.
- Copying full conversation transcripts into Trama.
