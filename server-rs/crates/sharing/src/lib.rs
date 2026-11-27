//! Shared with me, "Show in" placements and moving a project between workspaces: the port of
//! `server/src/sharing`.
//!
//! * `GET /api/shared/projects`, `PUT|DELETE /api/shared/projects/{projectId}/placement`,
//!   `POST /api/shared/projects/{projectId}/leave` ([`service`]): account-level routes, a browser
//!   session only. A project is shared with a person when they belong to its workspace through
//!   a membership limited to some projects (a guest); a placement is a per-person link
//!   (`project_placements`) that grants nobody anything.
//! * `GET /api/w/{slug}/projects/{id}/transfer-preview` and
//!   `POST /api/w/{slug}/projects/{id}/transfer` ([`transfer`]): move a project, with its issues,
//!   time, comments and history, to another workspace the caller administers. [`plan`] holds the
//!   pure mapping rules.
//!
//! The projects crate is not ported yet, so project rows are read through the entities directly.
//!
//! Other crates can call [`service::list`] (the projects a person reaches as a guest),
//! [`service::place`], [`service::hide`], [`service::clear`] and [`service::leave`].

pub mod invites;
pub mod plan;
pub mod router;
pub mod schemas;
pub mod service;
pub mod transfer;

pub use router::{ApiDoc, router};
