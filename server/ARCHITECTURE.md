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
  events/                         EventsService (record + SSE), WorkstreamBus, EventsController (list + stream), request-store
  teams repositories workstreams milestones input-requests issues artifacts decisions dependencies comments views
  snapshot/ health/
  status/ attention/ graph/ search/ agent-context/   (backend-intelligence)
```

## Request pipeline

1. `requestStoreMiddleware` stores `X-Client-Id` in an AsyncLocalStorage (so `EventsService.publish` can echo it).
2. **`AccessGuard`** (global `APP_GUARD`, `workspaces/access.guard.ts`) runs for every route except `@Public()`:
   authenticates (`Authorization: Bearer nbl_…` → `TokensService`, else the `nabla_session` cookie → `AuthService`) → `req.auth: AuthInfo`;
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

Routes are declared as `@Controller('w/:slug/<things>')`; every query must be scoped by `ctx.workspace.id` (all domain rows carry `workspaceId`; it is hidden from the wire on input requests/artifacts because the contract has no such field).

Agent tokens: `actor = { type: 'agent', id }`, role `member`, `ctx.userId` undefined (guard user-only logic with `@RequireUser()` or check `ctx.userId`). User tokens act as the user with that user's membership role.

## Serialization

Entities extend `Wire` (`database/entities/wire.ts`): `toJSON()` drops `null`/`undefined` (the contract uses optional fields) and the keys returned by `hidden()` (`passwordHash`, `tokenHash`, integration `secret`/`webhookSecret`/`config`, internal `workspaceId`). Services return entities directly. (The `Execution` concept was removed by migration `DropExecutions`; the domain no longer has an execution entity or service.)

## Events

`EventsService` (global, `events/events.service.ts`):

```ts
record({ workspaceId, actor, type, subject: {type, id}, workstreamId?, data?, at?, manager? }, live?)
  // inserts a DomainEvent AND publishes a LiveEvent for SSE. `<x>.created` → created, `<x>.deleted` → deleted, else updated.
  // live = false  → persist only;   live = { type, entity, id } → custom LiveEvent.
publish(workspaceId, { type, entity, id })   // LiveEvent only (clientId + at added automatically)
stream$                                       // Observable<{ workspaceId, event }> backing GET /events/stream
```

Every mutating service calls `record(...)`. Event types are listed in API.md; add new types freely (they are plain strings).

### WorkstreamTouched bus (extension point for the status engine)

`WorkstreamBus` (global, `events/workstream-bus.ts`):

```ts
bus.onTouched(handler: (e: { workspaceId, workstreamId, reason }) => void | Promise<void>): () => void  // returns unsubscribe
bus.touch(workspaceId, workstreamId, reason): Promise<void>        // awaits handlers sequentially, errors logged not thrown
bus.touchMany(workspaceId, workstreamIds, reason): Promise<void>
```

Fired (and awaited, so the response is consistent) after any change to a workstream or its criteria, input requests, artifacts, decisions (origin + related), dependencies (both ends) and linked issues. The status engine (`status/status.service.ts`) subscribes in `onModuleInit`, recomputes `status` / `derivedStatus` / `shippedAt` on `workstreams`, and on a change records `workstream.status_changed` (system actor) and publishes a live event; see "Intelligence modules" below. `status = statusOverride ?? derivedStatus`.

## Numbering

`CountersService.next(manager, workspaceId, name)` is an atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` on `workspace_counters`: `wskey:<teamKey>` (workstream numbers per team key, so they survive deleting and recreating a team), `issue:<kind>` (BUG-142), `adr` (ADR-21). Call it inside the transaction that inserts the numbered row. Workstream creation uses `nextAbove(…, max number already used with that key prefix)`, so a key kept by a reassigned workstream can never be handed out again; a leftover unique violation is mapped to 409. Changing a workstream's owner team keeps its key. Changing an issue's `kind` takes the next number of the new kind and keeps the old key in `aliases` (lookups match aliases).

## Database

- Entities: `database/entities/index.ts` (every table, `ENTITIES` array). Migration: `database/migrations/*-NablaBaseline.ts` (registered explicitly in `migrations/index.ts`). `synchronize` is off; `migrationsRun` is on.
- The database named in `DATABASE_URL` is created on boot if missing (`database/ensure-database.ts`, connects to `postgres` first).
- Add a table/column: edit the entity, then `npm run migration:generate -- src/database/migrations/<Name>` (builds first; generated file is `.js`, convert it to a `.ts` class like the baseline), register it in `migrations/index.ts`.
- Polymorphic references (dependencies `from/to`, comments/events `subject`) have no FKs: services clean them up on delete. Events keep `workstreamId` without an FK so history survives deletion.
- Integration secrets: `integration_connections.secret` / `webhookSecret` hold `encryptSecret()` output (AES-256-GCM, key from `SECRETS_KEY`); the entity never serializes them (`webhookConfigured` is derived). `config` (jsonb) is for non-secret provider settings and is also hidden.
- `attention_state(userId, workspaceId, itemId, state, snoozedUntil, since)` exists for the attention module.

## Seed

`database/seed/` (`builder.ts` = fluent builder that also writes the event history, `seed-data.ts` = the Acme data, `seed.service.ts`). Runs on boot when `users` is empty (not in production, `SEED_DEMO=false` disables); `POST /api/admin/reset` re-runs it (only with `TRAMA_ENABLE_ADMIN_RESET=true`, never in production). Stored statuses follow the rules in `status/derive-status.ts`. Keep the seed valid when you add columns (there is a unit test).

## How to add a domain module

