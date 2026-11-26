//! The Trama domain contract in Rust: the wire types and pure rules of `contracts/domain.ts`.
//!
//! `contracts/domain.ts` is the single source of truth shared by the NestJS API, the Angular
//! client, the `trama` CLI and the MCP server. This crate is its Rust form, so every module crate
//! answers with the same JSON and applies the same rules:
//!
//! * **Wire types** (`Issue`, `Project`, `Membership`, `WorkspaceSnapshot`, …) are serde structs
//!   with camelCase field names. Optional TS fields (`foo?: T`) are `Option<T>` that are omitted
//!   when `None`; the contract never sends `null` for them (the NestJS `Wire.toJSON` drops nulls).
//!   Fields typed `T | null` (`nextCursor`, `ProjectPlacement::workspace_id`, …) are plain
//!   `Option<T>` and serialize `null`. Every type derives [`utoipa::ToSchema`], so a module's
//!   `ApiDoc` can list it in `components(schemas(...))`.
//! * **String-literal unions** (`Priority`, `IssueKind`, `TokenScope`, …) are Rust enums whose
//!   serde names are the exact TS strings. Each has `ALL` (declaration order), `as_str()`,
//!   `parse()` and `Display`, so entities that store the string convert with
//!   `Priority::parse(&row.priority)`.
//! * Values a workspace can redefine are plain strings on the wire: `Issue::status`,
//!   `Project::status` and `Project::health` hold status catalog ids (the seeded ids equal the
//!   semantic types, see [`status`]), and `Membership::role` holds a workspace role id.
//! * **Rules** are plain functions with the TS names in `snake_case`:
//!   [`roles::role_has_capability`], [`roles::role_allows`], [`roles::apply_token_scope`],
//!   [`access::effective_member_access`], [`settings::resolve_workspace_settings`],
//!   [`status::resolve_status_catalog`], [`labels::assign_label_ids`],
//!   [`projects::unique_project_key`], … Functions that normalize stored or client JSON take
//!   `&serde_json::Value`, exactly like the TS ones take `unknown`.
//!
//! Besides `domain.ts`, the crate holds pure rules NestJS keeps next to a module but several
//! modules use: the status lookups of `server/src/status` ([`status::load_status_catalog`],
//! [`status::require_status`], [`status::status_filter_ids`]), the saved-view label rewrite of
//! `server/src/labels` ([`labels::rewrite_label_filters`]), who may remove or demote whom
//! ([`member_rules`]), which people a project-limited caller sees ([`people_scope`]) and
//! constants imported across folders ([`common::ASSISTANT_TOKEN_NAME`]).
//!
//! ```
//! use trama_contracts::roles::{role_has_capability, Capability};
//! use trama_contracts::settings::resolve_workspace_settings;
//!
//! // A workspace row stores only what was customized; resolve it before reading roles.
//! let settings = resolve_workspace_settings(&serde_json::json!({}));
//! assert!(role_has_capability(&settings.roles, "owner", Capability::InviteMembers));
//! assert!(!role_has_capability(&settings.roles, "viewer", Capability::CreateIssues));
//! ```
//!
//! JavaScript semantics are kept where they change results: lengths and truncation count UTF-16
//! code units and `trim` uses the JS whitespace set ([`js`]), and whole numbers in `f64` fields
//! serialize without a fraction, as `JSON.stringify` does.

#[macro_use]
mod macros;

pub mod access;
pub mod activity;
pub mod common;
pub mod identity;
pub mod imports;
pub mod insights;
pub mod integrations;
pub mod issues;
pub mod js;
pub mod labels;
pub mod member_rules;
pub mod people_scope;
pub mod projects;
pub mod roles;
pub mod routing;
pub mod settings;
pub mod status;
pub mod views;

pub use access::{MemberAccess, MemberAction, MemberGrant, MemberProjectScope, MemberResource};
pub use common::{ActorRef, ActorType, Id, IsoDate, LegacySubjectRef, Priority, SubjectRef};
pub use roles::{Capability, TokenScope, WorkspaceRole};
pub use settings::WorkspaceSettings;
