//! The workspace snapshot (`snapshot.service.ts`): everything the client needs to boot a
//! workspace in one call.

use std::collections::HashSet;

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use trama_artifacts::artifact_view;
use trama_attention::SnapshotRows as AttentionRows;
use trama_auth::WorkspaceContext;
use trama_auth::member_access::{project_hidden, scope_snapshot};
use trama_comments::service as comments_service;
use trama_contracts::access::is_project_limited;
use trama_contracts::activity::{SnapshotCommentsMode, WorkspaceSnapshot};
use trama_contracts::identity::{Agent, Membership, User, Workspace};
use trama_contracts::integrations::IntegrationConnection;
use trama_contracts::people_scope::visible_memberships;
use trama_contracts::roles::Capability;
use trama_core::{AppError, AppState};
use trama_entities::{
    agents, artifacts, domain_events, integration_connections, issues, memberships, projects, users,
};
use trama_events::schemas::EventView;
use trama_events::visibility::filter_events;
use trama_issues::present as issue_view;
use trama_milestones::service as milestones_service;
use trama_sharing::schemas::project_wire;
use trama_workspaces::service::agent_view;

/// `SNAPSHOT_EVENTS`: how many recent events the snapshot carries; older ones via
/// `GET /events?before=`.
pub const SNAPSHOT_EVENTS: u64 = 500;

/// Everything the client needs to boot a workspace (`SnapshotService.build`): the workspace, the
/// caller, the people and the records, the recent events, the caller's attention items, the saved
/// views, and the integration connections for whoever may manage them.
///
/// A guest or a member limited to some projects only meets the people and agents of those
/// projects; [`scope_snapshot`] then drops every record their access cannot view, so a hidden
/// issue's parent reference disappears rather than the row itself.
///
/// # Errors
///
/// A database error, or a stored comment or event that does not fit the contract.
pub async fn build(
    state: &AppState,
    ctx: &WorkspaceContext,
    me: &users::Model,
    mode: SnapshotCommentsMode,
) -> Result<WorkspaceSnapshot, AppError> {
    let db = &state.db;
    let ws = ctx.workspace.id.clone();
    let access = ctx.access.as_ref();

    let membership_rows = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(ws.as_str()))
        .order_by_asc(memberships::Column::CreatedAt)
        .order_by_asc(memberships::Column::Id)
        .all(db)
        .await?;
    let member_ids: Vec<String> = membership_rows.iter().map(|m| m.user_id.clone()).collect();
    let user_rows = if member_ids.is_empty() {
        Vec::new()
    } else {
        users::Entity::find().filter(users::Column::Id.is_in(member_ids)).all(db).await?
    };
    let agent_rows = agents::Entity::find()
        .filter(agents::Column::WorkspaceId.eq(ws.as_str()))
        .order_by_asc(agents::Column::CreatedAt)
        .order_by_asc(agents::Column::Id)
        .all(db)
        .await?;
    let project_rows = projects::Entity::find()
        .filter(projects::Column::WorkspaceId.eq(ws.as_str()))
        .order_by_asc(projects::Column::Name)
        .order_by_asc(projects::Column::Id)
        .all(db)
        .await?;
    let milestones = milestones_service::list(db, ws.as_str(), None).await?;
    let issue_rows = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(ws.as_str()))
        .order_by_asc(issues::Column::CreatedAt)
        .order_by_asc(issues::Column::Id)
        .all(db)
        .await?;
    let artifact_rows = artifacts::Entity::find()
        .filter(artifacts::Column::WorkspaceId.eq(ws.as_str()))
        .order_by_asc(artifacts::Column::CreatedAt)
        .order_by_asc(artifacts::Column::Id)
        .all(db)
        .await?;
    let (comments, comment_index) = match mode {
        SnapshotCommentsMode::Full => (comments_service::list_all(db, ws.as_str()).await?, None),
        SnapshotCommentsMode::Index => {
            (Vec::new(), Some(comments_service::index(db, ws.as_str()).await?))
        }
    };
    let events = recent_events(db, &ws, access).await?;
    let views = trama_views::service::list(state, ctx).await?;
    // account, baseUrl, status and lastError of the git connections are for whoever manages them
    // (same gate as GET /integrations); everyone else gets an empty list
    let integrations = managed_connections(state, ctx, &ws).await?;
    let attention = trama_attention::list(
        db,
        ws.as_str(),
        &me.id,
        Some(AttentionRows { issues: &issue_rows, artifacts: &artifact_rows }),
    )
    .await?;

    // A guest, or a member limited to some projects, only meets the people and agents of those
    // projects.
    let (memberships, users, agents) =
        visible_people(ctx, access, &membership_rows, &user_rows, &agent_rows, &issue_rows);

    let snapshot = WorkspaceSnapshot {
        workspace: Workspace::from(&ctx.workspace),
        me: User::from(me),
        my_role: ctx.role.clone(),
        users,
        memberships,
        agents,
        projects: project_rows.iter().map(project_wire).collect(),
        milestones,
        issues: issue_rows.iter().map(issue_view).collect(),
        artifacts: artifact_rows.iter().map(artifact_view).collect(),
        comments,
        comment_index,
        events,
        attention,
        views,
        integrations,
    };
    Ok(scope_snapshot(snapshot, access))
}

