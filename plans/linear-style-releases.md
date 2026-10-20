# Plan: Linear-style Releases, integrated with the rest of Trama

**Mode:** Full
**Status:** Complete (slices 1–5); pending final review + manual UI pass

## Goal and non-goals

Replaces the flat list of `release` artifacts with a first-class releases system modeled on
[Linear Releases](https://linear.app/docs/releases): pipelines group releases, releases group
issues, and everything is reachable from issue views, saved Views, and the issue sidebar.

**Goal:** a user can create a release pipeline, create a release in it, attach issues, write
release notes, complete the release (with an option to move its open issues to Done), and
filter issue Views by release; a Changelog view assembles released notes chronologically.

**Non-goals (this iteration):**
- CI/CD integration (access keys, GitHub Action, auto-creating releases on push) — the API
  endpoints land first, automation can be added later.
- Stages within scheduled pipelines, and auto-generation of release notes via the AI module.
- Migrating or deleting the existing `release` **artifact** kind: those remain generic
  external attachments (link + provider + environment). The new Release entity is separate.

## Acceptance criteria

- [ ] Settings-less flow: pipelines and releases are managed from the Releases page (Linear
      keeps them in Settings; for Trama the Releases page itself is the management surface).
- [ ] Releases page shows pipelines; each pipeline shows its releases with version/name,
      status, target date, issue count; a release detail shows its issues and release notes.
- [ ] Completing a release marks it `released`; the user is offered "move open issues to Done"
      (matching the pipeline's team statuses) — nothing moves without confirmation.
- [ ] An issue's sidebar has a Release property (per-pipeline pick list); removing is possible.
- [ ] Saved issue Views can filter by release (`release` field, id-op), in the web client and
      in server-side view queries (shared/public views).
- [ ] Changelog tab per pipeline lists released releases with their notes in date order.
- [ ] Server unit tests cover pipeline/release CRUD, issue assignment rules, complete-release
      status moves, and release filtering in view queries.

## Current state and evidence

**Verified:**
- Domain model source of truth is `contracts/domain.ts`; `scripts/sync-contracts.mjs` copies it
  into `server/src/contracts/domain.ts` and `src/app/core/contracts/domain.ts`.
- Server: NestJS feature modules under `server/src` (e.g. `artifacts/`, `milestones/`,
  `views/`); TypeORM entities in `server/src/database/entities/index.ts` (Wire base class,
  `@Entity`/`@ForeignKey` decorators); migrations in `server/src/database/migrations/`; unit
  tests are Vitest `*.spec.ts` beside implementations.
- Client: central store `src/app/core/stores/trama.store.ts`; releases today are only a
  workspace-wide artifact list in `src/app/features/releases/release-list-page.ts` reusing
  `ProjectArtifactRow`/`ProjectArtifactDialog`; route `releases` in `src/app/app.routes.ts`,
  nav entries in `src/app/layout/nav.ts`.
- Views: `ViewEntity = 'issue' | 'decision' | 'project'` in `contracts/domain.ts`;
  client filter field definitions in `src/app/core/query/fields.ts` (`FIELD_DEFS`), value
  labels/pickers in `src/app/features/views/view-model.ts`; server-side query in
  `server/src/views/view-query.ts` (no release concept today).
- Issue properties sidebar: `src/app/features/issues/issue-sidebar.ts`.

**Assumed (to confirm at implementation time):**
- New NestJS module + controller/service follow the `artifacts` module's shape
  (workspace-scoped, permission checks via existing guards).
- `status` module exposes a notion of a team's "Done" status reachable from the release
  completion logic (as the existing status automations do). If not, completion only marks the
  release and moving issues stays a manual bulk action.

## Alternatives and decision

- **Keep releases as artifacts** (status quo): rejected — cannot group issues, no lifecycle,
  no view integration.
- **Release as a grouping table with a join table** (`release_issues`): more flexible (an
  issue in two releases, hotfix backports) but heavier; Linear itself rejects this — an issue
  belongs to one upcoming release at a time.
- **Chosen:** `releaseId` column on the issue row (mirrors Linear, trivially queryable for
  Views and the sidebar). Backports can be handled later by allowing per-issue override if a
  real need appears.

## Proposed design

```mermaid
erDiagram
    RELEASE_PIPELINE ||--o{ RELEASE : contains
    RELEASE_PIPELINE }o--o| TEAM : owned-by
    RELEASE ||--o{ ISSUE : groups-via
    RELEASE {
        id ID
        workspaceId ID
        pipelineId ID
        name "v1.4.0 or SHA"
        status "draft | released | canceled"
        notes "markdown release notes"
        releasedAt "actual completion"
        targetAt "scheduled only"
    }
    ISSUE {
        releaseId "nullable FK"
    }
```

### Contracts (source: `contracts/domain.ts`, unverified pseudocode)

```ts
export type ReleasePipelineType = 'continuous' | 'scheduled';
export interface ReleasePipeline {
  id: ID; workspaceId: ID; name: string;
  type: ReleasePipelineType;
  teamId?: ID;              // ownership, drives suggested statuses
  moveOpenIssuesToNext: boolean; // honored when completing a scheduled release
  createdAt: ISODate; updatedAt: ISODate;
}
export interface Release {
  id: ID; workspaceId: ID; pipelineId: ID;
  name: string;             // version or SHA
  status: 'draft' | 'released' | 'canceled';
  notes?: string;           // markdown
  targetAt?: ISODate;       // scheduled pipelines
  releasedAt?: ISODate;
  issueCount?: number;      // set on reads
  createdAt: ISODate; updatedAt: ISODate;
}
// Issue gains: releaseId?: ID
```

### Server API (`server/src/releases/`, new module)

- `GET/POST/PATCH/DELETE /workspaces/:id/releases/pipelines`
- `GET/POST/PATCH/DELETE /workspaces/:id/releases` (+ `POST .../releases/:id/complete`)
- Completing a release: set `status='released'`, `releasedAt=now`; if the caller asked for it
  (or the pipeline's `moveOpenIssuesToNext` on scheduled pipelines), move its open issues to
  the pipeline team's done status; issues with `releaseId` on a completed release and still
  open are moved to the next draft release in the pipeline (creating one if needed).
- Assignment rule: an issue joins a release by setting `issue.releaseId`; server rejects
  setting it when the issue belongs to a different workspace than the release.

### Client

- `src/app/features/releases/` rebuilt: pipeline tabs (or segmented control), release list,
  release detail (issues + editable markdown notes + Complete button), Changelog tab.
  Reuses `PageHeader`, `EmptyState`, existing hlm components; new `release.store` state lives
  in `trama.store.ts` alongside other workspace state.
- `issue-sidebar.ts`: Release property using the per-pipeline pick list.
- Views: add `release` to issue `FIELD_DEFS` (`src/app/core/query/fields.ts`, kind `id`) plus
  picker options in `view-model.ts`, and the equivalent predicate in
  `server/src/views/view-query.ts` so shared/public views match.
- Old flat artifact list stays reachable? No — the Releases page is replaced; `release`
  artifacts remain visible in their owners' artifact sections.

## Reviewable slices

1. **Domain + API foundation** — **Ready for review.** Contracts, entity, migration, `releases`
   module with pipeline/release CRUD, assignment, and complete-release logic + unit tests.
   Done status is workspace-catalog (`resolveStatusEntry(..., 'done')`), not per-team.
   Verify: `cd server && npm test` (800 passed), `npm run lint`, `npm run build`.
2. **Releases page (web)** — **Ready for review.** Store state (snapshot-backed pipelines/releases),
   pipeline tabs, release list/detail, complete action with “move open issues to Done”, empty
   states. Changelog tab per pipeline included here (was slice 5). Nav route `releases` kept.
   Verify: `npm run build` (pass). `npm test` not run: root `ng test` has no Angular test target
   and there are no feature-page specs. Server snapshot spec covers `releasePipelines`/`releases`.
   Manual UI pass against the dev server still needed.
3. **Issue integration** — **Ready for review.** Issue detail sidebar Release property
   (`IssueReleaseProp`): pick list grouped by pipeline, status hint, clear via `setIssueRelease`.
   Verify: `npm run build` (pass). No frontend `*.spec.ts` targets exist; server tests not run
   (no server change). List/board column skipped (no established column extension). Manual UI
   pass against the issue page still needed.
4. **Views integration** — **Ready for review.** Issue views filter/group by `releaseId`
   (`FIELD_DEFS` + `view-model` pickers/labels; server `VIEW_FIELDS` + `RefKind` `'release'`
   so public/shared group labels resolve). View pages consume `FIELD_DEFS` generically.
5. **Changelog + polish** — Changelog tab shipped in slice 2. Remaining: nav copy, docs if needed.
   Verify: build + full suites.

Each slice stops for review; slices 3 and 4 are independent of each other but both depend on 2.

## Test and validation strategy

- Server: Vitest specs beside implementations — service-level CRUD, complete-release status
  moves (including the no-done-status fallback), view-query release filtering, permission
  edges (non-member). RED–GREEN for the complete-release rules.
- Client: `npm test` plus manual verification against `npm run start:dev` + `npm start`.
- Before opening the PR: server `npm run lint && npm run build`, client `npm run build`.

## Rollout and rollback

- Migration only adds tables/columns (`release_pipelines`, `releases`, nullable
  `issues.release_id`); rollback is dropping them. No existing data is rewritten.
- The old releases page is replaced in slice 5, so the feature is incomplete-but-safe at every
  intermediate landing.

## Risks and open decisions

- **Done-status semantics** (assumption above): confirm how the `status` module models team
  done statuses before slice 1 is finalized.
- `moveOpenIssuesToNext` on continuous pipelines is meaningless (Linear only offers it for
  scheduled); confirm we don't want a backlog concept for continuous pipelines in v1.
- Deleting a pipeline with releases: follow Linear's soft-delete (recently deleted, 30-day
  restore) or hard-cascade? Plan assumes soft-delete is a follow-up and v1 refuses deletion
  while non-canceled releases exist.
