---
name: trama-report-progress
description: How to record progress in Trama accurately, by updating acceptance criteria, attaching pull requests and builds as artifacts with CI and review state, and commenting. Use after opening or updating a PR, after tests or CI change, when a criterion is met, or when the user asks you to "update Trama" or "log this".
---

# Report progress

Trama derives a workstream's status from **facts you record**. Recording them correctly is how the status becomes true. Never write the status yourself.

## How the status is derived (first match wins)

1. A manual `statusOverride` (do not set it).
2. **shipped**: a healthy `deployment` or `published` `release` artifact, or every non-closed PR/MR is `merged`.
3. **blocked**: an unshipped workstream it depends on.
4. **needs_input**: an open input request or a `proposed` decision.
5. **ready_to_land**: an open PR with `review: approved`, `ci: passing` and `hasConflicts: false`.
6. **in_review**: any open PR.
7. **working**: a criterion `in_progress`, or a `build` / `test_report` artifact.
8. **planned**: has acceptance criteria.
9. **draft**: nothing yet.

So: opening a PR moves it to in review; CI and review state on that PR decide ready to land; merging every PR ships it.

## What to record, and when

### Acceptance criteria
Mark each criterion as you genuinely satisfy it:
```
update_criterion { idOrKey, criterionId, state: "met" }   // pending → in_progress → met
```
Only `met` when it is demonstrably true (tests pass, behaviour verified). Do not delete criteria you could not meet; leave them and say why in a comment.

### Pull requests and builds
Create the artifact **once** when the PR opens, then update it as it changes:
```
create_artifact {
  workstreamId, kind: "pull_request", title: "Rotate refresh tokens",
  provider: "github", url, externalId: "318",
  state: "open", ci: "pending", review: "none", hasConflicts: false,
  repositoryId
}
update_artifact { id, ci: "passing" }            // when CI finishes
update_artifact { id, review: "approved" }       // when a person approves
update_artifact { id, state: "merged" }          // when it merges
```
Allowed values: `kind` pull_request, merge_request, document, design, image, file, build, test_report, deployment, release · `state` draft, open, merged, closed, pending, running, succeeded, failed, healthy, degraded, published · `ci` pending, passing, failing · `review` none, requested, approved, changes_requested.

Before creating, `list_artifacts` for the workstream and update an existing entry instead of duplicating. Use the **real** values from the forge. Never mark `ci: "passing"` or `state: "merged"` unless you saw it.

Other artifacts: a test run → `kind: "test_report"` with `state: "succeeded"` / `"failed"`; a design or doc → `kind: "design"` / `"document"` with its `url`; a deploy → `kind: "deployment"`, `environment`, `state: "healthy"`.

### Issues
Issue status is separate. When the fix for an issue is merged, set it:
```
update_issue { idOrKey: "BUG-142", status: "done" }
```
Use `in_review` while its PR is open. Do not close issues whose fix is not merged.

### A short comment
After a meaningful step, one comment summarising what changed and what is next. Keep it factual:
```
create_comment { subject: { type: "workstream", id }, body: "PR #318 open: rotates refresh tokens. CI running. Criterion 1 met; criterion 2 needs Safari testing." }
```
Skip comments for trivial steps; the activity log already records every change.

## Checklist before you say "done"

- Criteria reflect reality (`met` only where true).
- Every PR you opened exists as an artifact with current `state`, `ci`, `review`.
- Linked issues have the right status.
- Anything unresolved is an input request or a comment, not silence.
- You did not set `statusOverride`.
