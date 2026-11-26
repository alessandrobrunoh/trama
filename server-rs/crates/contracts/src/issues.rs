//! Issues (served as tasks) and artifacts.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::common::{ActorRef, Id, IsoDate, Priority};
use crate::imports::ExternalRef;

string_enum! {
    /// What an issue is.
    pub enum IssueKind {
        Bug = "bug",
        Feature = "feature",
        Incident = "incident",
        TechDebt = "tech_debt",
        Feedback = "feedback",
        Idea = "idea",
        Security = "security",
    }
}

string_enum! {
    /// Tracker status (the semantic types of the issue status catalog). `backlog` is
    /// unscheduled demand.
    pub enum IssueStatus {
        Draft = "draft",
        Backlog = "backlog",
        Todo = "todo",
        InProgress = "in_progress",
        InReview = "in_review",
        Done = "done",
        Canceled = "canceled",
    }
}

string_enum! {
    /// Where an issue came from.
    pub enum IssueSource {
        Manual = "manual",
        Github = "github",
        Gitlab = "gitlab",
        Linear = "linear",
        Email = "email",
        Api = "api",
        Agent = "agent",
    }
}

/// A unit of demand: one bug, request, incident, or task.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// Issue id.
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Human key (`CORA-12`).
    pub key: String,
    /// Number inside the key prefix.
    pub number: i32,
    /// Kind.
    pub kind: IssueKind,
    /// Title.
    pub title: String,
    /// Description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Where it came from.
    pub source: IssueSource,
    /// Free-text reporter (customer, email…) when not a workspace user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reporter_name: Option<String>,
    /// Reporting user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reporter_id: Option<Id>,
    /// Assignee.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_id: Option<Id>,
    /// Priority.
    pub priority: Priority,
    /// Issue status catalog id (seeded ids equal [`IssueStatus`] strings).
    pub status: String,
    /// Project this issue is planned under.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Id>,
    /// Milestones this issue is in: at most one per project, only milestones of `projectId`.
    pub milestone_ids: Vec<Id>,
    /// Story-point estimate (non-negative).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::js::opt_number"
    )]
    pub estimate: Option<f64>,
    /// When the task should be done (a calendar day, stored as midnight UTC).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<IsoDate>,
    /// First time the status entered `in_progress` / `in_review`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<IsoDate>,
    /// Set when the status becomes done or canceled; cleared on reopen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<IsoDate>,
    /// Workspace label ids.
    pub labels: Vec<Id>,
    /// Previous keys; lookups by key also match these.
    pub aliases: Vec<String>,
    /// Parent issue id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Id>,
    /// Set when this issue duplicates another. Status is `canceled`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of_id: Option<Id>,
    /// External URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_url: Option<String>,
    /// Link to the Delta thread the user is working on for this task.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_url: Option<String>,
    /// The issue this one was imported from or is linked to in an external tracker.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_ref: Option<ExternalRef>,
    /// Visible artifacts attached, set on issue get only when the caller can read artifacts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_count: Option<i64>,
    /// Creation time.
    pub created_at: IsoDate,
    /// Last update.
    pub updated_at: IsoDate,
}

/// Public name of an [`Issue`]. The wire type, JSON field names and discriminators stay
/// `issue`; HTTP routes and API-token resources use `tasks`.
pub type Task = Issue;

/// Plan artifacts of an issue.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    /// Plan artifacts.
    pub artifact_count: i64,
    /// The newest one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_artifact: Option<Artifact>,
}

/// Issue-owned context, with a plan summary only when the issue has plan artifacts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct IssueContext {
    /// The issue.
    pub issue: Issue,
    /// Plan summary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_summary: Option<PlanSummary>,
    /// Attached artifacts.
    pub artifacts: Vec<Artifact>,
}

string_enum! {
    /// What an artifact is.
    pub enum ArtifactKind {
        PullRequest = "pull_request",
        MergeRequest = "merge_request",
        Document = "document",
        Link = "link",
        Design = "design",
        Image = "image",
        File = "file",
        Build = "build",
        TestReport = "test_report",
        Deployment = "deployment",
        Release = "release",
    }
}

