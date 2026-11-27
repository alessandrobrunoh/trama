//! `EventVisibilityService` of `server/src/events/event-visibility.service.ts`: the same project
//! boundary for historical events, snapshots and live events. A narrowed member never receives
//! an event whose owner cannot be resolved.

use std::collections::{BTreeSet, HashMap};

use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value};
use trama_contracts::access::{MemberAccess, MemberAction, MemberGrant, MemberResource};
use trama_contracts::activity::{DomainEvent, LiveEvent};
use trama_contracts::common::LegacySubjectRef;
use trama_entities::{artifacts, comments, domain_events, issues, milestones};

/// Subject types a live event's entity can name directly (`SubjectType`).
const SUBJECT_TYPES: [&str; 5] = ["issue", "artifact", "project", "milestone", "import"];

/// Entities that are workspace-wide, rather than owned by a project.
pub const UNASSIGNED_SUBJECTS: [&str; 11] = [
    "import",
    "workspace",
    "membership",
    "invite",
    "favorite",
    "customer_subscription",
    "notification",
    "agent",
    "integration",
    "webhook",
    "view",
];

/// The view grant a narrowed member needs to see events about a subject type.
fn member_view_grant(subject_type: &str) -> Option<MemberGrant> {
    let resource = match subject_type {
        "project" => MemberResource::Projects,
        "issue" => MemberResource::Issues,
        "milestone" => MemberResource::Milestones,
        "artifact" => MemberResource::Artifacts,
        _ => return None,
    };
    Some(MemberGrant::new(resource, MemberAction::View))
}

const COMMENTS_VIEW: MemberGrant = MemberGrant::new(MemberResource::Comments, MemberAction::View);

/// Anything with a subject that [`filter_events`] can scope (`ScopedEvent`).
pub trait ScopedEvent {
    /// `subject.type`; may be a retired or unknown type in stored rows.
    fn subject_type(&self) -> &str;
    /// `subject.id`.
    fn subject_id(&self) -> &str;
    /// The event payload (`projectId`, `issueId` name the owner of deleted records).
    fn data(&self) -> Option<&Map<String, Value>> {
        None
    }
    /// The event type (`comment.*` events need `comments:view`).
    fn event_type(&self) -> Option<&str> {
        None
    }
}

fn json_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

impl ScopedEvent for domain_events::Model {
    fn subject_type(&self) -> &str {
        json_str(&self.subject, "type")
    }
    fn subject_id(&self) -> &str {
        json_str(&self.subject, "id")
    }
    fn data(&self) -> Option<&Map<String, Value>> {
        self.data.as_object()
    }
    fn event_type(&self) -> Option<&str> {
        Some(&self.r#type)
    }
}

impl ScopedEvent for DomainEvent {
    fn subject_type(&self) -> &str {
        self.subject.kind.as_str()
    }
    fn subject_id(&self) -> &str {
        &self.subject.id
    }
    fn data(&self) -> Option<&Map<String, Value>> {
        Some(&self.data)
    }
    fn event_type(&self) -> Option<&str> {
        Some(&self.kind)
    }
}

/// A bare subject with an optional event type and payload.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScopedRef {
    /// `subject.type`.
    pub subject_type: String,
    /// `subject.id`.
    pub subject_id: String,
    /// Event type.
    pub event_type: Option<String>,
    /// Event payload.
    pub data: Option<Map<String, Value>>,
}

impl ScopedRef {
    /// A subject with no type or payload.
    #[must_use]
    pub fn new(subject_type: impl Into<String>, subject_id: impl Into<String>) -> Self {
        Self { subject_type: subject_type.into(), subject_id: subject_id.into(), ..Self::default() }
    }

    /// Sets the event type.
    #[must_use]
    pub fn with_type(mut self, event_type: impl Into<String>) -> Self {
        self.event_type = Some(event_type.into());
        self
    }

    /// Sets the payload (a non-object value means none).
    #[must_use]
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = match data {
            Value::Object(map) => Some(map),
            _ => None,
        };
        self
    }
}

