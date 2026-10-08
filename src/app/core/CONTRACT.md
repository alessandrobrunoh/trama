# Nabla client data layer — contract

Everything under `src/app/core/**` (except `theme/`, `contracts/`). Feature agents rely on this file only; read it before touching data.
Authoritative inputs: `PLAN.md` (§4 API, §5 routes), `contracts/domain.ts` (types; synced copy at `core/contracts/domain.ts`, never edit).

Import from the barrel: `import { NablaStore, SessionStore, KeyboardShortcuts, type Workstream } from '../../core';`
(barrel = `core/index.ts`; it re-exports the domain types too).

Conventions: Angular 22 zoneless, standalone, signals, `inject()`, OnPush, built-in control flow. Route params bind to `input()`s.

```
core/
  contracts/domain.ts      GENERATED copy of contracts/domain.ts
  config.ts                API_BASE_URL token ('/api')
  utils.ts format.ts       initials, uid, isTypingTarget, avatarColor, tint, clamp, nowIso | relativeTime, shortDate, fullDate, isOverdue
  meta.ts                  labels / tone / order for every enum (WORKSTREAM_STATUS_META, ...)
  api/                     ApiClient, ApiError, apiInterceptor, request DTO types (api.types.ts)
  session/                 SessionStore, authGuard, guestGuard, workspaceGuard, rootRedirectGuard, roleGuard
  stores/nabla.store.ts    NablaStore  (workspace data + mutations)
  stores/ui.store.ts       UiStore     (modals, sidebar, list focus/selection)
  sync/                    LiveSync (SSE), SyncStatus, reconcile, CLIENT_ID
  query/                   filter / sort / group utilities driven by ViewFilter
  keyboard/                KeyboardShortcuts, usePageShortcuts, SHORTCUT_GROUPS, GO_TO_ROUTES
  notify/notifier.ts       Notifier (toast sink; core never imports a UI library)
```

---

## 1. Routes (`src/app/app.routes.ts`)

Top level (reserved, cannot be workspace slugs): `login`, `signup`, `new-workspace`, `404`.

| path | page class (file) | guards |
|---|---|---|
| `/login` | `LoginPage` (features/auth/login-page.ts) | guestGuard |
| `/signup` | `SignupPage` (features/auth/signup-page.ts) | guestGuard |
| `/new-workspace` | `NewWorkspacePage` (features/auth/new-workspace-page.ts) | authGuard |
| `/404` | `NotFoundPage` (features/not-found/not-found-page.ts), inputs `workspace`, `error` | - |
| `/` | (no component) redirect: last-used or first workspace `/<slug>/overview`, `/new-workspace` if none, `/login` if signed out | rootRedirectGuard |
| `/:workspaceSlug` | `AppShell` (layout/app-shell.ts) | authGuard, workspaceGuard |

Children of `/:workspaceSlug` (all lazy, title `<Page> · Nabla`):

| path | class (file under features/) | inputs besides `workspaceSlug` |
|---|---|---|
| `` | redirect -> `overview` | |
| `overview` | `OverviewPage` overview/overview-page.ts | |
| `attention` | `AttentionPage` attention/attention-page.ts | |
| `issues` | `IssuePage` issues/issue-page.ts | |
| `issues/:key` | `IssueDetailPage` issues/issue-detail-page.ts | `key` (BUG-142 or id) |
| `workstreams` | `WorkstreamListPage` workstreams/workstream-list-page.ts | |
| `workstreams/:key` | `WorkstreamDetailPage` workstreams/workstream-detail-page.ts | `key` (AUTH-42 or id), `tab` (query) |
| `executions/:id` | `ExecutionDetailPage` executions/execution-detail-page.ts | `id` |
| `graph` | `GraphPage` graph/graph-page.ts | |
| `decisions` | `DecisionListPage` decisions/decision-list-page.ts | |
| `decisions/:key` | `DecisionDetailPage` decisions/decision-detail-page.ts | `key` (ADR-7 or id) |
| `projects` | `RepositoryListPage` repositories/repository-list-page.ts | The product calls these **projects**. `repositories` redirects here. |
| `projects/:id` | `RepositoryDetailPage` repositories/repository-detail-page.ts | `id`. `repositories/:id` redirects here. |
| `teams` | `TeamListPage` teams/team-list-page.ts | |
| `teams/:key` | `TeamDetailPage` teams/team-detail-page.ts | `key` (team key AUTH or id) |
| `views` | `ViewListPage` views/view-list-page.ts | |
| `views/:id` | `ViewDetailPage` views/view-detail-page.ts | `id` |
| `settings` | redirect -> `settings/profile` | |
| `settings/:section` | `SettingsPage` settings/settings-page.ts | `section`: profile, appearance, workspace, members, teams, agents, tokens, integrations, danger |
| `**` | `NotFoundPage` (renders inside the shell) | |

