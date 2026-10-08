---
name: trama-start-work
description: How to pick up and begin work on a Trama workstream or issue. Use when the user says "work on AUTH-42", "continue this workstream", "take BUG-142", hands you a Trama key or link, or asks what is left on a workstream.
---

# Start work on a workstream

Goal: understand the outcome, confirm there is something to do, and leave a clear trail, without duplicating anything the team already recorded.

## 1. Load the briefing

```
whoami
get_workstream_context { idOrKey: "AUTH-42" }
```

The briefing contains the objective, acceptance criteria, decisions, dependencies, artifacts, open questions and recent progress. Read all of it. If the user gave an **issue** key, call `get_issue` and check its `workstreamIds`; then load the briefing of the workstream it belongs to.

If the user only describes the work, `search { q, types: "workstream,issue,decision" }` first. Do not create a second workstream for something that exists.

## 2. Check you should proceed

Stop and report instead of working when any of these is true:

- The workstream is `blocked` (a dependency has not shipped) or `shipped` / `canceled`.
- There is an **open input request** whose answer changes the approach. Mention it to the user.
- A **proposed decision** touches the area you are about to change. Wait for a person to accept it, or ask.
- Acceptance criteria are empty or vague. Propose concrete criteria (`add_criterion`) and confirm with the user before relying on them.

## 3. Respect what is already decided

Accepted decisions are binding unless the user says otherwise; follow them, and cite the key (`ADR-21`) in your commit or PR text. `superseded` and `rejected` decisions are history, not instructions.

## 4. Mark that you started

Set the first criterion you are tackling to `in_progress`:

```
update_criterion { idOrKey, criterionId, state: "in_progress" }
```

That is the signal Trama uses to show the workstream as `working`. Do not touch `statusOverride`.

## 5. Work where the code lives

Trama does not hold your code or conversation. The workstream links the shared workspace via `deltaThreadUrl` and the repositories via `repositoryIds`. Use those; do not paste transcripts into Trama.

## 6. Leave a short trail

Add one comment when you begin, saying what you will do and which criteria you target:

```
create_comment { subject: { type: "workstream", id }, body: "Starting on …; targeting criteria 1 and 2." }
```

Then continue with `trama-report-progress` as you make progress.

## Pitfalls

- Starting from the issue title alone. The workstream objective and criteria are the real brief.
- Treating a `draft` workstream as approved scope. Drafts are unfinished; ask.
- Changing `deltaThreadUrl`, owner team or accountable user. Those are the team's decisions.
