//! Workspaces of the Trama API: the port of `server/src/workspaces` without the access guard and
//! the personal workspace (those live in `trama-auth`).
//!
//! # Routes
//!
//! `/api/workspaces`, `/api/w/{slug}` (rename, delete, transfer ownership), `…/settings`,
//! `…/roles`, `…/members`, `…/agents`, `…/tokens`, `…/labels` and `…/statuses`, each behind the
//! `trama_auth::Gate` of its NestJS decorators. [`router`] returns them, [`ApiDoc`] documents
//! them.
//!
//! # Services other crates call
//!
//! * [`labels::assign`] (`LabelsService.assign`): validates the `labels` of an issue or project
//!   against the workspace catalog, returning the de-duplicated ids (`None` when the caller sent
//!   none);
//! * [`labels::catalog_of`] and [`statuses::catalog_of`]: the resolved catalogs of a workspace
//!   row;
//! * [`service::list_members`] with a [`service::MemberViewer`]: the memberships a caller may
//!   see, already narrowed by [`people_scope`] (`visibleMemberships`); [`member_rules`] holds who
//!   may remove or demote whom. Both are re-exported from `trama-contracts`;
//! * [`service::list_agents`] (project-scoped like `listAgents`), [`service::get_agent`],
//!   [`service::agent_view`];
//! * the workspace, role, member, agent and token functions behind the routes, which publish the
//!   same live events as NestJS.

mod catalog;
pub mod labels;
mod members;
pub mod router;
pub mod schemas;
pub mod service;
pub mod statuses;
mod validate;

pub use router::{ApiDoc, router};
pub use trama_contracts::{member_rules, people_scope};
