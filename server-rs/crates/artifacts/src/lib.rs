//! Task artifacts of the Trama API: the port of `server/src/artifacts`.
//!
//! An artifact is something a task produced or points to: a pull request, a build, a link, a
//! file. Every artifact has a task owner (`issueId`); it follows the task's project when the
//! caller's access is narrowed (hidden artifacts are neither listed nor readable, and cannot be
//! attached to or moved onto a hidden task).
//!
//! # Routes
//!
//! | Route | Notes |
//! | --- | --- |
//! | `GET /api/w/{slug}/artifacts` | filters `issueId`, `repository`, `kind`, `state` |
//! | `GET /api/w/{slug}/artifacts/{id}` | |
//! | `POST /api/w/{slug}/artifacts` | 201; needs `issueId` |
//! | `PATCH /api/w/{slug}/artifacts/{id}` | `null` clears a nullable field, not `issueId` |
//! | `DELETE /api/w/{slug}/artifacts/{id}` | 204 |
//! | `GET /api/w/{slug}/tasks/{idOrKey}/artifacts` | the owner comes from the path |
//! | `POST /api/w/{slug}/tasks/{idOrKey}/artifacts` | 201; the path wins over the body's `issueId` |
//!
//! `POST /api/w/{slug}/tasks/{idOrKey}/artifacts/upload` is served by `trama-uploads`; both
//! crates build the response with [`artifact_view`], so an artifact looks the same wherever it
//! comes from.
//!
//! # Public API for other crates
//!
//! The functions of [`service`] are the `ArtifactsService` of NestJS. They take the connection
//! (`&state.db`) or, when they record events, the [`trama_core::AppState`]; the request's
//! project scope is read from the `trama-auth` task-local, and background callers (webhooks,
//! the artifact linker) run unnarrowed.
//!
//! | NestJS | Rust |
//! | --- | --- |
//! | `list(ws, filter)` | [`service::list`]`(&db, ws, &`[`ArtifactFilter`]`)` |
//! | `get(ws, id)` | [`service::get`] |
//! | `countForIssue(ws, issueId)` | [`service::count_for_issue`] |
//! | `resolveIssueId(ws, idOrKey)` | [`service::resolve_issue_id`] |
//! | `create(ws, actor, { kind, … })` | [`service::create`]`(&state, ws, &actor, kind,` [`ArtifactInput`]`)` |
//! | `update(ws, actor, id, patch)` | [`service::update`] |
//! | `remove(ws, actor, id)` | [`service::remove`] |
//! | `isHttpUrl`, `artifactOwners` | [`service::is_http_url`], [`service::artifact_owners`] |
//!
//! Rows go to the wire through [`artifact_view`] (`ArtifactEntity.toJSON`).

pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
pub use service::{ArtifactFilter, ArtifactInput};
pub use trama_uploads::schemas::artifact_view;
