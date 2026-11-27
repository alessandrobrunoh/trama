# Porting a NestJS module to Rust

Rules every module port follows, so crates written in parallel fit together. The NestJS source in
`server/src` is the specification: the Rust crate must answer the same requests with the same
status codes, bodies and side effects.

## Crate shape

- One crate per domain in `crates/<name>`, package `trama-<name>`, added to
  `[workspace.dependencies]` in the root `Cargo.toml` as `trama-<name> = { path = "crates/<name>" }`.
  Use `version.workspace = true` (and edition, rust-version, publish) and `[lints] workspace = true`.
- Files: `lib.rs` (crate docs, `pub use router::{router, ApiDoc}`), `router.rs` (handlers, a
  `pub fn router() -> trama_auth::Routes` with paths relative to `/api`, and
  `#[derive(OpenApi)] pub struct ApiDoc`), `schemas.rs` (request/response bodies),
  `service.rs` (database work, callable from other crates). Split further when a file grows.
- Handlers are private `async fn`s annotated with `#[utoipa::path(...)]` (full path including
  `/api`, a `tag` named after the crate, every response status).
- Wire your crate in yourself: merge its `router()` in `routes()` in `src/lib.rs`, add its
  `ApiDoc` to `api_doc()` in `src/openapi.rs` (and a tag there), and add it to the root
  package's `[dependencies]`. Keep those lists sorted by crate name so parallel merges conflict
  only on adjacent lines.
- External dependencies come from `[workspace.dependencies]`; add new ones there.

## Wire format

- Response bodies are structs in `schemas.rs` with `#[serde(rename_all = "camelCase")]`,
  matching the TypeScript contract in `contracts/domain.ts` field for field, including which
  fields are omitted vs `null` (`#[serde(skip_serializing_if = "Option::is_none")]` for optional
  TS fields `foo?:`, plain `Option<T>` for `foo: T | null`).
- Types and rules that `contracts/domain.ts` already defines come from `trama-contracts`; use
  them instead of redefining them (`trama_contracts::issues::Issue`, `roles::role_allows`,
  `settings::resolve_workspace_settings`, `status::require_status`, …). Its crate docs explain
  the conventions. Endpoint-specific bodies (DTOs, list wrappers) stay in the module's
  `schemas.rs`.
- Dates: `trama_core::time::to_iso` (`2026-11-25T14:01:36.424Z`). Ids: `trama_core::ids::uid`
  with the NestJS prefix. Entities (`trama-entities`) are storage rows; map them into schemas.
- Status codes: NestJS answers 201 for `@Post` unless the controller sets `@HttpCode`; match it.

## Input

- JSON bodies: `trama_core::ApiJson<T>` (object only, NUL and list-size checks, unknown fields
  dropped, 413 `request entity too large` past 2 MB). Value rules:
  `trama_core::validation::Checks` with the same rules as the DTO's class-validator decorators.
  `@Clearable()` / `@OptionalNotNull()` fields: `#[serde(default)] Patch<T>`. `@IsThreadUrl()`:
  `trama_common::validation::thread_url`.
- Query strings: `axum::extract::Query` with a typed struct. A `%00` anywhere in the path or
  query is already refused with 400 by the HTTP layers (`RejectUnsafeInputPipe`).
- Error messages: the `AppError` constructors with the NestJS wording
  (`AppError::entity_not_found("Issue", key)` for `notFound(...)`).

## Configuration

Never read `std::env` in a module. Every variable NestJS reads is a field of
`trama_core::Config` (`state.config`), parsed with the NestJS defaults and quirks: `mail`,
`ai`, `grok`, `push` (VAPID), `rate_limit`, `outbound`, `encryption`, `seed`, `public_views`,
`app_url`, `public_url`, `mcp_url`, `trust_proxy`, `demo_login`, `admin_reset_enabled`,
`import_runner_enabled`, `sse_recheck_ms`, `webhook_retry_ms`, `production`. A variable NestJS
reads that is missing there belongs in `crates/core/src/config.rs` and `.env.example`.

In tests build configuration with `Config::from_vars(&[("NODE_ENV", "production")])`, not by
overriding single fields (derived values such as `outbound.require_https` would not follow).

## Platform services (`trama-common`)

Use these instead of writing your own; the crate docs list them all.

