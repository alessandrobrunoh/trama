//! Project milestones of the Trama API: the port of `server/src/milestones`.
//!
//! * [`router`]: `/api/w/{slug}/milestones` (list, read, create, reorder, edit, delete); writes
//!   need the `manageProjects` capability and a narrowed member only reaches the milestones of
//!   their projects;
//! * [`service`]: the same operations for other crates. [`service::list`] is what the
//!   workspace snapshot embeds and [`service::create`] what the importers call;
//! * [`scope`]: [`scope::prune_issue_milestones`], which keeps an issue in milestones of its own
//!   project only (called when an issue changes project, and when a project is deleted);
//! * [`dates`]: `@IsISO8601()` and `new Date(value)` for `targetDate`, for callers that pass
//!   dates in as strings.

pub mod dates;
pub mod router;
pub mod schemas;
pub mod scope;
pub mod service;

pub use router::{ApiDoc, router};
pub use scope::prune_issue_milestones;
pub use service::{MilestonePatch, NewMilestone};
