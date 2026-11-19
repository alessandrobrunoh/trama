---
name: trama-report-progress
description: Record factual progress on Trama tasks, including implementation artifacts and concise updates. Use after meaningful implementation, a PR or build change, or when asked to update Trama.
---

# Report progress

Record what happened, where it happened, and what remains. Use task-level updates and artifacts; do not create duplicate progress on a separate execution object.

## Read, then report

Read the relevant task context first. For work spanning multiple tasks, update each affected task with the facts relevant to it. Do not claim a change, test, review, or deployment you have not observed.

Use `report_progress` to record, in one call, any of: an `artifact` (PR, build, test report, deployment...), a new task status (`issueStatus`), a `projectUpdate` (health plus markdown body), and one factual `comment`. Pass the task key as `issue` (the argument name is historical) or a `project` id. Use `attach_artifact` when you only need to attach or refresh an artifact, and `add_comment` for a note. For anything else, use `list_capabilities` and `run_tool`, and the exact schema they return. Keep update text short and useful; the full transcript and detailed execution log belong in execution tools, not Trama.

## What to record

- A concise comment on what changed and what remains.
- The actual task status when it changes: `in_progress` when you start, `in_review` while the PR is open, `done` only once the fix is merged.
- Relevant PR, build, test, design, or deployment artifacts, with accurate observed state (`state`, `ci` as pending, passing or failing, `review`, `hasConflicts`).
- A short verification note: what was tested, where, and the result.
- Anything that needs a person's decision, stated plainly in the comment.

Attach an artifact to the task or tasks it concerns. Repeating the same `externalId` or URL updates the artifact in place, so do not worry about duplicates, but do not attach the same artifact to unrelated tasks. Verify the result after writing.

## Projects

A project update is for a project-level status (health `on_track`, `at_risk` or `off_track`, and what shipped, what is next, the risks). Task progress belongs on the task, not in a project update.

## Before saying "done"

- Every affected task has an accurate, useful comment and status.
- Artifacts reflect their current observed state.
- Verification claims are backed by evidence; state what was not checked.
- Open questions for a person are written down on the task.
- No full transcript or speculative progress was copied into Trama.