The files above currently hold PLACEHOLDERS (title + params). Replace the body, keep the class name and file path (routes lazy-import them) and the inputs.

- `withComponentInputBinding()` is on and `paramsInheritanceStrategy: 'always'`: **any page can declare `readonly workspaceSlug = input<string>()`** plus its own params and query params (`readonly tab = input<string>()`).
- **Workstream detail tabs use the `tab` query param**, not child routes: `?tab=` one of `overview` (default, param absent), `executions`, `artifacts`, `decisions`, `graph`, `activity`, `context`. Change tab with `router.navigate([], { queryParams: { tab }, queryParamsHandling: 'merge' })`.
- Link helper: `['/', workspaceSlug, 'workstreams', ws.key]`. There is no global "current slug" other than `nabla.slug()` / `session.workspace()?.slug`.
- Guards re-run when `:workspaceSlug` changes, so switching workspace reloads the snapshot.
- Not a member / unknown workspace: guard redirects to `/404?workspace=<slug>` (server unreachable: `/404?error=1`).

---

## 2. ApiClient (`core/api`)

`inject(ApiClient)`. Promise-based; base URL `/api` (`API_BASE_URL`, proxied to the Nest server). Features should normally use `NablaStore` mutations; use ApiClient directly for endpoints that are not part of the snapshot (search, graph, agent context, attention for `scope=all`, events with filters, comments of a subject).

Cross-cutting behavior (HttpInterceptor `apiInterceptor`, registered in app.config.ts): `withCredentials: true` (cookie `nabla_session`); every non-GET/HEAD gets `X-Client-Id: <per-tab id>` (so SSE echoes can be ignored).

Errors: every call rejects with `ApiError { status, message, code?, details?, isUnauthorized/isForbidden/isNotFound/isConflict/isValidation/isNetwork }` (`status 0` = unreachable).
- 401 on a non-`/auth/` call: `api.sessionExpired` emits; SessionStore clears the session and redirects to `/login?next=<url>` (toast "Your session expired").
- 403: toast "You don't have permission" (pass `{ quiet: true }` to the few methods that take `RequestOptions` to suppress; core stores never double-toast it) and the ApiError is still thrown.

Surface (`slug` = workspace slug; `idOrKey` = id or key like `AUTH-42`; everything returns the contract types):

