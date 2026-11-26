//! Tasks (issues) of the Trama API: the port of `server/src/issues`.
//!
//! # Routes
//!
//! | Route | Notes |
//! | --- | --- |
//! | `GET /api/w/{slug}/tasks` | filters `kind`, `status`, `assigneeId`, `projectId`, `milestoneId`, `q`, `priority` (comma-separated), `open`, `limit` (1 to 500) |
//! | `GET /api/w/{slug}/tasks/{idOrKey}` | by id, key or a previous key; `artifactCount` for callers who can read artifacts |
//! | `GET /api/w/{slug}/tasks/{idOrKey}/context` | JSON, or the markdown briefing with `?format=markdown` / `Accept: text/markdown` |
//! | `POST /api/w/{slug}/tasks` | 201; needs `createIssues` |
//! | `PATCH /api/w/{slug}/tasks/{idOrKey}` | `null` clears a clearable field |
//! | `DELETE /api/w/{slug}/tasks/{idOrKey}` | 204; needs `deleteIssues` |
//! | `POST /api/w/{slug}/tasks/bulk` | 200; one patch for up to 100 tasks, all or nothing |
//! | `POST /api/w/{slug}/tasks/bulk-delete` | 200 `{ deleted }`; needs `deleteIssues` |
//!
//! # Public API for other crates
//!
//! The functions of [`service`] are the `IssuesService` of NestJS. Reads take any connection
//! (`&state.db`); writes take the [`trama_core::AppState`] (they record the domain events) and
//! the acting [`trama_contracts::ActorRef`]. The request's project scope is read from the
//! `trama-auth` task-local; outside a request (routing rules, the importers, the snapshot)
//! nothing is hidden.
//!
//! | NestJS | Rust |
//! | --- | --- |
//! | `get(ws, idOrKey)` | [`service::get`] |
//! | `getMany(ws, refs)` | [`service::get_many`] |
//! | `list(ws, filter)` | [`service::list`]`(&db, ws, &`[`IssueFilter`]`)` |
//! | `create(ws, actor, input, authorize)` | [`service::create`]`(&state, ws, &actor,` [`NewIssue`]`)` |
//! | `update(ws, actor, idOrKey, patch, authorize)` | [`service::update`]`(&state, ws, &actor, id_or_key,` [`IssueInput`]`)` |
//! | `updateMany`, `removeMany` | [`service::update_many`], [`service::remove_many`] |
//! | `remove(ws, actor, idOrKey, authorize)` | [`service::remove`] |
//! | `setExternalRef`, `refreshExternalRef` | [`service::set_external_ref`], [`service::refresh_external_ref`] |
//! | `visibleParentIds` | [`service::visible_parent_ids`] and [`service::hide_invisible_parents`] |
//! | `issueKeyPrefix`, `allocateIssueNumbers` | [`keys::issue_key_prefix`], [`keys::allocate_issue_numbers`] |
//! | `rekeyIssues` | [`keys::rekey_issues`] (mutates the rows in memory; [`service::save_rows`] writes them) |
//! | `applyStatusFacts`, `claimAssignee` | [`facts::apply_status_facts`], [`facts::claim_assignee`] |
//! | `renderIssueBriefing` | [`briefing::render_issue_briefing`] |
//!
//! Rows are [`trama_entities::issues::Model`]s; [`present`] is the wire [`trama_contracts::issues::Issue`]
//! (`IssueEntity.toJSON()`). The authorizer callbacks of the NestJS service (`assertTeams`) did
//! nothing but the project-hidden check the service already makes, and are gone.

pub mod briefing;
pub mod facts;
mod hierarchy;
pub mod keys;
pub mod router;
pub mod rows;
pub mod schemas;
pub mod service;

pub use keys::{IssueKeyChange, IssueRekeyReason};
pub use router::{ApiDoc, router};
pub use rows::present;
pub use service::{BulkIssuePatch, ExternalRefRefresh, IssueFilter, IssueInput, NewIssue};
