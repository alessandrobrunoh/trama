//! Comments, domain events, attention items, live events and the workspace snapshot.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use utoipa::ToSchema;

use crate::common::{ActorRef, Id, IsoDate, LegacySubjectRef};
use crate::identity::{Agent, Membership, User, Workspace};
use crate::integrations::IntegrationConnection;
use crate::issues::{Artifact, Issue};
use crate::projects::{Milestone, Project};
use crate::roles::Role;
use crate::views::SavedView;

/// A comment on a subject.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    /// Comment id.
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// What it is on.
    pub subject: LegacySubjectRef,
    /// Who wrote it.
    pub author: ActorRef,
    /// Markdown body.
    pub body: String,
    /// Creation time.
    pub created_at: IsoDate,
    /// Last edit.
    pub updated_at: IsoDate,
}

/// Default page size of `GET /comments/page`.
pub const COMMENT_PAGE_SIZE_DEFAULT: u32 = 50;
/// Largest page size of `GET /comments/page`.
pub const COMMENT_PAGE_SIZE_MAX: u32 = 100;

/// One page of the comments of a single subject, newest first. `next_cursor` is opaque; `null` on
/// the last page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommentPage {
    /// The page.
    pub items: Vec<Comment>,
    /// Cursor of the next (older) page.
    pub next_cursor: Option<String>,
}

/// How many comments each author left on each subject (the slim snapshot's summary).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CommentIndexEntry {
    /// The subject.
    pub subject: LegacySubjectRef,
    /// The author.
    pub author: ActorRef,
    /// Comments.
    pub count: i64,
}

/// Append-only activity log entry (`issue.created`, `artifact.attached`, …).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DomainEvent {
    /// Event id.
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// When it happened.
    pub at: IsoDate,
    /// Who did it.
    pub actor: ActorRef,
    /// Event type, e.g. `issue.status_changed`.
    #[serde(rename = "type")]
    pub kind: String,
    /// What it is about.
    pub subject: LegacySubjectRef,
    /// Provenance for events retained from a retired Workstream association.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_workstream_key: Option<String>,
    /// Event payload.
    #[schema(value_type = Object)]
    pub data: Map<String, Value>,
}

string_enum! {
    /// Why something needs the current user's attention.
    pub enum AttentionKind {
        ReviewRequested = "review_requested",
        CiFailed = "ci_failed",
        Conflict = "conflict",
        Triage = "triage",
    }
}

string_enum! {
    /// Severity of an attention item or risk.
    pub enum AttentionSeverity {
        High = "high",
        Medium = "medium",
        Low = "low",
    }
}

string_enum! {
    /// Per-user state of an attention item.
    pub enum AttentionState {
        Open = "open",
        Snoozed = "snoozed",
        Dismissed = "dismissed",
    }
}

/// Derived server-side for the current user ("where is my attention required?").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    /// Stable id derived from kind + source entity.
    pub id: String,
    /// Kind.
    pub kind: AttentionKind,
    /// Severity.
    pub severity: AttentionSeverity,
    /// Headline.
    pub title: String,
    /// Explanation.
    pub detail: String,
    /// Artifact it is about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<Id>,
    /// Issue it is about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Id>,
    /// When the underlying condition started.
    pub since: IsoDate,
    /// Per-user state.
    pub state: AttentionState,
    /// Snoozed until.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<IsoDate>,
}

string_enum! {
    /// `?comments=` on `GET /snapshot`: `index` (default) returns `comments: []` plus
    /// `commentIndex`; `full` inlines every comment.
    pub enum SnapshotCommentsMode {
        Full = "full",
        Index = "index",
    }
}

/// `SNAPSHOT_COMMENTS_MODES`.
pub const SNAPSHOT_COMMENTS_MODES: &[SnapshotCommentsMode] = SnapshotCommentsMode::ALL;

/// `GET /api/w/:slug/snapshot`: everything the client needs to boot a workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    /// The workspace.
    pub workspace: Workspace,
    /// The caller.
    pub me: User,
    /// The caller's role id.
    pub my_role: Role,
    /// Visible people.
    pub users: Vec<User>,
    /// Visible memberships.
    pub memberships: Vec<Membership>,
    /// Agents.
    pub agents: Vec<Agent>,
    /// Projects.
    pub projects: Vec<Project>,
    /// Milestones.
    pub milestones: Vec<Milestone>,
    /// Tasks. The field name stays `issues`.
    pub issues: Vec<Issue>,
    /// Artifacts.
    pub artifacts: Vec<Artifact>,
    /// Every comment in `full` mode; empty in `index` mode.
    pub comments: Vec<Comment>,
    /// Present only in `index` mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_index: Option<Vec<CommentIndexEntry>>,
    /// Most recent events; older ones via `GET /events?before=`.
    pub events: Vec<DomainEvent>,
    /// Attention items.
    pub attention: Vec<AttentionItem>,
    /// Saved views.
    pub views: Vec<SavedView>,
    /// Integration connections.
    pub integrations: Vec<IntegrationConnection>,
}

string_enum! {
    /// What happened, in a live event.
    pub enum LiveEventType {
        Created = "created",
        Updated = "updated",
        Deleted = "deleted",
        Attention = "attention",
    }
}

string_enum! {
    /// What a live event is about.
    pub enum LiveEventEntity {
        Issue = "issue",
        Artifact = "artifact",
        Project = "project",
        Milestone = "milestone",
        Import = "import",
        Comment = "comment",
        View = "view",
        Membership = "membership",
        Invite = "invite",
        Favorite = "favorite",
        Notification = "notification",
        Agent = "agent",
        Integration = "integration",
        Workspace = "workspace",
        Webhook = "webhook",
    }
}

/// Server-sent event on `GET /api/w/:slug/events/stream`. Clients refetch / patch on receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LiveEvent {
    /// What happened.
    #[serde(rename = "type")]
    pub kind: LiveEventType,
    /// What it is about.
    pub entity: LiveEventEntity,
    /// Record id.
    pub id: Id,
    /// `X-Client-Id` of the originating request, so a tab can ignore its own echoes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// When.
    pub at: IsoDate,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn live_events_and_domain_events_use_type() {
        let live = LiveEvent {
            kind: LiveEventType::Updated,
            entity: LiveEventEntity::Membership,
            id: "mb_1".into(),
            client_id: None,
            at: "2026-01-01T00:00:00.000Z".into(),
        };
        assert_eq!(
            serde_json::to_value(&live).unwrap(),
            json!({ "type": "updated", "entity": "membership", "id": "mb_1", "at": "2026-01-01T00:00:00.000Z" })
        );
        let event: DomainEvent = serde_json::from_value(json!({
            "id": "ev_1", "workspaceId": "ws_1", "at": "2026-01-01T00:00:00.000Z",
            "actor": { "type": "system" }, "type": "issue.created",
            "subject": { "type": "workstream", "id": "w_1" }, "data": { "a": 1 },
        }))
        .unwrap();
        assert_eq!(event.kind, "issue.created");
        assert_eq!(event.data["a"], 1);
        let page = CommentPage { items: Vec::new(), next_cursor: None };
        assert_eq!(serde_json::to_value(page).unwrap(), json!({ "items": [], "nextCursor": null }));
    }
}