```ts
api.health()
api.auth.login({email,password}) -> User          api.auth.signup({name,email,password}) -> User
api.auth.logout()                                  api.auth.me() -> { user, workspaces? }
api.workspaces.list() | create({name,slug?}) | get(slug) | update(slug,{name?,slug?}) | remove(slug) | snapshot(slug)
api.members.list|add(slug,{email,role})|update(slug,membershipId,{role})|remove(slug,membershipId)
api.agents.list|create(slug,{name,provider,description?,ownerUserId?})|update|remove
api.tokens.list|create(slug,{name,agentId?,expiresAt?}) -> { token, secret }|remove
api.teams.list|get|create({name,key,color?,description?,memberIds?})|update(id,{name?,color?,description?,memberIds?})|remove   // key is immutable
api.repositories.list|get|create({provider,fullName,url?,defaultBranch?,teamIds?})|update(id,{url?,defaultBranch?,teamIds?})|remove
api.workstreams.list|get(slug,idOrKey)|create|update|remove
api.workstreams.addCriterion(slug,idOrKey,{text,state?}) | updateCriterion(slug,idOrKey,criterionId,{text?,state?}) | removeCriterion(...)   // return the updated Workstream
api.workstreams.contextMarkdown(slug,idOrKey) -> string     api.workstreams.contextJson(slug,idOrKey)
api.workstreams.graph(slug,idOrKey) -> GraphResponse
api.executions.list|get|create|update|remove|progress(slug,id,{note,state?})|complete(slug,id,note?)
api.inputRequests.list|create|answer(slug,id,answer)|dismiss(slug,id)
api.issues.list|get|create|update|remove|link(slug,idOrKey,{workstreamIds?,createWorkstream?,status?})
api.artifacts.list|create|update|remove          api.decisions.list|get|create|update|remove|accept(slug,id)|reject(slug,id)|supersede(slug,id,byId)
api.dependencies.list|create({fromType,fromId,toType,toId})|remove
api.comments.list(slug,{type,id}?)|create({subject,body})|update(slug,id,body)|remove
api.events.list(slug,{workstreamId?,subject?,before?,limit?}) -> DomainEvent[]
api.attention.list(slug,{scope?:'mine'|'all'}) | dismiss(slug,attentionId) | snooze(slug,attentionId,untilIso)
api.views.list|create|update|remove      api.graph(slug) -> GraphResponse      api.search(slug,q) -> SearchResults
api.integrations.list|create({provider,account?,baseUrl?,token?,webhookSecret?})|remove|sync(slug,id)
api.request(method, path, {body?,params?,text?,accept?})   // escape hatch (path relative to /api)
```
Request DTO types (`CreateWorkstreamInput`, `UpdateExecutionInput`, ...) live in `api/api.types.ts`; in `Update*` inputs `null` clears an optional field, `undefined` is ignored.

---

## 3. SessionStore (`core/session`)

`inject(SessionStore)` (providedIn root).

```ts
user: Signal<User | null>              workspaces: Signal<Workspace[]>        // mine
workspace: Signal<Workspace | null>    // active one (set once its snapshot loaded)
role: Signal<Role | null>              // my role in the active workspace
isAuthenticated: Signal<boolean>       ready: Signal<boolean>                 // /auth/me check done
init(): Promise<void>                                  // idempotent; guards call it
login(email, password): Promise<void>                  // rejects with ApiError -> show .message in the form
signup(name, email, password): Promise<void>           // rejects with ApiError
logout(): Promise<void>                                // clears everything, navigates /login
switchWorkspace(slug): Promise<void>                   // navigates to /<slug>/overview
createWorkspace(name, slug): Promise<Workspace>        // rejects with ApiError; navigates to the new workspace
can(minRole: Role): boolean                            // role rank: viewer < member < admin < owner
```
Extras: `goAfterAuth(next?)` (after login/signup: navigate to `next` if it is a same-origin path, else the default workspace), `defaultWorkspaceUrl()`, `enterWorkspace(slug)` (used by workspaceGuard), `updateWorkspace({name?,slug?})`, `deleteWorkspace()` (owner).

Guards (`core/session/guards.ts`): `authGuard` (-> `/login?next=`), `guestGuard`, `rootRedirectGuard`, `workspaceGuard`, `roleGuard(minRole)` (use on a route to hide an admin screen; redirects to overview).

In templates, hide admin-only controls with `nabla.can('admin')` (works in `computed`/templates; viewers are read-only; the server enforces anyway and a 403 toasts).

---

## 4. NablaStore (`core/stores/nabla.store.ts`)

`inject(NablaStore)`. Holds the current workspace's `WorkspaceSnapshot` in signals. Everything is readonly outside the store.

**Lifecycle**: `workspaceGuard` loads it, so inside `/:workspaceSlug/**` the store is always `ready`. `status: 'idle'|'loading'|'ready'|'error'`, `ready`, `loadError`, `slug` (active slug), `load(slug): Promise<'ok'|'not-found'|'error'>`, `reset()`, `refetch()`, `scheduleRefetch(ms?)`.

**Meta signals**: `workspace`, `me` (User), `myRole`.

**Collections** (`Signal<readonly T[]>`, server order): `users`, `memberships`, `agents`, `teams`, `repositories`, `workstreams`, `executions`, `inputRequests`, `issues`, `artifacts`, `decisions`, `dependencies`, `comments`, `events` (newest first), `attention` (all states), `views`, `integrations`, plus `tokens` (empty until `loadTokens()`).

