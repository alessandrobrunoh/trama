//! Operational endpoints: the health check used by Docker and load balancers.

pub mod router;
pub mod schemas;

pub use router::{ApiDoc, router};
