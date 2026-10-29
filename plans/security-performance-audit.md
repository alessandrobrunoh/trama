# Security & performance audit — findings and fix plan

_Audit date: 2026-02-27. Scope: full repo — NestJS API (`server/src`), Angular app (`src/app`), shared contracts, migrations, Docker/self-host stack, dependency trees. Method: targeted code reading of every security-relevant module plus pattern sweeps (raw SQL interpolation, `innerHTML`, secrets, child processes, unbounded queries, index coverage) and `npm audit --omit=dev` on both manifests._

## Overall assessment

The codebase is already strongly hardened. Verified strengths (not findings): SSRF guard with per-address checks and no rebinding window (`server/src/common/safe-fetch.ts`), timing-safe HMAC on all inbound/outgoing webhooks (`server/src/webhooks/signatures.ts`, `server/src/outgoing-webhooks/signature.ts`), argon2 with unknown-email timing equalization and sha256-hashed session tokens (`server/src/auth/auth.service.ts`), API tokens stored hashed with per-token rate/write caps (`server/src/auth/tokens.service.ts`), AES-256-GCM secrets at rest with boot failure in prod without a key (`server/src/common/crypto.ts`), parameterized SQL everywhere (no interpolation found), uploads sandboxed with size caps and restrictive response headers, assistant tool tokens scoped against prompt injection (`server/src/ai/assistant-tools.service.ts` `WITHHELD`), migrations not `synchronize`, hardened containers (`cap_drop: ALL`, read-only fs).

What remains are real but bounded issues: **two high-severity dependency CVEs in the API runtime**, **a stale critical package in the root lockfile**, **unindexed substring scans on the hottest upload path**, **an O(workspace) snapshot that is refetched on nearly every change event**, **an O(n)-per-issue query storm on the issue board's drag-and-drop and bulk status changes**, plus small hardening items.

## Goal

Fix the confirmed security and performance issues found in this audit, in reviewable, independently verifiable slices, without regressing the existing hardening.

## Non-goals


- Redesigning the snapshot architecture wholesale (a bounded first increment plus a design spike only).
- Adding new product features; retention policy for activity history is raised as a question, not decided here.
- Frontend bundle work beyond running the existing `size` budget check (app is zoneless + signals + OnPush; nothing alarming found).

## Findings

