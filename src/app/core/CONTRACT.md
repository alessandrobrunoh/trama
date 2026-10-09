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
  session/                 SessionStore, authGuard, guestGuard, workspaceGuard, landingGuard, roleGuard
  stores/nabla.store.ts    NablaStore  (workspace data + mutations)
  stores/ui.store.ts       UiStore     (modals, sidebar, list focus/selection)
  sync/                    LiveSync (SSE), SyncStatus, reconcile, CLIENT_ID
  query/                   filter / sort / group utilities driven by ViewFilter
  keyboard/                KeyboardShortcuts, usePageShortcuts, SHORTCUT_GROUPS, GO_TO_ROUTES
  notify/notifier.ts       Notifier (toast sink; core never imports a UI library)
```

---

## 1. Routes (`src/app/app.routes.ts`)

Top level (reserved, cannot be workspace slugs): `login`, `register`, `signup` (redirects to `/register`), `invite`, `blog`, `roadmap`, `changelog`, `brand`, `new-workspace`, `404`.

| path | page class (file) | guards |
|---|---|---|
| `/login` | `LoginPage` (features/auth/login-page.ts) | guestGuard |
| `/register` | `SignupPage` (features/auth/signup-page.ts) | guestGuard |
| `/invite/:token` | `InvitePage` (features/auth/invite-page.ts); public, `?next=`/`?email=` flow through login and register | - |
| `/blog`, `/blog/:slug` | `BlogIndexPage`, `BlogPostPage` (features/blog/), posts in blog-posts.ts | - |
| `/roadmap`, `/changelog` | `RoadmapPage`, `ChangelogPage` (features/roadmap/, features/changelog/) | - |
| `/brand` | `BrandPage` (features/brand/), logo copy/download via `BrandAssets` | - |
| `/new-workspace` | `NewWorkspacePage` (features/auth/new-workspace-page.ts) | authGuard |
| `/404` | `NotFoundPage` (features/not-found/not-found-page.ts), inputs `workspace`, `error` | - |
| `/` | `LandingPage` (features/landing/landing-page.ts) when signed out; signed in → last-used or first workspace `/<slug>/overview`, `/new-workspace` if none | landingGuard |
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
| `repositories` | `RepositoryListPage` repositories/repository-list-page.ts | Git repositories. |
| `repositories/:id` | `RepositoryDetailPage` repositories/repository-detail-page.ts | `id`. |
| `teams` | `TeamListPage` teams/team-list-page.ts | |
| `teams/:key` | `TeamDetailPage` teams/team-detail-page.ts | `key` (team key AUTH or id) |
| `views` | `ViewListPage` views/view-list-page.ts | |
| `views/:id` | `ViewDetailPage` views/view-detail-page.ts | `id`. Layouts `list`, `board`, `timeline` (workstream and project views; draws `TimelineView`, features/timeline/timeline-view.ts) |
| `timeline` | redirect -> `views` (the timeline used to be a page; it is a view layout now) | |
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
- 401 other than `POST /auth/login`, `POST /auth/signup` or `POST /auth/logout`: `api.sessionExpired` emits; SessionStore clears the session and redirects to `/login?next=<url>` (toast "Your session expired"). A 401 from `GET /auth/me` is a dead session too. Wrong-password and logout 401s do not.
- 403: toast "You don't have permission" (pass `{ quiet: true }` to the few methods that take `RequestOptions` to suppress; core stores never double-toast it) and the ApiError is still thrown.

Surface (`slug` = workspace slug; `idOrKey` = id or key like `AUTH-42`; everything returns the contract types):

```ts
api.health()
api.auth.login({email,password}) -> User          api.auth.signup({name,email,password}) -> User
api.auth.logout()                                  api.auth.me() -> { user, workspaces? }
api.workspaces.list() | create({name,slug?}) | get(slug) | update(slug,{name?,slug?}) | remove(slug) | snapshot(slug, comments?: 'full'|'index')
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
api.milestones.list(slug,workstreamId?)|create({workstreamId,name,description?,targetDate?,sortOrder?})|update(id,{name?,description?,targetDate?,sortOrder?})|reorder(slug,workstreamId,ids)|remove(id)
api.projects.list|get|create|update(…,{…,icon?: string|null})|remove      // icon = lucide kebab name or one emoji
api.projects.updates.list(slug,projectId) | get(slug,projectId,id) | create(slug,projectId,{health,body,aiDrafted?}) | update(slug,projectId,id,{health?,body?}) | remove(slug,projectId,id)   // ProjectUpdate, newest first
api.projects.context(slug,projectId) -> ProjectContext     api.projects.contextMarkdown(slug,projectId) -> string (text/markdown)
api.projects.ai(slug,projectId,kind: 'update_draft'|'summary'|'issues'|'risks') -> ProjectAiResult   // discriminated by .kind
api.projects.artifacts.list(slug,projectId) | create(slug,projectId,CreateOwnedArtifactInput)         // artifacts attached to the project itself
api.issues.artifacts.list(slug,idOrKey) | create(slug,idOrKey,CreateOwnedArtifactInput)              // artifacts attached to an issue
api.artifacts.list|create({workstreamId,…})|update|remove          api.decisions.list|get|create|update|remove|accept(slug,id)|reject(slug,id)|supersede(slug,id,byId)
api.dependencies.list|create({fromType,fromId,toType,toId})|remove
api.comments.list(slug,{type,id}?)|page(slug,{type,id},{cursor?,limit?}) -> CommentPage {items newest first,nextCursor}|create({subject,body})|update(slug,id,body)|remove
api.events.list(slug,{workstreamId?,subject?,before?,limit?}) -> DomainEvent[]
api.attention.list(slug,{scope?:'mine'|'all'}) | dismiss(slug,attentionId) | snooze(slug,attentionId,untilIso)
api.views.list|create|update|remove      api.graph(slug) -> GraphResponse      api.search(slug,q) -> SearchResults
api.integrations.list|create({provider,account?,baseUrl?,token?,webhookSecret?})|remove|sync(slug,id)
api.request(method, path, {body?,params?,text?,accept?})   // escape hatch (path relative to /api)
```
Artifact creation inputs: `CreateArtifactInput` (workstream, `POST /artifacts`) and `CreateOwnedArtifactInput` (= `CreateArtifactFields`: `kind`, `title`, `provider?`, `url?`, `externalId?`, `description?`, `state?`, `repositoryId?`, ci/review/…; the owner is in the path). Request DTO types (`CreateWorkstreamInput`, `UpdateExecutionInput`, ...) live in `api/api.types.ts`; in `Update*` inputs `null` clears an optional field, `undefined` is ignored.

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

Guards (`core/session/guards.ts`): `authGuard` (-> `/login?next=`), `guestGuard`, `landingGuard`, `workspaceGuard`, `roleGuard(minRole)` (use on a route to hide an admin screen; redirects to overview).

In templates, hide admin-only controls with `nabla.can('admin')` (works in `computed`/templates; viewers are read-only; the server enforces anyway and a 403 toasts).

---

## 4. NablaStore (`core/stores/nabla.store.ts`)

`inject(NablaStore)`. Holds the current workspace's `WorkspaceSnapshot` in signals. Everything is readonly outside the store.

**Lifecycle**: `workspaceGuard` loads it, so inside `/:workspaceSlug/**` the store is always `ready`. `status: 'idle'|'loading'|'ready'|'error'`, `ready`, `loadError`, `slug` (active slug), `load(slug): Promise<'ok'|'not-found'|'error'>`, `reset()`, `refetch()`, `scheduleRefetch(ms?)`.

**Meta signals**: `workspace`, `me` (User), `myRole`.

**Collections** (`Signal<readonly T[]>`, server order): `users`, `memberships`, `agents`, `teams`, `repositories`, `projects`, `workstreams`, `milestones` (by workstream then `sortOrder`), `executions`, `inputRequests`, `issues`, `artifacts`, `decisions`, `dependencies`, `comments` (only the threads loaded so far), `events` (newest first), `attention` (all states), `views`, `integrations`, plus `tokens` (empty until `loadTokens()`).

**Lookup computeds** (Maps; use `.get(...)` after calling the signal: `store.teamById().get(id)`):
- by id: `userById`, `agentById`, `teamById`, `repositoryById`, `workstreamById`, `executionById`, `inputRequestById`, `issueById`, `artifactById`, `decisionById`, `viewById`, `integrationById`
- by key (UPPER-CASE keys): `workstreamByKey` (AUTH-42), `issueByKey` (BUG-142), `decisionByKey` (ADR-7), `teamByKey` (AUTH); `membershipByUserId`
- grouped: `executionsByWorkstream`, `childExecutions` (by parent execution id), `executionTrees` (workstreamId -> `ExecutionNode[]` = `{execution, children}` roots with subthreads), `inputRequestsByWorkstream`, `inputRequestsByExecution`, `artifactsByWorkstream`, `artifactsByExecution`, `artifactsByRepository`, `artifactsByProject`, `artifactsByIssue` (artifacts attached **directly** to that owner; `Artifact.workstreamId` is optional: an artifact belongs to a project, a workstream and/or an issue), `decisionsByWorkstream` (origin or related), `issuesByWorkstream`, `issuesByMilestone`, `milestonesByWorkstream` (workstream id -> milestones by `sortOrder`), `issuesByTeam`, `workstreamsByOwnerTeam`, `workstreamsByParticipatingTeam`, `workstreamsByRepository`, `incomingDependencies` (node id -> deps pointing at it, i.e. what blocks it), `outgoingDependencies` (node id -> deps leaving it), `commentsBySubject` (key `"<type>:<id>"`, oldest first), `eventsByWorkstream`, `eventsBySubject` (key `"<type>:<id>"`, newest first)
- project tree (local, derived from the snapshot, works without `/context`): `projectArtifactTree` (`Map<projectId, ArtifactTreeNode>`; node = `{ subject: SubjectRef, artifacts: Artifact[], children: ArtifactTreeNode[] }`: project → workstreams of the project → their issues, plus issues planned under the project (`issue.projectId`) that are in none of its workstreams; `artifacts` = attached directly to the node) and `projectArtifacts` (`Map<projectId, ProjectContextArtifact[]>` = `{ artifact, path: SubjectRef[] }[]`, same shape as `ProjectContext.artifacts`, each artifact once, `path` = chain project → … → owner). `issuesByProject` includes issues with `issue.projectId` as well as those linked to a workstream of the project.
- lists: `members` (`{membership,user}[]`), `openInputRequests`, `myTeams`, `myTeamIds`, `myWorkstreams` (I am accountable), `actors` (`ResolvedActor[]`: all users+agents+teams, for pickers)
- attention: `openAttention` (state open, severity then newest), `snoozedAttention`, `attentionByKind` (Map<AttentionKind, AttentionItem[]>), `attentionCounts` (`Record<AttentionKind, number>`, zeros included), `attentionCount` (total open; sidebar badge), `highAttentionCount`, `backlogIssues`, `backlogIssueCount`

**Point lookups / helpers (methods)**:
```ts
getWorkstream(idOrKey) getExecution(id) getIssue(idOrKey) getDecision(idOrKey) getTeam(idOrKey) getRepository(id) getUser(id) getArtifact(id) getView(id)
commentsFor(subject: SubjectRef): readonly Comment[]      // loaded part of the thread, oldest first
commentCountFor(subject): number                          // from the snapshot's comment index, exact once fully loaded
commentAuthorsFor(subject): readonly ActorRef[]
loadComments(subject, {force?,quiet?}): Promise<void>     // newest page; call when a detail view opens (<app-comments-loader>)
loadMoreComments(subject): Promise<void>                  // next (older) page; commentThread(subject) -> {state,nextCursor,loadingMore}
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
updateIssue(id: ID, patch: UpdateIssueInput): Promise<boolean>   // patch: estimate (null clears), projectId (null clears; drops its milestone), milestoneIds, kind (waits for server: re-keys)
changeIssueKind(id: ID, kind: IssueKind): Promise<Issue | undefined>   // resolves the issue with its new key; old key stays in issue.aliases
// milestones
createMilestone(input: CreateMilestoneInput): Promise<Milestone | undefined>
updateMilestone(id: ID, patch: UpdateMilestoneInput): Promise<boolean>
deleteMilestone(id: ID): Promise<boolean>              // also strips it from issues.milestoneIds
reorderMilestones(workstreamId: ID, ids: readonly ID[]): Promise<boolean>
getMilestone(id): Milestone | undefined   // milestoneById map; getIssue(ref) also matches aliases
deleteIssue(id: ID): Promise<boolean>
linkIssue(id: ID, input: LinkIssueInput): Promise<Issue | undefined>   // {workstreamIds?, createWorkstream?, status?}
// artifacts, decisions, dependencies
attachArtifact(input: CreateArtifactInput): Promise<Artifact | undefined>                 // to a workstream (input.workstreamId)
attachProjectArtifact(projectId: ID, input: CreateOwnedArtifactInput): Promise<Artifact | undefined>   // to the project itself
attachIssueArtifact(issueRef: string, input: CreateOwnedArtifactInput): Promise<Artifact | undefined>    // to an issue (id or key)
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
// projects: createProject(input) / updateProject(id, patch: UpdateProjectInput incl. icon) / deleteProject(id)
// project updates (Updates feed; on demand, see "Project data" below)
loadProjectUpdates(projectId: ID, options?: { force?: boolean; quiet?: boolean }): Promise<void>
createProjectUpdate(projectId: ID, input: { health: ProjectHealth; body: string; aiDrafted?: boolean }): Promise<ProjectUpdate | undefined>   // waits for the server
updateProjectUpdate(projectId: ID, id: ID, patch: { health?; body? }): Promise<boolean>     // optimistic (sets editedAt)
deleteProjectUpdate(projectId: ID, id: ID): Promise<boolean>                                  // optimistic
// project context + AI (reads: never reject, toast on error, resolve undefined)
projectContext(projectId: ID, options?: { force?: boolean }): Promise<ProjectContext | undefined>
projectContextMarkdown(projectId: ID): Promise<string | undefined>
aiProject<K extends ProjectAiKind>(projectId: ID, kind: K): Promise<Extract<ProjectAiResult, { kind: K }> | undefined>
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
createIntegration({provider, token, baseUrl?}) → {connection, webhook?} / updateIntegration(id, {token?, baseUrl?}) / rotateWebhookSecret(id) / deleteIntegration(id) / loadIntegrationDetails() + integrationDetails() / remoteRepositories(id, page?) / linkRepository(id, {fullName, teamIds?}) / unlinkRepository(id, repositoryId)
```
### Project data (updates feed, context, AI)

Not part of the snapshot; loaded on demand, cached per project, exposed as **stable per-id signals** (the same `Signal` object is returned for an id, so it is safe inside `computed()` / templates):

```ts
type LoadState = 'idle' | 'loading' | 'ready' | 'error'
projectUpdates(projectId): Signal<readonly ProjectUpdate[]>        // newest first; [] until loaded
projectUpdatesState(projectId): Signal<LoadState>
projectContextOf(projectId): Signal<ProjectContext | undefined>    // cached /context (stale-while-revalidate)
projectContextState(projectId): Signal<LoadState>
```
Typical page: `effect(() => { void store.loadProjectUpdates(id()); })` (a no-op when already `ready`) and read `store.projectUpdates(id())()`; for the context call `store.projectContext(id)` (served from cache while fresh) and read `projectContextOf(id)()`.

- **Health stays consistent**: creating / editing / deleting an update re-derives `Project.health` and `Project.lastUpdateAt` locally (newest update wins; no updates → both cleared), then the snapshot refetch confirms. Rolled back if the write fails. Discussion on an update = comments with subject `{ type: 'project_update', id }` (`store.commentsFor(...)`, `addComment(...)`).
- **Freshness**: a live `project_update` event reloads every loaded feed; any live event on `project | project_update | workstream | issue | artifact | milestone | decision | input_request | dependency`, and every write from this tab, marks cached contexts stale and reloads them in the background (debounced, old value stays visible). `store.invalidateProjectContexts()` forces that. Deleting a project drops its caches.
- `projectContext(id)` (`ProjectContext` = project, milestones, updates, workstreams, issues, artifacts-with-path, decisions, input requests) is the server's authoritative tree; the local `projectArtifactTree` / `projectArtifacts` computeds give the same project → workstream → issue → artifact view from the snapshot alone.
- `aiProject(id, 'update_draft')` → `{ kind, health, body }` (feed it to `createProjectUpdate(id, { health, body, aiDrafted: true })`); `'summary'` → `{ summary, description }`; `'issues'` → `{ suggestions: { issueId, reason }[] }`; `'risks'` → `{ health, risks[] }`. Nothing is persisted by the call. Not queued with writes; the caller tracks its own busy flag.

Workspace-level admin (rename, delete) is on SessionStore (`updateWorkspace`, `deleteWorkspace`).

Status chip: `inject(SyncStatus)`: `live` (`'idle'|'connecting'|'open'|'reconnecting'`), `lastSyncedAt`, `lastError`, `pendingWrites`, `label` (computed short text).

---

## 5. LiveSync (`core/sync`)

`SSE GET /api/w/:slug/events/stream` (cookie auth). Created by an app initializer (app.config.ts), it connects automatically whenever `NablaStore` has a ready workspace and disconnects on workspace switch / logout. Events carrying this tab's `X-Client-Id` are ignored; any other event triggers a debounced (300 ms) snapshot refetch and is passed to `NablaStore.handleLiveEvent(event)`, which refreshes the on-demand project data and reloads the newest page of every opened comment thread on `comment` events (updates feeds and `/context` caches, see "Project data"); the snapshot's artifacts (including project / issue owned ones) refresh with the refetch. Reconnect with exponential backoff (1 s .. 30 s + jitter), refetch after reconnect, refetch when the tab becomes visible / the browser goes online. Connection state: `inject(SyncStatus).live` (or `LiveSync.state`); `LiveSync.retryNow()` forces a reconnect.

---

## 6. Query utilities (`core/query`)

Pure functions, drive list/board screens and saved views from `ViewFilter` / `SavedView` (contract). Entities (`ViewEntity`): `'workstream' | 'issue' | 'decision' | 'project'`.

```ts
FIELD_DEFS: Record<ViewEntity, FieldDef[]>    // { field, label, kind: 'enum'|'id'|'multi-id'|'tags'|'text'|'date', values?, refersTo?, sortable, groupable }
fieldDef(entity, field) | fieldValues(entity, item, field, ctx?) -> string[]

applyFilters(entity, items, filters?, ctx?)    // AND of all filters
matchesFilter(entity, item, filter, ctx?)      // ops: is, is_not, in, not_in, contains, before, after; value '' means "no value"
matchesSearch(item, text)                 // searches key/title/name/summary/objective/statement/body/description
sortItems(entity, items, { field, direction }?, ctx?)       // stable; enum fields sort by display order; empty values last
groupItems(entity, items, groupBy?, ctx?, include?)         // Group<T>[] = { key, items }; key '' = none (last); `include` forces empty columns
queryItems(entity, items, { filters?, sort?, groupBy?, search? }, ctx?)    // filter -> search -> sort
queryGroups(entity, items, spec, ctx?, include?)            // + group (what a list/board renders)
specFromView(view) -> QuerySpec
setFilter(filters, field, op, value | null) | toggleFilterValue(filters, field, value) | filterValues(filters, field)   // filter-bar helpers
enumOrder(entity, field, value)
```
Filterable fields — workstream: `status`, `ownerTeamId`, `participatingTeamIds`, `teamId` (owner OR participating), `accountableUserId`, `priority`, `labels`, `projectId`, `repositoryIds`, `startDate`, `targetDate`, `title`, `createdAt`, `updatedAt`. issue: `kind`, `status`, `assigneeId`, `teamId`, `priority`, `source`, `title`, dates. execution: `state`, `provider`, `performers` (matches performer ids of any type), `teamId`, `workstreamId`, `repositoryIds`, `title`, dates. issue also: `projectId` (id, groupable, refersTo project), `milestoneIds` (multi-id, refersTo milestone). project: `status`, `priority`, `health` (enums), `leadId` (user, groupable), `teamIds` (multi-id, groupable), `repositoryIds`, `targetDate`, `startDate`, `name`, `createdAt`, `updatedAt`. `FieldDef.refersTo` is `'team'|'user'|'repository'|'project'|'workstream'|'milestone'|'actor'`. decision: `status`, `tags`, `originWorkstreamId`, `title`, `decidedAt`, dates. `ctx.workstreamById` is needed for an issue's `projectId`: it matches the issue's own project and the projects of its workstreams (same meaning as `issuesByProject`; `issueProjectIds(issue, workstreamById)` returns them). Without it only `issue.projectId` is used.

```ts
readonly rows = computed(() => queryGroups('workstream', this.store.workstreams(), { filters, sort, groupBy: 'status', search }, {}, WORKSTREAM_STATUS_FLOW));
```
Enum display metadata (`meta.ts`): `WORKSTREAM_STATUS_META`, `WORKSTREAM_STATUS_FLOW` (board column order), `EXECUTION_STATE_META`, `PRIORITY_META`, `PROVIDER_META`, `ISSUE_KIND_META`, `ISSUE_STATUS_META`, `ARTIFACT_KIND_META`, `DECISION_STATUS_META`, `CRITERION_STATE_META`, `ATTENTION_KIND_META` (label, groupTitle, order), `ROLE_META`, `PROJECT_STATUS_META` (core; the projects feature keeps its own Tailwind-class variant in `features/projects/project-model.ts`), `PROJECT_HEALTH_META` (On track / At risk / Off track; tones success / warning / danger), `VIEW_LAYOUT_META` + `VIEW_LAYOUTS` (`list|board|graph|timeline`); `ARTIFACT_KIND_META` also has `link`; each `{ label, tone, order }` where `tone` is `neutral|muted|info|accent|success|warning|danger`; ordered key arrays `WORKSTREAM_STATUSES`, `EXECUTION_STATES`, `PRIORITIES`, `PROVIDERS`, `ISSUE_KINDS`, `ISSUE_STATUSES`, `ARTIFACT_KINDS`, `DECISION_STATUSES`, `ATTENTION_KINDS`, `ROLES`. `statusVar('needs_input')` -> `var(--status-needs-input)` (the conventional CSS token; check `src/styles` for the real names).

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
| `C` | create, context-aware: attention/issues -> issue; workstreams -> workstream; workstream detail -> execution (prefilled `workstreamId`); execution detail -> sub-execution (`workstreamId`, `parentExecutionId`); decisions -> decision; views -> view; teams list -> team; team detail -> workstream (`ownerTeamId`); repositories -> repository (`kind: 'repository'`) / workstream (`repositoryIds`); otherwise workstream. Opens `ui.openCreate(kind, defaults)`. |
| `G` then `O` `A` `I` `W` `D` `R` `X` `S` (+ `T` teams, `V` views) | go to overview / attention / issues / workstreams / decisions / repositories (`G` `R`) / graph / settings / teams / views of the active workspace (`GO_TO_ROUTES`) |
| `Esc` | page shortcut first, then: close modal -> close mobile sidebar -> clear selection -> on `/:slug/{workstreams,issues,decisions,repositories,teams,views}/:x` go back to the list |
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
