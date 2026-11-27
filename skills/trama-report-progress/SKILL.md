---
name: trama-report-progress
description: Keep a Trama task's thread record in sync. Use after every turn that edits files, when you open a PR or make a decision, and when asked to update Trama.
---

# Report progress

The thread's record on the task (summary, files, decisions, PR, suggested time) is written with one call: `trama sync` / `sync_thread`. Comments are for questions to people, not for progress.

## Sync after each turn that edits files

CLI:

`trama sync <ID> --summary "<state and what remains>" --files-from-git --turns <N> --minutes <N>`, with `--decision "<text>@path,path"` once per decision and `--file <path>` for files git does not show. `--summary-file <F>` or `--summary -` read the text from a file or stdin.

MCP: `sync_thread {issue, summary, files, decisions, turns, pullRequestUrl, activeMinutes, threadUrl}`; every field is optional, send what changed. Pass `issue` as the task key (the argument name is historical).

Rules:

- The summary **replaces** the previous one: write the whole current state in a few sentences (what changed, what remains, what was verified), not a diff of the turn.
- Files are merged in; decisions are appended. Do not resend old decisions.
- A decision is a durable choice a later agent should respect, with paths: a file, a directory prefix (`src/auth/`) or a glob (`src/auth/*`). No routine edits.
- `--minutes` / `activeMinutes` is your active time since the last sync. It becomes a suggested time entry that a person accepts or dismisses; it is not logged time.
- Sync only what you did and observed. Do not claim a test, review or deployment you have not seen, and state what was not checked.
- Skip the sync on turns that edit no files. `trama sync --all` syncs every task linked to the current thread.
- Output such as `✓ summary · 2 decisions · 3 files · 47m suggested` is the confirmation; no extra read is needed.

## Attach the PR

When you open a PR: `trama sync <ID> --pr <url>` (or `owner/repo#123`), MCP `sync_thread {issue, pullRequestUrl}`. It creates or refreshes the `pull_request` artifact on the task; repeating the same URL updates it in place. Attach it only to the task it concerns. Use `attach_artifact` (or `report_progress {artifact}`) for other artifacts: build, test report, design, deployment, with their observed state (`state`, `ci` as pending, passing or failing, `review`, `hasConflicts`).

## Status belongs to people

You set `in_progress` when you start, and nothing else. Never set `in_review` or `done`: the person moves the task after reviewing the PR. If the task is blocked, say so in your reply and in a comment.

## Comments

Use `add_comment` (or `report_progress {comment}`) only for a question or a note a person must see: an open decision, a blocker, something you could not verify. Say it plainly. Do not repeat the sync summary as a comment. Full transcripts and execution logs belong in execution tools.

## Before saying "done"

- The record has the latest summary, files and decisions of every affected task.
- The PR is attached with `sync --pr`, and its state is what you observed.
- Open questions for a person are written down on the task.
- Verification claims are backed by evidence.
- You left the status alone, apart from `in_progress`.