| # | Severity | Area | Finding (evidence) |
| --- | --- | --- | --- |
| S1 | **High** | API deps | `npm audit --omit=dev` in `server/`: `body-parser` 2.0.0–2.3.0 HIGH (DoS, GHSA-27r3-jxmh-p828), `multer` 2.0.0–2.4.0 HIGH (DoS, GHSA-q7qp-rjg7-q26m, via `@nestjs/platform-express`), `qs` ≤6.16.0 MODERATE. Multer is reachable (all upload endpoints) though the custom memory storage and size cap already limit the practical impact; body-parser runs on every request. |
| S2 | Medium | Root lockfile | `package-lock.json` contains orphaned entries `next@16.4.0` (3 advisories incl. critical RCE), `zod`, `fast-uri` that nothing in `package.json` depends on. Not imported by the app, but `npm ci` installs them and the audit noise masks real issues. |
| S3 | Low | API headers | No `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, or HSTS on API responses (`server/src/configure-app.ts`). Per `SECURITY.md` scope this is hardening, not a vulnerability; the uploads endpoint already sets such headers manually, so the intent exists. |
| S4 | Low | API shape | `GET /api/w/:slug/issues` returns the entire workspace when `limit` is omitted (`issues.service.ts` `if (f.limit) qb.take(f.limit)`; DTO caps at 500 only when provided). Authenticated-only, and consistent with the snapshot design, but a cheap cap removes an unnecessary whole-table dump. |
| P1 | **High** | Server + client perf | `SnapshotService.build` loads every row of ~15 tables per workspace, serializes and scopes in JS (`server/src/snapshot/snapshot.service.ts`). The client refetches the full snapshot (debounced 300 ms) for nearly every SSE event from other clients (`src/app/core/sync/live-sync.service.ts`), after its own writes (`trama.store.ts`, 400 ms), on tab visible, and on reconnect. Cost is roughly `clients × activity × O(workspace)` — the product's defining scalability constraint. Comments are already excluded by default (`comments: 'index'`). |
| P2 | **High** | Server perf | Every `GET /uploads/:id` runs `references()`: five `strpos(coalesce(body,''), token)` full scans over issues, projects, documents, document_revisions and comments (`uploads.service.ts` L412–477). Unindexed substring search over all workspace text per file fetch; a page with 20 images triggers up to 100 scans. Same path also loops sequentially per id in `retained()`, `releaseIds()`, `assertAttachable()` (N+1). |
| P3 | Medium | Server perf | `TokensService.enforceLimits` UPSERTs `api_token_usage` on every mutating API-token request (`tokens.service.ts` L50–57) — one extra write + row lock per mutation. Bounded, but hot-path. |
| P4 | Medium | Server perf | SSE stream runs `isLiveVisible` (DB-dependent) per published event per connected client (`events.controller.ts` L73–86, concurrency 8). Busy workspace × many viewers multiplies queries. |
| P5 | Low | Data growth | `domain_events` grows unbounded (one row per mutation, no retention found). `webhook_deliveries` (7 days) and read notifications (90 days) are pruned; events are a product feature, so this needs a product decision, not a silent trim. |
| P6 | **High** | Issues board perf | The `/issues` drag-and-drop and bulk status changes multiply database round-trips per issue. A bulk status change of n issues runs n separate lookups in `IssuesService.getMany` (one `get` per ref, `issues.service.ts` L740–760) and then `prepareUpdate` per row, which calls `resolveIssueStatus` twice — each call re-fetches the whole workspace row via `loadStatusCatalog` just to read the status catalog (`issues.service.ts` L172–175, L949–955). 100 issues ≈ 100 lookups + 200 identical workspace fetches before the transaction starts. A single drag (`issue-board.ts` `move`, L1126) goes through `TramaStore.attempt`, whose `finally` always calls `scheduleRefetch()` (`trama.store.ts` L919), so moving one card reloads the entire workspace snapshot — and the SSE echo makes every other open client do the same. |
| C1 | Medium | Issues board correctness | The quick done/undone toggle hardcodes legacy status enums: `issue-items.ts` L284 calls `setStatus([id], quiet ? 'todo' : 'done')`. `resolveStatusEntry` (`contracts/domain.ts` L3005) falls back to the first catalog entry whose `type` matches, so in a workspace that renamed or replaced its statuses the click lands the issue on a different status than the one the user sees as "Done". Board columns themselves are safe: `groupUniverse` derives them from the catalog (`issue-model.ts` L245). |

Explicitly checked and found **not** vulnerable: SQL interpolation (none — all parameterized, `buildTsQuery` strips operators, `escapeLike` used in search), `innerHTML` bindings (blog content is a static local constant; document snippets are HTML-escaped server-side before `<mark>` insertion in `document-rules.ts`), secrets in client code (localStorage holds only UI prefs; AI/integration keys never leave the server), CSRF (SameSite=Lax cookie + `X-Client-Id` echo, CORS allowlist), path traversal in Grok CLI homes (sha256-derived dirs + `resolve` prefix check, `shell: false`, fixed argv), admin reset (env-gated, disabled in production).

## Proposed design and slices

### Slice 1 — dependency hygiene (S1, S2) — smallest, do first

- In `server/`: `npm audit fix` (bumps `body-parser`, `multer` via `@nestjs/platform-express`, `qs` within compatible ranges). Verify the custom multer memory storage still enforces `UPLOAD_MAX_BYTES` (its own spec suite covers it).
- In root: remove orphaned lockfile entries (`npm install` after deleting the stale entries, or `npm prune` — confirm `next`/`zod`/`fast-uri` disappear from `package-lock.json` and `npm audit --omit=dev` is clean).
- Verification: `npm audit --omit=dev` clean in both; `cd server && npm test && npm run test:e2e && npm run build`; root `npm run build`.

### Slice 2 — indexed upload references (P2)

Replace the five `strpos` scans with an `upload_references` table (`uploadId`, `subjectType`, `subjectId`, `projectId` denormalized), maintained where text is already parsed on write:

```ts
// migration: upload_references, indexed (uploadId), (subjectId)
// uploads.service.ts — on retained()/idsLostWith()/attachArtifact():
//   diff uploadIdsIn(beforeText) / uploadIdsIn(afterText) per subject and
//   insert/delete reference rows in the same transaction; references() becomes
//   one indexed query. Keep the strpos scan only in a reconciliation helper
//   (admin/maintenance) so a missed write can never orphan or leak a blob.
```

- `open()` visibility rules stay identical: a row is readable iff any reference row is visible (same `uploadVisible` logic, now over indexed rows instead of substring hits).
- Batch the per-id loops (`retained`, `assertAttachable`) into one query per subject set.
- Verification: extend `uploads.service.spec.ts` (reference transitions: stage → attach → text edit → owner delete → orphan cleanup); run e2e; manual smoke: upload an image into a comment, view the workspace as a second user with narrowed project access.
- Risk: correctness of garbage collection must not regress (a file wrongly considered unreferenced is deleted and links rot). The reconciliation helper mitigates; keep `referenced` flag semantics unchanged.

### Slice 3 — API hardening (S3, S4)

- Small middleware in `configure-app.ts` (or `helmet` with a minimal config): `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and HSTS when `NODE_ENV=production`. Keep the uploads endpoint's stricter CSP as-is.
- Default `take(500)` in the issues list when `limit` is omitted (mirrors the DTO max). Sweep other `if (f.limit)` list endpoints for the same pattern and apply one consistent rule.
- Verification: unit test asserting headers on a sample route; e2e green.

### Slice 4 — snapshot refetch de-amplification, first increment (P1)

Bounded step that removes the worst multiplier without changing the architecture:

