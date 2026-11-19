# Server architecture (backend core)

NestJS 12 (ESM), TypeORM 1 + Postgres 18, class-validator DTOs, vitest + supertest. No ORM relations: entities are flat rows with explicit foreign keys in the baseline migration; services validate cross-references through `RefsService`.

```
src/
  main.ts / configure-app.ts      bootstrap, /api prefix, ValidationPipe(whitelist), CORS(credentials)
  app.module.ts                   wires every module; applies requestStoreMiddleware
  contracts/domain.ts             GENERATED copy of ../contracts/domain.ts, never edit
  common/                         uid(), CountersService, RefsService, crypto (AES-GCM, sha256), validation helpers
  database/                       entities/index.ts (all tables), migrations/, ensure-database, seed/, admin.controller
  auth/                           AuthService (users, sessions), TokensService, AuthController, request-context.ts (decorators)
  workspaces/                     AccessGuard (global), WorkspacesService + controllers (workspace, members, agents, tokens)
  events/                         EventsService (record + SSE), EventsController (list + stream), request-store
  projects milestones project-updates issues (the /tasks routes) artifacts documents comments views labels
  notifications favorites snapshot/ health/
  status/ (status catalog) attention/ search/ insights/   (backend-intelligence)
```

## Request pipeline

1. `requestStoreMiddleware` stores `X-Client-Id` in an AsyncLocalStorage (so `EventsService.publish` can echo it).
2. **`AccessGuard`** (global `APP_GUARD`, `workspaces/access.guard.ts`) runs for every route except `@Public()`:
   authenticates (`Authorization: Bearer trm_…` → `TokensService`, else the `trama_session` cookie (or the legacy `nabla_session`) → `AuthService`) → `req.auth: AuthInfo`;
   CSRF checks for cookie mutations (custom header + JSON);
   if the route has a `:slug` param resolves the workspace and the caller's role → `req.ctx: WorkspaceContext` (404 for non-members, 403 for a too-low role).
3. `ValidationPipe` (whitelist, transform) validates the DTO, the controller calls a service.

### Decorators (`auth/request-context.ts`)

| Name | Use |
|---|---|
| `@Public()` | skip authentication |
| `@Roles('admin')` | minimum workspace role for a handler/controller. Default: `viewer` for GET/HEAD/OPTIONS, `member` for everything else |
| `@RequireUser()` | reject agent tokens (needs a human principal) |
| `@Ctx() ctx: WorkspaceContext` | `{ workspace: WorkspaceEntity, actor: ActorRef, userId?, role }` |
| `@Actor() actor: ActorRef` | `{ type: 'user'\|'agent', id }` of the caller (use for `createdBy`, events) |
| `@Auth() auth: AuthInfo` | `{ actor, user?, token?, method, sessionId? }`, also on non-workspace routes |

Helpers: `hasRole(role, min)`, `ROLE_RANK`, types `AppRequest`, `WorkspaceContext`, `AuthInfo`.

Routes are declared as `@Controller('w/:slug/<things>')`; every query must be scoped by `ctx.workspace.id` (all domain rows carry `workspaceId`; it is hidden from the wire on artifacts because the contract has no such field). The public path for issues is `/w/:slug/tasks`; the internal type, table and subject type stay `Issue` / `issues` / `issue`, and the stored membership grants stay `issues:*` while API token permissions are `tasks:*`.

Agent tokens: `actor = { type: 'agent', id }`, role `member`, `ctx.userId` undefined (guard user-only logic with `@RequireUser()` or check `ctx.userId`). User tokens act as the user with that user's membership role.

## Serialization

Entities extend `Wire` (`database/entities/wire.ts`): `toJSON()` drops `null`/`undefined` (the contract uses optional fields) and the keys returned by `hidden()` (`passwordHash`, `tokenHash`, integration `secret`/`webhookSecret`/`config`, internal `workspaceId`). Services return entities directly. (The `Execution` concept was removed by migration `DropExecutions`; the domain no longer has an execution entity or service.)

