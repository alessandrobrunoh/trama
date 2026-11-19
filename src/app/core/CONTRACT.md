# Trama client data layer

This is a short guide to the current Angular client architecture. For domain/API truth, use
[`contracts/domain.ts`](../../../contracts/domain.ts), synced into `core/contracts/domain.ts` by
`node scripts/sync-contracts.mjs`. The server route and authorization contract is in [`server/API.md`](../../../server/API.md);
the route table is in `app.routes.ts`.

## Product and state boundaries

- A **Task** is the unit of work. The TypeScript type, the wire type and internal discriminators stay `Issue` /
  `issue`; the UI route is `/:workspace/tasks` and the HTTP resource is `/w/:slug/tasks`. Keep Tasks granular;
  one Task should describe one problem or request.
- The Task body describes the problem and relevant context. There is no separate goal field.
- A **Project** groups planned Tasks and milestones. It has one optional `repository` string (`owner/name` or a
  URL); there is no repository registry.
- Tasks have no team and no release. Teams, releases, customers, decisions, input requests, the
  repository registry, project updates and health, project-level context and artifacts, and Documents no longer
  exist. A Task still shows the pull requests, builds and attachments linked to it.
- Full transcripts, prompts, tool calls, and file-edit history belong in the execution tool. Trama keeps the
  durable context needed to understand and continue the work.
- Workstreams are not an active entity, route, API resource, status, or Task association.

Persisted domain state comes from the API snapshot. Ephemeral interaction state (dialogs, selection, draft
forms, filters) belongs in the UI/session stores, not in domain records.

## Core layout

```text
core/
  contracts/domain.ts      generated mirror of contracts/domain.ts
  api/                     ApiClient, ApiError, interceptor and request DTOs
  session/                 SessionStore and route guards
  stores/trama.store.ts    workspace snapshot, indexes, resource mutations
  stores/ui.store.ts       dialogs, sidebar, selection and create-dialog state
  query/                   filters, sorting and grouping for Tasks and Projects
  sync/                    SSE, reconnects and snapshot reconciliation
  keyboard/                global shortcuts and route navigation
  notify/notifier.ts       toast sink; core does not depend on a UI library
```

Reusable non-domain UI helpers live in `src/app/shared/` (`picker`, `comments`, `inline-edit`,
`comment-input`, `date-picker`, and `issue-progress`). Do not import generic helpers from a retired
feature directory.

## Routes and API

The authenticated workspace shell is `/:workspaceSlug`. Current work surfaces include Inbox
(needs you, your tasks, updates, snoozed), Tasks and Task detail, Projects, Milestones, Views, Statistics, Timer, Activity,
and Settings. Old `/issues` links redirect to `/tasks`. `src/app/app.routes.ts` is authoritative; removed routes
must not be reintroduced by links, chips, favorites, or shortcuts.

`ApiClient` is promise-based and uses `/api`. Prefer `TramaStore` for snapshot-backed reads and writes; use
the client directly for on-demand endpoints such as search, filtered event history, time entries, and the full
Attention list. Important current resources:

- Tasks: list/get/create/update/delete and bulk operations.
- Artifacts: pull requests, builds and attachments linked to a Task.
- Time entries: the signed-in person's tracked time (`GET time-entries`), used by Statistics.
- Attention: review requests, failing checks, conflicts, and triage; state is per user.
- Projects, milestones, comments, activity, notifications, integrations, and saved views.

The API interceptor sends cookie credentials and `X-Client-Id` on writes. `ApiError` distinguishes HTTP
failures from network errors. Store mutations own optimistic updates, rollback, refetch scheduling, and
user-facing error toasts; components should check the resolved result instead of duplicating that behavior.

## Workspace state and query model

`TramaStore` owns the current `WorkspaceSnapshot`: workspace/member data, projects, milestones, Tasks,
artifacts, comments, events, Attention, views, and integrations. It exposes readonly collections,
lookup/grouping computeds, actor resolution, comment loading, and resource mutations. Consult the store
source for exact method signatures; this document intentionally does not duplicate a generated method catalog.

Saved-view entities are Task and Project. Layouts are List, Board, and Project Timeline. Query field
definitions are in `core/query/fields.ts`; filtering/sorting/grouping logic is pure and shared by list,
board, and saved-view pages. Task project and milestone filters use direct Task ownership.

The live event stream invalidates the snapshot. Comment bodies are loaded by
subject on demand; the snapshot may carry a compact comment index instead.

## Forms and validation

The global create dialog presents Task as its primary composer, plus compact Project and View forms. Task
creation takes a title, a description and the usual properties.

Validate external/user input at the API boundary and use explicit domain types. Do not infer or silently
assign legacy records to Tasks.

## Verification

Run the focused frontend build with `npm run build`; Angular tests, when configured for this workspace, use
`npm test`. When changing the canonical domain contract, run `node scripts/sync-contracts.mjs` before
building either client or server.
