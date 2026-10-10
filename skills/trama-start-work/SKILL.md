---
name: trama-start-work
description: How to pick up and begin work on a Trama workstream or issue. Use when the user says "work on AUTH-42", "continue this workstream", "take BUG-142", hands you a Trama key or link, or asks what is left on a workstream.
---

# Start work on a workstream

Goal: understand the outcome, confirm there is something to do, and leave a clear trail, without duplicating anything the team already recorded.

## 1. Load the briefing

```
whoami
get_context { id: "AUTH-42" }
```

`get_context` returns the briefing: the outcome status and what is still missing (`completion.gaps`), the objective, acceptance criteria (with who declared each `met` and its proof), the plan and its approval, decisions, dependencies, artifacts, open questions and recent progress. Read all of it. Use it alone when the user only asks what is left or what the state is.

If `whoami` returned more than one workspace, call `list_accounts` and pass `workspace` (the slug) on every call below; a key like `AUTH-42` is only unique inside one workspace. If the user gave an **issue** key, `get_context` returns the issue with the workstreams it belongs to; `start_work` below loads the briefing of the workstream for you.

If the user hands you a **project** (or you need the big picture across several workstreams), call `get_context { id: "pj_…" }`: one markdown "mega context" with the project's updates, milestones, workstreams, issues, artifacts, decisions and open questions, each traceable to where it is attached. Then pick a workstream.

If the user only describes the work, `search { q, types: "workstream,issue,decision" }` first (or `find_work { q }`). Do not create a second workstream for something that exists.

## 2. Check you should proceed, and mark the start

When you decide to begin, one call does the checks and the writes:

```
start_work { key: "AUTH-42", plan: "Rotating refresh tokens; targeting criteria 1 and 2.", criteria: ["1", "2"] }
```

`key` is a workstream or an issue. `start_work` stops **without writing** (`ready: false`, with `stopBecause`) when the workstream is `blocked` (completion gap `blocked`), `shipped` or `canceled`, or the issue is `done`/`canceled`. A `statusOverride` is a pin by a person, not a fact: read `completion.gaps` for what is really missing. Report a stop to the user instead of working.

When it proceeds it returns `cautions` and the workstream's `completion`. Read them; stop and tell the user when:

- There is an **open input request** whose answer changes the approach.
- A **proposed decision** touches the area you are about to change. Wait for a person to accept it, or ask.
- The gap `no_criteria` is present, or the criteria are vague. A workstream with no criteria cannot ship. Propose concrete, observable ones with `addCriteria` (`start_work { key, addCriteria: ["OAuth login passes on Safari 18"] }`) and confirm them with the user before relying on them.

## 3. Respect what is already decided

Accepted decisions are binding unless the user says otherwise; follow them, and cite the key (`ADR-21`) in your commit or PR text. `superseded` and `rejected` decisions are history, not instructions.

## 4. Plan before non-trivial work

The plan is a convention, not a gate. It is a `document` artifact on the workstream whose title starts with "Plan": a Trama document (preferred) or a link to a file in the repository (put the commit sha in `externalId`). Its approval is an ordinary decision, titled `Plan for AUTH-42 approved at v3` (the Trama document `version`) or `... approved at 3f2a9c1` (the sha), proposed by you and accepted by a person. The briefing's **Plan** section (`plans` in the JSON) lists each plan, its revision, the approving decision and whether the plan changed since.

- **Approved plan:** follow it and cite the decision key in your PR. Do not re-ask.
- **"plan changed since approval":** the plan moved on after a person approved it. Propose a new decision for the current revision and wait.
- **Scope changes** (you need something the plan does not cover): update the plan, then propose a new decision for the new revision. Never edit an accepted decision.
- **No plan, or not approved, and the work is non-trivial** (several areas, a design or data-model choice, a migration, or the user asks for a plan): do not code yet. Draft the plan, propose the approval and stop with a question:

```
run_tool { name: "create_document", arguments: { title: "Plan: rotate refresh tokens", body: "## Approach\n…\n## Steps\n…", workstreamId: "AUTH-42" } }
record_decision { title: "Plan for AUTH-42 approved at v1", statement: "Implement 'Plan: rotate refresh tokens' as written at v1.", workstream: "AUTH-42", tags: ["plan"] }
ask_human { workstream: "AUTH-42", question: "Plan for AUTH-42 is ready at v1 (ADR-23). Approve it, or what should change?", options: ["Approve", "Change the plan"] }
```

`create_document` attaches the document to the workstream in the same call; read its `version` from the reply or `run_tool { name: "get_document", arguments: { id } }`. After you edit the document the version grows, so name the new one in the new decision. With several plans on one workstream, put the plan's title in the decision statement. A proposed decision already makes the workstream `needs_input`; the question tells the person where to look.
- **Trivial work** (one small change, a typo, a bug with an obvious fix): no plan needed. Do not add ceremony.

## 5. What the start records

`start_work` sets the criteria you target (default: the first one not met) to `in_progress`. That is the signal Trama uses to show the workstream as `working`. Do not touch `statusOverride`.

When the work is an issue, it also sets that issue to `in_progress` if it is not already. If the issue has no assignee and `whoami.actor.type` is `user`, the server sets `assigneeId` to that user on the status change (an `agent` actor is not assigned; an existing assignee is never replaced). Filing an issue you are not starting leaves the assignee empty.

The `plan` you pass becomes one comment on the workstream (the issue when it has no workstream): what you will do and which criteria you target. Skip it when you have nothing to add.

## 6. Work where the code lives

Trama does not hold your code or conversation. The workstream links the shared workspace via `deltaThreadUrl` (empty when the workspace does not use Delta threads) and the repositories via `repositoryIds`. Use those; do not paste transcripts into Trama.

The thread is the execution context, not the boundary of the work. If a workstream already exists for this outcome, continue it, whether or not its `deltaThreadUrl` is this thread. If this thread later takes on an unrelated outcome, use or create another workstream for it (search first); do not widen the current one. Subagents you spawn stay inside Delta; point them at the issues they serve.

Then continue with `trama-report-progress` as you make progress.

## Pitfalls

- Starting from the issue title alone. The workstream objective and criteria are the real brief.
- Treating a `draft` workstream as approved scope. Drafts are unfinished; ask.
- Changing `deltaThreadUrl`, owner team or accountable user. Those are the team's decisions.
- Creating one workstream per subagent, or per trivial issue. Group issues that serve the same outcome.
- Adding an unrelated issue to the current workstream because it came up in the same thread. A workstream is an outcome, not a Delta thread.
- Coding on a non-trivial change while the plan is missing, unapproved, or changed since approval.
- Starting anyway after `ready: false`. The call refused for a reason; say so to the user.
