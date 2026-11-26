//! Response bodies of the system endpoints.

use serde::Serialize;
use utoipa::ToSchema;

/// The API is up and the database answers.
#[derive(Debug, Serialize, ToSchema)]
pub struct HealthUp {
    /// Always `ok`.
    #[schema(example = "ok")]
    pub status: &'static str,
    /// Always `up`.
    #[schema(example = "up")]
    pub db: &'static str,
    /// Server time, ISO 8601 in UTC with milliseconds.
    #[schema(example = "2026-11-25T14:01:36.424Z")]
    pub time: String,
}

/// Unauthenticated settings the sign-in page needs before a session exists.
#[derive(Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    /// Show the shared demo credentials (`DEMO_LOGIN`; unset: everywhere but production).
    pub demo_login: bool,
    /// Link token of the public roadmap Shared View (`PUBLIC_ROADMAP_VIEW_TOKEN`).
    pub roadmap_view_token: Option<String>,
    /// Link token of the public changelog Shared View (`PUBLIC_CHANGELOG_VIEW_TOKEN`).
    pub changelog_view_token: Option<String>,
}

/// The database does not answer (sent with 503).
#[derive(Debug, Serialize, ToSchema)]
pub struct HealthDown {
    /// Always `error`.
    #[schema(example = "error")]
    pub status: &'static str,
    /// Always `down`.
    #[schema(example = "down")]
    pub db: &'static str,
}
