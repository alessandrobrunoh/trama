---
name: trama
description: Core concepts and ground rules for working in Trama through its MCP tools (issues, workstreams, decisions, artifacts, input requests). Read this first whenever you are about to read or change anything in a Trama workspace, or when the user mentions Trama, a workstream key like AUTH-42, an issue key like BUG-142, or a decision like ADR-21.
---

# Trama: how it works

Trama coordinates teams of humans and coding agents. It keeps the issue tracker you already know and adds what a ticket cannot carry alone. You act in it through the `trama` MCP tools.

## The five things

| Thing | Answers | Key examples | You usually |
|---|---|---|---|
| **Issue** | What problem or request exists? | `BUG-142`, `FEAT-12`, `INC-3`, `DEBT-7`, `FB-20`, `IDEA-4`, `SEC-2` | create and update |
| **Workstream** | What outcome are we pursuing? | `AUTH-42` (team key + number) | read, update, report on |
| **Decision** | Why did we do it this way? | `ADR-21` | propose; never accept |
| **Artifact** | What did the work produce? | a PR, build, deployment, doc | attach and keep current |
| **Input request** | What do you need a human to answer? | `create_input_request` | ask when blocked |

Issues are *demand*. A workstream groups the issues that share a root cause and is the unit you execute. Grouping is by **outcome, not convenience**: five bugs with one cause belong together; ten unrelated bugs do not.

A **project** sits above them: the planned outcome (with milestones, a lead, a health and a feed of status updates) that workstreams carry out. Projects are planning, workstreams are execution; a project reaches its workstreams, their issues and all their artifacts. To understand a whole project in one read, call `get_project_context` (markdown "mega context"); to report on it, post a project update (see `trama-report-progress`).

Issue status (`draft, backlog, todo, in_progress, in_review, done, canceled`) and workstream status are independent. Do not move one to match the other.

## Ground rules

1. **Start with `whoami`.** It tells you which workspace and role you act as and which tools your token allows. Tools your key cannot use are hidden; do not look for workarounds.
2. **Read before you write.** To work on a workstream call `get_workstream_context` (a markdown briefing); for a project call `get_project_context`. Use targeted `list_*` / `get_*` / `search` tools. Avoid `get_snapshot`: it is huge and only works for user tokens.
3. **Never set a workstream's status yourself.** Status is *derived* from facts (see `trama-report-progress`). `statusOverride` exists for people pinning a board column; leave it alone unless the user explicitly asks.
4. **Facts, not guesses.** Do not invent progress, percentages or completion. Report what exists: criteria met, PR state, CI result.
5. **You cannot accept decisions.** Propose them (`draft` or `proposed`). A person accepts, rejects or supersedes.
6. **Ask, don't stall.** If a human must choose or unblock something, open an input request instead of guessing or stopping silently.
7. **Respect limits.** Tokens have per-minute and per-day caps (default 600 requests/min, 60 writes/min, 2000 writes/day). On HTTP 429 **stop and tell the user**; never retry in a loop.
8. **Be economical with writes.** Batch your thinking, then write once. Do not create duplicates: `search` first.
9. **Ids and keys.** Tools accept either (`idOrKey`). Old issue keys keep resolving after a re-key. Dates are ISO strings.

## Which skill next

- Picking up work on a workstream → `trama-start-work`
- Reporting progress, PRs, CI → `trama-report-progress`
- Blocked, or a choice needs recording → `trama-ask-and-decide`
- Filing and grouping issues → `trama-triage-issues`

## Tool map

`workspace/whoami` · `search` · `list_issues` `get_issue` `create_issue` `update_issue` `link_issue` · `list_workstreams` `get_workstream` `get_workstream_context` `create_workstream` `update_workstream` `add_criterion` `update_criterion` · `list_projects` `get_project` `get_project_context` `update_project` `list_project_updates` `create_project_update` `update_project_update` `delete_project_update` · `list_artifacts` `list_project_artifacts` `list_issue_artifacts` `create_artifact` `update_artifact` · `create_decision` `update_decision` · `create_input_request` `answer_input_request` · `create_comment` `list_comments` · `list_milestones` `create_milestone` · `create_dependency` · `list_events` `get_graph`.

`api_request` is an escape hatch for workspace routes with no dedicated tool. Prefer the dedicated tools; it only takes plain workspace-relative paths.