**Lookup computeds** (Maps; use `.get(...)` after calling the signal: `store.teamById().get(id)`):
- by id: `userById`, `agentById`, `teamById`, `repositoryById`, `workstreamById`, `executionById`, `inputRequestById`, `issueById`, `artifactById`, `decisionById`, `viewById`, `integrationById`
- by key (UPPER-CASE keys): `workstreamByKey` (AUTH-42), `issueByKey` (BUG-142), `decisionByKey` (ADR-7), `teamByKey` (AUTH); `membershipByUserId`
- grouped: `executionsByWorkstream`, `childExecutions` (by parent execution id), `executionTrees` (workstreamId -> `ExecutionNode[]` = `{execution, children}` roots with subthreads), `inputRequestsByWorkstream`, `inputRequestsByExecution`, `artifactsByWorkstream`, `artifactsByExecution`, `artifactsByRepository`, `decisionsByWorkstream` (origin or related), `issuesByWorkstream`, `issuesByTeam`, `workstreamsByOwnerTeam`, `workstreamsByParticipatingTeam`, `workstreamsByRepository`, `incomingDependencies` (node id -> deps pointing at it, i.e. what blocks it), `outgoingDependencies` (node id -> deps leaving it), `commentsBySubject` (key `"<type>:<id>"`, oldest first), `eventsByWorkstream`, `eventsBySubject` (key `"<type>:<id>"`, newest first)
- lists: `members` (`{membership,user}[]`), `openInputRequests`, `myTeams`, `myTeamIds`, `myWorkstreams` (I am accountable), `actors` (`ResolvedActor[]`: all users+agents+teams, for pickers)
- attention: `openAttention` (state open, severity then newest), `snoozedAttention`, `attentionByKind` (Map<AttentionKind, AttentionItem[]>), `attentionCounts` (`Record<AttentionKind, number>`, zeros included), `attentionCount` (total open; sidebar badge), `highAttentionCount`, `backlogIssues`, `backlogIssueCount`

**Point lookups / helpers (methods)**:
```ts
getWorkstream(idOrKey) getExecution(id) getIssue(idOrKey) getDecision(idOrKey) getTeam(idOrKey) getRepository(id) getUser(id) getArtifact(id) getView(id)
commentsFor(subject: SubjectRef): readonly Comment[]
resolveActor(ref?: ActorRef): ResolvedActor   // { type, id?, name, hue? (user), color?/key? (team), provider? (agent), known }
actorName(ref?: ActorRef): string             // 'Nabla' for system / missing
userRef(id): ActorRef
can(minRole: Role): boolean                   // same as session.can, available without SessionStore
loadOlderEvents(query?: {workstreamId?, subject?, limit?}): Promise<number>   // activity "load more"
```

### Mutation semantics (read this)
- **Never reject.** On failure the store rolls back, shows a toast ("Could not <action>: <message>") and resolves `undefined` (creates) / `false` (others). Do not wrap in try/catch; check the result when you need to (e.g. navigate to the created entity).
- **Updates / deletes / dismissals are optimistic** (applied locally at once, entity-level rollback on error). **Creates wait for the server** (ids, keys like `AUTH-42`, numbers and derived status are server-assigned) and resolve the created entity, so `await store.createWorkstream(...)` then navigate to `ws.key`.
- Writes run through one serial queue (call order = server order).
- After writes settle the snapshot is re-fetched (debounced 400 ms) because the server derives workstream status and attention; unchanged entities keep object identity (cheap for OnPush / `@for track`). Do not poll or refetch yourself.
- Methods taking `ref` accept an id OR a key.

