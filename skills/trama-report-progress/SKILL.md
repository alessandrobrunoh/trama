---
name: trama-report-progress
description: How to record progress in Trama accurately, by updating acceptance criteria, attaching pull requests and builds as artifacts with CI and review state, and commenting. Use after opening or updating a PR, after tests or CI change, when a criterion is met, or when the user asks you to "update Trama" or "log this".
---

# Report progress

Trama derives a workstream's status from **facts you record**. Recording them correctly is how the status becomes true. Never write the status yourself.

## Reading the status

The server derives `status` from the facts you record and tells you what is missing. Do not recompute it from a rule list; read it:

```
get_context { id: "AUTH-42" }   // briefing: status, delivery, completion: { achieved, gaps[] }; report_progress replies with the same
```

- `completion.achieved` is true only when the outcome is done. `completion.gaps` lists why not: `no_criteria`, `criteria_pending`, `blocked`, `needs_input`, `no_delivery`. Fix the gaps; do not argue with them.
- `delivery` (`none`, `in_review`, `merged`, `released`, `deployed`) is what the code did. A merged PR sets `delivery: merged`, never "done". A workstream with no acceptance criteria never ships on its own: add one.
- `statusOverride` set means a person pinned the status by hand. It is not evidence that the outcome is achieved; `completion` still says what is missing.
- Canceled issues do not count. Linking an issue or a PR never changes a criterion.

## What to record, and when

One tool records it all: `report_progress`. It takes any combination of criteria, a PR/build artifact, the issue status, a project update and a comment, applies them in order, and answers with what was applied, what failed and the workstream's resulting status. Each step uses your key's permissions; a step you may not do is reported, the others still run. If something failed, resend only the failed parts.

```
report_progress {
  workstream: "AUTH-42",
  criteria: [{ criterion: "1", state: "met" }],
  artifact: { kind: "pull_request", title: "Rotate refresh tokens", url, externalId: "318", state: "open", ci: "pending", review: "none", hasConflicts: false },
  issue: "BUG-142", issueStatus: "in_review",
  comment: "PR #318 open: rotates refresh tokens. CI running. Criterion 1 met; criterion 2 needs Safari testing."
}
```

### Acceptance criteria

Mark each criterion as you genuinely satisfy it, and attach the proof in the same call. `criterion` is the criterion id, its 1-based position (`"2"`) or a unique piece of its text:

```
report_progress { workstream, criteria: [{ criterion: "2", state: "met",
  evidence: { artifactIds: ["ar_…"], note: "tested on staging" } }] }   // pending → in_progress → met
report_progress { workstream, addCriteria: ["Refresh tokens rotate on every use"] }
```

Set `met` only with evidence: an artifact of this workstream (test report, deployment, PR) and/or a short note saying what you verified. The server records that **you** declared it (shown as "declared by agent"); a person can still verify it. `met` without evidence is allowed but shows as "no evidence" (the reply carries a warning), so do not do it. Do not set `met` just because a PR is open or merged, and say in a comment what you did not verify. Changing a criterion's text resets it to `pending`. Do not delete criteria you could not meet; leave them and say why in a comment.

### Pull requests and builds

Create the artifact **once** when the PR opens, then call again as it changes. `report_progress` (and `attach_artifact`) finds the existing artifact by `externalId` or `url` and updates it in place, so you never duplicate it:

```
report_progress { workstream, artifact: { kind: "pull_request", title: "Rotate refresh tokens", provider: "github", url, externalId: "318", state: "open", ci: "pending", review: "none", hasConflicts: false, repositoryId } }
report_progress { workstream, artifact: { kind: "pull_request", title: "Rotate refresh tokens", externalId: "318", ci: "passing" } }        // when CI finishes
report_progress { workstream, artifact: { kind: "pull_request", title: "Rotate refresh tokens", externalId: "318", review: "approved" } }   // when a person approves
report_progress { workstream, artifact: { kind: "pull_request", title: "Rotate refresh tokens", externalId: "318", state: "merged" } }      // when it merges
```

Allowed values: `kind` pull_request, merge_request, document, link, design, image, file, build, test_report, deployment, release · `state` draft, open, merged, closed, pending, running, succeeded, failed, healthy, degraded, published · `ci` pending, passing, failing · `review` none, requested, approved, changes_requested.

Always pass `kind`, `title` and the same `externalId` or `url` so it matches. Use the **real** values from the forge. Never mark `ci: "passing"` or `state: "merged"` unless you saw it.

Other artifacts: a plain URL (spec, dashboard, ticket elsewhere) → `kind: "link"` with `url` and an optional `description`; a test run → `kind: "test_report"` with `state: "succeeded"` / `"failed"`; a design or doc → `kind: "design"` / `"document"` with its `url`; a deploy → `kind: "deployment"`, `environment`, `state: "healthy"`.

### Attaching an artifact to a project or an issue

`attach_artifact` takes any of `workstream`, `issue`, `project` (at least one; you may pass several). Attach it where it belongs, not everywhere:

```
attach_artifact { project: "pj_…", kind: "document", title: "Q4 launch plan", url, description: "Scope and rollout order" }
attach_artifact { issue: "BUG-142", kind: "pull_request", title: "Fix login timeout", url, state: "open" }
get_context { id: "BUG-142" }      // the issue with its artifacts; for a project's own + its workstreams' + its issues' artifacts: get_context { id: "pj_…" }
```

A project sees the artifacts of its workstreams and issues automatically, so do not duplicate an artifact onto the project just to make it visible there. PR state (`ci`, `review`) only drives a workstream's status when the artifact is attached to that workstream.

### Project updates

A project update is the status post people read on the project: a `health` and a short markdown write-up. Post one when you finish a meaningful body of work for a project (a milestone reached, something shipped, a risk appeared), not after every commit:

```
get_context { id: "pj_…" }                 // read what is actually true first
report_progress { project: "pj_…", projectUpdate: { health: "at_risk", body: "## Shipped\n- Importer merged (#318)\n\n## Next\n- Safari fix\n\n## Risks\n- Waiting on the legal review" } }
```

`health` is `on_track`, `at_risk` or `off_track`, and the newest update sets the project's health. Base it on facts (milestones, blocked workstreams, failing CI), say what you based it on, and prefer `at_risk` over a rosy guess. To fix your own update instead of posting a second one, or to delete one, use `list_capabilities { q: "project update" }` and `run_tool` (`update_project_update`). Do not delete updates written by other people.

### Issues

Issue status is separate. When the fix for an issue is merged, set it:

```
report_progress { issue: "BUG-142", issueStatus: "done" }       // or update_issue { idOrKey: "BUG-142", status: "done" }
```

Use `in_review` while its PR is open. Do not close issues whose fix is not merged.

### A short comment

After a meaningful step, one comment summarising what changed and what is next. Keep it factual: `comment` in `report_progress` (on the workstream, else the issue, else the project), or `add_comment { on, body }` for anything else:

```
report_progress { workstream: "AUTH-42", comment: "PR #318 open: rotates refresh tokens. CI running. Criterion 1 met; criterion 2 needs Safari testing." }
```

Skip comments for trivial steps; the activity log already records every change.

## Checklist before you say "done"

- Criteria reflect reality (`met` only where true, with evidence).
- `completion.gaps` is empty, or you told the user what remains.
- If the work moved a project (milestone, risk), a project update says so, with an honest `health`.
- Every PR you opened exists as an artifact with current `state`, `ci`, `review` (the `applied` list of `report_progress` shows it).
- Linked issues have the right status.
- Anything unresolved is an input request or a comment, not silence.
- You did not set `statusOverride`.
