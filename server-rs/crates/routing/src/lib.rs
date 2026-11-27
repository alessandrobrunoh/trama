//! Routing rules for bringing legitimate external integration events into project tasks.
//!
//! [`service`] is also the public API used by webhook handlers and importers to resolve a source
//! to its project. Rule writes and management routes are exposed under
//! `/w/{slug}/projects/{projectId}/routing-rules`.
pub mod inbound;
pub mod outbound;
pub mod router;
pub mod schemas;
pub mod service;
pub mod source_path;

pub use router::{ApiDoc, router};