```ts
// workstreams
createWorkstream(input: CreateWorkstreamInput): Promise<Workstream | undefined>
updateWorkstream(ref: string, patch: UpdateWorkstreamInput): Promise<boolean>
deleteWorkstream(ref: string): Promise<boolean>
addCriterion(ref: string, input: {text; state?}): Promise<AcceptanceCriterion | undefined>
updateCriterion(ref: string, criterionId: ID, patch: {text?; state?}): Promise<boolean>
removeCriterion(ref: string, criterionId: ID): Promise<boolean>
// executions & input requests
createExecution(input: CreateExecutionInput): Promise<Execution | undefined>
updateExecution(id: ID, patch: UpdateExecutionInput): Promise<boolean>
deleteExecution(id: ID): Promise<boolean>
reportProgress(id: ID, input: { note: string; state?: ExecutionState }): Promise<boolean>
completeExecution(id: ID, note?: string): Promise<boolean>
createInputRequest(input: CreateInputRequestInput): Promise<InputRequest | undefined>
answerInput(id: ID, answer: string): Promise<boolean>        // also clears its attention item
dismissInput(id: ID): Promise<boolean>
// issues
createIssue(input: CreateIssueInput): Promise<Issue | undefined>
updateIssue(id: ID, patch: UpdateIssueInput): Promise<boolean>
deleteIssue(id: ID): Promise<boolean>
linkIssue(id: ID, input: LinkIssueInput): Promise<Issue | undefined>   // {workstreamIds?, createWorkstream?, status?}
// artifacts, decisions, dependencies
attachArtifact(input: CreateArtifactInput): Promise<Artifact | undefined>
updateArtifact(id: ID, patch: UpdateArtifactInput): Promise<boolean>
removeArtifact(id: ID): Promise<boolean>
proposeDecision(input: CreateDecisionInput): Promise<Decision | undefined>      // status 'proposed' (default) or 'accepted'
updateDecision(id: ID, patch: UpdateDecisionInput): Promise<boolean>
acceptDecision(id: ID): Promise<boolean>
rejectDecision(id: ID): Promise<boolean>
supersedeDecision(id: ID, byId: ID): Promise<boolean>
deleteDecision(id: ID): Promise<boolean>
addDependency(input: {fromType,fromId,toType,toId}): Promise<Dependency | undefined>   // from blocks to; cycles -> 409 toast
removeDependency(id: ID): Promise<boolean>
// comments
addComment(subject: SubjectRef, body: string): Promise<Comment | undefined>
editComment(id: ID, body: string): Promise<boolean>
deleteComment(id: ID): Promise<boolean>
// attention (ids are AttentionItem.id, e.g. "input_requested:ir_1")
dismissAttention(id: string): Promise<boolean>
snoozeAttention(id: string, untilIso: string): Promise<boolean>
// views
createView(input: CreateViewInput): Promise<SavedView | undefined>
updateView(id: ID, patch: UpdateViewInput): Promise<boolean>
deleteView(id: ID): Promise<boolean>
// admin (member+ for domain data; admin for these)
createTeam / updateTeam(id, patch) / deleteTeam(id)
createRepository / updateRepository(id, patch) / deleteRepository(id)
addMember({email, role}) / updateMemberRole(membershipId, role) / removeMember(membershipId)
createAgent({name, provider, description?, ownerUserId?}) / updateAgent(id, patch) / deleteAgent(id)
loadTokens(): Promise<void>   createToken({name, agentId?, expiresAt?}): Promise<{token, secret} | undefined>   deleteToken(id)   // secret is shown once
createIntegration({provider, account?, baseUrl?, token?, webhookSecret?}) / deleteIntegration(id) / syncIntegration(id)
```
Workspace-level admin (rename, delete) is on SessionStore (`updateWorkspace`, `deleteWorkspace`).

Status chip: `inject(SyncStatus)`: `live` (`'idle'|'connecting'|'open'|'reconnecting'`), `lastSyncedAt`, `lastError`, `pendingWrites`, `label` (computed short text).

---

## 5. LiveSync (`core/sync`)

`SSE GET /api/w/:slug/events/stream` (cookie auth). Created by an app initializer (app.config.ts), it connects automatically whenever `NablaStore` has a ready workspace and disconnects on workspace switch / logout. Events carrying this tab's `X-Client-Id` are ignored; any other event triggers a debounced (300 ms) snapshot refetch. Reconnect with exponential backoff (1 s .. 30 s + jitter), refetch after reconnect, refetch when the tab becomes visible / the browser goes online. Connection state: `inject(SyncStatus).live` (or `LiveSync.state`); `LiveSync.retryNow()` forces a reconnect.