## Events

`EventsService` (global, `events/events.service.ts`):

```ts
record({ workspaceId, actor, type, subject: {type, id}, data?, at?, manager? }, live?)
  // inserts a DomainEvent AND publishes a LiveEvent for SSE. `<x>.created` → created, `<x>.deleted` → deleted, else updated.
  // live = false  → persist only;   live = { type, entity, id } → custom LiveEvent.
publish(workspaceId, { type, entity, id })   // LiveEvent only (clientId + at added automatically)
stream$                                       // Observable<{ workspaceId, event }> backing GET /events/stream
```

Every mutating service calls `record(...)`. Event types are listed in API.md; add new types freely (they are plain strings).

## Numbering

Issue sequences use `issue-key:<prefix>` (`AUTH-142` or `UNPR-7`) and are atomic per workspace and prefix. `allocateIssueNumbers` checks retained aliases when first initializing a prefix counter, so a project tag can be reused without issuing an ambiguous old key. Project tags are unique in a workspace and limited to four characters; changing a tag or moving an issue re-keys affected issues and keeps prior keys in `aliases`. Changing an issue's `kind` only changes its classification. `adr` is a reserved project key.

## Database

- Entities: `database/entities/index.ts` (every table, `ENTITIES` array). Migration: `database/migrations/*-NablaBaseline.ts` (the file and class keep the old name because TypeORM tracks applied migrations by name; do not rename them) (registered explicitly in `migrations/index.ts`). `synchronize` is off; `migrationsRun` is on.
- The database named in `DATABASE_URL` is created on boot if missing (`database/ensure-database.ts`, connects to `postgres` first).
- Add a table/column: edit the entity, then `npm run migration:generate -- src/database/migrations/<Name>` (builds first; generated file is `.js`, convert it to a `.ts` class like the baseline), register it in `migrations/index.ts`.
- Polymorphic references (dependencies `from/to`, comments/events `subject`) have no FKs: services clean them up on delete.
- Removing a product area is a data migration, not just code: `1793860000000-RemoveObsoleteFeatures` deletes the comments, events, favorites, notifications, saved views and attention rows of the removed subjects (teams, repositories, decisions, input requests, releases, customers and intake), keeps every issue row, turns `team` actors into `system`, rewrites `issues:*` token permissions to `tasks:*` and drops the tables. It cannot be reversed (`down()` throws). `1793850000000-ProjectRepository` adds `projects.repository`, which the removal migration fills from the first linked registry repository.
- Integration secrets: `integration_connections.secret` / `webhookSecret` hold `encryptSecret()` output (AES-256-GCM, key from `SECRETS_KEY`); the entity never serializes them (`webhookConfigured` is derived). `config` (jsonb) is for non-secret provider settings and is also hidden.
- `attention_state(userId, workspaceId, itemId, state, snoozedUntil, since)` exists for the attention module.

## Seed

`database/seed/` (`builder.ts` = fluent builder that also writes the event history, `seed-data.ts` = the Acme data, `seed.service.ts`). Runs on boot when `users` is empty (not in production, `SEED_DEMO=false` disables); `POST /api/admin/reset` re-runs it (only with `TRAMA_ENABLE_ADMIN_RESET=true`, never in production). Keep the seed valid when you add columns (there is a unit test).

## How to add a domain module

1. Entity in `database/entities/index.ts` + add to `ENTITIES` + migration.
2. `src/<name>/<name>.module.ts` (`TypeOrmModule.forFeature([...])`), `.service.ts`, `.controller.ts` with `@Controller('w/:slug/<name>')`, add the module to `AppModule`.
3. Controller methods take `@Ctx() ctx` and `@Actor() actor`; add `@Roles('admin')` on admin-only writes.
4. Scope every query by `ctx.workspace.id`; validate foreign ids with `RefsService`.
5. After persisting: `events.record(...)`.
6. e2e test in `test/` (helpers `Client`, `TokenClient`, `createTestApp` in `test/app.ts`).

