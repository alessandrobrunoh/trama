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
- Do **not** edit `src/lib.rs` or `src/openapi.rs`; the integration step wires routers in.
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
  dropped). Value rules: `trama_core::validation::Checks` with the same rules as the DTO's
  class-validator decorators. `@Clearable()` fields: `#[serde(default)] Patch<T>`.
- Query strings: `axum::extract::Query` with a typed struct.
- Error messages: the `AppError` constructors with the NestJS wording
  (`AppError::entity_not_found("Issue", key)` for `notFound(...)`).

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