impl From<&LegacySubjectRef> for ScopedRef {
    fn from(subject: &LegacySubjectRef) -> Self {
        Self::new(subject.kind.as_str(), subject.id.clone())
    }
}

impl ScopedEvent for ScopedRef {
    fn subject_type(&self) -> &str {
        &self.subject_type
    }
    fn subject_id(&self) -> &str {
        &self.subject_id
    }
    fn data(&self) -> Option<&Map<String, Value>> {
        self.data.as_ref()
    }
    fn event_type(&self) -> Option<&str> {
        self.event_type.as_deref()
    }
}

/// Projects an event belongs to; empty means a known workspace-level or genuinely unassigned
/// subject. `None` in the list is "no project".
type Scope = Vec<Option<String>>;

fn ids_of<T: ScopedEvent>(events: &[T], kind: &str) -> Vec<String> {
    let set: BTreeSet<&str> =
        events.iter().filter(|e| e.subject_type() == kind).map(ScopedEvent::subject_id).collect();
    set.into_iter().map(ToOwned::to_owned).collect()
}

/// The project owners of the records the events name.
struct Owners {
    /// Issue id → its project (`None`: no project).
    issue_projects: HashMap<String, Option<String>>,
    /// Milestone id → its project.
    milestone_projects: HashMap<String, String>,
    /// Artifact id → its issue.
    artifact_issues: HashMap<String, Option<String>>,
}

impl Owners {
    async fn load<C: ConnectionTrait, T: ScopedEvent>(
        db: &C,
        workspace_id: &str,
        events: &[T],
    ) -> Result<Self, DbErr> {
        let issue_ids = ids_of(events, "issue");
        let milestone_ids = ids_of(events, "milestone");
        let artifact_ids = ids_of(events, "artifact");
        let mut issue_projects: HashMap<String, Option<String>> =
            issue_rows(db, workspace_id, issue_ids).await?.into_iter().collect();
        let milestone_projects: HashMap<String, String> = if milestone_ids.is_empty() {
            HashMap::new()
        } else {
            milestones::Entity::find()
                .select_only()
                .columns([milestones::Column::Id, milestones::Column::ProjectId])
                .filter(milestones::Column::WorkspaceId.eq(workspace_id))
                .filter(milestones::Column::Id.is_in(milestone_ids))
                .into_tuple::<(String, String)>()
                .all(db)
                .await?
                .into_iter()
                .collect()
        };
        let artifact_issues: HashMap<String, Option<String>> = if artifact_ids.is_empty() {
            HashMap::new()
        } else {
            artifacts::Entity::find()
                .select_only()
                .columns([artifacts::Column::Id, artifacts::Column::IssueId])
                .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
                .filter(artifacts::Column::Id.is_in(artifact_ids))
                .into_tuple::<(String, Option<String>)>()
                .all(db)
                .await?
                .into_iter()
                .collect()
        };

        // Artifacts that are gone (no row) are scoped by the task their event names.
        let mut related: BTreeSet<String> = artifact_issues.values().flatten().cloned().collect();
        for event in events {
            if event.subject_type() == "artifact"
                && let Some(id) =
                    event.data().and_then(|d| d.get("issueId")).and_then(Value::as_str)
            {
                related.insert(id.to_owned());
            }
        }
        if !related.is_empty() {
            issue_projects
                .extend(issue_rows(db, workspace_id, related.into_iter().collect()).await?);
        }

        Ok(Self { issue_projects, milestone_projects, artifact_issues })
    }
}

