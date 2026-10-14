# Trama client data layer

This is a short guide to the current Angular client architecture. For domain/API truth, use
[`contracts/domain.ts`](../../../contracts/domain.ts), synced into `core/contracts/domain.ts` by
`node scripts/sync-contracts.mjs`. The server route and authorization contract is in [`server/API.md`](../../../server/API.md);
the route table is in `app.routes.ts`.

## Product and state boundaries

- An **Issue** is the unit of work. Keep Issues granular; one Issue should describe one problem or request.
- `Issue.goal` is optional outcome context: the desired result, not a technical plan. The Issue body describes
  the problem and relevant context.
- Issue **Human input** is one entry point with two modes. Question mode creates an `InputRequest`; Decision
  mode creates a `Decision`. They have different record shapes and lifecycles.
- A Plan is optional. It is represented by a Plan-titled Document/artifact attached to an Issue; an approval
  is an Issue-linked Decision. There is no separate Plan entity.
- Full transcripts, prompts, tool calls, and file-edit history belong in the execution tool. Trama keeps the
  durable context needed to understand and continue the work.
- Workstreams are not an active entity, route, API resource, status, or Issue association. Legacy requests,
  Decisions, artifacts, comments, and events may retain former-key provenance; they are not linked to a
  replacement Issue unless the migration could identify exactly one existing Issue.

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
  query/                   filters, sorting and grouping for Issues, Decisions and Projects
  sync/                    SSE, reconnects and snapshot reconciliation
  keyboard/                global shortcuts and route navigation
  notify/notifier.ts       toast sink; core does not depend on a UI library
```

Reusable non-domain UI helpers live in `src/app/shared/` (`picker`, `comments`, `inline-edit`,
`comment-input`, `date-picker`, and `issue-progress`). Do not import generic helpers from a retired
feature directory.

## Routes and API

The authenticated workspace shell is `/:workspaceSlug`. Current work surfaces include Overview, Attention,
Issues and Issue detail, Input requests, Decisions and Decision detail, Projects, Milestones, Documents,
Repositories, Teams, Views, Activity, and Settings. `src/app/app.routes.ts` is authoritative; removed routes
must not be reintroduced by links, chips, favorites, or shortcuts.

`ApiClient` is promise-based and uses `/api`. Prefer `TramaStore` for snapshot-backed reads and writes; use
the client directly for on-demand endpoints such as Issue/Project context, search, filtered event history,
and the full Attention list. Important current resources:

- Issues: list/get/create/update/delete, bulk operations, and `GET issues/:idOrKey/context`.
- Human input: Issue-filterable Input Requests and Issue-linked Decisions.
- Artifacts and Documents: attach to an Issue or Project; Plans are ordinary Issue-owned Documents/artifacts.
- Attention: issue questions, proposed Decisions, review requests, failing checks, conflicts, and triage;
  state is per user.
- Projects, milestones, comments, activity, notifications, integrations, and saved views.

The API interceptor sends cookie credentials and `X-Client-Id` on writes. `ApiError` distinguishes HTTP
failures from network errors. Store mutations own optimistic updates, rollback, refetch scheduling, and
user-facing error toasts; components should check the resolved result instead of duplicating that behavior.

## Workspace state and query model

`TramaStore` owns the current `WorkspaceSnapshot`: workspace/member data, teams, repositories, projects,
milestones, Issues, Input Requests, artifacts, Decisions, comments, events, Attention, views, and
integrations. It exposes readonly collections, lookup/grouping computeds, actor resolution, comment loading,
and resource mutations. Consult the store source for exact method signatures; this document intentionally
does not duplicate a generated method catalog.

Saved-view entities are Issue, Decision, and Project. Layouts are List, Board, and Project Timeline. Query
field definitions are in `core/query/fields.ts`; filtering/sorting/grouping logic is pure and shared by list,
board, and saved-view pages. Issue project and milestone filters use direct Issue ownership.

The live event stream invalidates the snapshot and on-demand Project contexts. Comment bodies are loaded by
subject on demand; the snapshot may carry a compact comment index instead.

## Forms and validation

The global create dialog presents Issue and Decision as its primary composer modes. Issue creation includes
an optional Goal, described as the desired result rather than a technical plan. Other resource forms remain
available through their relevant entry points.

Validate external/user input at the API boundary and use explicit domain types. Keep Question and Decision
lifecycles distinct even though they share an Issue Human input UI. Do not infer or silently assign legacy
records to Issues.

## Verification

Run the focused frontend build with `npm run build`; Angular tests, when configured for this workspace, use
`npm test`. When changing the canonical domain contract, run `node scripts/sync-contracts.mjs` before
building either client or server.