string_enum! {
    /// Where an artifact lives.
    pub enum ArtifactProvider {
        Github = "github",
        Gitlab = "gitlab",
        Bitbucket = "bitbucket",
        Delta = "delta",
        Figma = "figma",
        Docs = "docs",
        Ci = "ci",
        Other = "other",
    }
}

string_enum! {
    /// Lifecycle state of an artifact.
    pub enum ArtifactState {
        Draft = "draft",
        Open = "open",
        Merged = "merged",
        Closed = "closed",
        Pending = "pending",
        Running = "running",
        Succeeded = "succeeded",
        Failed = "failed",
        Healthy = "healthy",
        Degraded = "degraded",
        Published = "published",
    }
}

string_enum! {
    /// PR/MR/commit CI status.
    pub enum CiState {
        Pending = "pending",
        Passing = "passing",
        Failing = "failing",
    }
}

string_enum! {
    /// PR/MR review status.
    pub enum ReviewState {
        None = "none",
        Requested = "requested",
        Approved = "approved",
        ChangesRequested = "changes_requested",
    }
}

/// Something a task produced or points to: a PR, a build, a link, a file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    /// Artifact id.
    pub id: Id,
    /// The task that owns it. Absent only on artifacts retained from a retired Workstream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Id>,
    /// Provenance for artifacts retained from a retired Workstream owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_workstream_key: Option<String>,
    /// Git full name (`owner/name`) or URL of the artifact's repository.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Short note on what it is / why it is attached (markdown allowed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Kind.
    pub kind: ArtifactKind,
    /// Provider.
    pub provider: ArtifactProvider,
    /// Title.
    pub title: String,
    /// Link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// e.g. "#182", a commit sha, "ADR-021".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    /// State.
    pub state: ArtifactState,
    /// PR/MR CI status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ci: Option<CiState>,
    /// PR/MR review status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<ReviewState>,
    /// PR/MR has merge conflicts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_conflicts: Option<bool>,
    /// Deployment / release environment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    /// Who made it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_ref: Option<ActorRef>,
    /// Creation time.
    pub created_at: IsoDate,
    /// Last update.
    pub updated_at: IsoDate,
}

/// An issue's implementation plan is a `document` artifact whose title starts with "Plan".
#[must_use]
pub fn is_plan_artifact(kind: ArtifactKind, title: &str) -> bool {
    if kind != ArtifactKind::Document {
        return false;
    }
    // /^\s*plan\b/i
    let rest = title.trim_start_matches(crate::js::is_whitespace);
    let Some(head) = rest.get(..4) else { return false };
    head.eq_ignore_ascii_case("plan")
        && !rest[4..].chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_plan_documents() {
        assert!(is_plan_artifact(ArtifactKind::Document, "Plan"));
        assert!(is_plan_artifact(ArtifactKind::Document, "  plan: auth rework"));
        assert!(is_plan_artifact(ArtifactKind::Document, "PLAN-v2"));
        assert!(!is_plan_artifact(ArtifactKind::Document, "Planning notes"));
        assert!(!is_plan_artifact(ArtifactKind::Document, "Pla"));
        assert!(!is_plan_artifact(ArtifactKind::Link, "Plan"));
        assert!(!is_plan_artifact(ArtifactKind::Document, "The plan"));
    }

    #[test]
    fn whole_estimates_have_no_fraction() {
        let issue: Issue = serde_json::from_value(serde_json::json!({
            "id": "in_1", "workspaceId": "ws_1", "key": "UNPR-1", "number": 1, "kind": "bug",
            "title": "t", "source": "manual", "priority": "none", "status": "todo",
            "milestoneIds": [], "estimate": 3, "labels": [], "aliases": [],
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
        }))
        .unwrap();
        let out = serde_json::to_string(&issue).unwrap();
        assert!(out.contains(r#""estimate":3,"#));
        assert!(!out.contains("body"));
    }
}