---

## 6. Query utilities (`core/query`)

Pure functions, drive list/board screens and saved views from `ViewFilter` / `SavedView` (contract). Entities: `'workstream' | 'issue' | 'execution' | 'decision'`.

```ts
FIELD_DEFS: Record<ViewEntity, FieldDef[]>    // { field, label, kind: 'enum'|'id'|'multi-id'|'tags'|'text'|'date', values?, refersTo?, sortable, groupable }
fieldDef(entity, field) | fieldValues(entity, item, field, ctx?) -> string[]

applyFilters(entity, items, filters?, ctx?)    // AND of all filters
matchesFilter(entity, item, filter, ctx?)      // ops: is, is_not, in, not_in, contains, before, after; value '' means "no value"
matchesSearch(item, text)
sortItems(entity, items, { field, direction }?, ctx?)       // stable; enum fields sort by display order; empty values last
groupItems(entity, items, groupBy?, ctx?, include?)         // Group<T>[] = { key, items }; key '' = none (last); `include` forces empty columns
queryItems(entity, items, { filters?, sort?, groupBy?, search? }, ctx?)    // filter -> search -> sort
queryGroups(entity, items, spec, ctx?, include?)            // + group (what a list/board renders)
specFromView(view) -> QuerySpec
setFilter(filters, field, op, value | null) | toggleFilterValue(filters, field, value) | filterValues(filters, field)   // filter-bar helpers
enumOrder(entity, field, value)
```
Filterable fields — workstream: `status`, `ownerTeamId`, `participatingTeamIds`, `teamId` (owner OR participating), `accountableUserId`, `priority`, `labels`, `repositoryIds`, `targetDate`, `title`, `createdAt`, `updatedAt`. issue: `kind`, `status`, `assigneeId`, `teamId`, `priority`, `source`, `title`, dates. execution: `state`, `provider`, `performers` (matches performer ids of any type), `teamId`, `workstreamId`, `repositoryIds`, `title`, dates. decision: `status`, `tags`, `originWorkstreamId`, `title`, `decidedAt`, dates. `ctx.workstreamById` is only needed for execution `ownerTeamId`.

```ts
readonly rows = computed(() => queryGroups('workstream', this.store.workstreams(), { filters, sort, groupBy: 'status', search }, {}, WORKSTREAM_STATUS_FLOW));
```
Enum display metadata (`meta.ts`): `WORKSTREAM_STATUS_META`, `WORKSTREAM_STATUS_FLOW` (board column order), `EXECUTION_STATE_META`, `PRIORITY_META`, `PROVIDER_META`, `ISSUE_KIND_META`, `ISSUE_STATUS_META`, `ARTIFACT_KIND_META`, `DECISION_STATUS_META`, `CRITERION_STATE_META`, `ATTENTION_KIND_META` (label, groupTitle, order), `ROLE_META`; each `{ label, tone, order }` where `tone` is `neutral|muted|info|accent|success|warning|danger`; ordered key arrays `WORKSTREAM_STATUSES`, `EXECUTION_STATES`, `PRIORITIES`, `PROVIDERS`, `ISSUE_KINDS`, `ISSUE_STATUSES`, `ARTIFACT_KINDS`, `DECISION_STATUSES`, `ATTENTION_KINDS`, `ROLES`. `statusVar('needs_input')` -> `var(--status-needs-input)` (the conventional CSS token; check `src/styles` for the real names).

---

## 7. UiStore (`core/stores/ui.store.ts`)

```ts
sidebarCollapsed (persisted) mobileSidebarOpen modal: 'command'|'search'|'shortcuts'|'create'|'confirm-delete'|null
openModal(m) closeModal() openCommandPalette() toggleCommandPalette() commandPaletteOpen
openCreate(kind: CreateKind, defaults?: Record<string, unknown>)   // kind: workstream|execution|issue|decision|artifact|view|team|repository|input-request
createKind createDefaults                                          // read by the global create dialog
setConfirmDelete({title, description, confirmLabel?, onConfirm}) / confirmDelete
toggleSidebar() setSidebarCollapsed(b) setMobileSidebar(b)
pendingG                                                           // "g" pressed, waiting for the second key
focusedRowId selectedRowIds hasSelection selectedSet setFocusedRow(id) toggleSelected(id, range?) setSelected(ids) clearSelected()
```
Create defaults used by the dialogs: `{ workstreamId, parentExecutionId, ownerTeamId, repositoryIds, kind (issue kind), ... }`; the keyboard service fills them from the current route (see below).