/// The events of `workspace_id` that `access` may see, in their order. `None` access (or every
/// project) keeps them all.
///
/// # Errors
///
/// A database error while resolving the owners.
pub async fn filter_events<C: ConnectionTrait, T: ScopedEvent>(
    db: &C,
    workspace_id: &str,
    events: Vec<T>,
    access: Option<&MemberAccess>,
) -> Result<Vec<T>, DbErr> {
    let Some(access) = access.filter(|a| !a.projects.all) else { return Ok(events) };
    if events.is_empty() {
        return Ok(events);
    }

    let Owners { issue_projects, milestone_projects, artifact_issues } =
        Owners::load(db, workspace_id, &events).await?;

    let scope_for = |event: &T| -> Option<Scope> {
        let data = event.data();
        let id = event.subject_id();
        // own `projectId`: a string, or null for anything else; `None` when absent
        let data_project =
            data.and_then(|d| d.get("projectId")).map(|v| v.as_str().map(ToOwned::to_owned));
        match event.subject_type() {
            "project" => Some(vec![Some(id.to_owned())]),
            "issue" => match issue_projects.get(id) {
                Some(project) => Some(vec![project.clone()]),
                None => data_project.map(|p| vec![p]),
            },
            "milestone" => match milestone_projects.get(id) {
                Some(project) => Some(vec![Some(project.clone())]),
                None => data_project.map(|p| vec![p]),
            },
            "artifact" => {
                let row = artifact_issues.get(id);
                // A deleted artifact is scoped by the task its event names.
                let issue_id = match row {
                    Some(issue) => issue.clone(),
                    None => data
                        .and_then(|d| d.get("issueId"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                };
                match issue_id.filter(|i| !i.is_empty()) {
                    None => row.map(|_| Vec::new()),
                    Some(issue_id) => {
                        issue_projects.get(&issue_id).map(|project| vec![project.clone()])
                    }
                }
            }
            other => UNASSIGNED_SUBJECTS.contains(&other).then(Vec::new),
        }
    };

    let can_see = |scope: Option<Scope>| -> bool {
        let Some(scope) = scope else { return false };
        if scope.is_empty() {
            return access.include_unassigned;
        }
        scope.iter().all(|project| match project {
            None => access.include_unassigned,
            Some(id) => access.projects.project_ids.contains(id),
        })
    };

    Ok(events
        .into_iter()
        .filter(|event| {
            if let Some(grant) = member_view_grant(event.subject_type())
                && !access.grants.contains(&grant)
            {
                return false;
            }
            if event.event_type().is_some_and(|t| t.starts_with("comment."))
                && !access.grants.contains(&COMMENTS_VIEW)
            {
                return false;
            }
            can_see(scope_for(event))
        })
        .collect())
}

async fn issue_rows<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: Vec<String>,
) -> Result<Vec<(String, Option<String>)>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    issues::Entity::find()
        .select_only()
        .columns([issues::Column::Id, issues::Column::ProjectId])
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.is_in(ids))
        .into_tuple()
        .all(db)
        .await
}

/// Whether `access` may receive `event` on the live stream (`isLiveVisible`). `scope_subject` is
/// the record that owns the change when it differs from the event's entity (a comment's issue);
/// without it, a comment is scoped by its stored subject.
///
/// # Errors
///
/// A database error while resolving the owner.
pub async fn is_live_visible<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    event: &LiveEvent,
    access: Option<&MemberAccess>,
    scope_subject: Option<&LegacySubjectRef>,
) -> Result<bool, DbErr> {
    if access.is_none_or(|a| a.projects.all) {
        return Ok(true);
    }
    let entity = event.entity.as_str();
    let mut subject = scope_subject.map(ScopedRef::from);
    if subject.is_none() && SUBJECT_TYPES.contains(&entity) {
        subject = Some(ScopedRef::new(entity, event.id.clone()));
    }
    if subject.is_none() && entity == "comment" {
        let stored = comments::Entity::find()
            .select_only()
            .column(comments::Column::Subject)
            .filter(comments::Column::WorkspaceId.eq(workspace_id))
            .filter(comments::Column::Id.eq(event.id.clone()))
            .into_tuple::<Value>()
            .one(db)
            .await?;
        subject = stored.map(|s| ScopedRef::new(json_str(&s, "type"), json_str(&s, "id")));
    }
    let Some(subject) = subject else {
        return Ok(
            access.is_some_and(|a| a.include_unassigned) && UNASSIGNED_SUBJECTS.contains(&entity)
        );
    };
    let visibility_type = if entity == "comment" {
        "comment.updated".to_owned()
    } else {
        format!("{entity}.{}", event.kind)
    };
    let visible =
        filter_events(db, workspace_id, vec![subject.with_type(visibility_type)], access).await?;
    Ok(visible.len() == 1)
}
