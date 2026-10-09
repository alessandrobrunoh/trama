---
name: trama-triage-issues
description: How to file, deduplicate, classify and group issues into workstreams in Trama. Use when the user reports a bug, request or idea to log, asks you to triage a backlog, find duplicates, or turn several related issues into one workstream.
---

# File and triage issues

An issue describes **one** problem or request. A workstream is the coordinated effort that resolves one or many issues. Keep them apart.

## Before creating anything: search

```
search { q: "refresh token logout", types: "issue,workstream,decision", limit: 10 }
list_issues { open: true, q: "…" }
```

If a matching open issue exists, **comment on it** or update it instead of creating another. If you find a true duplicate, mark it: `update_issue { idOrKey, duplicateOfId: "<original>" }`.

## Create the issue

```
get_workspace                                          // settings.labels, settings.estimateScale
create_issue {
  kind: "bug",                          // required
  title: "Logout leaves a stale auth cookie",
  body: "## What happens\n…\n## Expected\n…\n## Steps\n1. …",
  priority: "medium", teamId, projectId, source: "agent",
  labels: ["lb_bug"],                   // catalog ids that exist in this workspace
  estimate: 2                           // only when the size is clear and the scale is not none
}
```

- **kind** decides the key prefix and cannot be guessed lightly (changing it re-keys the issue): `bug` BUG, `feature` FEAT, `incident` INC, `tech_debt` DEBT, `feedback` FB, `idea` IDEA, `security` SEC.
- **title**: the symptom or request in plain words, under ~80 characters. No "bug:" prefixes.
- **body**: markdown. For bugs give steps, expected vs actual, and where you saw it. Include a stack trace or log line only if short and relevant.
- **status** defaults to `backlog`. Use `draft` if it is unfinished and you want people to refine it first. Do not set `in_progress` unless someone is working on it.
- **priority**: `urgent` only for outages and security exposure; most things are `medium` or `low`. When unsure, leave `none` and say why.
- **source**: use `agent` so people can tell it was filed by an agent.
- **projectId**: the project resolved from this checkout (`trama`, "Issues of this checkout") when there is exactly one. Several: ask. None: omit it and say the issue is not on a project.
- **labels**: ids from `get_workspace` → `settings.labels`, never names and never new labels. Use the catalog entry that exists: bug, incident, security → Bug; feature, idea → Feature; tech_debt → Improvement; a documentation change → Documentation. Skip a mapping whose id is not in the catalog.
- **estimate**: omit it when `settings.estimateScale` is `none`. Otherwise set a value on that scale only when you can justify it in one sentence (the user gave a size, or the change is obviously one small fix or a wide one). Fibonacci is `0, 1, 2, 3, 5, 8, 13, 21`. Linear is `1`–`10`. Exponential is `1, 2, 4, 8, 16, 32`. T-shirt is stored as XS `1`, S `2`, M `3`, L `5`, XL `8`. If you cannot justify a number, omit it and say why. Do not pick one just to fill the field.
- **assigneeId**: leave it empty while the issue stays in `backlog`, `draft` or `todo`. When you set `in_progress` and nobody is assigned, set it to `whoami.actor.id` if `actor.type` is `user`. The server does the same on create, update and link, and does not claim an `agent`. Never replace an assignee who is already set. Passing `assigneeId` yourself, including `null`, wins over that rule.

## Group issues into a workstream

Group when several issues **share a root cause or need the same change**. Do not group by convenience or by team.

Exception: the parent agent of a Delta thread was told to do these issues here, with subagents. Then there is one workstream for that thread, and every listed issue links to it. Do not invent one workstream per issue. Do not propose the split first. Spawn one subagent per issue; the subagent does not get its own workstream. If a slice has no issue yet, create an issue on that workstream, not a second workstream.

1. Check there is not already a workstream for it (`search`, `list_workstreams`).
2. To attach to an existing one:
   ```
   link_issue { idOrKey: "BUG-148", workstreamIds: ["<workstream id>"] }
   ```
3. To start a new one in the same call:
   ```
   link_issue {
     idOrKey: "BUG-142",
     createWorkstream: {
       title: "Stabilize authentication before v2",
       ownerTeamId, deltaThreadUrl,       // https URL of the Delta thread; omit it if the workspace turned Delta threads off
       objective: "Sessions survive token rotation on all supported browsers."
     }
   }
   ```
   If the workspace uses Delta threads and you do not have a `deltaThreadUrl`, **ask the user**; do not invent one. The create call tells you when it is required.
4. Then add acceptance criteria that are *observable* ("OAuth login passes on Safari 18"), not tasks ("fix OAuth").

An issue can belong to several workstreams, but only if it truly contributes to each; keep that rare.

## Triaging a backlog

1. `list_issues { status: "backlog", open: true }`, newest first.
2. For each: duplicate? already fixed? missing information? Propose changes in a table to the user rather than editing dozens of issues silently.
3. Apply the agreed changes with `update_issue`. Prefer fewer, deliberate writes; there are daily write caps.
4. Group clusters of related issues and propose the workstream (title, objective, criteria) before creating it.

## Don'ts

- Do not delete issues. If something is wrong, set `canceled` or mark it a duplicate.
- Do not change other people's assignees, estimates or priorities without being asked. Filling them on an issue you are creating, or taking the assignee because you moved it to `in_progress` and it had none, is not that.
- Do not paste secrets, tokens or customer data into issue bodies.
