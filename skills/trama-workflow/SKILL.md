---
name: trama-workflow
description: Use the Issue-first Trama workflow when starting, continuing, or closing work on one or more issues. Search first, read each issue's context, optionally associate a Goal, and use an Issue's Human input feature when a person must answer a question or record a decision.
---

# The Trama work cycle

This skill dispatches work to `trama` for concepts and rules, `trama-triage-issues` for filing, `trama-start-work` for starting, `trama-report-progress` for factual updates, and `trama-ask-and-decide` for Human input. Use `trama-cli` when MCP is unavailable.

## 1. Identify the workspace and find the issue

Read `.trama` at the repository root first. If its repository matches the checkout, use the saved workspace and project ID to scope routine issue lookups; if the file is missing or incomplete, follow `trama-project-context` to ask the user for setup details. Call `whoami` as needed to verify access. If several workspaces are connected, use `list_accounts` to select one for writes. Prefer `find_work` with `scope: "issues"` and the saved project ID over global `search`; if its schema lacks that filter, discover `list_issues` with `list_capabilities` and call it through `run_tool`. Read the workspace stamp on every result. Reuse or update a matching issue rather than creating a duplicate.

## 2. Read the issue context

Read context for every issue the work will touch. If the user names several issues, work across them directly without adding another unit of execution or duplicating their status. An optional Goal may provide broader product context, but it does not replace issue context or become a unit of execution.

When the user describes work but names no issue, search first. If nothing matches, create an issue using `create_issue` or the `trama-triage-issues` workflow. Associate an optional Goal only when it is clear which existing Goal applies; ask rather than guessing if there are multiple plausible Goals.

## 3. Start and implement

Start work on the relevant issue or issues using `start_work` when available. Respect each issue's actual state and any open Human input. Stop only for work that depends on an unanswered question or an unaccepted decision; continue independent work across other issues.

A Plan is optional. For non-trivial implementation, create or update one near the issue it serves and follow any applicable approval process exposed by the current Trama tools. Do not make a Plan a gate for small, clear changes.

## 4. Record progress and conclude

Record verifiable progress on the relevant issue(s) with `report_progress`, `attach_artifact`, or supported Issue updates: concise updates and the actual issue status when it changes. Do not invent progress or duplicate status on another object. Keep full transcripts and execution details in the execution tools, not Trama.

If a person must choose or clarify, use the Issue's Human input feature (Question or Decision mode) as described in `trama-ask-and-decide`. Then continue work unaffected by the answer. Report remaining blockers and what was actually verified.
