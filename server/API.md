# Trama API

REST + SSE backend (NestJS 12, TypeORM, Postgres 17). Everything lives under the `/api` prefix. Entity shapes are defined in
[`contracts/domain.ts`](../contracts/domain.ts) (synced to `src/contracts/domain.ts`); this file documents routes, auth and behaviour.
Architecture and extension points: [ARCHITECTURE.md](./ARCHITECTURE.md).

Dev server: `http://localhost:3000/api` (`PORT` to change). Demo login after first boot: **demo@nabla.dev / nabla-demo** (workspace slug `acme`).

## Conventions

- JSON in, JSON out. Optional fields are **omitted**, never `null`, in responses. In `PATCH` bodies `null` clears an optional field; unknown fields are dropped silently.
- Ids are opaque prefixed strings (`wk_…`, `ex_…`). Workstreams, issues, decisions and teams can also be addressed by **key** (`AUTH-42`, `BUG-142`, `ADR-21`, `AUTH`) wherever the route says `:idOrKey`.
- Dates are ISO-8601. Lists have no pagination except `events`.
- Errors: `{ "statusCode": 400, "message": "…" | ["field validation messages"], "error": "Bad Request" }`. 400 validation / unknown reference, 401 not authenticated, 403 role too low (or missing CSRF header), 404 not found **or not a member of that workspace**, 409 conflict (duplicate key, cycle, wrong state), 415 non-JSON body.
- Mutations return the updated entity (`204` for deletes). Actions (`/answer`, `/accept`, `/triage`, …) return the updated entity with `200`.

## Authentication

Two ways, accepted on every route except the public ones (`/health`, `/auth/signup`, `/auth/login`):

1. **Cookie session** (browser). `POST /auth/login` or `/auth/signup` set an httpOnly `nabla_session` cookie (`SameSite=Lax`, `Secure` in production, 30 days; stored in Postgres as a sha256). The SPA must send credentials (`withCredentials: true`) and, on every **mutating** request (POST/PUT/PATCH/DELETE), a custom header **`X-Client-Id`** (or `X-Requested-With`) — requests without it get `403`. Bodies must be `application/json` (`415` otherwise). CORS allows `http://localhost:4300` and `:4301` (and `CORS_ORIGIN`) with credentials.
2. **API token**: `Authorization: Bearer nbl_…`. Tokens belong to one workspace and act either as a **user** (same role as that user) or as an **agent** (role `member`). No CSRF header needed. Tokens are created via `POST /w/:slug/tokens`; the secret is returned once, only its sha256 and a display prefix are stored.

| Route | Body | Result |
|---|---|---|
| `POST /auth/signup` | `{ name, email, password (≥ 8) }` | `201 { user, workspaces: [] }` + cookie. `409` if the email exists. |
| `POST /auth/login` | `{ email, password }` | `200 { user, workspaces }` + cookie. `401` on bad credentials. |
| `POST /auth/logout` | – | `204`, clears the session. |
| `GET /auth/me` | – | `{ user, workspaces }`. `workspaces` = `Array<Workspace & { role }>`. Agent tokens get `403`. |
| `GET /health` | – | `{ status: 'ok', db: 'up' }` or `503`. |

### Custom tokens (resource × action permissions) and caps

`scope` is `read`, `write`, `admin` or `custom`. A `custom` token (also implied by sending `permissions`) carries an explicit list of
`<resource>:<action>` grants (catalog: `API_RESOURCES` in `contracts/domain.ts`; actions `read|write|delete`, plus `decisions:accept`). The
required permission is derived from the route: `/w/:slug/<resource>/…` and the method (GET → read, POST/PATCH → write, DELETE → delete;
`POST /decisions/:id/accept|reject|supersede` → `decisions:accept`; `/settings` and `/w/:slug` itself → `workspace`). `write`/`delete`/`accept`
imply `read` on the same resource. Routes outside the catalog (e.g. `/ai/*`, `/workspaces`, `/auth/me`) are denied (fail closed), except
`GET /auth/token`. The permission list only narrows: the acting user's role still applies, and a custom token can only mint custom tokens
that are a subset of its own permissions.

Every API token has caps (`limits`, defaults `requestsPerMinute` 600, `writesPerMinute` 60, `writesPerDay` 2000; configurable up to 6000 / 600 / 20000).
Per-minute counters are per API process; the daily write counter is stored in Postgres. Over a cap: `429` with a message naming the cap.

## Roles (RBAC)

`viewer` < `member` < `admin` < `owner`. Default: GET needs `viewer`, every write on domain entities needs `member`.
`admin` additionally: create/update/delete **teams, repositories, agents, integrations**, add/change/remove **members**, edit the workspace, see all tokens.
`owner` additionally: delete the workspace, grant/modify the `owner` role. A workspace always keeps at least one owner (`409`).
Agent tokens act as `member` (they cannot accept/reject decisions, own views, mint tokens or call `/snapshot` and `/auth/me`).
A caller who is not a member of `:slug` (or whose token belongs to another workspace) gets **404**.

