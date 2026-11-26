# Porting a NestJS module to Rust

Rules every module port follows, so crates written in parallel fit together. The NestJS source in
`server/src` is the specification: the Rust crate must answer the same requests with the same
status codes, bodies and side effects.

## Crate shape

- One crate per domain in `crates/<name>`, package `trama-<name>`, added to
  `[workspace.dependencies]` in the root `Cargo.toml` as `trama-<name> = { path = "crates/<name>" }`.
  Use `version.workspace = true` (and edition, rust-version, publish) and `[lints] workspace = true`.
- Files: `lib.rs` (crate docs, `pub use router::{router, ApiDoc}`), `router.rs` (handlers, a
  `pub fn router() -> Router<AppState>` with paths relative to `/api`, and
  `#[derive(OpenApi)] pub struct ApiDoc`), `schemas.rs` (request/response bodies),
  `service.rs` (database work, callable from other crates). Split further when a file grows.
- Handlers are private `async fn`s annotated with `#[utoipa::path(...)]` (full path including
  `/api`, a `tag` named after the crate, every response status).
- Wire your crate in yourself: merge its `router()` in `app()` in `src/lib.rs`, add its
  `ApiDoc` to `api_doc()` in `src/openapi.rs` (and a tag there), and add it to the root
  package's `[dependencies]`. Keep those lists sorted by crate name so parallel merges conflict
  only on adjacent lines.
- External dependencies come from `[workspace.dependencies]`; add new ones there.

## Wire format

- Response bodies are structs in `schemas.rs` with `#[serde(rename_all = "camelCase")]`,
  matching the TypeScript contract in `contracts/domain.ts` field for field, including which
  fields are omitted vs `null` (`#[serde(skip_serializing_if = "Option::is_none")]` for optional
  TS fields `foo?:`, plain `Option<T>` for `foo: T | null`).
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

## Tests

- Port the module's NestJS `*.spec.ts` cases as Rust unit or integration tests, and cover each
  endpoint's behaviour from the relevant `server/test/*.e2e-spec.ts` files.
- Database tests: `let Some(test) = trama_core::testkit::TestDb::create().await else { return };`
  then `trama_migration::Migrator::up(&test.db, None)`, and `test.drop().await` at the end.
  Test routers with `tower::ServiceExt::oneshot`.
- Before committing, from `server-rs/`:
  `cargo fmt --all`, `cargo clippy --all-targets --all-features` (no warnings) and
  `TEST_DATABASE_URL=postgres://delta:delta@localhost:5435/trama_core_test cargo test --workspace`.
