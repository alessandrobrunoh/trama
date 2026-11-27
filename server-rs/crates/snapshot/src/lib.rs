//! The workspace snapshot (`server/src/snapshot`): everything the client needs to boot a
//! workspace in one call.
//!
//! * `GET /api/w/:slug/snapshot` ([`router`]): a member's [`WorkspaceSnapshot`] — the workspace,
//!   the caller, the people and agents, the projects, milestones, tasks, artifacts and comments
//!   (or the bounded `commentIndex`), the recent events, the caller's attention items, the saved
//!   views, and the integration connections for whoever may manage them.
//! * [`service::build`] is the port of `SnapshotService.build`; it reuses the comments, views,
//!   attention, integrations, milestones and issues services, reads the other rows through the
//!   entities, and ends with [`scope_snapshot`] so a guest or a project-limited member only
//!   receives what their access allows.

pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
