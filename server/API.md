# Trama API

REST + SSE backend (NestJS 12, TypeORM, Postgres 18). Everything lives under the `/api` prefix. Entity shapes are defined in
[`contracts/domain.ts`](../contracts/domain.ts) (synced to `src/contracts/domain.ts`); this file documents routes, auth and behaviour.
Architecture and extension points: [ARCHITECTURE.md](./ARCHITECTURE.md).

Dev server: `http://localhost:3000/api` (`PORT` to change). Demo login after first boot: **demo@trama.dev / trama-demo** (workspace slug `acme`).

## Conventions

- JSON in, JSON out. Optional fields are **omitted**, never `null`, in responses. In `PATCH` bodies `null` clears an optional field; unknown fields are dropped silently.
- Ids are opaque prefixed strings (`in_…`, `dc_…`). Tasks (issues) can also be addressed by **key** (`CORA-142`) wherever the route says `:idOrKey`.
- Dates are ISO-8601. Lists have no pagination except `events`.
- Errors: `{ "statusCode": 400, "message": "…" | ["field validation messages"], "error": "Bad Request" }`. 400 validation / unknown reference, 401 not authenticated, 403 role too low (or missing CSRF header), 404 not found **or not a member of that workspace**, 409 conflict (duplicate key, cycle, wrong state), 415 non-JSON body, 422 public shared view exceeds its evaluation limit.
- Mutations return the updated entity (`204` for deletes). Actions (`/answer`, `/accept`, `/triage`, …) return the updated entity with `200`.

## Authentication

Two ways, accepted on every route except the public ones (`/health`, `/config`, `/auth/signup`, `/auth/login`):

1. **Cookie session** (browser). `POST /auth/login` or `/auth/signup` set an httpOnly `trama_session` cookie (sessions started under the old name `nabla_session` stay valid) (`SameSite=Lax`, `Secure` in production, 30 days; stored in Postgres as a sha256). The SPA must send credentials (`withCredentials: true`) and, on every **mutating** request (POST/PUT/PATCH/DELETE), a custom header **`X-Client-Id`** (or `X-Requested-With`) — requests without it get `403`. Bodies must be `application/json` (`415` otherwise). CORS allows `http://localhost:4300` and `:4301` (and `CORS_ORIGIN`) with credentials.
2. **API token**: `Authorization: Bearer trm_…`. Tokens minted before the rename to Trama start with `nbl_` and keep working. Tokens belong to one workspace and act either as a **user** (same role as that user) or as an **agent** (role `member`). No CSRF header needed. Tokens are created via `POST /w/:slug/tokens`; the secret is returned once, only its sha256 and a display prefix are stored.