## Workspaces, members, agents, tokens

| Route | Role | Notes |
|---|---|---|
| `GET /workspaces` | user | Mine, each `Workspace & { role }`. |
| `POST /workspaces` | user | `{ name, slug? }`. Creator becomes `owner`. Slug auto-derived from the name (unique; reserved: `login`, `signup`, `new-workspace`, `settings`, …). `409` if an explicit slug is taken. |
| `GET /w/:slug` | viewer | `Workspace & { role }` |
| `PATCH /w/:slug` | admin | `{ name?, slug? }` |
| `DELETE /w/:slug` | owner | `204`, cascades everything |
| `GET /w/:slug/members` | viewer | `Array<Membership & { user: User }>` |
| `POST /w/:slug/members` | admin | `{ email, role }`. The user must already exist (`404`), not already be a member (`409`). Only owners can grant `owner`. |
| `PATCH /w/:slug/members/:id` | admin | `{ role }` (`:id` = membership id). Last owner cannot be demoted (`409`). |
| `DELETE /w/:slug/members/:id` | admin (anyone may remove themselves) | Also removes the user from teams. Last owner → `409`. |
| `GET /w/:slug/invites` | `inviteMembers` | Pending invitations (`WorkspaceInvite[]`), expired ones included so they can be resent. |
| `POST /w/:slug/invites` | `inviteMembers` | `{ email, role }` → `{ invite, url, emailed }`. The person does not need an account yet. Same address again refreshes the invite (new link and expiry, the old link stops working). Already a member → `409`; a role above your own → `403`. `url` is the only time the secret link is returned (only its hash is stored). |
| `POST /w/:slug/invites/:id/resend` | `inviteMembers` | New link and expiry, emailed again. Same response as create. |
| `DELETE /w/:slug/invites/:id` | `inviteMembers` | Revoke. |
| `GET /w/:slug/favorites` | user (viewer and up; agent tokens → `403`) | The caller's own favorites (`Favorite[]`, oldest first). Favorites whose subject was deleted, or a view that is no longer visible to the caller, are dropped here. |
| `POST /w/:slug/favorites` | user | `{ type: issue\|workstream\|decision\|team\|repository\|view, subjectId }` (the entity's id, not its key). Idempotent. Unknown subject, or another person's private view → `404`; at most 100 per workspace (`409`). Viewers may keep favorites. |
| `DELETE /w/:slug/favorites/:type/:subjectId` | user | Idempotent (`204` even when it was not pinned). Favorites are private: nobody else sees them. |
| `GET /w/:slug/notifications` | user (agent tokens → `403`) | `?limit` (default 50, max 200) `&unread=true` → `{ items: Notification[], unread }`, newest first. `unread` counts the whole workspace, not just the page. |
| `POST /w/:slug/notifications/read` | user | `{ ids? }` → `{ unread }`. Without `ids`, marks everything in the workspace as read. |
| `GET /me/notification-settings`, `PATCH /me/notification-settings` | user | `{ settings: { <kind>: { inApp, email } }, emailAvailable }`. `PATCH { settings: { assigned: { inApp: false } } }` merges per kind and channel; unknown kinds or channels → `400`. Same in every workspace. |
| `GET /invites/:token` | public | `InvitePreview` (`workspaceName`, `role`, `email`, `invitedByName`, `expiresAt`). `404` when unknown, used, revoked or expired. |
| `POST /invites/:token/accept` | signed-in user | Joins the workspace; the account email must equal the invited one (`403` otherwise). → `{ workspace: { slug, name }, role }`. Single use; an existing member keeps their role. |

Invitation links are `APP_URL/invite/<token>` and last 7 days. Emails need `SMTP_URL`; without it `emailed` is `false` and the UI shows the link to share by hand. Not exposed to API tokens with custom permissions.
| `GET/POST /w/:slug/agents`, `GET/PATCH/DELETE /w/:slug/agents/:id` | read: viewer, write: admin | `{ name, provider, description?, ownerUserId? }`. Deleting an agent revokes its tokens. |
| `GET /w/:slug/tokens` | member | Admins see all tokens, others only their own. `ApiToken[]` (never contains the hash). |
| `POST /w/:slug/tokens` | member (user) | `{ name, scope?, permissions?, limits?, expiresAt?, agentId? }` → `201 { token: ApiToken, secret }`. Without `agentId` the token acts as you; with `agentId` (admin only) it acts as that agent. See *Custom tokens* below. |
| `GET /auth/token` | API token | `{ token, actor, workspace: { id, slug, name }, permissions }`: what the calling token is. Used by the MCP server. |
| `DELETE /w/:slug/tokens/:id` | own or admin | revoke |

## Workspace snapshot

`GET /w/:slug/snapshot` → `WorkspaceSnapshot` (workspace, me, myRole, users, memberships, agents, teams, repositories, workstreams, milestones, executions, inputRequests, issues, artifacts, decisions, dependencies, comments, last 500 `events`, `attention`, views, integrations). `views` = shared ones plus your private ones. Needs a user principal (not an agent token).

## Domain routes (all under `/w/:slug`)

`PATCH` is partial. List filters are query params. “member” = default write role.

### Teams — `/teams` (writes: admin)
`GET`, `GET /:idOrKey`, `POST { name, key (^[A-Z][A-Z0-9]{1,7}$), color?, description?, memberIds? }`, `PATCH /:idOrKey { name?, color?, description?, memberIds? }` (the key is immutable), `DELETE /:idOrKey` (`409` while it owns workstreams; detaches it from participating lists, issues and executions otherwise). `memberIds` must be workspace members.

### Repositories — `/repositories` (writes: admin)
`POST { provider: github|gitlab, fullName: "owner/name", url?, defaultBranch?, teamIds? }` (unique per provider+name), `PATCH { url?, defaultBranch?, teamIds? }`, `DELETE` (removes it from workstreams/executions).

### Workstreams — `/workstreams`
- `GET ?status&ownerTeamId&teamId(owner or participating)&accountableUserId&priority&repositoryId&label&q`
- `GET /:idOrKey`
- `POST { title, ownerTeamId, deltaThreadUrl?, description?, objective?, context?, participatingTeamIds?, accountableUserId?, repositoryIds?, acceptanceCriteria?: [{ text, state? }], priority?, labels?, statusOverride?: draft|planned|working|needs_input|in_review|blocked|ready_to_land|shipped|canceled, startDate?, targetDate? }`
  - `deltaThreadUrl`: an `https` URL on `delta.dev` (or a subdomain), the Delta thread that carries this workstream. Required, except for `statusOverride: draft` and for workspaces that turned **Delta threads** off (`PATCH /w/:slug/settings { deltaThreads: false }`, admin; on by default and recommended). A supplied URL is always validated; the briefing omits the section when there is none.
  - Key = `${ownerTeam.key}-${n}` with `n` from a per-owner-team counter (atomic, never reused).
  - Initial `status`/`derivedStatus`: `planned` if it has criteria, else `draft`.
- `PATCH /:idOrKey` any of the create fields, `statusOverride: null` clears the override. `deltaThreadUrl` can be replaced but not cleared. **Changing `ownerTeamId` keeps the key** (`AUTH-42` stays `AUTH-42`); numbering continues per team.
- `DELETE /:idOrKey` (cascades input requests, artifacts, milestones, dependencies, comments; unlinks issues/decisions and drops the deleted milestones from issues).
- Criteria (each returns the updated workstream): `POST /:idOrKey/criteria { text, state? }`, `PATCH /:idOrKey/criteria/:criterionId { text?, state? }`, `DELETE /:idOrKey/criteria/:criterionId`. States: `pending|in_progress|met`.
- `status` / `derivedStatus` / `shippedAt` are written by the status engine (see *Derived workstream status* below); `status = statusOverride ?? derivedStatus`.

### Milestones — `/milestones`
Linear-style milestones inside a workstream (flat resource, like artifacts). `Milestone { id: ms_…, workspaceId, workstreamId, name, description?, targetDate?, sortOrder, createdAt, updatedAt }`; also in the snapshot (`milestones`, ordered by `sortOrder`).
- `GET ?workstreamId` (ordered by workstream, `sortOrder`), `GET /:id`
- `POST { workstreamId, name, description?, targetDate?, sortOrder? }` → `sortOrder` defaults to last (max + 1).
- `PATCH /:id { name?, description?, targetDate?, sortOrder? }` (`null` clears `description` / `targetDate`).
- `POST /reorder { workstreamId, ids: [...] }` → re-numbers `sortOrder` to 0..n-1 following `ids` (milestones not listed follow, in their current order); `400` for ids that are not milestones of that workstream. Returns the ordered list.
- `DELETE /:id` (`204`; removes the id from `Issue.milestoneIds`, deletes its comments). Milestones are deleted with their workstream.
- Events: `milestone.created|updated|deleted` (subject `milestone`, `workstreamId` set; `data.name`, `data.fields`). Live (SSE) events use entity `milestone`.
- Issue rule: an issue is in at most one milestone per workstream and only in milestones of workstreams in its `workstreamIds` (`PATCH /issues/:idOrKey { milestoneIds }` → `400` otherwise). Removing a workstream from `workstreamIds` drops that workstream's milestone from the issue.

### Input requests — `/input-requests`
`GET ?state&workstreamId&assigneeUserId`, `GET /:id`, `POST { question, workstreamId, options?, assigneeUserId? }` (`requestedBy` = caller), `PATCH` (open only), `POST /:id/answer { answer }`, `POST /:id/dismiss` (`409` if not open), `DELETE`.

### Issues — `/issues`
Demand items (bugs, requests, incidents, tasks). Status is a tracker workflow, separate from workstream status. Keys stay per kind: `BUG-n|FEAT-n|INC-n|DEBT-n|FB-n|IDEA-n|SEC-n`.
- `GET ?kind&status&priority(comma list)&open(true = backlog|todo|in_progress|in_review)&limit(1-500, newest first)&teamId&assigneeId&workstreamId&milestoneId&q`, `GET /:idOrKey` (`BUG-142`, an **alias** — an old key from before a kind change, case-insensitive — or id; the response carries the current `key`)
- `POST { kind, title, body?, source?, reporterName?, assigneeId?, teamId?, priority?, status?: backlog|todo|in_progress|in_review|done|canceled, externalUrl?, estimate? }` → status defaults to `backlog`.
- `PATCH /:idOrKey { title?, kind?, estimate?, body?, reporterName?, assigneeId?, teamId?, priority?, status?, externalUrl?, workstreamIds?, milestoneIds?, duplicateOfId? }` — `duplicateOfId` (id or key, or `null`) marks the issue as a duplicate and sets status `canceled`; an issue cannot duplicate itself. `null` clears an optional field. `estimate` is a non-negative number (story points, ≤ 1000), `null` clears it; `issue.updated.data.fields` includes `estimate`. **`kind` re-keys the issue**: it takes the next number of the new kind (`BUG-148` → `FEAT-35`), the old key is appended to `aliases` (lookups by old keys keep working), and an `issue.rekeyed` event (`data: { from, to, fromKind, toKind }`) is recorded. Sending the current kind is a no-op.
- Time facts (server-set, read-only): `startedAt` = first time the status enters `in_progress`/`in_review` (kept if moved back); `completedAt` = set when the status becomes `done`/`canceled`, cleared on reopen. Also applied by `POST` (initial status) and `/link`.
- `POST /:idOrKey/link { workstreamIds?, createWorkstream?: { title, ownerTeamId, deltaThreadUrl?, objective?, … same as workstream create }, status? }` — attaches existing and/or a newly created workstream (created atomically). `backlog`/`todo` move to `in_progress` unless `status` is set. A duplicate issue cannot be linked. At least one of `workstreamIds` / `createWorkstream` is required.
- `DELETE /:idOrKey`

### Artifacts — `/artifacts`
`GET ?workstreamId&executionId&repositoryId&kind&state`, `POST { workstreamId, kind, title, executionId?, repositoryId?, provider?, url?, externalId?, state?, ci?, review?, hasConflicts?, environment? }`, `PATCH` (same fields), `DELETE`. Defaults: PR/MR → `open`, ci `pending`, review `none`, no conflicts; provider `github`/`gitlab` by kind; document/design/release → `published`, build/deployment → `pending`. Kinds: pull_request, merge_request, document, design, image, file, build, test_report, deployment, release (`commit` and `branch` were removed; PRs cover them). `review.requested` is recorded when review becomes `requested`.

### Decisions — `/decisions`
`GET ?status&workstreamId&tag&q`, `GET /:idOrKey` (`ADR-21`), `POST { title, statement, rationale?, status?: proposed|accepted|rejected, originWorkstreamId?, originExecutionId?, relatedWorkstreamIds?, tags? }` (key `ADR-n` per workspace; `accepted`/`rejected` at creation need a person), `PATCH` (content only), `POST /:idOrKey/accept` and `/reject` (people only; `409` unless `proposed`), `POST /:idOrKey/supersede { byId }` (id or key; `409` on cycles or when the replacement is itself superseded/rejected), `DELETE`.

### Dependencies — `/dependencies`
`GET ?fromId&toId`, `POST { fromType, fromId, toType, toId }` (types `workstream|execution`; `from` blocks `to`; `400` for self/unknown nodes, `409` for duplicates and **cycles**), `DELETE /:id`.

### Comments — `/comments`
`GET ?subjectType&subjectId`, `POST { subject: { type, id }, body }` (subject must exist in the workspace; types: workstream, execution, issue, artifact, decision, input_request, repository, team), `PATCH /:id { body }` (author only), `DELETE /:id` (author or admin).

### Views — `/views`
`GET` (shared + your private), `GET /:id`, `POST { name, entity: workstream|issue|execution|decision, filters?, sort?, groupBy?, layout?: list|board|graph, shared? }`, `PATCH`, `DELETE`. Only the owner (or an admin, for shared views) can change a view; other people's private views are `404`.

### Attention — `/attention` (human attention: agent tokens get `403`)
`GET /attention?scope=mine|all&state=open|snoozed|dismissed|active` → `AttentionItem[]` for the caller (PLAN.md §3). `scope=all` (admin+, else `403`) returns every item of the workspace. `state=active` = open + snoozed. Without `state` dismissed/snoozed items are included with their `state` (the snapshot's `attention` is this unfiltered list). Sorted by severity (high → low), then `since` ascending (longest waiting first).

- **Relevance**: accountable user, members of the owner/participating teams. Narrower: `input_requested` goes to the assignee (else the accountable user, else the owner team); `review_requested` to the accountable user + owner team; `triage` to members of the issue's team (backlog issues without a team: workspace admins/owners, id `triage:workspace`). Workstreams with a `statusOverride` and shipped workstreams raise nothing.
- **Kinds / severity**: `input_requested` high, `needs_decision` high, `ci_failed` high, `blocked` high (blocked/failed executions; CI, conflicts and dependencies have their own kinds), `review_requested` medium, `conflict` medium, `ready_to_land` medium, `deadline` medium (high when overdue; within 3 days), `dependency` low (another team's unshipped workstream), `ready_to_ship` low, `triage` low (one item per team, with a count).
- **Ids** are stable: `${kind}:${sourceEntityId}` (`ci_failed:ar_…`, `triage:tm_…`). URL-encode the colon in paths if your client does not.
- `since` is when the condition started (event log where available, else the entity timestamp). A **dismissed item reappears only if its `since` changes**; a **snoozed item reappears after `until`**.
- `POST /attention/:id/dismiss` · `POST /attention/:id/snooze { until: ISO (future) }` · `POST /attention/:id/restore` → the updated `AttentionItem` (`404` when the item does not currently exist for you, `400` for a past `until`). State is per user (`attention_state`).
- A `LiveEvent { type: 'attention', entity: 'workstream', id }` is published whenever a workstream is touched (any underlying change) and on dismiss/snooze/restore; refetch `GET /attention`.

### Graph — `GET /graph`, `GET /workstreams/:idOrKey/graph`
Query (all optional): `teamId` (workstreams owned by / participating the team), `workstreamId`, `includeArtifacts` (default `true`), `includeActors` (users, agents, teams; default `true`), `includeRepositories` (default `true`). Dependency edges that leave the selection pull in the other end as nodes with `data.external = true`. Types (copy into the client):

```ts
export type GraphNodeType = 'workstream' | 'execution' | 'artifact' | 'agent' | 'user' | 'team' | 'repository';
export type GraphEdgeKind = 'contains' | 'subthread' | 'depends_on' | 'produces' | 'performed_by' | 'targets';

export interface GraphNode {
  id: string;                 // the entity id (wk_…, ex_…, ar_…, ag_…, usr_…, tm_…, rp_…)
  type: GraphNodeType;
  label: string;              // workstream: "AUTH-42 Title"; others: title / name / fullName
  status?: string;            // workstreams only: effective WorkstreamStatus
  state?: string;             // executions and artifacts: ExecutionState / ArtifactState
  parentId?: string;          // execution → parent execution or workstream; artifact → execution or workstream; workstream → owner team
  data: Record<string, unknown>; // workstream: key, title, priority, derivedStatus, ownerTeamId, participatingTeamIds, accountableUserId?, targetDate?, external?
                                 // execution: workstreamId, provider, parentExecutionId?, progressNote?, sessionUrl?, branch?
                                 // artifact: kind, workstreamId, executionId?, url?, externalId?, ci?, review?, hasConflicts?, environment?
                                 // agent: provider · user: email, avatarHue · team: key, color · repository: fullName, provider, url, defaultBranch
}

export interface GraphEdge {
  id: string;                 // `${kind}:${source}>${target}`
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }
```

Edge semantics: `contains` team → workstream, workstream → top-level execution, workstream → artifact without an execution; `subthread` parent execution → child execution; `produces` execution → artifact; `performed_by` execution → agent/user/team; `targets` workstream/execution → repository; **`depends_on` source depends on (waits for) target**, i.e. it points from the blocked node to its blocker (workstream↔workstream or execution↔execution, as stored in `dependencies`).

### Search — `GET /search?q=&types=&limit=`
`types` is a comma list of `workstream,issue,decision,execution,artifact,repository,team` (default all); `limit` 1–100 (default 20). ILIKE on key / title / body (workstream objective, decision statement, issue body, execution description, artifact title + externalId, repository fullName, team name + key); every whitespace-separated term must match. Response `{ results: [{ type, id, key?, title, subtitle, workstreamKey?, score }] }` sorted by score (exact key 100, key prefix 80, key contains 60, title exact 70 / prefix 55 / contains 40, all terms in title 30, body 20), ties broken by type (workstream, decision, issue, execution, artifact, repository, team). `workstreamKey` is set for executions and artifacts. Readable by agent tokens.

### Agent Context — `GET /workstreams/:idOrKey/context`
Viewer+ and agent tokens. `text/markdown` by default; JSON with `Accept: application/json` or `?format=json`. Markdown sections: `# KEY — title`, status line, Objective, Acceptance Criteria (`- [x]` met, `- [ ]` pending, `- [ ] … _(in progress)_`), Context, Repositories (fullName — url, default branch), Teams, Dependencies (what it waits on with resolution state, what it blocks), Decisions (accepted with rationale one-liners; proposed flagged; superseded marked "do not follow"), Related issues, Artifacts (state, CI, review, conflicts), Executions, Open input requests, Recent progress (last 10 progress notes / state changes / answers). Empty sections are omitted. The JSON mirrors the same data (`AgentContext` in `src/agent-context/agent-context.service.ts`).

### MCP
Not yet implemented (planned: Streamable HTTP MCP server with `nabla.*` tools over the same services; see PLAN.md §4). Agents can use the REST API with a `Bearer nbl_…` agent token in the meantime.

## Derived workstream status

`status` / `derivedStatus` / `shippedAt` are written by the status engine (`src/status`), never by clients: after any change to a workstream or its criteria, executions, input requests, artifacts, originating decisions or dependencies (and on boot / after seed reset) it re-derives PLAN.md §2 (first match wins; `status = statusOverride ?? derivedStatus`), sets `shippedAt` the first time it ships, and on a change records a `workstream.status_changed` event (`actor: system`, `data: { key, title, from, to, derivedStatus }`). Workstreams that depend on it are re-derived too. Clarifications: closed (abandoned) PRs/MRs do not hold back "all PRs merged"; a failed execution stops blocking once a later-created completed execution with the same parent exists; only `open` PRs (not `draft`) count for CI/conflict/review rules; dependency edges into an already-terminal execution are ignored.

## Events (activity log + live updates)

- `GET /events?workstreamId&subject=<type>:<id>&type=<prefix>&before=<ISO>&limit(≤500, default 100)` → `DomainEvent[]`, newest first. Written by the server on every mutation (`workstream.created|updated|status_changed|deleted`, `criterion.updated`, `execution.created|updated|state_changed|progress|deleted`, `input.requested|answered|dismissed|updated|deleted`, `artifact.attached|updated|deleted`, `review.requested`, `decision.proposed|accepted|rejected|superseded|updated|deleted`, `issue.created|status_changed|rekeyed|linked|updated|deleted`, `milestone.created|updated|deleted`, `dependency.added|removed`, `comment.created`, `team.*`, `repository.*`). `actor` is the user or agent that made the change (`system` for derived changes).
- `GET /events/stream` — **Server-Sent Events**, one `LiveEvent` JSON per message (`{ type: created|updated|deleted|attention, entity, id, clientId?, at }`), plus a named `ping` event every 25 s. `clientId` echoes the `X-Client-Id` header of the request that caused the change, so a tab can ignore its own echoes. Use `new EventSource(url, { withCredentials: true })` (cookie auth; EventSource cannot send headers).

## Dev utilities

`POST /api/admin/reset` (unauthenticated, **disabled when `NODE_ENV=production`**) wipes the database and re-seeds the demo workspace. The same seed runs automatically on boot when the `users` table is empty (`SEED_DEMO=false` disables it): workspace **Acme** (`acme`), 6 users (all with password `nabla-demo`; roles: Alessandro owner, Maya admin, Jonas/Priya/Tomas member, Elena viewer), 7 teams, 4 agents, 6 repositories, 14 workstreams covering every status, ~36 executions, artifacts, ADR-1…23, 18 issues, comments, 5 saved views and ~300 events over the last 6 weeks.

## Configuration

`PORT` (3000), `DATABASE_URL` (default `postgres://delta:delta@localhost:5434/nabla`; the database is created on boot if missing), `CORS_ORIGIN` (comma-separated), `NODE_ENV`, `SEED_DEMO`, `SECRETS_KEY` (AES key material for integration secrets). See `.env.example`.

## Integrations — `/w/:slug/integrations` (admin and above)

Connections to GitHub, GitLab (including GitHub Enterprise / self-hosted GitLab) and Delta. Tokens and webhook secrets are encrypted at rest (AES-256-GCM, key `TRAMA_ENCRYPTION_KEY`) and **never returned**. Responses are the contract `IntegrationConnection` plus `webhookUrl`, `repositoryIds` (linked repositories) and `lastWebhookAt` (last delivery seen).

| Route | Notes |
|---|---|
| `GET /integrations`, `GET /integrations/:id` | list / one. |
| `POST /integrations` | `{ provider: github\|gitlab\|delta, token, baseUrl? }` → `201 { connection, webhook? }`. The token is checked against the provider's "current user" API (`400` when rejected or rate limited, `502` when unreachable); `account` is taken from the answer. `baseUrl`: GitHub Enterprise (`https://ghe.example.com`, API at `/api/v3`) or self-hosted GitLab (default `https://gitlab.com`). Delta needs `baseUrl` and is a stub (stored, no validation call, no webhook). `409` for a duplicate provider+account+baseUrl. `webhook = { url, secret, contentType, events }`: **the secret is only ever shown here and in `rotate-webhook-secret`**. |
| `PATCH /integrations/:id` | `{ token?, baseUrl? }` — re-validates and updates `account`/`status`. |
| `DELETE /integrations/:id` | `204`. Repositories and artifacts stay; webhook calls then answer `404`. |
| `POST /integrations/:id/rotate-webhook-secret` | `200 { connection, webhook }` with a new secret; the old one stops working immediately. |
| `GET /integrations/:id/remote-repositories?page&perPage(≤100, default 30)` | `{ items: [{ fullName, url, defaultBranch, private?, description?, linked, repositoryId? }], page, perPage, hasMore }` — repositories visible to the token. |
| `POST /integrations/:id/link-repository` | `{ fullName, teamIds? }` — checks the repository is visible to the token, creates the `Repository` (url + default branch from the provider; `201`) or adopts the existing row (`200`), and attaches it to the connection. |
| `DELETE /integrations/:id/repositories/:repositoryId` | `204`, detaches (the Repository row stays). |

### Required token scopes
- **GitHub**: a fine-grained token with *Metadata: read* and *Pull requests: read* (and *Webhooks: read/write* if you want to create the webhook through the API) on the linked repositories, or a classic PAT with `repo` (or `public_repo`). The token is used for "current user" and repository discovery.
- **GitLab**: a personal/project access token with `read_api` (use `api` if you want Trama to manage hooks later).

### Webhook setup (shown in Settings → Integrations)
**GitHub** — repository (or organization) *Settings → Webhooks → Add webhook*:
1. *Payload URL*: the `webhook.url` returned on creation (`${PUBLIC_URL}/api/webhooks/github/<connectionId>`).
2. *Content type*: **`application/json`** (form-encoded is rejected with `415`).
3. *Secret*: the `webhook.secret`.
4. *Events*: "Let me select individual events" → **Pull requests, Check suites, Check runs, Statuses** (more events are harmless: unknown ones answer `202`).
5. Link the repository to the connection (`link-repository`); events for unlinked repositories are ignored (`202`).

**GitLab** — project *Settings → Webhooks → Add new webhook*:
1. *URL*: `webhook.url` (`${PUBLIC_URL}/api/webhooks/gitlab/<connectionId>`).
2. *Secret token*: the `webhook.secret`.
3. *Triggers*: **Merge request events, Pipeline events**. Keep *Enable SSL verification* on.

`PUBLIC_URL` must be the externally reachable base URL of this API (falls back to the request's own host when unset).

## Webhooks — `POST /webhooks/github/:connectionId`, `POST /webhooks/gitlab/:connectionId` (public)

No session or token: authenticity is the signature. GitHub: `X-Hub-Signature-256` (HMAC-SHA256 of the **raw** body, timing-safe compare); GitLab: `X-Gitlab-Token` equals the secret. Raw bytes are captured for `/api/webhooks/*` only, the global JSON parser is unchanged. Bodies must be JSON.

| Result | Meaning |
|---|---|
| `200 { status: 'processed', artifactsCreated, artifactsUpdated, workstreams }` | applied (also `{ status: 'pong' }` for GitHub `ping`, `{ status: 'duplicate' }` for a replayed delivery id) |
| `202 { status: 'ignored', reason }` | accepted but nothing to do: unhandled event/action, repository not linked, no workstream key found, CI for an untracked commit |
| `400` | unparsable JSON or a payload that does not have the documented shape (never `500`) |
| `401` | missing / wrong signature or token |
| `404` | unknown connection id (or wrong provider) |

Idempotency: `X-GitHub-Delivery` / `X-Gitlab-Event-UUID` ids are stored in `webhook_deliveries` (pruned after 7 days); the artifact upsert is also idempotent on its own.

**Handled events**
- GitHub `pull_request` (opened, reopened, edited, synchronize, closed, ready_for_review, converted_to_draft, review_requested, review_request_removed), `check_suite`, `check_run`, `status`, `ping`.
- GitLab `merge_request` (any action; approved/unapproved set the review state), `pipeline`.

**Mapping.** A PR/MR becomes an Artifact (`pull_request` `#182` / `merge_request` `!12`) per linked workstream, upserted by (repository, kind, externalId, workstream). Workstreams are found by keys (`\b[A-Z][A-Z0-9]{1,9}-\d+\b`, validated against the workspace's real keys) in the title and body, and — case-insensitively, `auth-42/rotation` — in the branch name. The artifact attaches to the execution of that workstream whose `branch` equals the head branch. State: `draft|open|merged|closed`; `hasConflicts` from `mergeable(_state)` / `detailed_merge_status`; new commits reset `ci` to `pending`; `review` follows review requests (GitHub) and approvals (GitLab). CI events (`check_suite`/`check_run`/`status`, `pipeline`) carry only a commit sha (and PR numbers when available) and update `ci` (`passing` / `failing` / `pending`) of the PR/MRs whose head is that sha; cancelled/stale runs count as `pending`. Every change goes through `ArtifactsService`, i.e. it records `artifact.attached` / `artifact.updated` (with `changes`) / `review.requested` events by the `system` actor and touches the workstream so the status engine recomputes.

### Not implemented yet (documented TODOs)
- `POST /integrations/:id/sync` (history backfill: open + recently closed PRs/MRs, reviews, mergeability, deployments, releases). Until it exists, only events received after the webhook is set up are reflected.
- GitHub `pull_request_review`, `deployment_status`, `release`; GitLab `push`, `deployment`, `release`.
- Delta: connection type only (no session discovery; `sessionUrl` links on executions work as before).
- CI is derived from the single event received, not re-aggregated across all check suites of a commit.

## Permission policy, team roles and token scopes

- **Workspace settings** — `Workspace.settings` (always fully resolved in responses): `permissions` (minimum role per capability), `defaultTeamId?`, `estimateScale` (`fibonacci|linear|tshirt|none`), `weekStart`, `timeZone` (IANA or `auto`), `iconColor?`, `iconInitial?`, `deltaThreads` (boolean, default `true`: link workstreams to a Delta thread). `PATCH /w/:slug/settings` (admin; `permissions` needs an owner; `null` clears `defaultTeamId`, `iconColor`, `iconInitial`). `permissions` is partial: send only the capabilities you change, each set to `member|admin|owner`.
- **Capabilities** (defaults = historical behaviour): `createWorkstreams` member, `deleteWorkstreams` member, `createIssues` member, `deleteIssues` member, `acceptDecisions` member (accept/reject/supersede, always a person), `manageSharedViews` member (publish a view to the workspace), `createTeams` admin, `manageTeams` admin (edit/delete a team; a team lead may always edit their own team), `manageRepositories` admin, `inviteMembers` admin (a role above the inviter's own cannot be granted), `manageAgents` admin (agents and agent tokens), `manageTokens` member (personal tokens), `manageIntegrations` admin (integrations and outgoing webhooks). Enforced by `@Can(capability)` in `AccessGuard`; members/roles changes, workspace rename and delete keep their fixed roles.
- **Team roles** — `Team.leadIds` (subset of `memberIds`) and `Team.editPolicy` (`workspace` | `members`). With `members`, creating/updating/deleting the team's workstreams (`ownerTeamId`) and issues (`teamId`) — including moving work into the team — needs a team member/lead, or a workspace admin+. Agents count through their owner (`ownerUserId`). Enforced by `@EditsTeamWork` in `AccessGuard` (`PermissionsService`).
- **Token scopes** — `ApiToken.scope`: `read` (GET only, effective role viewer), `write` (default; effective role capped at member, so no admin routes), `admin` (full role of the acting user; only admins can mint one, never for agents). `POST /w/:slug/tokens { name, scope?, agentId?, expiresAt? }`.

## Outgoing webhooks (custom integrations) — `/w/:slug/outgoing-webhooks` (`manageIntegrations`)

`OutgoingWebhook { id, name, url, events[], enabled, createdAt, lastDeliveryAt?, lastStatus? }`. `events`: event types (`issue.created`), entity wildcards (`issue.*`) or `*`. `GET`, `GET /:id`, `POST { name, url, events, enabled? }` → `{ webhook, secret }` (the `whsec_…` secret is shown once), `PATCH /:id`, `DELETE /:id`, `POST /:id/rotate-secret` → `{ webhook, secret }`, `POST /:id/test` → sends a `ping` now and answers the delivery result, `GET /:id/deliveries?limit` → last deliveries (newest first; the latest 50 are kept).

Every `DomainEvent` (see *Events*) is delivered asynchronously (per webhook in order, 5 s timeout, one retry after ~2 s on a network error, 429 or 5xx): `POST url` with `Content-Type: application/json`, headers `X-Nabla-Event`, `X-Nabla-Delivery` (= event id), `X-Nabla-Signature: sha256=<hex HMAC-SHA256 of the raw body with the secret>`, body `{ id, event, workspaceId, at, actor, subject, workstreamId?, data }`. URLs must be http(s) without credentials; in production internal hosts (localhost, private IP ranges) are rejected unless `NABLA_ALLOW_PRIVATE_WEBHOOKS=true` (hostnames are not resolved: use an egress proxy for real SSRF protection). At most 20 webhooks per workspace. Limits: delivery is in-process (no durable queue), events emitted inside a transaction that later rolls back are still delivered.

## Notifications

Created on the server from domain events, for one person each, and never for whoever caused the event. Kinds (each switchable per channel; defaults: in-app on, email off): `assigned` (an issue assigned to you), `input_requested` (a question for you, or on a workstream you are accountable for), `decision_proposed`, `review_requested`, `ci_failed`, `comment` (on your issues, as assignee or reporter, and on workstreams and decisions you are accountable for) and `workstream_update` (shipped, blocked, ready to land). The recipient must still be a workspace member. The same message within a minute is stored once. Read notifications are removed after 90 days. A new one reaches only that person's live stream (`entity: "notification"`), so it never triggers a snapshot refetch. Email goes out through `SMTP_URL` (see Invitations); without it the email channel does nothing.
