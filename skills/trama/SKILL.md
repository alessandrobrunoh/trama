---
name: trama
description: Core concepts and ground rules for working in Trama through its MCP tools (issues, workstreams, decisions, artifacts, input requests). Read this first whenever you are about to read or change anything in a Trama workspace, when the user mentions Trama, a workstream key like AUTH-42, an issue key like BUG-142, or a decision like ADR-21, or when they ask for the issues of this project, this repository, or the current checkout.
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

## A Delta thread is not a workstream

A Delta thread is where the work runs. A workstream is the outcome. They are different objects, and the thread never decides what belongs together.

- Group by outcome. Link an issue to an existing workstream only when it serves that workstream's outcome.
- One thread may touch several workstreams (login in one, an unrelated dashboard bug in another). Do not stretch one workstream to cover everything done in a thread. A typo or one-line fix is an issue, not a workstream.
- A thread may have a primary workstream (the one its `deltaThreadUrl` points at). That is a pointer to the execution context, not a boundary. Each workstream you create or use for another outcome carries its own `deltaThreadUrl`, which can be the same thread URL.
- Search first (`search`, `list_workstreams`) so you reuse a matching workstream instead of creating a duplicate.
- A subagent works an issue; it is not a workstream, and it is not a new issue when the issue already exists.

If the user explicitly says these issues are one effort, that is the outcome: link them together. Do not infer it from "same thread".

People may say "workspace" for the thread. Do not create extra Trama workspaces.

A **project** sits above them: the planned outcome (with milestones, a lead, a health and a feed of status updates) that workstreams carry out. Projects are planning, workstreams are execution; a project reaches its workstreams, their issues and all their artifacts. **Documents** are Markdown pages that live in Trama (specs, plans and notes that do not belong in a repository); a document is attached to projects, workstreams and issues as a `document` artifact, so it stays one page. Search with `list_documents` before writing a new one, read with `get_document`, and edit with `update_document`, which needs the `baseVersion` you read (a stale one answers 409 with the current text: merge, then retry). Do not copy into a document what already lives in a repository or an issue.

To understand a whole project in one read, call `get_project_context` (markdown "mega context"); to report on it, post a project update (see `trama-report-progress`).

Issue status (`draft, backlog, todo, in_progress, in_review, done, canceled`) and workstream status are independent. Do not move one to match the other.

## Issues of this checkout

"This project", said from a git checkout, is a Trama project reached through the registered repository. It is not a guess, and it is not the forge's own issue list. Resolve it in order and stop when a step is missing.

1. Read the remote (`git remote get-url origin`, and `upstream` when it exists). Keep the host and `owner/name`, without `.git` or credentials.
2. Follow a rename before matching. `gh repo view --json nameWithOwner,url` does. Without `gh`, request the remote URL and use the final host and path. `github.com/alessandrobrunoh/nabla` redirects to `github.com/alessandrobrunoh/trama`; those are one repository.
3. `list_repositories` and match `fullName` (case-insensitive) or the same host and path on `url`.
4. No match: the checkout is not registered. Say so. Do not list GitHub or GitLab issues instead, and do not create the repository unless the user asked.
5. `list_projects { repositoryId }`. One project is "this project". Several: name them and ask which, unless the user already named one. None: the repository is registered but on no project. Say so. `list_workstreams { repositoryId }` can still show work that lists this repository; that is not the project.
6. Read the issues with `list_issues { projectId, open: true }` or, for the whole picture, `get_project_context { id }`. An issue has no repository of its own. It belongs here through `projectId`, or through a workstream of that project.

`get_workspace` returns `settings.estimateScale` and `settings.labels` (`id`, `name`). Assign those ids. Do not invent label names. Filing those fields is `trama-triage-issues`.

## Ground rules

1. **Start with `whoami`.** It tells you which workspace and role you act as and which tools your token allows. If several keys are connected it returns one entry per workspace; `list_accounts` lists them. Tools your key cannot use are hidden; do not look for workarounds.
2. **Read before you write.** To work on a workstream call `get_workstream_context` (a markdown briefing); for a project call `get_project_context`. Use targeted `list_*` / `get_*` / `search` tools. Avoid `get_snapshot`: it is huge and only works for user tokens.
3. **Never set a workstream's status yourself.** Status is *derived* from facts (see `trama-report-progress`). `statusOverride` exists for people pinning a board column; leave it alone unless the user explicitly asks.
4. **Facts, not guesses.** Do not invent progress, percentages or completion. Report what exists: criteria met, PR state, CI result.
5. **You cannot accept decisions.** Propose them (`draft` or `proposed`). A person accepts, rejects or supersedes.
6. **Ask, don't stall.** If a human must choose or unblock something, open an input request instead of guessing or stopping silently.
7. **Respect limits.** Tokens have per-minute and per-day caps (default 600 requests/min, 60 writes/min, 2000 writes/day). On HTTP 429 **stop and tell the user**; never retry in a loop.
8. **Be economical with writes.** Batch your thinking, then write once. Do not create duplicates: `search` first.
9. **Ids and keys.** Tools accept either (`idOrKey`). Old issue keys keep resolving after a re-key. Dates are ISO strings. A key like `BUG-142` is unique only inside one workspace, so with several workspaces connected always keep the `workspace` stamp that came back with the row.
10. **One key, one workspace.** A token never spans workspaces. With a single key, omit `workspace`. With several keys, every tool takes an optional `workspace` (a slug, or several separated by commas):
    - **Reads** (`list_*`, `get_*`, `search`, `get_*_context`): omit `workspace` to cover every connected workspace. Each result is stamped with the workspace it came from. A workspace that fails is reported, not fatal, as long as another answered.
    - **Writes** (`create_*`, `update_*`, `delete_*`, link, answer, accept): pass exactly one `workspace`. Omitting it is refused, so a write can never land in every workspace at once.
    - One key is unchanged: no `workspace` argument and no `list_accounts` tool.

## Which skill next

- Starting, continuing, or closing work → `trama-workflow` (it decides whether a workstream exists, then hands off)
- Picking up work on a workstream → `trama-start-work`
- Reporting progress, PRs, CI → `trama-report-progress`
- Blocked, or a choice needs recording → `trama-ask-and-decide`
- Filing and grouping issues → `trama-triage-issues`

## Tool map

`whoami` · `get_workspace` · `list_accounts` (only when several keys are connected) · `search` · `list_repositories` `get_repository` · `list_issues` `get_issue` `create_issue` `update_issue` `link_issue` · `list_workstreams` `get_workstream` `get_workstream_context` `create_workstream` `update_workstream` `add_criterion` `update_criterion` · `list_projects` `get_project` `get_project_context` `update_project` `list_project_updates` `create_project_update` `update_project_update` `delete_project_update` · `list_artifacts` `list_project_artifacts` `list_issue_artifacts` `create_artifact` `update_artifact` · `list_documents` `get_document` `create_document` `update_document` `attach_document` · `create_decision` `update_decision` · `create_input_request` `answer_input_request` · `create_comment` `list_comments` · `list_milestones` `create_milestone` · `create_dependency` · `list_events` `get_graph`.

`api_request` is an escape hatch for workspace routes with no dedicated tool. Prefer the dedicated tools; it only takes plain workspace-relative paths.