1. Entity in `database/entities/index.ts` + add to `ENTITIES` + migration.
2. `src/<name>/<name>.module.ts` (`TypeOrmModule.forFeature([...])`), `.service.ts`, `.controller.ts` with `@Controller('w/:slug/<name>')`, add the module to `AppModule`.
3. Controller methods take `@Ctx() ctx` and `@Actor() actor`; add `@Roles('admin')` on admin-only writes.
4. Scope every query by `ctx.workspace.id`; validate foreign ids with `RefsService`.
5. After persisting: `events.record(...)`, and `await bus.touch(workspaceId, workstreamId, reason)` if the change affects a workstream.
6. e2e test in `test/` (helpers `Client`, `TokenClient`, `createTestApp` in `test/app.ts`).

Other agents: `server/src/{attention,status,graph,search,agent-context,mcp}` belong to backend-intelligence (the MCP server is the separate Rust crate in `mcp/`), `server/src/{integrations,webhooks}` to backend-integrations. Webhook routes should be `@Public()` and verify signatures themselves; integration routes under `/w/:slug/integrations` should use `@Roles('admin')`.

## Testing

`npm test` (unit, `*.spec.ts`), `npm run test:e2e` (supertest against a freshly recreated `nabla_core_test` database in the same container; `SEED_DEMO=false`). `npm run lint` (oxlint type-aware), `npm run build`.

## Integrations and webhooks (`src/integrations`, `src/webhooks`)

```
integrations/  secrets.service (AES-256-GCM, TRAMA_ENCRYPTION_KEY, AAD = connection id + field)
               http-client (abstract HttpClient DI token; FetchHttpClient; tests override it, nothing hits the network)
               providers (GithubClient / GitlabClient: currentUser, listRepositories, getRepository; rate-limit aware errors)
               integrations.service/controller (connections CRUD, rotate secret, remote repos, link repository)
               artifact-linker.service (candidate -> Artifacts via ArtifactsService; keys from branch names, titles and descriptions, CI by sha)
               keys.ts (workstream key extraction), candidates.ts (normalized PR/MR + CI patch), entities.ts
webhooks/      controller (@Public), service (verify -> dedupe -> parse -> apply), events.ts (pure payload mapping),
               signatures.ts, raw-body.ts (JSON-parser `verify` hook, /api/webhooks/* only), fixtures.ts (test payloads)
```

- Flow: `WebhooksService.handle` loads the connection, decrypts the webhook secret, verifies the signature against the raw body, claims the delivery id (`webhook_deliveries`, `ON CONFLICT DO NOTHING`), maps the payload with the pure functions in `events.ts` (`PayloadError` -> 400), resolves the `Repository` by provider + full name, then `ArtifactLinkerService.upsert/applyCi`. Artifacts are created/updated through `ArtifactsService`, so events and `WorkstreamBus.touch` behave as for manual edits. Webhooks run as actor `{ type: 'system' }`.
- Tables (migration `1791500000000-IntegrationsWebhooks`): `webhook_deliveries`, `artifact_sources(artifactId, repositoryId, headSha, headBranch)` — git coordinates so CI events, which only know a sha, can find their PR/MR. `integration_connections.config` (hidden) holds `repositoryIds` (linked repositories) and `lastWebhookAt`.
- The linker serializes work per artifact identity with an in-process lock; running several API instances would need a DB unique index or advisory locks instead.
- Adding a webhook event: extend `events.ts` (pure, add a unit test with a fixture), then the `ParsedEvent` kind is applied by `WebhooksService.apply`. Adding a provider call: extend `GitProviderClient` in `providers.ts`.

## Intelligence modules

**Status engine flow** (`status/`): a domain service persists a change and `await bus.touch(workspaceId, workstreamId, reason)` → `StatusService.onTouched` loads the workstream's open input requests, artifacts, proposed decisions that originate from it and the incoming dependencies (with the sources' current status/state) → pure `deriveStatus()` (`derive-status.ts`, first matching rule wins, returns `{ status, derivedStatus, rule, delivery }`; `delivery` (none / in_review / merged / released / deployed) is evidence from artifacts and is stored in `workstreams.delivery`, separate from the outcome: `shipped` additionally requires met criteria and no blockers, open input requests or proposed decisions) → if `derivedStatus`/`status` changed, update the row (+ `shippedAt` the first time), record `workstream.status_changed` (system actor) → re-derive dependents (workstreams with edges *from* this workstream; cascades while statuses change, cycle-safe) → publish a `LiveEvent` of type `attention`. `onApplicationBootstrap` re-derives all workstreams; `SeedService.reset()` touches every seeded workstream through the bus (an additive hook). `blockers()` in `derive-status.ts` is shared with attention.

**Attention** (`attention/`): `attention-rules.ts` is a pure function (`computeAttention(data)`) from workspace rows to items with an *audience* (user ids); `AttentionService` loads the rows, adds event-log `since` timestamps (one SQL), filters by audience and merges per-user `attention_state`. Nothing is stored for items themselves. **Graph / search / agent-context** are read-only services over the same tables (raw ILIKE SQL for search).

## Access control, token scopes and outgoing webhooks

`@Can(capability)` (auth/request-context.ts) makes `AccessGuard` take the minimum role from `workspace.resolved().permissions` instead of a hard-coded `@Roles`. Token scopes cap the effective role in the guard (`capRole`), so every `ctx.role` check downstream already respects them; `ctx.memberRole` is the uncapped role. `@EditsTeamWork('workstream'|'issue')` calls `PermissionsService.enforceTeamScope` (team `editPolicy`). Migration `1791820000000-AccessWebhooks`. `src/outgoing-webhooks`: `EventsService.recorded$` (emits every non-backdated DomainEvent after persisting) feeds `OutgoingWebhooksService`, which delivers through the injectable `HttpClient` (tests override it) and logs to `outgoing_webhook_deliveries`.
