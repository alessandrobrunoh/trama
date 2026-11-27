//! What an import reads from a tracker, before any mapping (`importers/types.ts`).

use std::fmt;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use trama_contracts::common::Priority;
use trama_contracts::imports::{ExternalProvider, ExternalStateType, ImportOptions};
use trama_integrations::{HttpFailure, ProviderHttpError};

/// A person in the external tracker. GitHub gives a login only; Linear gives an email.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalUser {
    /// Tracker id.
    pub id: String,
    /// GitHub login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    /// Display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Email (Linear).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// A tracker state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalState {
    /// Tracker id.
    pub id: String,
    /// Name.
    pub name: String,
    /// The tracker's own category: GitHub `open` / `closed` / `not_planned`, Linear `triage` …
    /// `canceled`.
    #[serde(rename = "type")]
    pub kind: String,
}

/// A tracker label.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalLabel {
    /// Tracker id.
    pub id: String,
    /// Name.
    pub name: String,
    /// `#rrggbb` when the tracker has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// A tracker milestone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMilestone {
    /// Tracker id.
    pub id: String,
    /// Name.
    pub name: String,
    /// The external project it belongs to (GitHub: the repository pseudo-project).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Due date (`YYYY-MM-DD` or an ISO timestamp, as the tracker gives it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_on: Option<String>,
}

/// A tracker issue.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalIssue {
    /// Stable id (see `ExternalRef.id`): `owner/repo#12` lower-cased, or the Linear uuid.
    pub id: String,
    /// `#12` / `ENG-123`.
    pub key: String,
    /// Link.
    pub url: String,
    /// Title.
    pub title: String,
    /// Body.
    pub body: Option<String>,
    /// State.
    pub state: ExternalState,
    /// Priority, when the tracker has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// Estimate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate: Option<f64>,
    /// Labels.
    pub labels: Vec<ExternalLabel>,
    /// Assignee.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<ExternalUser>,
    /// Creator.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<ExternalUser>,
    /// Linear team.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// External project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Milestone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone: Option<ExternalMilestone>,
    /// ISO creation time as the tracker wrote it.
    pub created_at: String,
    /// ISO update time.
    pub updated_at: String,
    /// ISO start time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// ISO close time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
}

/// A tracker comment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalComment {
    /// Tracker id.
    pub id: String,
    /// Id of the external issue it belongs to.
    pub issue_id: String,
    /// Author.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<ExternalUser>,
    /// Body.
    pub body: String,
    /// ISO creation time.
    pub created_at: String,
}

/// One page of a listing.
#[derive(Clone, Debug, PartialEq)]
pub struct Page<T> {
    /// Items.
    pub items: Vec<T>,
    /// Opaque cursor for the next page, `None` at the end.
    pub next: Option<String>,
}

/// A team, project or label the source offers.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredEntity {
    /// Tracker id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Key (Linear team key).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// `#rrggbb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Issues using it, when the tracker tells cheaply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

/// Issue counts of a source. `None` when the tracker cannot count without reading everything.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryCounts {
    /// Issues.
    pub issues: Option<i64>,
    /// Open issues.
    pub open: Option<i64>,
    /// Closed issues.
    pub closed: Option<i64>,
}

/// A state with how many issues are in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredState {
    /// The state.
    #[serde(flatten)]
    pub state: ExternalState,
    /// Issues in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

/// A sample issue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SampleIssue {
    /// Key.
    pub key: String,
    /// Title.
    pub title: String,
    /// State name.
    pub state: String,
}

/// What a source offers, before any mapping.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    /// Tracker.
    pub provider: ExternalProvider,
    /// The account the credential belongs to (`public` without one).
    pub account: String,
    /// `owner/name` or the Linear workspace.
    pub source_label: String,
    /// Link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// Counts.
    pub counts: DiscoveryCounts,
    /// Linear teams.
    pub teams: Vec<DiscoveredEntity>,
    /// Projects (GitHub: the repository itself).
    pub projects: Vec<DiscoveredEntity>,
    /// Labels.
    pub labels: Vec<DiscoveredEntity>,
    /// Milestones.
    pub milestones: Vec<ExternalMilestone>,
    /// Users.
    pub users: Vec<ExternalUser>,
    /// States.
    pub statuses: Vec<DiscoveredState>,
    /// Sample issues.
    pub sample: Vec<SampleIssue>,
    /// Warnings.
    pub warnings: Vec<String>,
}

/// A provider call that failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SourceError {
    /// The provider answered with a non-2xx status (possibly a rate limit).
    Provider(ProviderHttpError),
    /// The request did not complete (network, SSRF guard, timeout).
    Transport(HttpFailure),
    /// The provider answered, but not in the expected shape.
    Unexpected(String),
}

impl SourceError {
    /// When the provider asked to wait.
    #[must_use]
    pub const fn rate_limited_until(&self) -> Option<DateTime<Utc>> {
        match self {
            Self::Provider(e) => e.rate_limited_until,
            _ => None,
        }
    }
}

impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Provider(e) => f.write_str(&e.message),
            Self::Transport(e) => f.write_str(&e.0),
            Self::Unexpected(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for SourceError {}

impl From<ProviderHttpError> for SourceError {
    fn from(e: ProviderHttpError) -> Self {
        Self::Provider(e)
    }
}

impl From<HttpFailure> for SourceError {
    fn from(e: HttpFailure) -> Self {
        Self::Transport(e)
    }
}

/// One tracker, read-only. Implementations only talk through `trama_integrations::Http` (and so
/// through `safe_fetch`).
#[async_trait]
pub trait ImportSourceAdapter: Send + Sync {
    /// The tracker.
    fn provider(&self) -> ExternalProvider;
    /// Describes the source: counts, teams, projects, labels, milestones, users, states, sample.
    async fn discover(&self) -> Result<Discovery, SourceError>;
    /// One page of issues from `cursor` (`None` = the first page).
    async fn issues(
        &self,
        cursor: Option<&str>,
        options: &ImportOptions,
    ) -> Result<Page<ExternalIssue>, SourceError>;
    /// One page of comments from `cursor`.
    async fn comments(&self, cursor: Option<&str>) -> Result<Page<ExternalComment>, SourceError>;
    /// One issue by its external id.
    async fn get_issue(&self, id: &str) -> Result<ExternalIssue, SourceError>;
}

/// An issue URL of GitHub (any host: the caller decides which hosts it trusts) or Linear.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedExternalUrl {
    /// Tracker.
    pub provider: ExternalProvider,
    /// Lower-cased host.
    pub host: String,
    /// GitHub `owner/name`.
    pub repository: Option<String>,
    /// GitHub issue number.
    pub number: Option<u64>,
    /// Linear `ENG-123`.
    pub identifier: Option<String>,
    /// Canonical URL.
    pub url: String,
}

/// `STATE_TYPES`: the tracker's state category, normalized.
#[must_use]
pub fn state_type(kind: &str) -> Option<ExternalStateType> {
    Some(match kind {
        "open" | "triage" | "backlog" | "unstarted" => ExternalStateType::Open,
        "started" => ExternalStateType::InProgress,
        "closed" | "completed" => ExternalStateType::Done,
        "not_planned" | "canceled" => ExternalStateType::Canceled,
        _ => return None,
    })
}
