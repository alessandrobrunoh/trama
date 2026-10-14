---
name: trama-report-progress
description: Record factual progress on Trama issues, including implementation artifacts and concise updates. Use after meaningful implementation, a PR or build change, or when asked to update Trama.
---

# Report progress

Record what happened, where it happened, and what remains. Use issue-level updates and artifacts; do not create duplicate progress on a separate execution object.

## Read, then report

Read the relevant Issue context first. For work spanning multiple issues, update each affected Issue with the facts relevant to it. Do not claim a change, test, review, or deployment you have not observed.

Use `report_progress` for factual progress and `attach_artifact` for related outputs when available. Use the current MCP capability or CLI schema for exact issue update, comment, and artifact arguments; do not assume parameters. Keep update text short and useful; the full transcript and detailed execution log belong in execution tools, not Trama.

## What to record

- A concise description of what changed and what remains.
- The actual Issue status when it changes, following the supported lifecycle.
- Relevant PR, build, test, design, or deployment artifacts, with accurate observed state.
- A short verification note: what was tested, where, and the result.
- Any decision-relevant follow-up using the Issue's Human input feature.

Attach an artifact to the Issue or Issues it concerns. Do not attach the same artifact repeatedly unless the supported operation updates it in place. Verify the result after writing.

## Goals and Plans

An optional Goal may provide context for the work, but report implementation progress on the Issue(s). A Plan is optional and belongs near the implementation it guides. If a Plan changes, update it and follow any approval lifecycle the current tools explicitly support; do not silently claim an approval.

## Before saying “done”

- Every affected Issue has accurate, useful context and status.
- Artifacts reflect their current observed state.
- Verification claims are backed by evidence; state what was not checked.
- Unresolved questions or proposed decisions are represented through the Issue's Human input feature.
- No full transcript or speculative progress was copied into Trama.
