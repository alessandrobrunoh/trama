//! External trackers: importing from GitHub Issues or Linear, and links to their issues.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::common::{ActorRef, Id, IsoDate};
use crate::issues::{IssueKind, IssueStatus};

string_enum! {
    /// Trackers Trama can import from or link to. Nothing is written back.
    pub enum ExternalProvider {
        Github = "github",
        Linear = "linear",
    }
}

/// `EXTERNAL_PROVIDERS`.
pub const EXTERNAL_PROVIDERS: &[ExternalProvider] = ExternalProvider::ALL;

impl ExternalProvider {
    /// `EXTERNAL_PROVIDER_META[provider].label`.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Github => "GitHub Issues",
            Self::Linear => "Linear",
        }
    }
}

string_enum! {
    /// The external status, normalized so a badge can colour it without knowing the tracker.
    pub enum ExternalStateType {
        Open = "open",
        InProgress = "in_progress",
        Done = "done",
        Canceled = "canceled",
    }
}

string_enum! {
    /// `import` when Trama created the issue from it, `link` when a person attached it.
    pub enum ExternalRefOrigin {
        Import = "import",
        Link = "link",
    }
}

/// Pointer from a Trama issue to an issue in another tracker. Unique per workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRef {
    /// Tracker.
    pub provider: ExternalProvider,
    /// Stable id in the tracker: `owner/repo#12` (lower-case) for GitHub, the issue uuid for
    /// Linear.
    pub id: String,
    /// Link.
    pub url: String,
    /// What people call it: `#12` or `ENG-123`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// The tracker's own state name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Normalized state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_type: Option<ExternalStateType>,
    /// Last time `state` was read from the tracker.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<IsoDate>,
    /// How it got there.
    pub origin: ExternalRefOrigin,
}

string_enum! {
    /// Lifecycle of an import job.
    pub enum ImportStatus {
        Queued = "queued",
        Running = "running",
        Completed = "completed",
        Failed = "failed",
        Canceled = "canceled",
    }
}

/// `IMPORT_STATUSES`.
pub const IMPORT_STATUSES: &[ImportStatus] = ImportStatus::ALL;
/// `IMPORT_ACTIVE_STATUSES`.
pub const IMPORT_ACTIVE_STATUSES: &[ImportStatus] = &[ImportStatus::Queued, ImportStatus::Running];

string_enum! {
    /// Phase of a running import.
    pub enum ImportPhase {
        Setup = "setup",
        Issues = "issues",
        Comments = "comments",
        Done = "done",
    }
}

/// A tracker credential kept (encrypted) on the server. Never returns the token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportCredential {
    /// Credential id (`tcr_…`).
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Tracker.
    pub provider: ExternalProvider,
    /// The account the token belongs to.
    pub account: String,
    /// Self-hosted GitHub Enterprise only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Creation time.
    pub created_at: IsoDate,
    /// Last use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<IsoDate>,
}

/// What to read. GitHub: one repository. Linear: one or more teams (empty = every team).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    /// `owner/name` (GitHub).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Linear team ids.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_ids: Option<Vec<String>>,
}

/// Which credential an import reads with.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportCredentialRef {
    /// A saved tracker credential.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<Id>,
    /// A GitHub integration connection of the workspace (its token is reused). GitHub only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<Id>,
}

/// What a tracker entity becomes, tagged by `action`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ImportTarget {
    /// An existing Trama record.
    Map {
        /// Its id.
        id: Id,
    },
    /// A new record.
    Create,
    /// Nothing.
    Skip,
}

/// The editable mapping from the tracker's entities to Trama's. Keys are the preview's ids.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ImportMapping {
    /// Linear team ids only. Trama has no teams.
    pub teams: BTreeMap<String, ImportTarget>,
    /// Projects.
    pub projects: BTreeMap<String, ImportTarget>,
    /// Labels.
    pub labels: BTreeMap<String, ImportTarget>,
    /// Tracker user id → Trama user id; `null` leaves the issue unassigned.
    #[schema(value_type = Object)]
    pub users: BTreeMap<String, Option<Id>>,
    /// Tracker state id → Trama status.
    pub statuses: BTreeMap<String, IssueStatus>,
}

/// Import options.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// Import comments.
    pub include_comments: bool,
    /// Import closed / completed / canceled issues too.
    pub include_closed: bool,
    /// Kind for issues no label points at.
    pub default_kind: IssueKind,
}

/// `DEFAULT_IMPORT_OPTIONS`.
pub const DEFAULT_IMPORT_OPTIONS: ImportOptions = ImportOptions {
    include_comments: false,
    include_closed: true,
    default_kind: IssueKind::Feature,
};