## 8. Keyboard (`core/keyboard`)

`AppShell` must `inject(KeyboardShortcuts)` once (its constructor installs the document listener).

Global bindings (single keys are ignored while typing in an input/textarea/contenteditable or inside an open overlay):

| keys | action |
|---|---|
| `⌘K` / Ctrl+K | command palette (works while typing) |
| `⌘B` | toggle sidebar (mobile: sheet) |
| `⌘J` | toggle theme (`ThemeService.toggle()` from `core/theme`) |
| `/` | search dialog (`ui.openModal('search')`) |
| `?` | shortcuts dialog (`ui.openModal('shortcuts')`) |
| `C` | create, context-aware: attention/issues -> issue; workstreams -> workstream; workstream detail -> execution (prefilled `workstreamId`); execution detail -> sub-execution (`workstreamId`, `parentExecutionId`); decisions -> decision; views -> view; teams list -> team; team detail -> workstream (`ownerTeamId`); projects -> project (`kind: 'repository'`) / workstream (`repositoryIds`); otherwise workstream. Opens `ui.openCreate(kind, defaults)`. |
| `G` then `O` `A` `I` `W` `D` `P` `X` `S` (+ `T` teams, `V` views) | go to overview / attention / issues / workstreams / decisions / projects / graph / settings / teams / views of the active workspace (`GO_TO_ROUTES`) |
| `Esc` | page shortcut first, then: close modal -> close mobile sidebar -> clear selection -> on `/:slug/{workstreams,issues,decisions,projects,teams,views}/:x` go back to the list |
| `j` `k` / `↓` `↑` | move `ui.focusedRowId` through DOM elements carrying `data-row-id="<id>"` |
| `Enter` | click the focused row (or its first `a[href]`) |
| `Space` / `x` | toggle selection of the focused row (`ui.selectedRowIds`) |

**Page-level shortcuts** (a page adds its own; they are removed when the component is destroyed):
```ts
import { usePageShortcuts } from '../../core';
// in a component (injection context, e.g. field initializer):
private readonly _keys = usePageShortcuts([
  { keys: 'e', label: 'Edit title', run: () => this.editing.set(true), when: () => !!this.ws() },
  { keys: 'mod+enter', label: 'Save', run: () => this.save(), allowWhileTyping: true },
  { keys: 'shift+a', label: 'Add criterion', run: () => this.addCriterion() },
]);
```
`keys`: optional `mod`/`shift`/`alt` joined by `+`, then one key: a character or `enter esc space up down left right delete backspace tab`. Page shortcuts override `C`, `/` and list navigation (but not `⌘K/B/J`, `?`, G-chords). They do not fire while typing unless the combo uses `mod` or `allowWhileTyping: true`. Registered shortcuts are listed in `KeyboardShortcuts.pageShortcuts()` (the shortcuts dialog can show a "This page" group); the static catalogue is `SHORTCUT_GROUPS`.

## 9. Notifier

`inject(Notifier)`: `success|error|info(title, {description?, duration?})`. Defaults to `console`; the app installs the real toast with `notifier.use((kind, title, opts) => toast...)` (one-time wiring in the UI foundation; until then core errors only reach the console). Feature code may use the UI toast directly.

## 10. Rules of the road

- Read data from `NablaStore` signals/computeds; never copy entities into component state. Use `computed()` over lookups.
- Mutate only through `NablaStore` (or `ApiClient` for non-snapshot endpoints, then `store.scheduleRefetch(0)`).
- Do not catch mutation errors; they never throw. Do catch `ApiError` from SessionStore auth methods and direct `ApiClient` calls.
- Do not create new entity types or edit `contracts/`; ask the orchestrator.
- Optional fields are omitted (never null) in entities; compare with `=== undefined`.
- Viewer role: hide mutating controls with `nabla.can('member')`.