| Route               | Body                              | Result                                                                                                             |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/signup` | `{ name, email, password (≥ 8) }` | `201 { user, workspaces: [] }` + cookie. `409` if the email exists.                                                |
| `POST /auth/login`  | `{ email, password }`             | `200 { user, workspaces }` + cookie. `401` on bad credentials.                                                     |
| `POST /auth/logout` | –                                 | `204`, deletes the session and clears the cookie with the same path, `SameSite` and `Secure` flags used to set it. |
| `GET /auth/me`      | –                                 | `{ user, workspaces }`. `workspaces` = `Array<Workspace & { role }>`. Agent tokens get `403`.                      |
| `GET /health`       | –                                 | `{ status: 'ok', db: 'up' }` or `503`.                                                                             |

### Custom tokens (resource × action permissions) and caps

`scope` is `read`, `write`, `admin` or `custom`. A `custom` token (also implied by sending `permissions`) carries an explicit list of
`<resource>:<action>` grants (catalog: `API_RESOURCES` in `contracts/domain.ts`; actions `read|write|delete`; the task resource is `tasks`). The
required permission is derived from the route: `/w/:slug/<resource>/…` and the method (GET → read, POST/PATCH → write, DELETE → delete;
`POST /tasks/bulk-delete` → `tasks:delete`; `/settings` and `/w/:slug` itself → `workspace`). `write`/`delete`
imply `read` on the same resource. Routes outside the catalog (e.g. `/ai/*`, `/workspaces`, `/auth/me`) are denied (fail closed), except
`GET /auth/token`. The permission list only narrows: the acting user's role still applies, and a custom token can only mint custom tokens
that are a subset of its own permissions.

Every API token has caps (`limits`, defaults `requestsPerMinute` 600, `writesPerMinute` 60, `writesPerDay` 2000; configurable up to 6000 / 600 / 20000).
Per-minute counters are per API process; the daily write counter is stored in Postgres. Over a cap: `429` with a message naming the cap.

On top of that, every client IP is rate limited before authentication (in memory, per API process): 1200 requests/minute on `/api` overall, and stricter on `POST /auth/login` (10 per 15 min), `POST /auth/signup` (10/hour), `/invites/:token` (30 per 15 min), `GET /public/views/:token` (30/minute), credential creation `POST /w/:slug/tokens|agents` (30/hour). Over a limit: `429` with a `Retry-After` header (seconds). Tunable through `TRAMA_RATE_LIMIT_*`, off when `NODE_ENV=test` or `TRAMA_RATE_LIMIT_ENABLED=false`; behind a reverse proxy set `TRAMA_TRUST_PROXY` so the real client address is used (see `.env.example`).

## Roles (RBAC)

`viewer` < `member` < `admin` < `owner`. Default: GET needs `viewer`, every write on domain entities needs `member`.
`admin` additionally: create/update/delete **agents, integrations**, add/change/remove **members**, edit the workspace, see all tokens.
`owner` additionally: delete the workspace, grant/modify the `owner` role. A workspace always keeps at least one owner (`409`).
Agent tokens act as `member` (they cannot own views, mint tokens or call `/snapshot` and `/auth/me`).
A caller who is not a member of `:slug` (or whose token belongs to another workspace) gets **404**.

## Workspaces, members, agents, tokens

| Route                                                              | Role                                       | Notes                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /workspaces`                                                  | user                                       | Mine, each `Workspace & { role }`.                                                                                                                                                                                                                                                                                         |
| `POST /workspaces`                                                 | user                                       | `{ name, slug? }`. Creator becomes `owner`. Slug auto-derived from the name (unique; reserved: `login`, `signup`, `new-workspace`, `settings`, …). `409` if an explicit slug is taken.                                                                                                                                     |
| `GET /w/:slug`                                                     | viewer                                     | `Workspace & { role }`                                                                                                                                                                                                                                                                                                     |
| `PATCH /w/:slug`                                                   | admin                                      | `{ name?, slug? }`                                                                                                                                                                                                                                                                                                         |
| `DELETE /w/:slug`                                                  | owner                                      | `{ confirm }`: the exact slug or name of the workspace (`400` when missing or different, nothing is deleted). `204`, cascades everything and cannot be undone. A token needs `workspace:delete`; neither the MCP server nor the CLI has a command for it, use `trama api DELETE /w/<slug> -d '{"confirm":"<slug>"}'`.      |
| `GET /w/:slug/members`                                             | viewer                                     | `Array<Membership & { user: User }>`                                                                                                                                                                                                                                                                                       |
| `POST /w/:slug/members`                                            | admin                                      | `{ email, role }`. The user must already exist (`404`), not already be a member (`409`). Only owners can grant `owner`.                                                                                                                                                                                                    |
| `PATCH /w/:slug/members/:id`                                       | admin                                      | `{ role }` (`:id` = membership id). Only owners can grant `owner`. Demoting an owner is treated like removing them, see _Owners_ below (`403`/`409`).                                                                                                                                                                      |
| `DELETE /w/:slug/members/:id`                                      | admin (anyone may remove themselves)       | Removing an owner follows the _Owners_ rules below (`403`/`409`).                                                                                                                                                                                                                        |
| `POST /w/:slug/transfer-ownership`                                 | owner (session only)                       | `{ membershipId }`: the primary owner hands the workspace to another member, who becomes `owner` and the new `primaryOwnerId`; the caller stays an owner and may then leave. Not available to API tokens. `403` unless you are the primary owner, `409` if the target already is.                                          |
| `GET /w/:slug/invites`                                             | `inviteMembers`                            | Pending invitations (`WorkspaceInvite[]`), expired ones included so they can be resent.                                                                                                                                                                                                                                    |
| `POST /w/:slug/invites`                                            | `inviteMembers`                            | `{ email, role }` → `{ invite, url, emailed }`. The person does not need an account yet. Same address again refreshes the invite (new link and expiry, the old link stops working). Already a member → `409`; a role above your own → `403`. `url` is the only time the secret link is returned (only its hash is stored). |
| `POST /w/:slug/invites/:id/resend`                                 | `inviteMembers`                            | New link and expiry, emailed again. Same response as create.                                                                                                                                                                                                                                                               |
| `DELETE /w/:slug/invites/:id`                                      | `inviteMembers`                            | Revoke.                                                                                                                                                                                                                                                                                                                    |
| `GET /w/:slug/favorites`                                           | user (viewer and up; agent tokens → `403`) | The caller's own favorites (`Favorite[]`, oldest first). Favorites whose subject was deleted, or a view that is no longer visible to the caller, are dropped here.                                                                                                                                                         |
| `POST /w/:slug/favorites`                                          | user                                       | `{ type: issue\|project\|view, subjectId }` (the entity's id, not its key). Idempotent. Unknown subject, or another person's private view → `404`; at most 100 per workspace (`409`). Viewers may keep favorites.                                                        |
| `DELETE /w/:slug/favorites/:type/:subjectId`                       | user                                       | Idempotent (`204` even when it was not pinned). Favorites are private: nobody else sees them.                                                                                                                                                                                                                              |
| `GET /w/:slug/notifications`                                       | user (agent tokens → `403`)                | `?limit` (default 50, max 200) `&unread=true` → `{ items: Notification[], unread }`, newest first. `unread` counts the whole workspace, not just the page.                                                                                                                                                                 |
| `POST /w/:slug/notifications/read`                                 | user                                       | `{ ids? }` → `{ unread }`. Without `ids`, marks everything in the workspace as read.                                                                                                                                                                                                                                       |
| `GET /me/notification-settings`, `PATCH /me/notification-settings` | user                                       | `{ settings: { <kind>: { inApp, email, push } }, emailAvailable }`. `PATCH { settings: { assigned: { inApp: false } } }` merges per kind and channel; unknown kinds or channels → `400`. Same in every workspace.                                                                                                          |
| `GET /me/push`                                                     | user                                       | `{ enabled, publicKey }`: `publicKey` is the VAPID key the browser subscribes with, `null` when push is off on this server.                                                                                                                                                                                                |
| `PUT /me/push/subscription`, `DELETE /me/push/subscription`        | user                                       | `PUT` a browser `PushSubscription` (`{ endpoint (https), keys: { p256dh, auth } }`), idempotent per endpoint; `400` when push is off. `DELETE { endpoint }` → `204`, unknown endpoints are fine.                                                                                                                           |
| `GET /invites/:token`                                              | public                                     | `InvitePreview` (`workspaceName`, `role`, `email`, `invitedByName`, `expiresAt`). `404` when unknown, used, revoked or expired.                                                                                                                                                                                            |
| `POST /invites/:token/accept`                                      | signed-in user                             | Joins the workspace; the account email must equal the invited one (`403` otherwise). → `{ workspace: { slug, name }, role }`. Single use; an existing member keeps their role.                                                                                                                                             |

**Owners.** `Workspace.primaryOwnerId` is the workspace owner: its creator until ownership is transferred. Rules, enforced on `PATCH`/`DELETE /members/:id` and `POST /transfer-ownership`:

- Nobody else can remove or demote the primary owner (`403`). To leave or step down they must transfer ownership first (`409`).
- Only the primary owner can remove or demote other owners (`403` for other owners and for admins). Any owner can leave or step down on their own, unless they are the primary owner.
- A workspace always keeps at least one owner (`409`).
- Workspaces created before this rule get their longest-standing owner as primary owner; one without a primary owner falls back to "any owner may act on owners".

Invitation links are `APP_URL/invite/<token>` and last 7 days. Emails need `SMTP_URL`; without it `emailed` is `false` and the UI shows the link to share by hand. Not exposed to API tokens with custom permissions.
| `GET/POST /w/:slug/agents`, `GET/PATCH/DELETE /w/:slug/agents/:id` | read: viewer, write: admin | `{ name, provider, description?, ownerUserId? }`. Deleting an agent revokes its tokens. |
| `GET /w/:slug/tokens` | member | Admins see all tokens, others only their own. `ApiToken[]` (never contains the hash). |
| `POST /w/:slug/tokens` | member (user) | `{ name, scope?, permissions?, limits?, expiresAt?, agentId? }` → `201 { token: ApiToken, secret }`. Without `agentId` the token acts as you; with `agentId` (admin only) it acts as that agent. See _Custom tokens_ below. |
| `GET /auth/token` | API token | `{ token, actor, workspace: { id, slug, name }, permissions }`: what the calling token is. Used by the MCP server. |
| `DELETE /w/:slug/tokens/:id` | own or admin | revoke |

## Workspace snapshot

`GET /w/:slug/snapshot` → `WorkspaceSnapshot` (workspace, me, myRole, users, memberships, agents, projects, milestones, issues, artifacts, comments, last 500 `events`, `attention`, views, integrations). `views` = shared ones plus your private ones. `integrations` is empty unless the caller has the `manageIntegrations` capability (same gate as `/integrations`). Needs a user principal (not an agent token).

## Domain routes (all under `/w/:slug`)

`PATCH` is partial. List filters are query params. “member” = default write role.

### Projects — `/projects` (writes: `manageProjects`, members by default)

Linear-style planning entity: the outcome we want, by when, and where. `Project { id: pj_…, workspaceId, name, key, summary?, description?, color, status, priority, leadId?, repository?, startDate?, targetDate?, createdAt, updatedAt, completedAt? }`; also in the snapshot (`projects`). `key` is the editable, uppercase project tag (1–4 letters/digits, starting with a letter; unique in the workspace). `repository` is one optional git repository, a URL or `owner/name` string (≤ 2048 characters); there is no repository registry. `ADR` and `UNPR` (unassigned issues) are reserved keys. `status`: `backlog|planned|in_progress|paused|completed|canceled` (`completedAt` is set on completed/canceled and cleared on reopen).

- `health?: on_track|at_risk|off_track` (a project health catalog id) is set by hand, on create or PATCH; `null` clears it, it is absent until set. An unknown value is `400`.
- `GET ?status&health&leadId&q`, `GET /:id`.
- `POST { name, key?, summary?, description?, color?, status?, health?, priority?, leadId?, repository?, startDate?, targetDate? }`; when omitted, `key` is suggested from the name. (`400` for an invalid tag, an over-long repository or a lead who is not a member.)
- `PATCH /:id` any of the create fields (`null` clears `summary`, `description`, `leadId`, `repository`, dates). Changing `key` re-keys the project's issues and retains their old keys as aliases.
- `DELETE /:id` (`204`; its milestones are deleted and removed from issues, and its issues become unassigned under the `UNPR` prefix).
- Events: `project.created|updated|status_changed|health_changed|deleted` (subject `project`). `health_changed` carries `data: { from, to }` (either may be `null`); `updated.data.fields` also lists `health`. Saved and public views can filter, sort and group projects by `health`.
### Milestones — `/milestones` (writes: `manageProjects`)

Linear-style milestones inside a project (flat resource). `Milestone { id: ms_…, workspaceId, projectId, name, description?, targetDate?, sortOrder, createdAt, updatedAt }`; also in the snapshot (`milestones`, ordered by `sortOrder`).

- `GET ?projectId` (ordered by project, `sortOrder`), `GET /:id`
- `POST { projectId, name, description?, targetDate?, sortOrder? }` → `sortOrder` defaults to last (max + 1).
- `PATCH /:id { name?, description?, targetDate?, sortOrder? }` (`null` clears `description` / `targetDate`).
- `POST /reorder { projectId, ids: [...] }` → re-numbers `sortOrder` to 0..n-1 following `ids` (milestones not listed follow, in their current order); `400` for ids that are not milestones of that project. Returns the ordered list.
- `DELETE /:id` (`204`; removes the id from `Issue.milestoneIds`, deletes its comments). Milestones are deleted with their project.
- Events: `milestone.created|updated|deleted` (subject `milestone`; `data.name`, `data.projectId`, `data.fields`). Live (SSE) events use entity `milestone`.
- Issue rule: an issue is in at most one milestone per project and only in milestones of its own `projectId` (`PATCH /tasks/:idOrKey { milestoneIds }` → `400` otherwise). Clearing or changing `projectId` drops milestones that no longer qualify. Deleting a project clears `projectId` on its issues.

### Tasks — `/tasks` (the issues; permission `tasks:*`)

The public route is `/w/:slug/tasks`. The record is still an issue (type `Issue`, subject type `issue`, events `issue.*`, ids and keys unchanged), and the `/issues` routes no longer exist. Items are bugs, requests, incidents and tasks. Keys use the project's tag (`CORA-n`); unassigned issues use `UNPR-n`. The issue `kind` remains an independent classification and does not affect its key. `GET /:idOrKey/context` returns `{ issue, planSummary?, artifacts }`; the optional plan summary is derived from plans owned by the issue, and artifact details are omitted for custom tokens without `artifacts:read`. With `?format=markdown` or `Accept: text/markdown` the same context is returned as a markdown briefing for picking the work up: description, plans and artifacts.

- `GET ?kind&status&priority(comma list)&open(true = backlog|todo|in_progress|in_review)&limit(1-500, newest first)&assigneeId&projectId&milestoneId&q`, `GET /:idOrKey` (`CORA-142`, a current key or an older project-key alias, case-insensitive, or id; the response carries the current `key`).- `POST { kind, title, body?, source?, reporterName?, assigneeId?, projectId?, parentId?, priority?, status?: backlog|todo|in_progress|in_review|done|canceled, externalUrl?, threadUrl?, estimate? }` → status defaults to `backlog`. `threadUrl` is the link to the Delta thread (delta.dev) the user works on for the task: an `http`/`https` URL with a host, at most 2048 characters, no surrounding spaces (`400` otherwise). It is returned on the task, in the snapshot, in `/context` (JSON `issue.threadUrl`, and a `Thread:` line in the markdown briefing).
- `PATCH /:idOrKey { title?, kind?, estimate?, body?, reporterName?, assigneeId?, projectId?, parentId?, priority?, status?, externalUrl?, threadUrl? (`null` clears), milestoneIds?, duplicateOfId? }`. `parentId` is an issue id or key; it can be set or cleared with `null`, and parent/child issues retain independent properties and status at any nesting depth. Parent and child must be in the same workspace, and self-links or cycles are rejected. `duplicateOfId` (id or key, or `null`) marks an issue as a duplicate and sets status `canceled`; an issue cannot duplicate itself. `null` clears an optional field. `estimate` is a non-negative number (story points, ≤ 1000), `null` clears it; `issue.updated.data.fields` includes `estimate`. Changing `projectId` re-keys the issue under the target project's tag (or `UNPR` when clearing the project), appends the old key to `aliases`, and records `issue.rekeyed`. Changing `kind` only changes the classification and leaves the key unchanged.
- Time facts (server-set, read-only): `startedAt` = first time the status enters `in_progress`/`in_review` (kept if moved back); `completedAt` = set when the status becomes `done`/`canceled`, cleared on reopen. Also applied by `POST` (initial status).
- `POST /:idOrKey/external-ref { url }`, `POST /:idOrKey/external-ref/refresh`, `DELETE /:idOrKey/external-ref` — link the issue to a GitHub or Linear issue and keep a read-only mirror of its status (`externalRef`, see _Imports and external links_). Imported issues carry `source: github|linear` and an `externalRef` with `origin: import`.
- `DELETE /:idOrKey` — deleting a parent preserves its children as root issues.
- `POST /bulk { ids, patch }` — one patch for 1-100 issues (ids or keys, no repeats), **all or nothing**: every issue and reference is validated first, the writes share one transaction, and the events (`issue.updated`, `issue.status_changed`, one set per issue) are recorded once it committed. `patch` takes `status?`, `priority?`, `assigneeId?`, `projectId?` (`null` clears the last two) and the list operations `addLabels?`, `removeLabels?` (at most 20 each; they add to / remove from each issue's current list, they never replace it). It follows the single-issue rules: moving an unassigned issue to `in_progress` assigns the acting user, leaving a project drops its milestone. `400` for an empty patch, an unknown label/user/project or a value both added and removed; `404` listing every unknown issue. Responds with the updated issues (input order). Needs `tasks:write`.
- `POST /bulk-delete { ids }` — delete 1-100 issues in one transaction (comments go too, issues that duplicated them are detached). Responds `{ deleted: [ids] }`. Needs the `deleteIssues` capability (`tasks:delete` for custom tokens). MCP tools: `bulk_update_issues`, `bulk_delete_issues`.

### Artifacts — `/artifacts`

Also `GET|POST /tasks/:idOrKey/artifacts` (and `POST /tasks/:idOrKey/artifacts/upload`), which need `artifacts:*`, not `tasks:*`, for custom tokens.

Artifacts always belong to a task (git integrations and agents attach PRs, builds and CI results to it); there are no project-level artifacts. `GET ?issueId&kind&state`, `POST { issueId, kind, title, repository? (git full name or URL, a string, not an id), provider?, url?, externalId?, state?, ci?, review?, hasConflicts?, environment? }`, `PATCH` (same fields), `DELETE`. Defaults: PR/MR → `open`, ci `pending`, review `none`, no conflicts; provider `github`/`gitlab` by kind; document/design/release → `published`, build/deployment → `pending`. Kinds: pull_request, merge_request, document (a link to a file or page, for example an implementation plan), link, design, image, file, build, test_report, deployment, release (`commit` and `branch` were removed; PRs cover them). `review.requested` is recorded when review becomes `requested`.

### Comments — `/comments`

`GET ?subjectType&subjectId`, `POST { subject: { type, id }, body }` (subject must exist in the workspace; types: issue, artifact, project, milestone), `PATCH /:id { body }` (author only), `DELETE /:id` (author or admin).

### Views — `/views`

`GET` (shared + your private), `GET /:id`, `POST { name, entity: issue|project, filters?, sort?, groupBy?, layout?: list|board|timeline, shared? }`, `PATCH`, `DELETE`. Only the owner, people invited with `edit`, and (for shared views) admins can change a view; views you cannot see are `404`.

Sharing: a view has `sharing { visibility: private|workspace|link, grants: [{ userId, level: view|edit }] }` (`shared` is the legacy mirror of `visibility != private`). `private` = owner + grants; `workspace` = every member can view; `link` = like `workspace`, plus anyone with the public link can read it. Send `sharing` (and/or `shared`) on `POST`/`PATCH`; only the owner (or an admin, for shared views) can change it, and visibility beyond `private` needs the `manageSharedViews` capability. `sharing.grants` on `PATCH` replaces the list and must name workspace members. `POST /views/:id/invite { emails[], level? }` grants existing members by email (`400` listing non-members). `POST /views/:id/rotate-link` replaces the public link. People who can manage sharing receive `publicToken` (while `visibility=link`); the URL is `<app>/shared/<publicToken>`. Leaving `link` visibility revokes the token for good.

Public view — `GET /api/public/views/:token` (**unauthenticated**, no query string or body is read): the fixed result of the view as `PublicView` (`groups[]` of `PublicViewItem`: key, title, kind, status, priority, health, assignee/project names, label names, dates, updatedAt; at most 500 rows). Filters, sort and grouping come only from the saved view and are evaluated on the server; only whitelisted fields can be filtered on. Evaluation reads at most 20,000 candidate rows for the selected entity in its workspace before applying saved filters. If there are more, the endpoint returns `422` rather than an incomplete result. Unknown, malformed, revoked or no-longer-`link` tokens all answer `404`. Responses are `Cache-Control: no-store`, `X-Robots-Tag: noindex`.

### Attention — `/attention` (human attention: agent tokens get `403`)

`GET /attention` → `AttentionItem[]` for the caller (`AttentionService`). Dismissed and snoozed items are included with their `state` (the snapshot's `attention` is this same list). Sorted by severity (high → low), then `since` ascending (longest waiting first).

- **Relevance**: artifacts attached to tasks the caller can see (project visibility and member access apply).
- **Kinds / severity**: `review_requested` (an attached pull request awaits review) and `ci_failed` (checks fail on an attached artifact).
- **Ids** are stable: `${kind}:${artifactId}` (`ci_failed:ar_…`). URL-encode the colon in paths if your client does not.
- `since` is when the condition started (event log where available, else the entity timestamp). A **dismissed item reappears only if its `since` changes**; a **snoozed item reappears after `until`**.
- `POST /attention/:id/dismiss` · `POST /attention/:id/snooze { until: ISO (future) }` · `POST /attention/:id/restore` → the updated `AttentionItem` (`404` when the item does not currently exist for you, `400` for a past `until`). State is per user (`attention_state`).
- A `LiveEvent { type: 'attention', entity: 'issue', id }` is published when issue attention changes and on dismiss/snooze/restore; refetch `GET /attention`.

### Search — `GET /search?q=&types=&limit=`

`types` is a comma list of `project,issue,artifact` (default all); `limit` 1–100 (default 20). ILIKE on key / title / body; every whitespace-separated term must match. Response `{ results: [{ type, id, key?, title, subtitle?, score }] }` sorted by score. Readable by agent tokens.

### MCP

Not part of this server. The MCP server is the separate Rust crate in [`mcp/`](../mcp/README.md): it forwards each client's `Bearer trm_…` key to this REST API, which stays the only authority. The `trama` CLI in [`cli/`](../cli/README.md) offers the same commands.

## Events (activity log + live updates)

- `GET /events?subject=<type>:<id>&type=<prefix>&before=<ISO>&limit(≤500, default 100)` → `DomainEvent[]`, newest first. Written on mutations to tasks and the other active resources.
- `GET /events/stream` — **Server-Sent Events**, one `LiveEvent` JSON per message (`{ type: created|updated|deleted|attention, entity, id, clientId?, at }`), plus a named `ping` event every 25 s. `clientId` echoes the `X-Client-Id` header of the request that caused the change, so a tab can ignore its own echoes. Use `new EventSource(url, { withCredentials: true })` (cookie auth; EventSource cannot send headers). The server re-checks the credential every 30 s (`TRAMA_SSE_RECHECK_MS`) and ends the stream once the session or API token is revoked or expired, or the member was removed from the workspace (the reconnect then gets 401/404).

## Dev utilities

`POST /api/admin/reset` (unauthenticated, **disabled unless `TRAMA_ENABLE_ADMIN_RESET=true`, and never available when `NODE_ENV=production`**; it answers 404 otherwise) wipes the database and re-seeds the demo workspace. The same seed runs automatically on boot when the `users` table is empty (`SEED_DEMO=false` disables it): workspace **Acme** (`acme`), 6 users (all with password `trama-demo`; roles: Alessandro owner, Maya admin, Jonas/Priya/Tomas member, Elena viewer), 4 agents, projects with milestones, artifacts, tasks, comments, saved views and event history.

## Configuration

`PORT` (3000), `DATABASE_URL` (default `postgres://delta:delta@localhost:5435/trama`; the database is created on boot if missing), `CORS_ORIGIN` (comma-separated), `NODE_ENV`, `SEED_DEMO`, `DEMO_LOGIN` (`1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`; unset shows the sign-in demo panel outside production and hides it in production), `SECRETS_KEY` (AES key material for integration secrets). See `.env.example`.

`GET /api/config` (unauthenticated) returns `{ demoLogin: boolean }` for the sign-in page.

## Integrations — `/w/:slug/integrations` (admin and above)

Connections to GitHub, GitLab (including GitHub Enterprise / self-hosted GitLab) and Delta. Tokens and webhook secrets are encrypted at rest (AES-256-GCM, key `TRAMA_ENCRYPTION_KEY`) and **never returned**. Responses are the contract `IntegrationConnection` plus `webhookUrl` and `lastWebhookAt` (last delivery seen).

| Route                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /integrations`, `GET /integrations/:id`                               | list / one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /integrations`                                                       | `{ provider: github\|gitlab\|delta, token, baseUrl? }` → `201 { connection, webhook? }`. The token is checked against the provider's "current user" API (`400` when rejected or rate limited, `502` when unreachable); `account` is taken from the answer. `baseUrl`: GitHub Enterprise (`https://ghe.example.com`, API at `/api/v3`) or self-hosted GitLab (default `https://gitlab.com`); `400` when it points at an internal address (same rules as outgoing webhooks, see `TRAMA_OUTBOUND_ALLOW_PRIVATE`). Delta needs `baseUrl` and is a stub (stored, no validation call, no webhook). `409` for a duplicate provider+account+baseUrl. `webhook = { url, secret, contentType, events }`: **the secret is only ever shown here and in `rotate-webhook-secret`**. |
| `PATCH /integrations/:id`                                                  | `{ token?, baseUrl? }` — re-validates and updates `account`/`status`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DELETE /integrations/:id`                                                 | `204`. Repositories and artifacts stay; webhook calls then answer `404`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /integrations/:id/rotate-webhook-secret`                             | `200 { connection, webhook }` with a new secret; the old one stops working immediately.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /integrations/:id/remote-repositories?page&perPage(≤100, default 30)` | `{ items: [{ fullName, url, defaultBranch, private?, description? }], page, perPage, hasMore }` — repositories visible to the token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Required token scopes

- **GitHub**: a fine-grained token with _Metadata: read_ and _Pull requests: read_ (and _Webhooks: read/write_ if you want to create the webhook through the API) on the repositories you want to follow, or a classic PAT with `repo` (or `public_repo`). The token is used for "current user" and repository discovery.
- **GitLab**: a personal/project access token with `read_api` (use `api` if you want Trama to manage hooks later).

### Webhook setup (shown in Settings → Integrations)

**GitHub** — repository (or organization) _Settings → Webhooks → Add webhook_:

1. _Payload URL_: the `webhook.url` returned on creation (`${PUBLIC_URL}/api/webhooks/github/<connectionId>`).
2. _Content type_: **`application/json`** (form-encoded is rejected with `415`).
3. _Secret_: the `webhook.secret`.
4. _Events_: "Let me select individual events" → **Pull requests, Check suites, Check runs, Statuses** (more events are harmless: unknown ones answer `202`).
5. There is no repository registry: an event is matched to a task by the issue key it carries (`202` with `no issue key found` otherwise), and the artifact stores the repository's full name as a plain string.

**GitLab** — project _Settings → Webhooks → Add new webhook_:

1. _URL_: `webhook.url` (`${PUBLIC_URL}/api/webhooks/gitlab/<connectionId>`).
2. _Secret token_: the `webhook.secret`.
3. _Triggers_: **Merge request events, Pipeline events**. Keep _Enable SSL verification_ on.

`PUBLIC_URL` must be the externally reachable base URL of this API (falls back to the request's own host when unset).

## LunaGest import — `/w/:slug/lunagest/import*` (`manageProjects`, plus `createIssues` to run it)

A workspace has one LunaGest login (`PUT /lunagest/connection`, `manageIntegrations`). On top of it:

- `GET /lunagest/import/projects` → `{ projects: [{ id, name, description|null, taskCount|null, imported, projectId|null, projectName|null, linkedTaskCount }] }`. `taskCount` is `null` when LunaGest did not return that project's tasks. `imported` means a Trama project is bound to it; `projectId` and `projectName` appear only when the caller may see that project; `linkedTaskCount` counts its Trama tasks already tied to a LunaGest task.
- `POST /lunagest/import { remoteProjectIds: string[] (1-25) }` → `201 { projects: [{ remoteProjectId, remoteProjectName, project: created|linked|existing|failed, projectId|null, projectKey|null, tasks: { created, linked, existing }, error? }] }`. `400` for an empty list, an id LunaGest does not list, or no saved connection.
  - Project: already bound → `existing`; else the one unbound Trama project with the same name (case-insensitive) is bound (`linked`); else a Trama project is created from the name and description (`created`).
  - Tasks: a remote task already tied to a Trama task is left alone (`existing`; differences are for `POST /projects/:id/lunagest/realign`); else a same-titled unbound Trama task of that project is tied to it (`linked`, unambiguous matches only); else a Trama task is created (`created`: kind `feature`, status `backlog`, source `api`, body from the description). Status and priority are not mapped: their LunaGest values were never recorded.
  - Idempotent: a second run creates nothing. One failing project reports `error` and the rest still run.
  - Import only reads from LunaGest. Created tasks are not pushed back (that would create a second remote task).
- The Trama timer does not follow the LunaGest timer; see `NON-GOALS.md` (the clock and time-entry endpoints were not recorded).

## Imports and external links — `/w/:slug/imports` (`manageIntegrations`, admin) and `/tasks/:idOrKey/external-ref`

Trama can sit next to GitHub Issues and Linear instead of replacing them. Everything is **read-only toward the tracker**: nothing is ever written back, and only `query` documents are sent to Linear. Every outbound call goes through the SSRF guard (`common/safe-fetch.ts`); the only hosts contacted are `api.github.com`, `api.linear.app` and a GitHub Enterprise host an admin configured. Tokens are encrypted at rest (AES-256-GCM, `TRAMA_ENCRYPTION_KEY`), used server-side only and **never returned or logged**; anything stored from a provider error (job errors, `lastError`) is scrubbed of the token.

**Credentials** — `GET /imports/credentials`, `POST /imports/credentials { provider: github|linear, token, baseUrl? }` (the token is checked against the tracker, `400` when rejected; the same account is updated, not duplicated; `baseUrl` is GitHub Enterprise only), `DELETE /imports/credentials/:id` (`204`). Rows are `{ id, provider, account, baseUrl?, createdAt, lastUsedAt? }`. A public GitHub repository needs no credential (60 requests an hour); for GitHub you can also pass `connectionId` of an existing GitHub integration connection instead of `credentialId`. Linear always needs a credential (a personal API key).

**Preview** — `POST /imports/preview { provider, source, credentialId?, connectionId? }`. `source` is `{ repository: "owner/name" }` (a GitHub URL is accepted) or `{ teamIds?: string[] }` for Linear (empty = every team). Writes nothing. Answers `ImportPreview`: `counts` (`issues/open/closed` are `null` when the tracker cannot count cheaply), the `teams`, `projects`, `labels`, `milestones`, `users` and `statuses` of the source, each with a `suggested` target (an existing Trama entity of the same name, otherwise create/skip; users matched by email, then login/display name, an ambiguous match gives none), a `sample` of issues and `warnings`. GitHub exposes the repository as a single pseudo team/project (`repo:owner/name`), its milestones become milestones of the project it maps to, and its states are `open`, `closed`, `not_planned`. Linear states are mapped by `type` (`triage`/`backlog` → backlog, `unstarted` → todo, `started` → in_progress, or in_review for a column named review/QA, `completed` → done, `canceled` → canceled), priorities `1..4` → urgent/high/medium/low, estimates as they are. A `400` is a rejected credential or a missing repository, `429` a rate limit (the message says until when), `502` an unreachable tracker.

**Run** — `POST /imports { provider, source, credentialId?, connectionId?, mapping?, options? }` → `202` with the job. `mapping` is the preview's, edited: `teams`, `projects`, `labels`: `{ [externalId]: { action: "map", id } | { action: "create" } | { action: "skip" } }`, `users`: `{ [externalId]: userId | null }`, `statuses`: `{ [externalId]: issueStatus }`. Every `map` id and user must exist in this workspace (`400` otherwise); anything missing from a partial mapping is skipped, and with no `mapping` at all the preview's suggestions are used. `options`: `includeComments` (default false; comments are written by the person who started the import, the original author and date are in the text), `includeClosed` (default true), `defaultKind` (default `feature`; a label such as bug, security, incident, chore or idea picks the kind first). Imported issues keep the tracker's creation, update, start and completion dates, `source` (`github`/`linear`), reporter name, labels, assignee, team, project, milestone and an `externalRef`. Only one import runs at a time per workspace (`409`).

The job runs in the background of the API process and survives a restart: its row holds the phase, the provider cursor and what the mapping resolved to, and another instance takes over a job whose heartbeat stopped. It is **idempotent**: an external issue is unique per workspace (`issues.externalRef` has a partial unique index on provider + id), so a re-run, a resume or a second import of the same repository skips what exists (and refreshes its mirrored status); created projects, teams, milestones, labels and comments are remembered in `import_links` and reused. Rate limits are waited out (`waitingUntil`; a window longer than 10 minutes parks the job as `queued` until it passes); transient 5xx are retried three times; a rejected credential or a vanished mapped entity fails the job. A single issue that cannot be written counts in `progress.failed` and the first 100 are listed in `errors` while the rest carries on. Imported issues do not emit a domain event each; the job emits `import.started`, `import.completed`, `import.failed` or `import.canceled` (subject `import`).

| Route                              | Notes                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `GET /imports`, `GET /imports/:id` | `ImportJob`: `status` (`queued                                                  | running | completed | failed | canceled`), `sourceLabel`, `source`, `options`, `mapping`, `progress { phase: setup | issues | comments | done, total?, processed, created, skipped, failed, comments }`, `errors [{ ref, message }]`, `waitingUntil?`, `cancelRequested`, `lastError?`, `createdBy`, `createdAt`, `startedAt?`, `finishedAt?`. Poll while `queued`/`running`. |
| `POST /imports/:id/cancel`         | Stops after the page in progress; what was imported stays. `409` once finished. |
| `POST /imports/:id/retry`          | Continues a `failed` job from its cursor. `409` otherwise.                      |
| `DELETE /imports/:id`              | `204`, only finished jobs (history). The imported issues stay.                  |

**Link instead of import** — `POST /tasks/:idOrKey/external-ref { url }` reads a GitHub issue/PR URL (`https://github.com/owner/repo/issues/12`) or a Linear issue URL and stores `issue.externalRef = { provider, id, url, key?, state?, stateType?, syncedAt?, origin: "link"|"import" }`; `409` when that external issue is already linked to another issue. The credential is the workspace's saved one for that host (github.com falls back to unauthenticated reads for public repositories; Linear needs a saved key; unknown hosts are refused). `POST /issues/:idOrKey/external-ref/refresh` re-reads the external status; `DELETE /issues/:idOrKey/external-ref` unlinks. `stateType` is `open|in_progress|done|canceled`. The mirror never changes the Trama status. These routes follow the issue's edit rules (`issues:write`, team edit policy), and the stored credential is used on the caller's behalf to read that single issue. A periodic background refresh is not implemented yet: refresh is manual.

## Webhooks — `POST /webhooks/github/:connectionId`, `POST /webhooks/gitlab/:connectionId` (public)

No session or token: authenticity is the signature. GitHub: `X-Hub-Signature-256` (HMAC-SHA256 of the **raw** body, timing-safe compare); GitLab: `X-Gitlab-Token` equals the secret. Raw bytes are captured for `/api/webhooks/*` only, the global JSON parser is unchanged. Bodies must be JSON.

| Result                                                                         | Meaning                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `200 { status: 'processed', artifactsCreated, artifactsUpdated }` | applied (also `{ status: 'pong' }` for GitHub `ping`, `{ status: 'duplicate' }` for a replayed delivery id)                    |
| `202 { status: 'ignored', reason }`                                            | accepted but nothing to do: unhandled event/action, no issue key found, or CI for an untracked commit |
| `400`                                                                          | unparsable JSON or a payload that does not have the documented shape (never `500`)                                             |
| `401`                                                                          | missing / wrong signature or token                                                                                             |
| `404`                                                                          | unknown connection id (or wrong provider)                                                                                      |

Idempotency: `X-GitHub-Delivery` / `X-Gitlab-Event-UUID` ids are stored in `webhook_deliveries` (pruned after 7 days); the artifact upsert is also idempotent on its own.

**Handled events**

- GitHub `pull_request` (opened, reopened, edited, synchronize, closed, ready_for_review, converted_to_draft, review_requested, review_request_removed), `check_suite`, `check_run`, `status`, `ping`.
- GitLab `merge_request` (any action; approved/unapproved set the review state), `pipeline`.

**Mapping.** GitHub/GitLab webhook artifact linking is issue/project-owned.
### Not implemented yet (documented TODOs)

- `POST /integrations/:id/sync` (history backfill: open + recently closed PRs/MRs, reviews, mergeability, deployments, releases). Until it exists, only events received after the webhook is set up are reflected.
- GitHub `pull_request_review`, `deployment_status`, `release`; GitLab `push`, `deployment`, `release`.
- Delta: connection type only; session transcripts remain in the execution tool.
- CI is derived from the single event received, not re-aggregated across all check suites of a commit.

## Permission policy and token scopes

- **Workspace settings** — `Workspace.settings` (always fully resolved in responses): `permissions` (minimum role per capability), `estimateScale` (`fibonacci|linear|tshirt|none`), `weekStart`, `timeZone` (IANA or `auto`), `iconColor?`, `iconInitial?`, `labels` (user-defined labels `{ id, name, color, template }`; new workspaces do not pre-create issue-type labels), `statuses`. `PATCH /w/:slug/settings` (admin; `permissions` needs an owner; `null` clears `iconColor`, `iconInitial`). `permissions` is partial: send only the capabilities you change, each set to `member|admin|owner`. Labels are not edited through that patch: `POST /w/:slug/labels { name, color? }` (member and above, so a picker can create a label on the spot), `PATCH /w/:slug/labels/:id { name?, color?, archived? }`, `POST /w/:slug/labels/:id/merge { into }` and `DELETE /w/:slug/labels/:id` (admin). Archived labels (`archived: true`) stay where they are but pickers stop offering them. Existing type labels become editable custom labels; a custom delete strips that id from issues, projects and saved views, and a merge swaps it for the target (no duplicates) in the same places, in one transaction. Assign labels by id (`labels: string[]`, at most 20) on issues and projects. Free-text names are rejected.
- **Capabilities** (defaults = historical behaviour): `manageProjects` member, `createIssues` member, `deleteIssues` member, `manageSharedViews` member (publish a view to the workspace), `inviteMembers` admin (a role above the inviter's own cannot be granted), `manageAgents` admin (agents and agent tokens), `manageTokens` member (personal tokens), `manageIntegrations` admin (integrations and outgoing webhooks). Enforced by `@Can(capability)` in `AccessGuard`; members/roles changes, workspace rename and delete keep their fixed roles.
- **Token scopes** — `ApiToken.scope`: `read` (GET only, effective role viewer), `write` (default; effective role capped at member, so no admin routes), `admin` (full role of the acting user; only admins can mint one, never for agents). `POST /w/:slug/tokens { name, scope?, agentId?, expiresAt? }`.

## Outgoing webhooks (custom integrations) — `/w/:slug/outgoing-webhooks` (`manageIntegrations`)

`OutgoingWebhook { id, name, url, events[], enabled, createdAt, lastDeliveryAt?, lastStatus? }`. `events`: event types (`issue.created`), entity wildcards (`issue.*`) or `*`. `GET`, `GET /:id`, `POST { name, url, events, enabled? }` → `{ webhook, secret }` (the `whsec_…` secret is shown once), `PATCH /:id`, `DELETE /:id`, `POST /:id/rotate-secret` → `{ webhook, secret }`, `POST /:id/test` → sends a `ping` now and answers the delivery result, `GET /:id/deliveries?limit` → last deliveries (newest first; the latest 50 are kept).

Every `DomainEvent` (see _Events_) is delivered asynchronously (per webhook in order, 5 s timeout, one retry after ~2 s on a network error, 429 or 5xx): `POST url` with `Content-Type: application/json`, headers `X-Trama-Event`, `X-Trama-Delivery` (= event id), `X-Trama-Signature: sha256=<hex HMAC-SHA256 of the raw body with the secret>` (the pre-rename `X-Nabla-Event`, `X-Nabla-Delivery` and `X-Nabla-Signature` headers are still sent with the same values), body `{ id, event, workspaceId, at, actor, subject, data }`. URLs must be http(s) without credentials (https only in production). The host is resolved at delivery time and refused (400 when saving, a failed delivery otherwise) if any address is loopback, private, link-local, CGNAT, multicast, IPv4-mapped IPv6 or a cloud metadata address; the connection is pinned to the checked address and redirects are not followed. To reach internal targets set `TRAMA_OUTBOUND_ALLOW_PRIVATE=true` or list hosts in `TRAMA_OUTBOUND_ALLOWED_HOSTS` (see `.env.example`). At most 20 webhooks per workspace. Limits: delivery is in-process (no durable queue), events emitted inside a transaction that later rolls back are still delivered.

## Notifications

Created on the server from domain events, for one person each, and never for whoever caused the event. Kinds (each switchable per channel; defaults: in-app on, email off, push on): `assigned`, `review_requested`, `ci_failed`, `comment`. A notification's `link` is relative to the workspace (`tasks/CORA-142`). The recipient must still be a workspace member. The same message within a minute is stored once. Read notifications are removed after 90 days. A new one reaches only that person's live stream (`entity: "notification"`), so it never triggers a snapshot refetch. Email goes out through `SMTP_URL` (see Invitations); without it the email channel does nothing. Push is Web Push to the devices a person registered (`PUT /me/push/subscription`): it needs `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (`npx web-push generate-vapid-keys`, optional `VAPID_SUBJECT`); without them the push channel does nothing. The payload follows Angular's service worker format, so a click opens the notification's page. Subscriptions the browser reports gone (404/410) are deleted.
