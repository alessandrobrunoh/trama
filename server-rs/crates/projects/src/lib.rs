//! Projects of the Trama API: the port of `server/src/projects`.
//!
//! # Routes
//!
//! | Route | Gate |
//! | --- | --- |
//! | `GET /api/w/{slug}/projects` | any member; `status`, `health`, `leadId`, `q` filters |
//! | `GET /api/w/{slug}/projects/{id}` | any member |
//! | `POST /api/w/{slug}/projects` | 201, `manageProjects` |
//! | `PATCH /api/w/{slug}/projects/{id}` | `manageProjects`; `null` clears a clearable field |
//! | `DELETE /api/w/{slug}/projects/{id}` | 204, `manageProjects` |
//!
//! Writes need the `manageProjects` capability; reads are open to every member, and a narrowed
//! member only reaches the projects of their access (create always refuses: their list cannot
//! grow through the API).
//!
//! # Public API for other crates
//!
//! The functions of [`service`] are the `ProjectsService` of NestJS; reads take any connection
//! (`&state.db`), writes take the [`trama_core::AppState`] (they record the domain events) and the
//! acting [`trama_contracts::common::ActorRef`]. The request's project scope is read from the
//! `trama-auth` task-local; outside a request (the routing rules, the importers, the project
//! sharing of the invites module) nothing is hidden.
//!
//! | NestJS caller | Rust |
//! | --- | --- |
//! | `routing-rules.service.ts` → `projects.get(ws, id)` | [`service::get`] (the stored row) |
//! | `import-sink.ts` → `projects.create(ws, actor, input)` | [`service::create`]`(&state, ws, &actor,` [`NewProject`]`)` |
//! | `project-sharing.service.ts` → `projects.get(ws, id)` | [`service::get`] |
//! | `time-entries.service.ts` → `projects.get(ws, id)` | [`service::get`] |
//! | the workspace snapshot | [`service::list`]`(&db, ws, &`[`ProjectFilter`]`)` then [`present`] |
//!
//! Changing or deleting a project re-keys its issues through [`trama_issues::keys::rekey_issues`]
//! (which keeps the old keys as aliases) and records `issue.rekeyed` events for each.

pub mod icon;
pub mod router;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
pub use service::{NewProject, ProjectFilter, ProjectPatch};