/// A tracker team, project or label in a preview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ImportPreviewEntity {
    /// Tracker id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Color.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Issues using it, when the tracker tells cheaply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    /// Suggested target.
    pub suggested: ImportTarget,
}

/// A tracker user in a preview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewUser {
    /// Tracker id.
    pub id: String,
    /// Name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    /// Email.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Trama member matched by email, then by login or name (`null` when none).
    pub suggested_user_id: Option<Id>,
}

/// A tracker state in a preview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ImportPreviewStatus {
    /// Tracker id.
    pub id: String,
    /// Name.
    pub name: String,
    /// The tracker's own category (`started`, `closed`, `not_planned`…).
    #[serde(rename = "type")]
    pub kind: String,
    /// Issues in it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    /// Suggested Trama status.
    pub suggested: IssueStatus,
}

/// Counts of a preview. `null` when the tracker cannot count without reading everything.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ImportPreviewCounts {
    /// Issues.
    pub issues: Option<i64>,
    /// Open issues.
    pub open: Option<i64>,
    /// Closed issues.
    pub closed: Option<i64>,
    /// Projects.
    pub projects: i64,
    /// Milestones.
    pub milestones: i64,
    /// Labels.
    pub labels: i64,
    /// Users.
    pub users: i64,
}

/// A tracker milestone in a preview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewMilestone {
    /// Tracker id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Tracker project id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Due date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_on: Option<String>,
}

/// A sample issue of a preview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ImportPreviewSample {
    /// Key.
    pub key: String,
    /// Title.
    pub title: String,
    /// State name.
    pub state: String,
}

/// What an import would read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// Tracker.
    pub provider: ExternalProvider,
    /// Account.
    pub account: String,
    /// `owner/name` or the Linear workspace.
    pub source_label: String,
    /// Link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// Counts.
    pub counts: ImportPreviewCounts,
    /// Teams.
    pub teams: Vec<ImportPreviewEntity>,
    /// Projects.
    pub projects: Vec<ImportPreviewEntity>,
    /// Labels.
    pub labels: Vec<ImportPreviewEntity>,
    /// Milestones.
    pub milestones: Vec<ImportPreviewMilestone>,
    /// Users.
    pub users: Vec<ImportPreviewUser>,
    /// States.
    pub statuses: Vec<ImportPreviewStatus>,
    /// Sample issues.
    pub sample: Vec<ImportPreviewSample>,
    /// Warnings.
    pub warnings: Vec<String>,
}

/// Progress of an import.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ImportProgress {
    /// Phase.
    pub phase: ImportPhase,
    /// Issues the tracker says there are, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    /// Processed.
    pub processed: i64,
    /// Created.
    pub created: i64,
    /// Already imported earlier (their mirrored status is refreshed).
    pub skipped: i64,
    /// Failed.
    pub failed: i64,
    /// Comments imported.
    pub comments: i64,
}

/// One import failure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ImportErrorEntry {
    /// External key or id the failure belongs to.
    #[serde(rename = "ref")]
    pub reference: String,
    /// Message.
    pub message: String,
}

/// An import job.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    /// Job id (`imp_…`).
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Tracker.
    pub provider: ExternalProvider,
    /// Status.
    pub status: ImportStatus,
    /// Human label of what is imported.
    pub source_label: String,
    /// What is read.
    pub source: ImportSource,
    /// Options.
    pub options: ImportOptions,
    /// Mapping.
    pub mapping: ImportMapping,
    /// Progress.
    pub progress: ImportProgress,
    /// First errors only (capped); `progress.failed` has the real count.
    pub errors: Vec<ImportErrorEntry>,
    /// Set while the tracker's rate limit is being waited out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_until: Option<IsoDate>,
    /// Cancel was requested.
    pub cancel_requested: bool,
    /// Last error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Who started it.
    pub created_by: ActorRef,
    /// Creation time.
    pub created_at: IsoDate,
    /// Start time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<IsoDate>,
    /// End time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<IsoDate>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn import_targets_are_tagged_by_action() {
        assert_eq!(
            serde_json::to_value(ImportTarget::Map { id: "pj_1".into() }).unwrap(),
            json!({ "action": "map", "id": "pj_1" })
        );
        assert_eq!(serde_json::to_value(ImportTarget::Skip).unwrap(), json!({ "action": "skip" }));
        let mapping: ImportMapping = serde_json::from_value(json!({
            "teams": {}, "projects": { "p": { "action": "create" } }, "labels": {},
            "users": { "u": null }, "statuses": { "s": "done" },
        }))
        .unwrap();
        assert_eq!(mapping.projects["p"], ImportTarget::Create);
        assert_eq!(mapping.users["u"], None);
        assert_eq!(serde_json::to_value(&mapping).unwrap()["users"], json!({ "u": null }));
    }
}
