# Trama API

REST + SSE backend (NestJS 12, TypeORM, Postgres 18). Everything lives under the `/api` prefix. Entity shapes are defined in
[`contracts/domain.ts`](../contracts/domain.ts) (synced to `src/contracts/domain.ts`); this file documents routes, auth and behaviour.
Architecture and extension points: [ARCHITECTURE.md](./ARCHITECTURE.md).

> **Stale parts:** the `Execution` concept was removed (migration `DropExecutions`; there is no `executions` module or route). Mentions of executions (`ex_…` ids, `executionId`, `execution` graph nodes and dependency types) below are leftovers and need a pass against `contracts/domain.ts` and the controllers.

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
| `POST /auth/logout` | – | `204`, deletes the session and clears the cookie with the same path, `SameSite` and `Secure` flags used to set it. |
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

On top of that, every client IP is rate limited before authentication (in memory, per API process): 1200 requests/minute on `/api` overall, and stricter on `POST /auth/login` (10 per 15 min), `POST /auth/signup` (10/hour), `/invites/:token` (30 per 15 min), `GET /public/views/:token` (30/minute), inbound customer-request webhooks `POST /webhooks/intake/:sourceId` (300/minute) and credential creation `POST /w/:slug/tokens|agents` (30/hour). Over a limit: `429` with a `Retry-After` header (seconds). Tunable through `TRAMA_RATE_LIMIT_*`, off when `NODE_ENV=test` or `TRAMA_RATE_LIMIT_ENABLED=false`; behind a reverse proxy set `TRAMA_TRUST_PROXY` so the real client address is used (see `.env.example`).

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
| `DELETE /w/:slug` | owner | `{ confirm }`: the exact slug or name of the workspace (`400` when missing or different, nothing is deleted). `204`, cascades everything and cannot be undone. A token needs `workspace:delete`; neither the MCP server nor the CLI has a command for it, use `trama api DELETE /w/<slug> -d '{"confirm":"<slug>"}'`. |
| `GET /w/:slug/members` | viewer | `Array<Membership & { user: User }>` |
| `POST /w/:slug/members` | admin | `{ email, role }`. The user must already exist (`404`), not already be a member (`409`). Only owners can grant `owner`. |
| `PATCH /w/:slug/members/:id` | admin | `{ role }` (`:id` = membership id). Only owners can grant `owner`. Demoting an owner is treated like removing them, see *Owners* below (`403`/`409`). |
| `DELETE /w/:slug/members/:id` | admin (anyone may remove themselves) | Also removes the user from teams. Removing an owner follows the *Owners* rules below (`403`/`409`). |
| `POST /w/:slug/transfer-ownership` | owner (session only) | `{ membershipId }`: the primary owner hands the workspace to another member, who becomes `owner` and the new `primaryOwnerId`; the caller stays an owner and may then leave. Not available to API tokens. `403` unless you are the primary owner, `409` if the target already is. |
| `GET /w/:slug/invites` | `inviteMembers` | Pending invitations (`WorkspaceInvite[]`), expired ones included so they can be resent. |
| `POST /w/:slug/invites` | `inviteMembers` | `{ email, role }` → `{ invite, url, emailed }`. The person does not need an account yet. Same address again refreshes the invite (new link and expiry, the old link stops working). Already a member → `409`; a role above your own → `403`. `url` is the only time the secret link is returned (only its hash is stored). |
| `POST /w/:slug/invites/:id/resend` | `inviteMembers` | New link and expiry, emailed again. Same response as create. |
| `DELETE /w/:slug/invites/:id` | `inviteMembers` | Revoke. |
| `GET /w/:slug/favorites` | user (viewer and up; agent tokens → `403`) | The caller's own favorites (`Favorite[]`, oldest first). Favorites whose subject was deleted, or a view that is no longer visible to the caller, are dropped here. |
| `POST /w/:slug/favorites` | user | `{ type: issue\|workstream\|project\|decision\|team\|repository\|view\|customer, subjectId }` (the entity's id, not its key). Idempotent. Unknown subject, or another person's private view → `404`; at most 100 per workspace (`409`). Viewers may keep favorites. |
| `DELETE /w/:slug/favorites/:type/:subjectId` | user | Idempotent (`204` even when it was not pinned). Favorites are private: nobody else sees them. |
| `GET /w/:slug/notifications` | user (agent tokens → `403`) | `?limit` (default 50, max 200) `&unread=true` → `{ items: Notification[], unread }`, newest first. `unread` counts the whole workspace, not just the page. |
| `POST /w/:slug/notifications/read` | user | `{ ids? }` → `{ unread }`. Without `ids`, marks everything in the workspace as read. |
| `GET /me/notification-settings`, `PATCH /me/notification-settings` | user | `{ settings: { <kind>: { inApp, email, push } }, emailAvailable }`. `PATCH { settings: { assigned: { inApp: false } } }` merges per kind and channel; unknown kinds or channels → `400`. Same in every workspace. |
| `GET /me/push` | user | `{ enabled, publicKey }`: `publicKey` is the VAPID key the browser subscribes with, `null` when push is off on this server. |
| `PUT /me/push/subscription`, `DELETE /me/push/subscription` | user | `PUT` a browser `PushSubscription` (`{ endpoint (https), keys: { p256dh, auth } }`), idempotent per endpoint; `400` when push is off. `DELETE { endpoint }` → `204`, unknown endpoints are fine. |
| `GET /invites/:token` | public | `InvitePreview` (`workspaceName`, `role`, `email`, `invitedByName`, `expiresAt`). `404` when unknown, used, revoked or expired. |
| `POST /invites/:token/accept` | signed-in user | Joins the workspace; the account email must equal the invited one (`403` otherwise). → `{ workspace: { slug, name }, role }`. Single use; an existing member keeps their role. |

**Owners.** `Workspace.primaryOwnerId` is the workspace owner: its creator until ownership is transferred. Rules, enforced on `PATCH`/`DELETE /members/:id` and `POST /transfer-ownership`:

- Nobody else can remove or demote the primary owner (`403`). To leave or step down they must transfer ownership first (`409`).
- Only the primary owner can remove or demote other owners (`403` for other owners and for admins). Any owner can leave or step down on their own, unless they are the primary owner.
- A workspace always keeps at least one owner (`409`).
- Workspaces created before this rule get their longest-standing owner as primary owner; one without a primary owner falls back to "any owner may act on owners".

Invitation links are `APP_URL/invite/<token>` and last 7 days. Emails need `SMTP_URL`; without it `emailed` is `false` and the UI shows the link to share by hand. Not exposed to API tokens with custom permissions.
| `GET/POST /w/:slug/agents`, `GET/PATCH/DELETE /w/:slug/agents/:id` | read: viewer, write: admin | `{ name, provider, description?, ownerUserId? }`. Deleting an agent revokes its tokens. |
| `GET /w/:slug/tokens` | member | Admins see all tokens, others only their own. `ApiToken[]` (never contains the hash). |
| `POST /w/:slug/tokens` | member (user) | `{ name, scope?, permissions?, limits?, expiresAt?, agentId? }` → `201 { token: ApiToken, secret }`. Without `agentId` the token acts as you; with `agentId` (admin only) it acts as that agent. See *Custom tokens* below. |
| `GET /auth/token` | API token | `{ token, actor, workspace: { id, slug, name }, permissions }`: what the calling token is. Used by the MCP server. |
| `DELETE /w/:slug/tokens/:id` | own or admin | revoke |

## Workspace snapshot

`GET /w/:slug/snapshot` → `WorkspaceSnapshot` (workspace, me, myRole, users, memberships, agents, teams, repositories, projects, workstreams, milestones, inputRequests, issues, customers, customerRequests, artifacts, decisions, dependencies, comments, last 500 `events`, `attention`, views, integrations). `views` = shared ones plus your private ones. `integrations` is empty unless the caller has the `manageIntegrations` capability (same gate as `/integrations`). Needs a user principal (not an agent token).

## Domain routes (all under `/w/:slug`)

`PATCH` is partial. List filters are query params. “member” = default write role.

### Teams — `/teams` (writes: admin)
`GET`, `GET /:idOrKey`, `POST { name, key (^[A-Z][A-Z0-9]{1,7}$), color?, description?, memberIds? }`, `PATCH /:idOrKey { name?, color?, description?, memberIds? }` (the key is immutable), `DELETE /:idOrKey` (`409` while it owns workstreams; detaches it from participating lists, issues and executions otherwise). `memberIds` must be workspace members.

### Repositories — `/repositories` (writes: admin)
`POST { provider: github|gitlab, fullName: "owner/name", url?, defaultBranch?, teamIds? }` (unique per provider+name), `PATCH { url?, defaultBranch?, teamIds? }`, `DELETE` (removes it from workstreams/executions).

### Workstreams — `/workstreams`
- `GET ?status&ownerTeamId&teamId(owner or participating)&accountableUserId&priority&repositoryId&label&q`
- `GET /:idOrKey`
- `POST { title, ownerTeamId, deltaThreadUrl?, description?, objective?, context?, participatingTeamIds?, accountableUserId?, projectId?, repositoryIds?, acceptanceCriteria?: [{ text, state? }], priority?, labels?, statusOverride?: draft|planned|working|needs_input|in_review|blocked|ready_to_land|shipped|canceled, startDate?, targetDate? }`
  - `deltaThreadUrl`: an `https` URL on `delta.dev` (or a subdomain), the Delta thread that carries this workstream. Required, except for `statusOverride: draft` and for workspaces that turned **Delta threads** off (`PATCH /w/:slug/settings { deltaThreads: false }`, admin; on by default and recommended). A supplied URL is always validated; the briefing omits the section when there is none.
  - Key = `${ownerTeam.key}-${n}` with `n` from a per-owner-team counter (atomic, never reused).
  - Initial `status`/`derivedStatus`: `planned` if it has criteria, else `draft`.
- `PATCH /:idOrKey` any of the create fields, `statusOverride: null` clears the override. `deltaThreadUrl` can be replaced but not cleared. **Changing `ownerTeamId` keeps the key** (`AUTH-42` stays `AUTH-42`); numbering continues per team.
- `projectId` links the workstream to the project it carries out (`null` on PATCH detaches; `GET ?projectId=` filters). Its `repositoryIds` must be a subset of the project's: omitted on create they are inherited from the project, otherwise `400` naming the offenders. Leaving a project drops the project's milestones from the workstream's issues that no longer qualify.
- `DELETE /:idOrKey` (cascades input requests, artifacts, dependencies, comments; unlinks issues/decisions and drops project milestones from issues that no longer have a workstream in that project).
- Criteria (each returns the updated workstream): `POST /:idOrKey/criteria { text, state? }`, `PATCH /:idOrKey/criteria/:criterionId { text?, state? }`, `DELETE /:idOrKey/criteria/:criterionId`. States: `pending|in_progress|met`.
- `status` / `derivedStatus` / `shippedAt` are written by the status engine (see *Derived workstream status* below); `status = statusOverride ?? derivedStatus`.

### Projects — `/projects` (writes: `manageProjects`, members by default)
Linear-style planning entity: the outcome we want, by when, and where. Workstreams carry a project out; milestones belong to it. `Project { id: pj_…, workspaceId, name, summary?, description?, color, status, priority, leadId?, teamIds, repositoryIds, startDate?, targetDate?, createdAt, updatedAt, completedAt? }`; also in the snapshot (`projects`). `status`: `backlog|planned|in_progress|paused|completed|canceled` (`completedAt` is set on completed/canceled and cleared on reopen).
- `GET ?status&teamId&leadId&repositoryId&customerId&tierId&minCustomers&minRequests&minRevenue&important&q`, `GET /:id`. Demand filters work like the issue ones, but a project counts the requests on itself and on its issues (planned under it or linked to one of its workstreams). Every project read includes `customerCount` (distinct customers who asked, `0` when none).
- `POST { name, summary?, description?, color?, status?, priority?, leadId?, teamIds?, repositoryIds?, startDate?, targetDate? }` (`400` for unknown teams, repositories or a lead who is not a member).
- `PATCH /:id` any of the create fields (`null` clears `summary`, `description`, `leadId`, dates). Removing a repository also removes it from the project's workstreams.
- `DELETE /:id` (`204`; its milestones are deleted and removed from issues, its workstreams are kept and detached).
- Events: `project.created|updated|status_changed|deleted` (subject `project`). Repositories deleted from the workspace are removed from projects.

### Milestones — `/milestones` (writes: `manageProjects`)
Linear-style milestones inside a project (flat resource). `Milestone { id: ms_…, workspaceId, projectId, name, description?, targetDate?, sortOrder, createdAt, updatedAt }`; also in the snapshot (`milestones`, ordered by `sortOrder`).
- `GET ?projectId` (ordered by project, `sortOrder`), `GET /:id`
- `POST { projectId, name, description?, targetDate?, sortOrder? }` → `sortOrder` defaults to last (max + 1).
- `PATCH /:id { name?, description?, targetDate?, sortOrder? }` (`null` clears `description` / `targetDate`).
- `POST /reorder { projectId, ids: [...] }` → re-numbers `sortOrder` to 0..n-1 following `ids` (milestones not listed follow, in their current order); `400` for ids that are not milestones of that project. Returns the ordered list.
- `DELETE /:id` (`204`; removes the id from `Issue.milestoneIds`, deletes its comments). Milestones are deleted with their project.
- Events: `milestone.created|updated|deleted` (subject `milestone`; `data.name`, `data.projectId`, `data.fields`; no `workstreamId`). Live (SSE) events use entity `milestone`.
- Issue rule: an issue is in at most one milestone per project and only in milestones of its own `projectId` or of the projects of its workstreams (`PATCH /issues/:idOrKey { milestoneIds }` → `400` otherwise). Clearing or changing `projectId`, or unlinking the last workstream of a project, drops that project's milestone from the issue. Deleting a project clears `projectId` on its issues.

### Input requests — `/input-requests`
`GET ?state&workstreamId&assigneeUserId`, `GET /:id`, `POST { question, workstreamId, options?, assigneeUserId? }` (`requestedBy` = caller), `PATCH` (open only), `POST /:id/answer { answer }`, `POST /:id/dismiss` (`409` if not open), `DELETE`.

### Issues — `/issues`
Demand items (bugs, requests, incidents, tasks). Status is a tracker workflow, separate from workstream status. Keys stay per kind: `BUG-n|FEAT-n|INC-n|DEBT-n|FB-n|IDEA-n|SEC-n`.
- `GET ?kind&status&priority(comma list)&open(true = backlog|todo|in_progress|in_review)&limit(1-500, newest first)&teamId&assigneeId&projectId&workstreamId&milestoneId&customerId&minCustomers&minRequests&tierId&minRevenue&important&q`, `GET /:idOrKey` (`BUG-142`, an **alias** — an old key from before a kind change, case-insensitive — or id; the response carries the current `key`). Every issue read includes `customerCount` (distinct linked customers, `0` when none). `customerId` keeps issues linked to that customer; `minCustomers` keeps issues linked to at least that many, `minRequests` at least that many requests, `tierId` issues a customer of that tier asked for, `minRevenue` issues whose requesting customers' annual revenue adds up to at least that (each customer counted once) and `important=true` issues with at least one request flagged important.
- `POST { kind, title, body?, source?, reporterName?, assigneeId?, teamId?, projectId?, priority?, status?: backlog|todo|in_progress|in_review|done|canceled, externalUrl?, estimate? }` → status defaults to `backlog`.
- `PATCH /:idOrKey { title?, kind?, estimate?, body?, reporterName?, assigneeId?, teamId?, projectId?, priority?, status?, externalUrl?, workstreamIds?, milestoneIds?, duplicateOfId? }` — `duplicateOfId` (id or key, or `null`) marks the issue as a duplicate and sets status `canceled`; an issue cannot duplicate itself. `null` clears an optional field. `estimate` is a non-negative number (story points, ≤ 1000), `null` clears it; `issue.updated.data.fields` includes `estimate`. **`kind` re-keys the issue**: it takes the next number of the new kind (`BUG-148` → `FEAT-35`), the old key is appended to `aliases` (lookups by old keys keep working), and an `issue.rekeyed` event (`data: { from, to, fromKind, toKind }`) is recorded. Sending the current kind is a no-op.
- Time facts (server-set, read-only): `startedAt` = first time the status enters `in_progress`/`in_review` (kept if moved back); `completedAt` = set when the status becomes `done`/`canceled`, cleared on reopen. Also applied by `POST` (initial status) and `/link`.
- `POST /:idOrKey/link { workstreamIds?, createWorkstream?: { title, ownerTeamId, deltaThreadUrl?, objective?, … same as workstream create }, status? }` — attaches existing and/or a newly created workstream (created atomically). Linking never changes the status by itself; only an explicit `status` does. A duplicate issue cannot be linked. At least one of `workstreamIds` / `createWorkstream` is required.
- `POST /:idOrKey/external-ref { url }`, `POST /:idOrKey/external-ref/refresh`, `DELETE /:idOrKey/external-ref` — link the issue to a GitHub or Linear issue and keep a read-only mirror of its status (`externalRef`, see *Imports and external links*). Imported issues carry `source: github|linear` and an `externalRef` with `origin: import`.
- `DELETE /:idOrKey`
- `POST /bulk { ids, patch }` — one patch for 1-100 issues (ids or keys, no repeats), **all or nothing**: every issue and reference is validated first, the writes share one transaction, and the events (`issue.updated`, `issue.status_changed`, one set per issue) are recorded once it committed. `patch` takes `status?`, `priority?`, `assigneeId?`, `teamId?`, `projectId?` (`null` clears the last three) and the list operations `addLabels?`, `removeLabels?`, `addWorkstreamIds?`, `removeWorkstreamIds?` (at most 20 each; they add to / remove from each issue's current list, they never replace it). It follows the single-issue rules: moving an unassigned issue to `in_progress` assigns the acting user, leaving a project drops its milestone, duplicates cannot be linked. `400` for an empty patch, an unknown label/user/team/project/workstream or a value both added and removed; `404` listing every unknown issue; `403` when any issue's team (or the team they move to) only lets its members edit. Responds with the updated issues (input order). Needs `issues:write`.
- `POST /bulk-delete { ids }` — delete 1-100 issues in one transaction (comments go too, issues that duplicated them are detached). Responds `{ deleted: [ids] }`. Needs the `deleteIssues` capability (`issues:delete` for custom tokens) and the same team check. MCP tools: `bulk_update_issues`, `bulk_delete_issues`.

### Customers — `/customers` (writes: `manageCustomers`, delete: `deleteCustomers`; both members by default)
A company, not a contact. `Customer { id: cus_…, workspaceId, name, domain, domains, logoUrl?, revenue?, size?, tierId?, status, createdBy, createdAt, updatedAt, archivedAt? }`. Also in the snapshot (`customers`, including archived).
- `domains` (1-20) are the company's identity: each is stored normalized (lower-case hostname; scheme, path, port and a leading `www.` removed), first one is the primary and mirrored in `domain`. No two customers of a workspace share a domain, primary or not (`409` on a clash, `400` when an entry is not a domain). Writes are serialized per workspace so two concurrent requests cannot both claim one.
- `logoUrl` is an `http(s)` URL (≤ 2000 chars; `javascript:`/`data:` are refused). `revenue` is a whole number ≥ 0 (annual, in the workspace's own currency; no currency is stored), `size` a whole number ≥ 0 (people). `status` is `prospect|active|churned` (default `active`; independent from archiving). `tierId` must be one of `Workspace.settings.customerTiers` (`400` otherwise).
- `GET ?archived=true|false|all&issueId&projectId&tierId&status&q` (default: active only; `q` matches name and any domain), `GET /:id`
- `POST { name, domains?: string[], domain?, logoUrl?, revenue?, size?, tierId?, status? }` — one of `domains` / `domain` is required.
- `PATCH /:id { name?, domains?, domain?, logoUrl?, revenue?, size?, tierId?, status?, archived? }` — `domains` replaces the whole list; `domain` replaces only the primary and keeps the others; `null` clears `logoUrl`, `revenue`, `size`, `tierId`. `archived: true` sets `archivedAt` and keeps requests; `false` restores. Issues are never deleted.
- `DELETE /:id` (`204`) removes the customer and its requests. Issues and projects stay.

#### Customer requests
`CustomerRequest { id: crq_…, workspaceId, customerId, issueId? | projectId?, body?, important, sourceUrl?, source?, externalId?, requesterEmail?, requesterName?, createdBy, createdAt, updatedAt }` (`source` … `requesterName` are set only for requests that came in through a source, see Customer request intake) is what a customer asked for. It lives on **exactly one** issue or project (`400` if neither or both; `404` if the target is not in this workspace). `body` is markdown (≤ 20000 chars), `important` a flag (default `false`), `sourceUrl` an `http(s)` link to the ticket/thread. A customer can have several requests on the same issue. In the snapshot as `customerRequests`; deleting the customer, the issue or the project removes only its requests.
- `GET /customers/:id/requests` — newest first, each with `issue: { id, key, title, status, updatedAt }` or `project: { id, name, status, updatedAt }`.
- `GET /customer-requests?customerId&issueId&projectId&important=true|false` — across customers (`customers:read`), same shape.
- `POST /customers/:id/requests { issueId | projectId, body?, important?, sourceUrl? }`
- `PATCH /customers/:id/requests/:requestId { body?, important?, sourceUrl? }` — `null` clears `body` / `sourceUrl`; bumps `updatedAt`.
- `POST /customers/:id/requests/:requestId/unlink` (`204`) deletes the request without touching the issue or project. It is a write (`customers:write` / `manageCustomers`), not a customer delete.
- Events: `customer.created|updated|archived|restored|deleted`, `customer_request.linked|updated|unlinked` (subjects `customer` and `customer_request`).

#### Following a customer — `/customer-subscriptions` (user, agent tokens → `403`; viewers may follow)
The bell on a customer page. `CustomerSubscription { id: csub_…, workspaceId, customerId, createdAt }` is private to the person. `GET` lists the caller's, `POST { customerId }` follows (idempotent, `404` for a customer of another workspace), `DELETE /:customerId` unfollows (idempotent, `204`). Followers get notifications `customer_request` (a request is added), `customer_important` (one is flagged important, or added already flagged) and `customer_delivered` (the issue is `done` or the project `completed`; whoever recorded a request hears about its delivery too, followers or not). Canceled work is never a delivery.

#### Customer request intake — `/intake-sources` (admin), `/customer-intake` (inbox), `POST /webhooks/intake/:sourceId` (public)
Brings requests in from Intercom, Zendesk, Front, Slack, email and any signed JSON webhook. Provider-agnostic: every delivery is reduced to `{ externalId, externalUrl?, requesterEmail?, requesterName?, subject?, body }`, matched to a customer, and either attached to a project or left in the triage inbox. A request created from an inbound item carries its provenance on `CustomerRequest`: `source` (`intercom|zendesk|front|slack|email|generic`), `externalId`, `requesterEmail?`, `requesterName?`, and `sourceUrl` is the link to the ticket. Salesforce and Attio (CRM sync) are not connected; that is a follow-up.

**Sources** (`manageIntegrations`; custom tokens need `integrations:*`). `IntakeSource { id: isrc_…, provider, name, enabled, hasSecret, autoCreateCustomers, targetProjectId?, subdomain?, webhookUrl, lastReceivedAt?, createdAt, updatedAt }`. The secret is AES-GCM encrypted like other integration secrets (aad `<id>:intake`) and never returned except where Trama generates it, once.
- `GET /intake-sources`, `GET /intake-sources/:id`.
- `POST /intake-sources { provider, name, autoCreateCustomers? (default true), targetProjectId?, subdomain? (Zendesk), secret? (providers that issue their own), enabled? }` → `{ source, secret? }`. `email` and `generic` sources get a generated `whsec_…` secret (in the response once); Intercom, Zendesk, Front and Slack use the secret the provider issues: send it now or later with `PATCH`. Deliveries are refused (`401`) until a secret exists.
- `PATCH /intake-sources/:id { name?, enabled?, autoCreateCustomers?, targetProjectId? (null clears), subdomain? (null clears), secret? }`; `DELETE` (`204`; its still-pending inbox items go with it, linked requests stay).
- `POST /intake-sources/:id/rotate-secret` (email / generic only) → `{ source, secret }`.
- `POST /intake-sources/:id/test` is a dry run: a sample delivery signed with the stored secret passes the real verification, parsing and customer matching, and the result says what would happen (`request`, `customer` or `wouldCreate`, `inbox`). Nothing is saved.

**Webhook** `POST /api/webhooks/intake/:sourceId` (public; raw body kept for the HMAC; `x-www-form-urlencoded` accepted for Slack). The workspace is the source's; a `workspaceId` in the payload is ignored. Signature per provider, timing-safe:
| Source | Header(s) | Signed |
|---|---|---|
| Intercom | `X-Hub-Signature: sha1=<hex>` | HMAC-SHA1 of the body, key = app client secret. Topic `conversation.user.created` (or `.contact.created`); `ping` answers pong |
| Zendesk | `X-Zendesk-Webhook-Signature` + `…-Timestamp` | base64 HMAC-SHA256 of `timestamp + body`, within 10 minutes. Trigger body template: `{"ticket_id":"{{ticket.id}}","subject":"{{ticket.title}}","description":"{{ticket.description}}","requester_email":"{{ticket.requester.email}}","requester_name":"{{ticket.requester.name}}"}`; event-style payloads (`zen:event-type:ticket.created`) work but carry no email, so they wait in the inbox |
| Front | `X-Front-Signature` + `X-Front-Request-Timestamp` | base64 HMAC-SHA256 of `timestamp:body` (ms), within 10 minutes. `inbound_received`; keyed by the conversation id |
| Slack | `X-Slack-Signature: v0=<hex>` + `X-Slack-Request-Timestamp` | HMAC-SHA256 of `v0:timestamp:body`, within 5 minutes. Slash command `/customer-request [email] text`; answers an ephemeral message |
| Email forward | `X-Trama-Signature`, `Authorization: Bearer <secret>`, or HTTP Basic with the secret as password (Postmark inbound URL credentials) | Parsed-email JSON: Postmark's `From`, `FromName`, `FromFull`, `Subject`, `TextBody`/`HtmlBody`, `MessageID`, or `from`, `fromName`, `subject`, `text`, `html`, `messageId` |
| Signed webhook | same as email | `{ externalId, body, subject?, externalUrl?, requesterEmail?, requesterName?, issueKey? }`; `issueKey` (e.g. `BUG-42`, resolved in the source's workspace) attaches straight to that issue |
`X-Trama-Signature` is `sha256=<hex HMAC-SHA256 of the raw body with the secret>`. Results: `200 { status: 'processed', itemId, linked, customerId? }`, `200 { status: 'duplicate' }`, `200 { status: 'pong' }`, `202 { status: 'ignored', reason }` (other topic, disabled source), `400` malformed payload, `401` missing / wrong signature or no secret, `404` unknown source, `429` rate limit.

**Matching and idempotency.** The sender's email domain is matched against `Customer.domains` of that workspace only (exact, then parent domains: `jane@eu.acme.com` reaches `acme.com`). Mailbox providers (gmail.com, outlook.com…) never match and never create a customer. With `autoCreateCustomers` and no match, a `prospect` customer named after the company domain is created (by the system actor); a concurrent creation of the same domain falls back to the match. `(sourceId, externalId)` is unique, so the same ticket twice (a redelivery, a second message of a Front conversation) records once. A request from a known customer is attached to the source's `targetProjectId`, or to `issueKey`, as a customer request created by the system actor (event `customer_request.linked`, followers are notified); everything else is `pending` in the inbox.

**Inbox** (`/customer-intake`; read for members, writes need `manageCustomers`). `IntakeItem { id: cin_…, sourceId, provider, externalId, externalUrl?, requesterEmail?, requesterName?, subject?, body, status: pending|linked|dismissed, customerId?, issueId?, projectId?, customerRequestId?, receivedAt, resolvedAt? }`.
- `GET /customer-intake?status=pending|linked|dismissed|all&limit` (default `pending`, newest first), `GET /customer-intake/count` → `{ pending }`.
- `POST /customer-intake/:id/link { issueId | projectId, customerId?, createCustomer?, customerName?, important? }` creates the customer request (with provenance and `sourceUrl`) and marks the item `linked`. Without a matched customer send `customerId` or `createCustomer` (from the sender's company domain; `400` for mailbox providers). `409` when the item is no longer pending (two people linking at once create one request).
- `POST /customer-intake/:id/dismiss`, `POST /customer-intake/:id/restore`.

#### Demand in saved views
Issue and project views can filter and sort on `customerId`, `customerTierId` (ids, `in`/`is`/…) and the numbers `customerCount`, `requestCount`, `importantCount`, `customerRevenue`, `customerSize` with the operators `gte` and `lte` (a number as the value). They are derived from customer requests, never stored. A public (link) view can filter and sort on them but never groups by them, and nothing about a customer is returned.

#### Customer tiers — `/customer-tiers` (admin)
Tiers are workspace settings (`Workspace.settings.customerTiers: { id: ct_…, name, color }[]`, empty by default, display order = creation order, at most 20). `POST { name, color? }` (name ≤ 40, unique case-insensitively, `409` on a clash; `color` `#rrggbb`), `PATCH /:id { name?, color? }`, `DELETE /:id` (customers with that tier are left without one). Each returns the updated workspace. Not editable through `PATCH /settings`.

### Documents — `/documents` (permission `documents:*`; members write, the author or an admin deletes)

Markdown pages that live in Trama: specs, plans and notes that do not belong in a repository. A document belongs to the workspace; it is linked to projects, workstreams and issues only through `document` artifacts (`Artifact.documentId`), so it shows in their Artifacts and there is no second parent to keep in sync. `Document { id: doc_…, workspaceId, title, body, icon?, version, author, lastEditor, archivedAt?, createdAt, updatedAt, links? }` (`links: { artifactId, projectId?, workstreamId?, issueId? }[]`). Not part of the snapshot (bodies are large).
- `GET ?q&projectId&workstreamId&issueId&attached&archived=false|only|all&authorId&sort=updated|created|title&order&limit(≤200, default 100)&offset` → `DocumentSummary[]` (no `body`; `excerpt`, `links`, and with `q` a `snippet` that is HTML-escaped with `<mark>` around matches). `q` is Postgres full-text over title (weight A) and body (B) with the `simple` configuration; every word matches as a prefix; best match first. Archived documents are hidden unless asked for.
- `POST { title (≤200), body? (≤150000 chars), icon? (one emoji), projectId?, workstreamId? (id or key), issueId? (id or key) }` → `201` `Document`. The owners are attached in the same call (one artifact each); an unknown owner is `404` and nothing is created.
- `GET /:id`, `PATCH /:id { baseVersion!, title?, body?, icon? }`, `DELETE /:id` (`204`; author or admin, else `403`; removes revisions, attachments and comments).
- **Concurrency**: `baseVersion` (the `version` you read) is required. If the document moved on, nothing is written and the answer is `409 { statusCode, code: "document_conflict", message, current: Document }` so the client can merge and retry. A change that touches nothing returns the document unchanged (no new version). Archived documents are read only (`400`).
- `POST /:id/archive`, `POST /:id/restore` (any writer) → `Document`.
- Revisions: `GET /:id/revisions` (newest first, no bodies), `GET /:id/revisions/:version` (with body), `POST /:id/revisions/:version/restore { baseVersion }` (makes it the current text as a new version; history is never rewritten). The newest revision is the current state; saves by the same editor within 5 minutes update it instead of adding one; the last 50 are kept.
- Attachments: `POST /:id/attach { projectId | workstreamId | issueId }` (exactly one; idempotent) and `POST /:id/detach { artifactId }` → `Document`; for custom tokens these two need `artifacts:write` (an attachment is an artifact). A `document` artifact can also be created with `POST /artifacts { kind: "document", documentId, <owner> }` (title and provider follow the document; attaching twice to the same owner is `409`).
- Events: `document.created|updated|archived|restored|deleted` (subject `document`; `document.updated` is recorded once per revision, autosaves inside a revision only emit a live event); attachments are `artifact.attached|deleted`. Live (SSE) entity `document`. Comments accept subject `document`.
- Security: the body is stored as text and never interpreted by the API; clients render it through a sanitising renderer. The API fetches no remote content for documents.

### Artifacts — `/artifacts`
`GET ?workstreamId&executionId&repositoryId&kind&state`, `POST { workstreamId, kind, title, executionId?, repositoryId?, provider?, url?, externalId?, state?, ci?, review?, hasConflicts?, environment? }`, `PATCH` (same fields), `DELETE`. Defaults: PR/MR → `open`, ci `pending`, review `none`, no conflicts; provider `github`/`gitlab` by kind; document/design/release → `published`, build/deployment → `pending`. Kinds: pull_request, merge_request, document, design, image, file, build, test_report, deployment, release (`commit` and `branch` were removed; PRs cover them). `review.requested` is recorded when review becomes `requested`.

### Decisions — `/decisions`
`GET ?status&workstreamId&tag&q`, `GET /:idOrKey` (`ADR-21`), `POST { title, statement, rationale?, status?: proposed|accepted|rejected, originWorkstreamId?, originExecutionId?, relatedWorkstreamIds?, tags? }` (key `ADR-n` per workspace; `accepted`/`rejected` at creation need a person), `PATCH` (content only), `POST /:idOrKey/accept` and `/reject` (people only; `409` unless `proposed`), `POST /:idOrKey/supersede { byId }` (id or key; `409` on cycles or when the replacement is itself superseded/rejected), `DELETE`.

### Dependencies — `/dependencies`
`GET ?fromId&toId`, `POST { fromType, fromId, toType, toId }` (types `workstream|execution`; `from` blocks `to`; `400` for self/unknown nodes, `409` for duplicates and **cycles**), `DELETE /:id`.

### Comments — `/comments`
`GET ?subjectType&subjectId`, `POST { subject: { type, id }, body }` (subject must exist in the workspace; types: workstream, execution, issue, artifact, decision, input_request, repository, team), `PATCH /:id { body }` (author only), `DELETE /:id` (author or admin).

### Views — `/views`
`GET` (shared + your private), `GET /:id`, `POST { name, entity: workstream|issue|decision|project, filters?, sort?, groupBy?, layout?: list|board|graph|timeline, shared? }` (`timeline` only for workstream and project views; filter fields are the client's field registry, e.g. `projectId` on an issue matches the issue's own project or the project of any workstream it is linked to), `PATCH`, `DELETE`. Only the owner, people invited with `edit`, and (for shared views) admins can change a view; views you cannot see are `404`.

Sharing: a view has `sharing { visibility: private|workspace|link, grants: [{ userId, level: view|edit }] }` (`shared` is the legacy mirror of `visibility != private`). `private` = owner + grants; `workspace` = every member can view; `link` = like `workspace`, plus anyone with the public link can read it. Send `sharing` (and/or `shared`) on `POST`/`PATCH`; only the owner (or an admin, for shared views) can change it, and visibility beyond `private` needs the `manageSharedViews` capability. `sharing.grants` on `PATCH` replaces the list and must name workspace members. `POST /views/:id/invite { emails[], level? }` grants existing members by email (`400` listing non-members). `POST /views/:id/rotate-link` replaces the public link. People who can manage sharing receive `publicToken` (while `visibility=link`); the URL is `<app>/shared/<publicToken>`. Leaving `link` visibility revokes the token for good.

Public view — `GET /api/public/views/:token` (**unauthenticated**, no query string or body is read): the fixed result of the view as `PublicView` (`groups[]` of `PublicViewItem`: key, title, kind, status, priority, health, team/assignee/project names, label names, dates, updatedAt; at most 500 rows). Filters, sort and grouping come only from the saved view and are evaluated on the server; only whitelisted fields can be filtered on. Unknown, malformed, revoked or no-longer-`link` tokens all answer `404`. Responses are `Cache-Control: no-store`, `X-Robots-Tag: noindex`.

### Attention — `/attention` (human attention: agent tokens get `403`)
`GET /attention?scope=mine|all&state=open|snoozed|dismissed|active` → `AttentionItem[]` for the caller (rules in `src/attention/attention-rules.ts`). `scope=all` (admin+, else `403`) returns every item of the workspace. `state=active` = open + snoozed. Without `state` dismissed/snoozed items are included with their `state` (the snapshot's `attention` is this unfiltered list). Sorted by severity (high → low), then `since` ascending (longest waiting first).

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
`types` is a comma list of `workstream,issue,decision,execution,artifact,document,repository,team` (default all); `limit` 1–100 (default 20). ILIKE on key / title / body (workstream objective, decision statement, issue body, execution description, artifact title + externalId, repository fullName, team name + key); every whitespace-separated term must match. Response `{ results: [{ type, id, key?, title, subtitle, workstreamKey?, score }] }` sorted by score (exact key 100, key prefix 80, key contains 60, title exact 70 / prefix 55 / contains 40, all terms in title 30, body 20), ties broken by type (workstream, decision, issue, execution, artifact, repository, team). `workstreamKey` is set for executions and artifacts. Readable by agent tokens.

### Agent Context — `GET /workstreams/:idOrKey/context`
Viewer+ and agent tokens. `text/markdown` by default; JSON with `Accept: application/json` or `?format=json`. Markdown sections: `# KEY — title`, status line, Objective, Acceptance Criteria (`- [x]` met, `- [ ]` pending, `- [ ] … _(in progress)_`), Context, Repositories (fullName — url, default branch), Teams, Dependencies (what it waits on with resolution state, what it blocks), Decisions (accepted with rationale one-liners; proposed flagged; superseded marked "do not follow"), Related issues, Artifacts (state, CI, review, conflicts), Executions, Open input requests, Recent progress (last 10 progress notes / state changes / answers). Empty sections are omitted. The JSON mirrors the same data (`AgentContext` in `src/agent-context/agent-context.service.ts`).

### MCP
Not part of this server. The MCP server is the separate Rust crate in [`mcp/`](../mcp/README.md): it forwards each client's `Bearer nbl_…` key to this REST API, which stays the only authority. The `trama` CLI in [`cli/`](../cli/README.md) offers the same commands.

## Derived workstream status

`status` / `derivedStatus` / `shippedAt` are written by the status engine (`src/status`), never by clients: after any change to a workstream or its criteria, executions, input requests, artifacts, originating decisions or dependencies (and on boot / after seed reset) it re-derives the status with the rules in `src/status/derive-status.ts` (first match wins; `status = statusOverride ?? derivedStatus`), sets `shippedAt` the first time it ships, and on a change records a `workstream.status_changed` event (`actor: system`, `data: { key, title, from, to, derivedStatus }`). Workstreams that depend on it are re-derived too. Clarifications: closed (abandoned) PRs/MRs do not hold back "all PRs merged"; a failed execution stops blocking once a later-created completed execution with the same parent exists; only `open` PRs (not `draft`) count for CI/conflict/review rules; dependency edges into an already-terminal execution are ignored.

## Events (activity log + live updates)

- `GET /events?workstreamId&subject=<type>:<id>&type=<prefix>&before=<ISO>&limit(≤500, default 100)` → `DomainEvent[]`, newest first. Written by the server on every mutation (`workstream.created|updated|status_changed|deleted`, `criterion.updated`, `execution.created|updated|state_changed|progress|deleted`, `input.requested|answered|dismissed|updated|deleted`, `artifact.attached|updated|deleted`, `document.created|updated|archived|restored|deleted`, `review.requested`, `decision.proposed|accepted|rejected|superseded|updated|deleted`, `issue.created|status_changed|rekeyed|linked|updated|deleted`, `milestone.created|updated|deleted`, `dependency.added|removed`, `comment.created`, `team.*`, `repository.*`). `actor` is the user or agent that made the change (`system` for derived changes).
- `GET /events/stream` — **Server-Sent Events**, one `LiveEvent` JSON per message (`{ type: created|updated|deleted|attention, entity, id, clientId?, at }`), plus a named `ping` event every 25 s. `clientId` echoes the `X-Client-Id` header of the request that caused the change, so a tab can ignore its own echoes. Use `new EventSource(url, { withCredentials: true })` (cookie auth; EventSource cannot send headers). The server re-checks the credential every 30 s (`TRAMA_SSE_RECHECK_MS`) and ends the stream once the session or API token is revoked or expired, or the member was removed from the workspace (the reconnect then gets 401/404).

## Dev utilities

`POST /api/admin/reset` (unauthenticated, **disabled unless `TRAMA_ENABLE_ADMIN_RESET=true`, and never available when `NODE_ENV=production`**; it answers 404 otherwise) wipes the database and re-seeds the demo workspace. The same seed runs automatically on boot when the `users` table is empty (`SEED_DEMO=false` disables it): workspace **Acme** (`acme`), 6 users (all with password `nabla-demo`; roles: Alessandro owner, Maya admin, Jonas/Priya/Tomas member, Elena viewer), 7 teams, 4 agents, 6 repositories, 14 workstreams covering every status, ~36 executions, artifacts, ADR-1…23, 18 issues, comments, 6 saved views (two of them timelines) and ~300 events over the last 6 weeks.

## Configuration

`PORT` (3000), `DATABASE_URL` (default `postgres://delta:delta@localhost:5434/nabla`; the database is created on boot if missing), `CORS_ORIGIN` (comma-separated), `NODE_ENV`, `SEED_DEMO`, `SECRETS_KEY` (AES key material for integration secrets). See `.env.example`.

## Integrations — `/w/:slug/integrations` (admin and above)

Connections to GitHub, GitLab (including GitHub Enterprise / self-hosted GitLab) and Delta. Tokens and webhook secrets are encrypted at rest (AES-256-GCM, key `TRAMA_ENCRYPTION_KEY`) and **never returned**. Responses are the contract `IntegrationConnection` plus `webhookUrl`, `repositoryIds` (linked repositories) and `lastWebhookAt` (last delivery seen).

| Route | Notes |
|---|---|
| `GET /integrations`, `GET /integrations/:id` | list / one. |
| `POST /integrations` | `{ provider: github\|gitlab\|delta, token, baseUrl? }` → `201 { connection, webhook? }`. The token is checked against the provider's "current user" API (`400` when rejected or rate limited, `502` when unreachable); `account` is taken from the answer. `baseUrl`: GitHub Enterprise (`https://ghe.example.com`, API at `/api/v3`) or self-hosted GitLab (default `https://gitlab.com`); `400` when it points at an internal address (same rules as outgoing webhooks, see `TRAMA_OUTBOUND_ALLOW_PRIVATE`). Delta needs `baseUrl` and is a stub (stored, no validation call, no webhook). `409` for a duplicate provider+account+baseUrl. `webhook = { url, secret, contentType, events }`: **the secret is only ever shown here and in `rotate-webhook-secret`**. |
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

## Imports and external links — `/w/:slug/imports` (`manageIntegrations`, admin) and `/issues/:idOrKey/external-ref`

Trama can sit next to GitHub Issues and Linear instead of replacing them. Everything is **read-only toward the tracker**: nothing is ever written back, and only `query` documents are sent to Linear. Every outbound call goes through the SSRF guard (`common/safe-fetch.ts`); the only hosts contacted are `api.github.com`, `api.linear.app` and a GitHub Enterprise host an admin configured. Tokens are encrypted at rest (AES-256-GCM, `TRAMA_ENCRYPTION_KEY`), used server-side only and **never returned or logged**; anything stored from a provider error (job errors, `lastError`) is scrubbed of the token.

**Credentials** — `GET /imports/credentials`, `POST /imports/credentials { provider: github|linear, token, baseUrl? }` (the token is checked against the tracker, `400` when rejected; the same account is updated, not duplicated; `baseUrl` is GitHub Enterprise only), `DELETE /imports/credentials/:id` (`204`). Rows are `{ id, provider, account, baseUrl?, createdAt, lastUsedAt? }`. A public GitHub repository needs no credential (60 requests an hour); for GitHub you can also pass `connectionId` of an existing GitHub integration connection instead of `credentialId`. Linear always needs a credential (a personal API key).

**Preview** — `POST /imports/preview { provider, source, credentialId?, connectionId? }`. `source` is `{ repository: "owner/name" }` (a GitHub URL is accepted) or `{ teamIds?: string[] }` for Linear (empty = every team). Writes nothing. Answers `ImportPreview`: `counts` (`issues/open/closed` are `null` when the tracker cannot count cheaply), the `teams`, `projects`, `labels`, `milestones`, `users` and `statuses` of the source, each with a `suggested` target (an existing Trama entity of the same name, otherwise create/skip; users matched by email, then login/display name, an ambiguous match gives none), a `sample` of issues and `warnings`. GitHub exposes the repository as a single pseudo team/project (`repo:owner/name`), its milestones become milestones of the project it maps to, and its states are `open`, `closed`, `not_planned`. Linear states are mapped by `type` (`triage`/`backlog` → backlog, `unstarted` → todo, `started` → in_progress, or in_review for a column named review/QA, `completed` → done, `canceled` → canceled), priorities `1..4` → urgent/high/medium/low, estimates as they are. A `400` is a rejected credential or a missing repository, `429` a rate limit (the message says until when), `502` an unreachable tracker.

**Run** — `POST /imports { provider, source, credentialId?, connectionId?, mapping?, options? }` → `202` with the job. `mapping` is the preview's, edited: `teams`, `projects`, `labels`: `{ [externalId]: { action: "map", id } | { action: "create" } | { action: "skip" } }`, `users`: `{ [externalId]: userId | null }`, `statuses`: `{ [externalId]: issueStatus }`. Every `map` id and user must exist in this workspace (`400` otherwise); anything missing from a partial mapping is skipped, and with no `mapping` at all the preview's suggestions are used. `options`: `includeComments` (default false; comments are written by the person who started the import, the original author and date are in the text), `includeClosed` (default true), `defaultKind` (default `feature`; a label such as bug, security, incident, chore or idea picks the kind first). Imported issues keep the tracker's creation, update, start and completion dates, `source` (`github`/`linear`), reporter name, labels, assignee, team, project, milestone and an `externalRef`. Only one import runs at a time per workspace (`409`).

The job runs in the background of the API process and survives a restart: its row holds the phase, the provider cursor and what the mapping resolved to, and another instance takes over a job whose heartbeat stopped. It is **idempotent**: an external issue is unique per workspace (`issues.externalRef` has a partial unique index on provider + id), so a re-run, a resume or a second import of the same repository skips what exists (and refreshes its mirrored status); created projects, teams, milestones, labels and comments are remembered in `import_links` and reused. Rate limits are waited out (`waitingUntil`; a window longer than 10 minutes parks the job as `queued` until it passes); transient 5xx are retried three times; a rejected credential or a vanished mapped entity fails the job. A single issue that cannot be written counts in `progress.failed` and the first 100 are listed in `errors` while the rest carries on. Imported issues do not emit a domain event each; the job emits `import.started`, `import.completed`, `import.failed` or `import.canceled` (subject `import`).

| Route | Notes |
|---|---|
| `GET /imports`, `GET /imports/:id` | `ImportJob`: `status` (`queued|running|completed|failed|canceled`), `sourceLabel`, `source`, `options`, `mapping`, `progress { phase: setup|issues|comments|done, total?, processed, created, skipped, failed, comments }`, `errors [{ ref, message }]`, `waitingUntil?`, `cancelRequested`, `lastError?`, `createdBy`, `createdAt`, `startedAt?`, `finishedAt?`. Poll while `queued`/`running`. |
| `POST /imports/:id/cancel` | Stops after the page in progress; what was imported stays. `409` once finished. |
| `POST /imports/:id/retry` | Continues a `failed` job from its cursor. `409` otherwise. |
| `DELETE /imports/:id` | `204`, only finished jobs (history). The imported issues stay. |

**Link instead of import** — `POST /issues/:idOrKey/external-ref { url }` reads a GitHub issue/PR URL (`https://github.com/owner/repo/issues/12`) or a Linear issue URL and stores `issue.externalRef = { provider, id, url, key?, state?, stateType?, syncedAt?, origin: "link"|"import" }`; `409` when that external issue is already linked to another issue. The credential is the workspace's saved one for that host (github.com falls back to unauthenticated reads for public repositories; Linear needs a saved key; unknown hosts are refused). `POST /issues/:idOrKey/external-ref/refresh` re-reads the external status; `DELETE /issues/:idOrKey/external-ref` unlinks. `stateType` is `open|in_progress|done|canceled`. The mirror never changes the Trama status. These routes follow the issue's edit rules (`issues:write`, team edit policy), and the stored credential is used on the caller's behalf to read that single issue. A periodic background refresh is not implemented yet: refresh is manual.

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

- **Workspace settings** — `Workspace.settings` (always fully resolved in responses): `permissions` (minimum role per capability), `defaultTeamId?`, `estimateScale` (`fibonacci|linear|tshirt|none`), `weekStart`, `timeZone` (IANA or `auto`), `iconColor?`, `iconInitial?`, `deltaThreads` (boolean, default `true`: link workstreams to a Delta thread), `labels` (the workspace catalog: templates Bug, Feature, Improvement and Documentation, plus custom labels `{ id, name, color, template }`), `customerTiers` (see Customers). `PATCH /w/:slug/settings` (admin; `permissions` needs an owner; `null` clears `defaultTeamId`, `iconColor`, `iconInitial`). `permissions` is partial: send only the capabilities you change, each set to `member|admin|owner`. Labels are not edited through that patch: `POST /w/:slug/labels { name, color? }` (member and above, so a picker can create a label on the spot), `PATCH /w/:slug/labels/:id { name?, color?, archived? }`, `POST /w/:slug/labels/:id/merge { into }` and `DELETE /w/:slug/labels/:id` (admin). Archived labels (`archived: true`, custom only) stay where they are but pickers stop offering them. Templates cannot be renamed, archived, merged away or deleted; a custom delete strips that id from issues, projects, repositories, workstreams and saved views, and a merge swaps it for the target (no duplicates) in the same places, in one transaction. Assign labels by id (`labels: string[]`, at most 20) on those four records. Free-text names are rejected.
- **Capabilities** (defaults = historical behaviour): `createWorkstreams` member, `deleteWorkstreams` member, `createIssues` member, `deleteIssues` member, `manageCustomers` member (create, edit, archive customers; create, edit and delete their requests), `deleteCustomers` member, `acceptDecisions` member (accept/reject/supersede, always a person), `manageSharedViews` member (publish a view to the workspace), `createTeams` admin, `manageTeams` admin (edit/delete a team; a team lead may always edit their own team), `manageRepositories` admin, `inviteMembers` admin (a role above the inviter's own cannot be granted), `manageAgents` admin (agents and agent tokens), `manageTokens` member (personal tokens), `manageIntegrations` admin (integrations and outgoing webhooks). Enforced by `@Can(capability)` in `AccessGuard`; members/roles changes, workspace rename and delete keep their fixed roles.
- **Team roles** — `Team.leadIds` (subset of `memberIds`) and `Team.editPolicy` (`workspace` | `members`). With `members`, creating/updating/deleting the team's workstreams (`ownerTeamId`) and issues (`teamId`) — including moving work into the team — needs a team member/lead, or a workspace admin+. Agents count through their owner (`ownerUserId`). Enforced by `@EditsTeamWork` in `AccessGuard` (`PermissionsService`).
- **Token scopes** — `ApiToken.scope`: `read` (GET only, effective role viewer), `write` (default; effective role capped at member, so no admin routes), `admin` (full role of the acting user; only admins can mint one, never for agents). `POST /w/:slug/tokens { name, scope?, agentId?, expiresAt? }`.

## Outgoing webhooks (custom integrations) — `/w/:slug/outgoing-webhooks` (`manageIntegrations`)

`OutgoingWebhook { id, name, url, events[], enabled, createdAt, lastDeliveryAt?, lastStatus? }`. `events`: event types (`issue.created`), entity wildcards (`issue.*`) or `*`. `GET`, `GET /:id`, `POST { name, url, events, enabled? }` → `{ webhook, secret }` (the `whsec_…` secret is shown once), `PATCH /:id`, `DELETE /:id`, `POST /:id/rotate-secret` → `{ webhook, secret }`, `POST /:id/test` → sends a `ping` now and answers the delivery result, `GET /:id/deliveries?limit` → last deliveries (newest first; the latest 50 are kept).

Every `DomainEvent` (see *Events*) is delivered asynchronously (per webhook in order, 5 s timeout, one retry after ~2 s on a network error, 429 or 5xx): `POST url` with `Content-Type: application/json`, headers `X-Nabla-Event`, `X-Nabla-Delivery` (= event id), `X-Nabla-Signature: sha256=<hex HMAC-SHA256 of the raw body with the secret>`, body `{ id, event, workspaceId, at, actor, subject, workstreamId?, data }`. URLs must be http(s) without credentials (https only in production). The host is resolved at delivery time and refused (400 when saving, a failed delivery otherwise) if any address is loopback, private, link-local, CGNAT, multicast, IPv4-mapped IPv6 or a cloud metadata address; the connection is pinned to the checked address and redirects are not followed. To reach internal targets set `TRAMA_OUTBOUND_ALLOW_PRIVATE=true` or list hosts in `TRAMA_OUTBOUND_ALLOWED_HOSTS` (see `.env.example`). At most 20 webhooks per workspace. Limits: delivery is in-process (no durable queue), events emitted inside a transaction that later rolls back are still delivered.

## Notifications

Created on the server from domain events, for one person each, and never for whoever caused the event. Kinds (each switchable per channel; defaults: in-app on, email off, push on): `assigned` (an issue assigned to you), `input_requested` (a question for you, or on a workstream you are accountable for), `decision_proposed`, `review_requested`, `ci_failed`, `comment` (on your issues, as assignee or reporter, and on workstreams and decisions you are accountable for) `workstream_update` (shipped, blocked, ready to land), and the customer kinds `customer_request`, `customer_important` and `customer_delivered` (see Following a customer). The recipient must still be a workspace member. The same message within a minute is stored once. Read notifications are removed after 90 days. A new one reaches only that person's live stream (`entity: "notification"`), so it never triggers a snapshot refetch. Email goes out through `SMTP_URL` (see Invitations); without it the email channel does nothing. Push is Web Push to the devices a person registered (`PUT /me/push/subscription`): it needs `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (`npx web-push generate-vapid-keys`, optional `VAPID_SUBJECT`); without them the push channel does nothing. The payload follows Angular's service worker format, so a click opens the notification's page. Subscriptions the browser reports gone (404/410) are deleted.