| Need | Use |
| --- | --- |
| Encrypt / decrypt integration credentials (`SecretsService`) | `Secrets::of(&state)?` then `.encrypt(plain, aad)` / `.decrypt(payload, aad)` (`v2`) |
| `encryptSecret` / `decryptSecret` / `sha256` | `Secrets::encrypt_secret` / `decrypt_secret`, `crypto::sha256_hex` |
| `SecretsService.generateWebhookSecret()` | `crypto::generate_webhook_secret()` |
| `safeRequest` | `SafeRequest::post(url).header(..).body(..).timeout(..).send(&state.config.outbound).await` |
| `outboundUrlProblem` | `safe_fetch::outbound_url_problem(url, &state.config.outbound).await` |
| `createSafeHttpsAgent` (Web Push) | `safe_fetch::guarded_client(&policy, Arc::new(SystemResolver))` |
| `MailService.send` / `.enabled` | `Mailer::of(&state).send(Mail { to, subject, text, html }).await` / `.enabled()` |
| `appUrl()` | `state.config.app_url` (`trama_common::app_url`) |
| `IntegrationsService.publicUrl(req)` | `proxy::public_base_url(&state.config, Some(&parts))` |
| `req.ip` | the `proxy::ClientIp` extractor, or `proxy::client_ip(..)` |
| `requestStore.getStore()?.clientId` | `trama_common::client_id()`; read it before `tokio::spawn` and pass it on, or wrap the task in `request_context::scope` |
| `CountersService.next/nextAbove/bumpTo` | `counters::next(&txn, ws, name)`, `next_above`, `bump_to` (pass the transaction) |
| `RefsService.projects/issues/users/resolveSubject` | `refs::projects(&db, ws, &ids)`, `issues`, `users`, `subject_exists` |
| `slugify`, `unique`, `isUniqueViolation` | `util::slugify`, `util::unique`, `util::is_unique_violation(&db_err)` |

Process-wide services are registered on `AppState` at startup
(`trama_common::with_platform_services`) and looked up by type with `state.extension::<T>()`;
a crate that needs another process-wide service (a broadcast bus, a cache) registers it the
same way in `run()` rather than adding a field to `AppState`. In tests register fakes with
`AppState::new(db, config).with_extension(Mailer::capture(&config))` and read
`mailer.sent()`.

## Auth, permissions and events

Use the `trama-auth` extractors and the `trama-events` API exactly as their crate docs describe.
Every permission check, role check and project scope in the NestJS controller or service must
have its Rust equivalent; every `events.record(...)`/`publish(...)` call must happen in the same
cases with the same payload.

Routes and gates (`trama_auth::{Routes, Gate}`):

- Register every handler with `Routes::new().get(path, gate, handler)` (`post`, `put`,
  `patch`, `delete`; `route_with` to layer one method router, e.g. a body limit). There is no
  gateless registration, and the guard treats anything without an entry as
  `Gate::authenticated()`.
- Translate the decorators: none → `Gate::authenticated()`, `@Public()` → `Gate::public()`,
  `@Roles('admin')` → `.roles(LegacyRole::Admin)`, `@Can(c)` → `.can(Capability::…)`,
  `@AllowCustomToken()`, `@SessionOnly()`, `@RequireUser()`, `@Multipart()`, `@NoGuests()` →
  the method of the same name. Class decorators become a `const` gate that the handlers extend
  (`const ADMIN: Gate = Gate::authenticated().roles(LegacyRole::Admin);`).
- Name the workspace segment `{slug}`: the guard resolves `/w/{slug}` (404 `Workspace "<slug>"
  not found` also for non-members, then the guest, token scope, role and capability 403s)
  before the handler runs. The guard derives the custom-token permission, the upload-bytes rule and the member
  grant from the path, so the path must be the NestJS one.

In handlers:

- `Ctx` (`@Ctx()`) is the `WorkspaceContext`: `ctx.workspace`, `ctx.settings`, `ctx.role`,
  `ctx.access`, `ctx.can_do(..)`, `ctx.is_owner()`, `ctx.has_admin_power()`.
- `Auth` (`@Auth()`) is the `AuthInfo` (`auth.user`, `auth.token`, `auth.require_user()?`);
  take `Option<Auth>` on a public route.
- `Actor` (`@Actor()`) is the acting `ActorRef`.

In services, project scoping reads the request's member access from a task-local, as NestJS
reads `AsyncLocalStorage`:

- `member_access::project_hidden`, `assert_can_use_project` for one record;
- `apply_project_scope(query, column)` or `project_scope_condition(column)` for lists;
- `can_view`, `scope_snapshot`;
- `upload_caller::current_upload_caller()`.

Both task-locals are lost across `tokio::spawn`: capture `current_access()` first and re-enter
with `with_access` (same for `with_upload_caller`).

### Recording and publishing events (`trama-events`)

`EventsService` is `trama_events::Events`: one process-wide, cheap-to-clone value registered on
the `AppState` at startup. In a handler or service that has the state, `let events =
Events::of(&state);` (a bare test state falls back to a shared process-local instance, so a
test sees its own events; to isolate a test, register `Events::local()` with
`with_extension`). Add `trama-events` to the crate's `[dependencies]`.