Other agents: `server/src/{attention,status,search,insights}` belong to backend-intelligence (the MCP server is the separate Rust crate in `mcp/`), `server/src/{integrations,webhooks}` to backend-integrations. Webhook routes should be `@Public()` and verify signatures themselves; integration routes under `/w/:slug/integrations` should use `@Roles('admin')`.

## Testing

`npm test` (unit, `*.spec.ts`), `npm run test:e2e` (supertest against a freshly recreated `trama_core_test` database in the same container; `SEED_DEMO=false`). `npm run lint` (oxlint type-aware), `npm run build`.

## Integrations and webhooks (`src/integrations`, `src/webhooks`)

```
integrations/  secrets.service (AES-256-GCM, TRAMA_ENCRYPTION_KEY, AAD = connection id + field)
               http-client (abstract HttpClient DI token; FetchHttpClient; tests override it, nothing hits the network)
               providers (GithubClient / GitlabClient: currentUser, listRepositories, getRepository; rate-limit aware errors)
               integrations.service/controller (connections CRUD, rotate secret, remote repos)
               artifact-linker.service (candidate -> Artifacts via ArtifactsService; keys from branch names, titles and descriptions, CI by sha)
               keys.ts (issue key extraction), candidates.ts (normalized PR/MR + CI patch), entities.ts
webhooks/      controller (@Public), service (verify -> dedupe -> parse -> apply), events.ts (pure payload mapping),
               signatures.ts, raw-body.ts (JSON-parser `verify` hook, /api/webhooks/* only), fixtures.ts (test payloads)
```

- Flow: `WebhooksService.handle` loads the connection, decrypts the webhook secret, verifies the signature against the raw body, claims the delivery id (`webhook_deliveries`, `ON CONFLICT DO NOTHING`), maps the payload with the pure functions in `events.ts` (`PayloadError` -> 400), finds the issue key in the payload, then `ArtifactLinkerService.upsert/applyCi`. The repository is kept as a plain full-name string on the artifact. Artifacts are created/updated through `ArtifactsService`, so events behave as for manual edits. Webhooks run as actor `{ type: 'system' }`.
- Tables (migration `1791500000000-IntegrationsWebhooks`): `webhook_deliveries`, `artifact_sources(artifactId, repository, headSha, headBranch)` — git coordinates so CI events, which only know a sha, can find their PR/MR. `integration_connections.config` (hidden) holds `lastWebhookAt`.
- The linker serializes work per artifact identity with an in-process lock; running several API instances would need a DB unique index or advisory locks instead.
- Adding a webhook event: extend `events.ts` (pure, add a unit test with a fixture), then the `ParsedEvent` kind is applied by `WebhooksService.apply`. Adding a provider call: extend `GitProviderClient` in `providers.ts`.

## Intelligence modules

`status/status-catalog.ts` holds the workspace status catalog. **Attention** (`attention/`): `AttentionService` derives `review_requested` and `ci_failed` items from the artifacts attached to tasks the caller can see, adds the per-user `attention_state` (dismissed / snoozed) and sorts by severity then age. Nothing is stored for the items themselves. **Search** is read-only raw ILIKE SQL over projects, issues, artifacts and documents.

## Access control, token scopes and outgoing webhooks

`@Can(capability)` (auth/request-context.ts) makes `AccessGuard` take the minimum role from `workspace.resolved().permissions` instead of a hard-coded `@Roles`. Token scopes cap the effective role in the guard (`capRole`), so every `ctx.role` check downstream already respects them; `ctx.memberRole` is the uncapped role. Teams and their edit policies no longer exist. Migration `1791820000000-AccessWebhooks`. `src/outgoing-webhooks`: `EventsService.recorded$` (emits every non-backdated DomainEvent after persisting) feeds `OutgoingWebhooksService`, which delivers through the injectable `HttpClient` (tests override it) and logs to `outgoing_webhook_deliveries`.
