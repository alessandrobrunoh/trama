//! Public inbound webhook endpoints for GitHub, GitLab, and Bitbucket.
//!
//! Provider identity is authenticated before payload dispatch; delivery claims are scoped to
//! the integration connection and released when processing fails so the provider can retry.
mod router;

pub use router::{ApiDoc, router};