`events.record(...)` takes the connection to write with, so the transaction version needs no
extra parameter: pass `&txn` to write atomically with the mutation (NestJS `manager`), else
`&state.db`. It returns the stored `domain_events::Model`.

```rust
use trama_events::{Events, LiveChange, RecordEvent};
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::common::{SubjectRef, SubjectType};

let events = Events::of(&state);
let subject = SubjectRef { kind: SubjectType::Issue, id: issue.id.clone() };

// events.record({ workspaceId, actor, type: 'issue.created', subject, data }, <live>)
events.record(&txn, RecordEvent::new(&ws.id, actor.clone(), "issue.created", subject.clone())
    .data(json!({ "title": issue.title, "projectId": issue.project_id }))).await?;
// live: false
events.record(&txn, RecordEvent::new(..).without_live()).await?;
// a custom LiveEvent (still scoped by `subject`): { type: 'created', entity: 'comment', id }
events.record(&txn, RecordEvent::new(..).live(LiveChange::created(LiveEventEntity::Comment, &c.id))).await?;
// `at` (seed only): backdates the row and keeps it off `subscribe_recorded`
RecordEvent::new(..).at(when)
```

- The default live event is `<x>.created` → `created`, `<x>.deleted` → `deleted`, anything else
  → `updated`, with `entity` = the subject type and `id` = the subject id. `data` must be a JSON
  object (anything else stores `{}`). Keep the payloads of the NestJS call: `projectId`,
  `issueId`, `issueIds`, `projectIds` in `data` are what the visibility rules read for deleted
  records.
- Call `record` in the same cases and at the same point as NestJS (inside the transaction when
  NestJS passed `manager`). The live event goes out right after the insert, as in NestJS; it
  does not wait for the commit.
- `events.publish(ws, LiveChange::updated(LiveEventEntity::Workspace, id))` is
  `events.publish(ws, { type, entity, id })`. With a recipient: `publish_to_user(ws, change,
  user_id)` (notifications, favorites: only that person's streams, whatever their project
  access). With the owning record, so a narrowed member's project access decides:
  `publish_with(ws, change, None, Some(subject.into()))` (e.g. a comment event about its issue).
  `LiveChange::{created, updated, deleted, new}` build the change.
- `publish` is synchronous and returns at once. It stamps `at` and the request's `X-Client-Id`
  (`trama_common::client_id()`, a task-local like NestJS's `requestStore`): call it inside the
  request, or wrap work moved to `tokio::spawn` in `trama_common::request_context::scope(id, fut)`
  with the id read before spawning.
- Events travel as JSON on the Postgres channel `trama_live` (`NOTIFY`), byte-compatible with
  NestJS, so every API instance (also a NestJS one) pushes them to its streams. One `LISTEN`
  connection per process reconnects with a 1 s..30 s backoff; while it is down, events reach
  this instance's streams only.
- Subscribers: `events.subscribe()` is `stream$` (every `PublishedEvent` of every workspace)
  and `events.subscribe_recorded()` is `recorded$` (every `domain_events` row this instance
  wrote, not backdated ones). Both are `tokio::sync::broadcast` receivers: spawn a task that
  loops on `recv()`, and treat `RecvError::Lagged` as "resynchronise". Outgoing webhooks,
  notifications and two-way sync consume `recorded`.
- Project visibility of events: `trama_events::visibility::filter_events(&db, ws_id, events,
  ctx.access.as_ref())` (`EventVisibilityService.filterEvents`; works on `domain_events::Model`,
  `trama_contracts::activity::DomainEvent` and `visibility::ScopedRef`) and
  `visibility::is_live_visible(..)` (`isLiveVisible`). Use them for snapshots and any other
  place that returns events.

Test a module's routes with `router().into_app(state)` and real sessions or tokens
(`trama_auth::service::create_session`, `trama_auth::tokens::create_token`); the guard runs as
in production.

## Tests

- Port the module's NestJS `*.spec.ts` cases as Rust unit or integration tests, and cover each
  endpoint's behaviour from the relevant `server/test/*.e2e-spec.ts` files.
- Database tests: `let Some(test) = trama_core::testkit::TestDb::create().await else { return };`
  then `trama_migration::Migrator::up(&test.db, None)`, and `test.drop().await` at the end.
  Test routers with `tower::ServiceExt::oneshot`.
- Before committing, from `server-rs/`:
  `cargo fmt --all`, `cargo clippy --all-targets --all-features` (no warnings) and
  `TEST_DATABASE_URL=postgres://delta:delta@localhost:5435/trama_core_test cargo test --workspace`.
