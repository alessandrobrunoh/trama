---
name: trama-start-work
description: How to pick up and begin work on a Trama issue. Use when the user asks you to work on or continue one or more issues, or asks what remains on an issue.
---

# Start work on an issue

Understand the issue, read its context, and confirm any decision needed before implementation. Issues are the units of work; work directly across as many issues as needed.

## 1. Load context

Call `whoami`, then use `get_context` to read the issue context before acting. If the user provides multiple issues, read each one. Check for an optional Goal, Plans, related Issues, artifacts, and Human input attached to the Issue. The issue title alone is not a sufficient briefing.

If the user only describes the work, use `find_work` or `search` for matching issues and reuse them. If no issue matches, use `create_issue` through `trama-triage-issues`. When several workspaces are connected, identify the workspace for each write.

## 2. Check whether to proceed

Use `start_work` and `update_issue` when available. Do not guess parameters: inspect the MCP capability or CLI schema. Respect the issue's state and do not overwrite a person's assignment or status without reason.

Before coding, check the Issue's Human input feature:

- An open **Question** is waiting for an answer. Wait only if that answer changes the work; keep doing independent work.
- A **Decision** that is proposed needs a human disposition. Do not treat it as accepted or accept it yourself.
- Read resolved input and decisions for applicable context. Do not silently delete or rewrite them.

## 3. Optional Plan near implementation

A Plan is optional and belongs near the Issue(s) it guides. For non-trivial work—multiple areas, a design/data-model choice, or a migration—write or update a concise Plan before implementation when useful. Follow any approval lifecycle the current tools expose; do not invent an approval gate where none exists. Small, obvious fixes need no Plan.

If a Plan covers several issues, make its scope explicit and associate it with the relevant issue context rather than creating a separate work container.

## 4. Work and preserve context boundaries

Implement in the repository and keep full transcripts in execution tools, not Trama. Record concise, useful facts on the Issue: what changed, relevant artifact links, what remains, and what was verified. Do not duplicate issue progress or status on a Goal.

## Pitfalls

- Starting from a title without reading issue context.
- Treating an optional Goal as a replacement for Issue context or the unit of work.
- Blocking all work because one issue has unanswered input when other issues are independent.
- Assuming Plan or input APIs, fields, or state transitions without inspecting current tool capabilities/schema.
- Copying full conversation transcripts into Trama.
