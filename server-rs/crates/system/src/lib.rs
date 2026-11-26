//! Operational endpoints: the health check used by Docker and load balancers, and the public
//! configuration the sign-in page reads (`GET /api/config`, the NestJS
//! `PublicConfigController`).

pub mod router;
pub mod schemas;

pub use router::{ApiDoc, router};
