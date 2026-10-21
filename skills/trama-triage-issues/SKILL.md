---
name: trama-triage-issues
description: File, deduplicate, and classify Trama issues. Use when a user reports a bug, request, or idea to log, asks you to triage an issue, or asks where existing issues are.
---

# File and triage issues

An Issue is the unit of work. One Issue should describe one problem or request. Agents may work across multiple Issues directly.

## Search before creating

Read `.trama` at the repository root first. If it matches the checkout, search within its saved project scope instead of searching every project. If it is missing or incomplete, follow `trama-project-context` to ask the user and create it after they reply. Use a project-filtered issue list or `find_work` with `scope: "issues"` and the project ID when supported; use global `search` only when the user asks for a cross-project search. If a matching Issue exists, use `update_issue` or add a concise comment rather than creating a duplicate. Check for true duplicates and use the supported duplicate relationship instead of deleting the issue.

## Create an Issue

Read workspace settings and available catalogs first. Discover the exact create fields from the current MCP capability or CLI schema.

Include the useful context available: a clear title and a concise description. For bugs, capture steps to reproduce, expected versus actual behavior, and relevant environment. Use only valid issue kinds, priorities, and catalog IDs. Set optional fields only when supported and justified. Associate an optional Goal only when the right existing Goal is clear; if several apply, ask.

Do not put secrets, tokens, customer data, or full execution transcripts in an Issue. Keep transcripts in execution tools.

## Create or read context for issues

For related work, search and read context for each Issue that may be affected. Agents can implement across any number of Issues without an intermediate work object or duplicated status. Record changes and artifacts on the Issue(s) they concern. An optional Goal can provide broader context but never replaces Issue context.

## Triage

1. Find relevant Issues within the saved project scope using `find_work` or a project-filtered issue list.
2. Review duplicates, stale reports, missing information, priority, and classification.
3. Present a concise proposed set of changes before making broad or ambiguous edits.
4. Apply agreed changes using `triage_issues`, `create_issue`, or `update_issue` as appropriate, and verify their results.

Do not delete Issues. Do not change another person's assignment, estimate, or priority without authorization. Leave unsupported or uncertain optional fields unset.