/// The workspace's git connections for whoever may manage them; an empty list for everyone else
/// (`canDo(ctx, 'manageIntegrations')`, the gate of `GET /integrations`). account, baseUrl,
/// status and lastError are for those people only.
///
/// # Errors
///
/// A database error, or a corrupt connection row.
async fn managed_connections(
    state: &AppState,
    ctx: &WorkspaceContext,
    ws: &str,
) -> Result<Vec<IntegrationConnection>, AppError> {
    if !ctx.can_do(Capability::ManageIntegrations) {
        return Ok(Vec::new());
    }
    let rows = integration_connections::Entity::find()
        .filter(integration_connections::Column::WorkspaceId.eq(ws))
        .order_by_asc(integration_connections::Column::CreatedAt)
        .order_by_asc(integration_connections::Column::Id)
        .all(&state.db)
        .await?;
    trama_integrations::service::summarize(&state.db, &rows).await
}

/// The people a project-limited caller may meet (`visibleMemberships` + the `users` and `agents`
/// filters of `SnapshotService.build`): themselves and everybody who works on at least one of
/// their projects, and only the agents assigned to a visible issue.
fn visible_people(
    ctx: &WorkspaceContext,
    access: Option<&trama_contracts::access::MemberAccess>,
    membership_rows: &[memberships::Model],
    user_rows: &[users::Model],
    agent_rows: &[agents::Model],
    issue_rows: &[issues::Model],
) -> (Vec<Membership>, Vec<User>, Vec<Agent>) {
    let limited = is_project_limited(access);
    let membership_wires: Vec<Membership> = membership_rows.iter().map(Membership::from).collect();
    let visible_members =
        visible_memberships(&membership_wires, &ctx.settings.roles, access, ctx.user_id.as_deref());
    let visible_user_ids: HashSet<&str> =
        visible_members.iter().map(|m| m.user_id.as_str()).collect();
    let assigned_ids: Option<HashSet<String>> = limited.then(|| {
        issue_rows
            .iter()
            .filter(|issue| !project_hidden(access, issue.project_id.as_deref()))
            .filter_map(|issue| issue.assignee_id.clone())
            .collect()
    });
    let users: Vec<User> = user_rows
        .iter()
        .map(User::from)
        .filter(|user| !limited || visible_user_ids.contains(user.id.as_str()))
        .collect();
    let agents: Vec<Agent> = agent_rows
        .iter()
        .map(agent_view)
        .filter(|agent| assigned_ids.as_ref().is_none_or(|ids| ids.contains(&agent.id)))
        .collect();
    (visible_members, users, agents)
}

/// The [`SNAPSHOT_EVENTS`] most recent events, without what the caller's project access hides
/// (`EventVisibilityService.filterEvents`), as the contract `DomainEvent`s.
///
/// # Errors
///
/// A database error, or a stored event whose subject or actor is outside the contract.
async fn recent_events(
    db: &sea_orm::DatabaseConnection,
    ws: &str,
    access: Option<&trama_contracts::access::MemberAccess>,
) -> Result<Vec<trama_contracts::activity::DomainEvent>, AppError> {
    let rows = domain_events::Entity::find()
        .filter(domain_events::Column::WorkspaceId.eq(ws))
        .order_by_desc(domain_events::Column::At)
        .order_by_desc(domain_events::Column::Id)
        .limit(SNAPSHOT_EVENTS)
        .all(db)
        .await?;
    let visible = filter_events(db, ws, rows, access).await?;
    visible
        .into_iter()
        .map(|row| {
            let id = row.id.clone();
            EventView::from(row).to_domain_event().ok_or_else(|| {
                AppError::internal(format!("domain event {id} is outside the contract"))
            })
        })
        .collect()
}