- Add a monotonic `version` (bigint) to `workspaces`, bumped once per committed mutation (the same place `EventsService.publish` fires).
- `GET /snapshot` returns `ETag: W/"<version>:<accessHash>"`, where `accessHash` derives from the caller's role + project access + comments mode — **the ETag must include the access fingerprint**, or a 304 could serve one member's view to another.
- Honor `If-None-Match` with 304: reconnect catch-ups, tab-visible refetches, online events, and multi-tab storms become O(1) instead of full serializations. Burst refetches after real changes still return 200 (correctly — data changed).
- Client (`trama.store.ts`) sends `If-None-Match` on refetches; on 304 keep state, clear retry backoff.
- Verification: e2e — mutate → refetch returns 200 with new ETag; no mutation → 304; two users with different project access must never share a 304. Unit tests for ETag computation.

### Slice 5 — issue board drag and status changes (P6, C1)

The board's security posture checked out and stays untouched: drop targets come from catalog-derived column keys (`groupUniverse`), the server rejects unknown statuses with 400 (`requireStatus`), the bulk DTO caps ids and regex-validates status, `getMany` is workspace-scoped and 404s before writing, and the transaction re-locks rows and re-checks project visibility. `applyStatusFacts` correctly clears `completedAt` on reopen. This slice only removes the redundant work and fixes the hardcoded toggle.

- Load the status catalog **once per request** and thread it through. `resolveIssueStatus` / `issueStatusType` currently each call `loadStatusCatalog` (a full workspace fetch); `prepareUpdate` calls both on every status patch, and `updateMany` calls `prepareUpdate` per row. Pass the already-loaded catalog in, so a bulk change of n issues costs one catalog read instead of 2n.
- Resolve bulk refs in **one query**. Replace the per-ref loop in `getMany` with a single `WHERE workspaceId = $1 AND (id = ANY($2) OR key = ANY($2) OR aliases && $2)` (aliases are jsonb — match the existing lookup the single `get` uses) and keep the current "404 naming every missing ref, nothing written" contract.
- Stop the full-snapshot refetch after a pure field move. A drag or inline status/priority/assignee/team change returns the updated issue and the store already upserts it (`patchIssue` `onResult`). These mutations derive nothing the snapshot must recompute, so they should not call `scheduleRefetch()`; reserve the refetch for writes that do derive state (creates, deletes, project moves that rekey). The live SSE event still informs other clients — that path is covered by slice 4's 304.
- Fix the quick toggle (C1): resolve the target from the catalog — the entry of type `done` (and `todo` for the quiet variant) — instead of the literal `'done'` / `'todo'`, so a customized catalog lands on the status the workspace actually uses.
- Verification: unit test that a bulk status update of n issues performs a constant number of catalog/workspace reads (spy on the repository) and that `getMany` issues one query; a component/unit test that the quick toggle targets the catalog's `done`-typed entry when its id is not `done`; existing issues e2e stays green. Manual smoke: drag a card between columns and confirm no snapshot refetch fires (network panel), then bulk-set status on a selection.

### Slice 6 (spike, output is a design note) — delta sync + retention decisions (P1 deep fix, P3, P4, P5)

- Design note for extending the existing `LiveEvent` stream into entity deltas so clients stop refetching the full snapshot for derived state (issues' status/attention are the fields that force the refetch today). Include P3 (batch the daily `api_token_usage` flush like `lastUsedAt`) and P4 (cache access snapshots per SSE connection with a short TTL) as riders if the note confirms the approach.
- P5 is a product question — propose options (workspace-level retention setting vs. global default with archive) in the same note; do not implement without a decision.

## Review/land boundaries


- Slices 1–5 are independently landable; each ends with its verification run and a stop for review. Slice 5 does not depend on slice 4, but slice 4's 304 is what keeps the *other* clients cheap when a drag's SSE event arrives. Slice 6 produces a document, not code, and needs maintainer decisions before any implementation.

## Verification strategy


- Per-slice checks above; mandatory gates per `AGENTS.md`: API `npm test`, `npm run test:e2e` (recreates `trama_core_test` — never point it at real data), `npm run lint`, `npm run build`; frontend `npm run build` + `npm run size`.
- Performance claims get before/after evidence where cheap: a seed script with a large synthetic workspace (e.g. 2k issues, 5k comments, 50 uploads) measuring snapshot latency and `GET /uploads/:id` latency before and after slices 2 and 4, plus query counts for a 100-issue bulk status change before and after slice 5.

## Risks / open questions


- Slice 2 is the only schema-behavior change; its migration and GC correctness need the closest review.
- Slice 4's ETag must vary by access (stated above) — reviewer should specifically probe cross-role 304 behavior.
- `multer`/`@nestjs/platform-express` bump: confirm the custom memory storage's error contract (`LIMIT_FILE_SIZE`) still maps cleanly through `UploadExceptionFilter`.
- No critical in-code vulnerability was found; if the maintainers disagree with the severity framing of S3/S4 (hardening vs. vulnerability), slice 3 can be dropped without affecting the others.
- Slice 5's "skip the snapshot refetch" change must be limited to mutations whose response already carries the full derived state. If a status change feeds the attention/demand summaries that only the snapshot recomputes, those clients would go stale until the next SSE-driven refetch — confirm against `AttentionService` before dropping the refetch, and fall back to keeping it (slice 4's 304 then absorbs the cost).
