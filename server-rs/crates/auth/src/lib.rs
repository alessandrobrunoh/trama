//! Authentication and authorization of the Trama API: the port of `server/src/auth` and
//! `server/src/workspaces/access.guard.ts`, plus the `/api/auth/*` routes.
//!
//! # Declaring routes: [`Routes`] and [`Gate`]
//!
//! Every module registers its handlers through [`Routes`] (not a bare `axum::Router`), and every
//! registration names a [`Gate`], the Rust form of the NestJS metadata decorators:
//!
//! | NestJS | Rust |
//! | --- | --- |
//! | *(nothing)* | [`Gate::authenticated()`]: signed in; on `/w/{slug}` a member, `viewer` gate for GET and `member` gate for writes |
//! | `@Public()` | [`Gate::public()`] |
//! | `@Roles('admin')` | `.roles(LegacyRole::Admin)` |
//! | `@Can(Capability.ManageAgents)` | `.can(Capability::ManageAgents)` |
//! | `@AllowCustomToken()` | `.allow_custom_token()` |
//! | `@SessionOnly()` | `.session_only()` |
//! | `@RequireUser()` | `.require_user()` |
//! | `@Multipart()` | `.multipart()` |
//! | `@NoGuests()` | `.no_guests()` |
//!
//! Decorators on the NestJS controller become a `const` the handlers extend, so a handler-level
//! decorator overrides the class one exactly like `getAllAndOverride`:
//!
//! ```
//! use axum::Json;
//! use axum::extract::State;
//! use trama_auth::{Ctx, Gate, Routes};
//! use trama_contracts::roles::{Capability, LegacyRole};
//! use trama_core::{AppError, AppState};
//!
//! /// `@Roles('admin')` on `AgentsController`.
//! const ADMIN: Gate = Gate::authenticated().roles(LegacyRole::Admin);
//!
//! async fn list(ctx: Ctx, State(_state): State<AppState>) -> Result<Json<Vec<String>>, AppError> {
//!     // `ctx.workspace`, `ctx.settings`, `ctx.actor`, `ctx.role`, `ctx.access`, …
//!     Ok(Json(vec![ctx.workspace.slug.clone()]))
//! }
//!
//! async fn create(ctx: Ctx) -> Result<(), AppError> {
//!     if !ctx.can_do(Capability::ManageAgents) { return Err(AppError::forbidden("…")) }
//!     Ok(())
//! }
//!
//! pub fn router() -> Routes {
//!     Routes::new()
//!         .get("/w/{slug}/agents", Gate::authenticated(), list)
//!         .post("/w/{slug}/agents", ADMIN.can(Capability::ManageAgents), create)
//! }
//! # let _ = router();
//! ```
//!
//! Paths are relative to `/api` with axum's `{param}` syntax; the workspace segment is always
//! `{slug}`. Status codes stay the handler's business (`201` for a NestJS `@Post` unless it has
//! `@HttpCode`). A module crate exposes `pub fn router() -> Routes`; `trama-api` merges them and
//! calls [`Routes::into_router`]. Tests use [`Routes::into_app`].
//!
//! Forgetting a gate is impossible (it is an argument), and anything that still reaches the
//! guard without an entry gets [`Gate::authenticated()`]. A method nobody registered on a known
//! path answers `404 Cannot <METHOD> <path>`, as NestJS does.
//!
//! # What the guard checks
//!
//! See [`guard`] for the order (it decides which error wins). After it passes, the request
//! carries:
//!
//! * [`Auth`] (`@Auth()`): an [`AuthInfo`] with the actor, the user (absent for agent tokens),
//!   the API token ([`AuthToken`], absent for sessions), the method and the session id. Fails
//!   with 401 on a public route; take `Option<Auth>` there.
//! * [`Ctx`] (`@Ctx()`): a [`WorkspaceContext`] on `/w/{slug}` routes: workspace row and resolved
//!   settings, actor, user id, role id (`member` for agents), token scope, the member access,
//!   whether the request is still the owner, and the capabilities after the token cap. Helpers:
//!   [`WorkspaceContext::can_do`] (`canDo`), [`WorkspaceContext::is_owner`] (`isOwner`),
//!   [`WorkspaceContext::has_admin_power`] (`hasAdminPower`), [`WorkspaceContext::has_role`]
//!   (`hasRole`).
//! * [`Actor`] (`@Actor()`): the acting [`trama_contracts::ActorRef`].
//!
//! # Project scope in services
//!
//! For `/w/{slug}` routes the handler runs inside two task-locals (the NestJS
//! `AsyncLocalStorage` stores), so services need no extra parameter:
//!
//! * [`member_access::current_access`]: `None` = not narrowed;
//! * [`member_access::project_hidden`] (`projectHidden`) and
//!   [`member_access::assert_can_use_project`] (`assertCanUseProject`, 403 `Outside the projects
//!   you can access`) for one record;
//! * [`member_access::apply_project_scope`] (`applyProjectScope`) for a list query:
//!   `apply_project_scope(issues::Entity::find(), issues::Column::ProjectId)`, or
//!   [`member_access::project_scope_condition`] / [`member_access::project_scope_expr`] to combine
//!   with other conditions or aliased columns;
//! * [`member_access::can_view`] for a whole resource and [`member_access::scope_snapshot`] for
//!   the snapshot;
//! * [`upload_caller::current_upload_caller`] (`currentUploadCaller`) for upload checks.
//!
//! Both are lost across `tokio::spawn`: capture them first and re-enter with
//! [`member_access::with_access`] / [`upload_caller::with_upload_caller`].
//!
//! # Services for other crates
//!
//! * [`tokens`]: `create_token`, `revoke`, `authenticate`, `enforce_limits`, `resolve_limits`,
//!   [`tokens::ApiTokenView`] (the wire form of a token row);
//! * [`permissions`]: `required_permission`, `normalize_permissions`, `is_upload_bytes_route`;
//! * [`service`]: password hashing, users, sessions, `workspaces_of`, [`WorkspaceWithRole`];
//! * [`personal_workspace`]: `ensure_personal_workspace` and the workspace slug rules
//!   (`base_slug`, `slug_with_suffix`, `free_slug`, `RESERVED_SLUGS`, `is_valid_slug`);
//! * [`cookies`]: the session `Set-Cookie` values and the `Cookie` parser.

pub mod context;
pub mod cookies;
pub mod gate;
pub mod guard;
pub mod member_access;
pub mod permissions;
pub mod personal_workspace;
pub mod router;
pub mod schemas;
pub mod service;
pub mod tokens;
pub mod upload_caller;

pub use context::{Actor, Auth, AuthInfo, AuthMethod, AuthToken, Ctx, WorkspaceContext};
pub use gate::{Gate, Routes};
pub use router::{ApiDoc, router};
pub use service::WorkspaceWithRole;
