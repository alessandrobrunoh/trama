---
name: trama-workflow
description: Run the Trama work cycle when you are about to start, continue, or close work, not when you are only looking something up. Use when the user hands you one or more issues, asks you to take, start, triage, or ship work in Trama, or names a workstream to work on. Search first. If a matching workstream already exists, attach the issues to it. If not, create one and document the outcome there before writing code. Then hand off to the other Trama skills. Do not use for a single read (get_issue, search, whoami).
---

# The Trama work cycle

You are the dispatcher, not the specialist. Decide where the work belongs, then hand off. Do not re-explain what the other skills already specify: `trama` for the rules, `trama-triage-issues` for filing, `trama-start-work` for picking up a workstream, `trama-report-progress` for recording facts, `trama-ask-and-decide` for a question or a decision. On the CLI the same tools are `trama` commands (`trama-cli`).

## 1. Know which workspace

```
whoami
```

If it returns more than one workspace, call `list_accounts` and pick one slug. A key like `BUG-142` is unique only inside its workspace, and a write with no `workspace` is refused. Pass that slug on every call below. With one key, omit it.

## 2. Search before you create

```
search { q, types: "workstream,issue,decision", limit: 10 }
```

Read what comes back, including the `workspace` stamp on each row. Do not create an issue or a workstream that already exists. Comment on or update the existing one instead (`trama-triage-issues`).

## 3. Decide where the work lives

A workstream is an outcome, not a container. One per outcome, never a second for the same outcome.

If you are the parent agent of this Delta thread, stop here and do not apply the cases below. Search for a workstream whose `deltaThreadUrl` is this thread and continue it. If none exists, create one and link every issue you were asked to do. A subagent works one of those issues; it does not get a workstream, and it does not get a new issue when the issue already exists. A slice with no issue yet becomes an issue on that workstream, never a second workstream. Do not split the list because the issues look unrelated, and do not ask whether to: being told to do them here is the grouping. People may say "workspace" for this thread. The Trama object is still one workstream.

Otherwise:

- The issues are already on a workstream: use that one. Load it with `get_workstream_context` and continue at step 5.
- Several issues share one outcome and have no workstream: create one and link them.
  ```
  link_issue {
    idOrKey: "BUG-142",
    createWorkstream: { title, ownerTeamId, objective, deltaThreadUrl }
  }
  link_issue { idOrKey: "BUG-148", workstreamIds: ["<id>"] }
  ```
- One issue, no workstream, and the work is a real outcome to pursue: create one the same way. A typo, a one-line fix, or a question is not an outcome. Leave it as an issue and work the issue; do not invent a workstream to have somewhere to write.
- The user described work but named nothing: search first. Create an issue (`trama-triage-issues`) only when nothing matches, then decide as above.

`deltaThreadUrl` is optional: a workstream can exist before its Delta thread. If you are the parent of a Delta thread, set it to this thread's URL. Otherwise omit it; do not invent one. A supplied URL must be an https link on delta.dev.

Document the outcome on the workstream, not on the issue: an objective in one sentence, and criteria that are observable ("OAuth login passes on Safari 18"), not tasks ("fix OAuth").

## 4. Do not write the status

A workstream's status is derived from the facts you record. Never set it, and never set `statusOverride`.

## 5. Hand off

- Starting: `trama-start-work`. It sets the first criterion to `in_progress` and leaves one comment saying what you will do.
- As facts appear (a criterion met, a PR opened, CI, a review): `trama-report-progress`. Record what you saw, never a guess.
- Blocked, or a choice only a person can make: `trama-ask-and-decide`. Ask once, then keep going on whatever the answer does not affect.
- Nothing to do (blocked, shipped, canceled, an open question that changes the approach, a proposed decision in your way): stop and tell the user. Do not start anyway.

## Done

Done is a fact, not a status you set. Every acceptance criterion is `met` or you have said why one is not, and the PR is merged or the work is recorded. Then stop. Do not re-summarize the workstream; the criteria and the comment trail already do.
