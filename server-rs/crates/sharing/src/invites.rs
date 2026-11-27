//! Workspace invitations (`server/src/invites/invites.service.ts`).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use base64::Engine;
use chrono::{Duration, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set, TransactionTrait,
};
use serde::Deserialize;
use serde_json::Value;
use trama_auth::{Auth, AuthMethod, Ctx, Gate, Routes};
use trama_common::crypto::sha256_hex;
use trama_common::mail::{Mail, Mailer};
use trama_contracts::access::{
    MemberAccess, MemberProjectScope, access_includes_project, access_within,
    effective_member_access, is_project_limited, normalize_member_access,
};
use trama_contracts::identity::{
    INVITE_TTL_DAYS, InviteLink, InvitePreview, Membership, ProjectInviteResult, ProjectShare,
    ProjectShareMember, User, WorkspaceInvite,
};
use trama_contracts::roles::{
    Capability, GUEST_ROLE_ID, can_grant_role, find_workspace_role, workspace_role_name,
};
use trama_core::{ApiJson, AppError, AppState};
use trama_entities::{invites, memberships, projects, users, workspaces};
use trama_events::{Events, LiveChange};
use utoipa::OpenApi;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    email: String,
    role: String,
    #[serde(default)]
    access: Option<Value>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
struct ProjectInviteBody {
    email: String,
}

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct MembershipEnded {
    membership_ended: bool,
}

#[derive(Debug, Deserialize, serde::Serialize, utoipa::ToSchema)]
struct AcceptResult {
    workspace: WorkspaceRef,
    role: String,
}

#[derive(Debug, Deserialize, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRef {
    slug: String,
    name: String,
}

#[derive(OpenApi)]
#[openapi(
    paths(
        list,
        create,
        resend,
        revoke,
        preview,
        accept,
        project_share,
        project_invite,
        project_resend,
        project_revoke,
        project_remove
    ),
    components(schemas(
        CreateBody,
        ProjectInviteBody,
        WorkspaceInvite,
        InviteLink,
        InvitePreview,
        AcceptResult,
        ProjectShare,
        ProjectInviteResult,
        ProjectShareMember,
        MembershipEnded
    ))
)]
/// OpenAPI definitions for invitation endpoints.
pub struct InviteApiDoc;

const MANAGE: Gate = Gate::authenticated().can(Capability::InviteMembers);
const PUBLIC: Gate = Gate::public();
const ACCEPT: Gate = Gate::authenticated().require_user().session_only();

/// Routes for workspace invite administration and invite links.
pub fn routes() -> Routes {
    Routes::new()
        .get("/w/{slug}/invites", MANAGE, list)
        .post("/w/{slug}/invites", MANAGE, create)
        .post("/w/{slug}/invites/{id}/resend", MANAGE, resend)
        .delete("/w/{slug}/invites/{id}", MANAGE, revoke)
        .get(
            "/w/{slug}/projects/{id}/share",
            Gate::authenticated().can(Capability::InviteToProject),
            project_share,
        )
        .post(
            "/w/{slug}/projects/{id}/invites",
            Gate::authenticated().can(Capability::InviteToProject),
            project_invite,
        )
        .post(
            "/w/{slug}/projects/{id}/invites/{inviteId}/resend",
            Gate::authenticated().can(Capability::InviteToProject),
            project_resend,
        )
        .delete(
            "/w/{slug}/projects/{id}/invites/{inviteId}",
            Gate::authenticated().can(Capability::InviteToProject),
            project_revoke,
        )
        .delete(
            "/w/{slug}/projects/{id}/share/{membershipId}",
            Gate::authenticated().can(Capability::InviteToProject),
            project_remove,
        )
        .get("/invites/{token}", PUBLIC, preview)
        .post("/invites/{token}/accept", ACCEPT, accept)
}

fn present(row: &invites::Model) -> WorkspaceInvite {
    WorkspaceInvite {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        email: row.email.clone(),
        role: row.role.clone(),
        access: row.access.as_ref().and_then(|v| serde_json::from_value(v.clone()).ok()),
        invited_by_user_id: row.invited_by_user_id.clone(),
        created_at: trama_core::time::to_iso(&row.created_at),
        expires_at: trama_core::time::to_iso(&row.expires_at),
        emailed_at: row.emailed_at.as_ref().map(trama_core::time::to_iso),
    }
}

fn roles(workspace: &workspaces::Model) -> trama_contracts::settings::WorkspaceSettings {
    trama_contracts::settings::resolve_workspace_settings(&workspace.settings)
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

async fn deliver_invite(
    state: &AppState,
    workspace: &workspaces::Model,
    saved: invites::Model,
    url: String,
) -> Result<InviteLink, AppError> {
    let inviter = if let Some(id) = &saved.invited_by_user_id {
        users::Entity::find_by_id(id).one(&state.db).await?
    } else {
        None
    };
    let settings = roles(workspace);
    let name = workspace_role_name(Some(&settings.roles), Some(&saved.role));
    let who = inviter
        .as_ref()
        .map_or_else(|| "You were invited".to_owned(), |u| format!("{} invited you", u.name));
    let expires_text = saved.expires_at.format("%Y-%m-%d").to_string();
    let subject = format!("{who} to {} on Trama", workspace.name);
    let text = format!(
        "{who} to join \"{}\" on Trama as {name}.\n\nAccept the invitation: {url}\n\nThe link works until {expires_text} and only for this email address. If you did not expect it, you can ignore this message.",
        workspace.name
    );
    let html = format!(
        "<!doctype html><html><body><p>Trama</p><h1>{} to {}</h1><p>You will join the workspace as <strong>{}</strong>.</p><p><a href=\"{}\">Accept invitation</a></p><p>The link works until {} and only for this email address. If you did not expect this message, you can ignore it.</p></body></html>",
        escape_html(&who),
        escape_html(&workspace.name),
        escape_html(&name),
        escape_html(&url),
        escape_html(&expires_text),
    );
    let emailed = Mailer::of(state)
        .send(Mail { to: saved.email.clone(), subject, text, html: Some(html) })
        .await;
    let saved = if emailed {
        let mut active: invites::ActiveModel = saved.into();
        active.emailed_at = Set(Some(Utc::now().fixed_offset()));
        active.update(&state.db).await?
    } else {
        saved
    };
    Ok(InviteLink { invite: present(&saved), url, emailed })
}

#[utoipa::path(get, path = "/api/w/{slug}/invites", tag = "sharing",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses((status = 200, description = "Pending workspace invitations", body = [WorkspaceInvite])))]
async fn list(
    State(state): State<AppState>,
    Ctx(ctx): Ctx,
) -> Result<Json<Vec<WorkspaceInvite>>, AppError> {
    let rows = invites::Entity::find()
        .filter(invites::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
        .filter(invites::Column::AcceptedAt.is_null())
        .filter(invites::Column::RevokedAt.is_null())
        .order_by_desc(invites::Column::CreatedAt)
        .all(&state.db)
        .await?;
    Ok(Json(rows.iter().map(present).collect()))
}

#[utoipa::path(post, path = "/api/w/{slug}/invites", tag = "sharing",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = CreateBody,
    responses((status = 201, description = "Invitation and shareable link", body = InviteLink),
        (status = 400, description = "Invalid input or unknown role"), (status = 403, description = "Cannot grant role"),
        (status = 409, description = "Already a member")))]
#[allow(clippy::too_many_lines)]
async fn create(
    State(state): State<AppState>,
    Ctx(ctx): Ctx,
    ApiJson(body): ApiJson<CreateBody>,
) -> Result<(StatusCode, Json<InviteLink>), AppError> {
    let mut checks = trama_core::validation::Checks::new();
    checks
        .email("email", &body.email)
        .min_length("role", &body.role, 1)
        .max_length("role", &body.role, 80);
    checks.finish()?;
    let settings = roles(&ctx.workspace);
    let target = find_workspace_role(&settings.roles, Some(&body.role))
        .ok_or_else(|| AppError::bad_request(format!("Unknown role \"{}\"", body.role)))?;
    if !trama_contracts::roles::can_grant_role(Some(&ctx.effective_role), Some(target)) {
        return Err(AppError::forbidden(
            "You cannot grant a role with permissions you do not have",
        ));
    }
    let access = match body.access.as_ref().filter(|v| !v.is_null()) {
        Some(value) => {
            if !value.is_object() {
                return Err(AppError::bad_request("access must be an object"));
            }
            normalize_member_access(value, &target.grants)
        }
        None => None,
    };
    let caller_access = effective_member_access(Some(&ctx.effective_role), ctx.access.as_ref());
    if !access_within(access.as_ref(), caller_access.as_ref(), &target.grants) {
        return Err(AppError::forbidden("You cannot grant access wider than your own"));
    }
    let email = body.email.trim().to_lowercase();
    if let Some(user) =
        users::Entity::find().filter(users::Column::Email.eq(&email)).one(&state.db).await?
        && memberships::Entity::find()
            .filter(memberships::Column::WorkspaceId.eq(&ctx.workspace.id))
            .filter(memberships::Column::UserId.eq(user.id))
            .one(&state.db)
            .await?
            .is_some()
    {
        return Err(AppError::conflict("This person is already a member"));
    }
    let previous = invites::Entity::find()
        .filter(invites::Column::WorkspaceId.eq(&ctx.workspace.id))
        .filter(invites::Column::Email.eq(&email))
        .filter(invites::Column::AcceptedAt.is_null())
        .filter(invites::Column::RevokedAt.is_null())
        .one(&state.db)
        .await?;
    let created = previous.is_none();
    let now = Utc::now().fixed_offset();
    let secret =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let expires = now + Duration::days(INVITE_TTL_DAYS);
    let mut row: invites::ActiveModel = if let Some(existing) = previous {
        existing.into()
    } else {
        invites::ActiveModel {
            id: Set(trama_core::ids::uid("inv")),
            workspace_id: Set(ctx.workspace.id.clone()),
            email: Set(email.clone()),
            role: Set(body.role.clone()),
            token_hash: Set(String::new()),
            invited_by_user_id: Set(ctx.user_id.clone()),
            created_at: Set(now),
            expires_at: Set(expires),
            emailed_at: Set(None),
            accepted_at: Set(None),
            revoked_at: Set(None),
            access: Set(None),
        }
    };
    row.role = Set(body.role.clone());
    row.access = Set(access.map(|a| serde_json::to_value(a).expect("member access serializes")));
    row.token_hash = Set(sha256_hex(&secret));
    row.expires_at = Set(expires);
    row.invited_by_user_id = Set(ctx.user_id.clone());
    let saved = if created { row.insert(&state.db).await? } else { row.update(&state.db).await? };

    let url = format!("{}/invite/{secret}", state.config.app_url);
    let link = deliver_invite(&state, &ctx.workspace, saved, url).await?;
    Events::of(&state).publish(
        &ctx.workspace.id,
        if created {
            LiveChange::created(trama_contracts::activity::LiveEventEntity::Invite, &link.invite.id)
        } else {
            LiveChange::updated(trama_contracts::activity::LiveEventEntity::Invite, &link.invite.id)
        },
    );
    Ok((StatusCode::CREATED, Json(link)))
}

#[utoipa::path(post, path = "/api/w/{slug}/invites/{id}/resend", tag = "sharing",
    params(("slug" = String, Path, description = "Workspace slug"), ("id" = String, Path, description = "Invite id")),
    responses((status = 200, description = "Rotated invitation link", body = InviteLink),
        (status = 400, description = "Invite role no longer exists"), (status = 403, description = "Cannot grant invite role"),
        (status = 404, description = "Pending invite not found")))]
async fn resend(
    State(state): State<AppState>,
    Ctx(ctx): Ctx,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<(StatusCode, Json<InviteLink>), AppError> {
    // Expiry does not make an invitation non-pending: resend is how it gets a fresh seven days.
    let row = invites::Entity::find_by_id(&id)
        .filter(invites::Column::WorkspaceId.eq(&ctx.workspace.id))
        .filter(invites::Column::AcceptedAt.is_null())
        .filter(invites::Column::RevokedAt.is_null())
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Invite", &id))?;
    let settings = roles(&ctx.workspace);
    let target = find_workspace_role(&settings.roles, Some(&row.role))
        .ok_or_else(|| AppError::bad_request(format!("Unknown role \"{}\"", row.role)))?;
    if !can_grant_role(Some(&ctx.effective_role), Some(target)) {
        return Err(AppError::forbidden(
            "You cannot grant a role with permissions you do not have",
        ));
    }

    let secret =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let now = Utc::now().fixed_offset();
    let mut active: invites::ActiveModel = row.into();
    active.token_hash = Set(sha256_hex(&secret));
    active.expires_at = Set(now + Duration::days(INVITE_TTL_DAYS));
    let saved = active.update(&state.db).await?;
    let url = format!("{}/invite/{secret}", state.config.app_url);
    let link = deliver_invite(&state, &ctx.workspace, saved, url).await?;
    Events::of(&state).publish(
        &ctx.workspace.id,
        LiveChange::updated(trama_contracts::activity::LiveEventEntity::Invite, &link.invite.id),
    );
    Ok((StatusCode::OK, Json(link)))
}

#[utoipa::path(delete, path = "/api/w/{slug}/invites/{id}", tag = "sharing",
    params(("slug" = String, Path, description = "Workspace slug"), ("id" = String, Path, description = "Invite id")),
    responses((status = 204, description = "Invitation revoked"), (status = 404, description = "Invitation not found")))]
async fn revoke(
    State(state): State<AppState>,
    Ctx(ctx): Ctx,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    let row = invites::Entity::find_by_id(&id)
        .filter(invites::Column::WorkspaceId.eq(&ctx.workspace.id))
        .filter(invites::Column::AcceptedAt.is_null())
        .filter(invites::Column::RevokedAt.is_null())
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Invite", &id))?;
    invites::Entity::update_many()
        .col_expr(invites::Column::RevokedAt, Expr::value(Utc::now().fixed_offset()))
        .filter(invites::Column::Id.eq(&row.id))
        .filter(invites::Column::WorkspaceId.eq(&ctx.workspace.id))
        .filter(invites::Column::AcceptedAt.is_null())
        .filter(invites::Column::RevokedAt.is_null())
        .exec(&state.db)
        .await
        .map_err(|error| {
            eprintln!("invite revoke failed at update: {error}");
            AppError::internal(error)
        })?;
    Events::of(&state).publish(
        &ctx.workspace.id,
        LiveChange::deleted(trama_contracts::activity::LiveEventEntity::Invite, &id),
    );
    Ok(StatusCode::NO_CONTENT)
}

fn stored_access(value: Option<&Value>) -> Option<MemberAccess> {
    value.and_then(|v| serde_json::from_value(v.clone()).ok())
}

fn project_access(ids: Vec<String>, previous: Option<MemberAccess>) -> MemberAccess {
    MemberAccess {
        projects: MemberProjectScope { all: false, project_ids: ids },
        include_unassigned: false,
        grants: previous.map_or_else(Vec::new, |a| a.grants),
    }
}

async fn checked_project(
    state: &AppState,
    ctx: &trama_auth::WorkspaceContext,
    id: &str,
) -> Result<projects::Model, AppError> {
    let project = projects::Entity::find_by_id(id)
        .filter(projects::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
        .one(&state.db)
        .await?
        .filter(|_| !trama_auth::member_access::project_hidden(ctx.access.as_ref(), Some(id)))
        .ok_or_else(|| AppError::entity_not_found("Project", id))?;
    Ok(project)
}

#[utoipa::path(get, path = "/api/w/{slug}/projects/{id}/share", tag = "sharing",
    params(("slug" = String, Path), ("id" = String, Path)),
    responses((status = 200, description = "People and pending invitations with project access", body = ProjectShare),
        (status = 404, description = "Project not found")))]
async fn project_share(
    State(state): State<AppState>,
    Ctx(ctx): Ctx,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Json<ProjectShare>, AppError> {
    checked_project(&state, &ctx, &id).await?;
    let settings = roles(&ctx.workspace);
    let rows = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
        .order_by_asc(memberships::Column::CreatedAt)
        .all(&state.db)
        .await?;
    let mut members = Vec::new();
    for row in rows {
        let access = stored_access(row.access.as_ref());
        let effective = effective_member_access(
            find_workspace_role(&settings.roles, Some(&row.role)),
            access.as_ref(),
        );
        if !access_includes_project(effective.as_ref(), &id) {
            continue;
        }
        // A narrowed caller may only enumerate people whose project scope overlaps theirs, plus self.
        if let Some(caller) = ctx.access.as_ref()
            && ctx.user_id.as_deref() != Some(row.user_id.as_str())
            && !trama_contracts::access::accesses_share_project(effective.as_ref(), Some(caller))
        {
            continue;
        }
        let user_row = users::Entity::find_by_id(&row.user_id).one(&state.db).await?;
        members.push(ProjectShareMember {
            membership: Membership::from(&row),
            user: user_row.as_ref().map(User::from),
            all_projects: !is_project_limited(effective.as_ref()),
        });
    }
    let pending = invites::Entity::find()
        .filter(invites::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
        .filter(invites::Column::AcceptedAt.is_null())
        .filter(invites::Column::RevokedAt.is_null())
        .order_by_desc(invites::Column::CreatedAt)
        .all(&state.db)
        .await?;
    let invites = pending
        .into_iter()
        .filter(|row| {
            stored_access(row.access.as_ref()).is_some_and(|a| a.projects.project_ids.contains(&id))
        })
        .map(|row| present(&row))
        .collect();
    Ok(Json(ProjectShare { members, invites }))
}

#[utoipa::path(post, path = "/api/w/{slug}/projects/{id}/invites", tag = "sharing",
    params(("slug" = String, Path), ("id" = String, Path)),
    request_body = ProjectInviteBody,
    responses((status = 201, description = "Invitation or existing member added", body = ProjectInviteResult),
        (status = 400, description = "Project cannot be shared with this person"),
        (status = 403, description = "Cannot change this person's access"),
        (status = 404, description = "Project not found"), (status = 409, description = "Pending workspace invitation exists")))]
#[allow(clippy::too_many_lines)]
async fn project_invite(
    State(state): State<AppState>,
    ctx: Ctx,
    Path((_slug, id)): Path<(String, String)>,
    ApiJson(body): ApiJson<ProjectInviteBody>,
) -> Result<(StatusCode, Json<ProjectInviteResult>), AppError> {
    checked_project(&state, &ctx, &id).await?;
    let mut checks = trama_core::validation::Checks::new();
    checks.email("email", &body.email);
    checks.finish()?;
    let email = body.email.trim().to_lowercase();
    let settings = roles(&ctx.workspace);
    let user = users::Entity::find().filter(users::Column::Email.eq(&email)).one(&state.db).await?;
    if let Some(user) = user
        && let Some(member) = memberships::Entity::find()
            .filter(memberships::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
            .filter(memberships::Column::UserId.eq(user.id.clone()))
            .one(&state.db)
            .await?
    {
        let role = find_workspace_role(&settings.roles, Some(&member.role));
        let effective =
            effective_member_access(role, stored_access(member.access.as_ref()).as_ref());
        if !is_project_limited(effective.as_ref()) {
            return Err(AppError::bad_request(format!(
                "{} is already a member with access to every project. Nothing to share.",
                if user.name.is_empty() { &email } else { &user.name }
            )));
        }
        if !can_grant_role(Some(&ctx.effective_role), role) {
            return Err(AppError::forbidden(
                "You cannot change the access of someone with permissions you do not have",
            ));
        }
        if !access_includes_project(effective.as_ref(), &id) {
            let mut ids =
                effective.as_ref().map_or_else(Vec::new, |a| a.projects.project_ids.clone());
            ids.push(id.clone());
            let mut active: memberships::ActiveModel = member.clone().into();
            active.access = Set(Some(
                serde_json::to_value(project_access(ids, stored_access(member.access.as_ref())))
                    .expect("member access serializes"),
            ));
            active.update(&state.db).await?;
            Events::of(&state).publish(
                &ctx.workspace.id,
                LiveChange::updated(
                    trama_contracts::activity::LiveEventEntity::Membership,
                    &member.id,
                ),
            );
        }
        let member = memberships::Entity::find_by_id(member.id)
            .one(&state.db)
            .await?
            .expect("membership remains");
        let access = stored_access(member.access.as_ref());
        let effective = effective_member_access(
            find_workspace_role(&settings.roles, Some(&member.role)),
            access.as_ref(),
        );
        return Ok((
            StatusCode::CREATED,
            Json(ProjectInviteResult::Added {
                member: ProjectShareMember {
                    membership: Membership::from(&member),
                    user: Some(User::from(&user)),
                    all_projects: !is_project_limited(effective.as_ref()),
                },
            }),
        ));
    }
    if find_workspace_role(&settings.roles, Some(GUEST_ROLE_ID)).is_none() {
        return Err(AppError::bad_request(
            "This workspace has no Guest role. Add one in Settings · Roles & permissions before inviting guests.",
        ));
    }
    let pending = invites::Entity::find()
        .filter(invites::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
        .filter(invites::Column::Email.eq(&email))
        .filter(invites::Column::AcceptedAt.is_null())
        .filter(invites::Column::RevokedAt.is_null())
        .one(&state.db)
        .await?;
    if pending.as_ref().is_some_and(|i| i.role != GUEST_ROLE_ID) {
        return Err(AppError::conflict(
            "This person already has a pending workspace invitation. Manage it in Settings · Members.",
        ));
    }
    let mut ids = pending
        .as_ref()
        .and_then(|i| stored_access(i.access.as_ref()))
        .map_or_else(Vec::new, |a| a.projects.project_ids);
    if !ids.contains(&id) {
        ids.push(id);
    }
    let access = project_access(ids, None);
    let (_, Json(link)) = create(
        State(state),
        ctx,
        ApiJson(CreateBody {
            email,
            role: GUEST_ROLE_ID.to_owned(),
            access: Some(serde_json::to_value(access).expect("member access serializes")),
        }),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(ProjectInviteResult::Invited { link })))
}

#[utoipa::path(post, path = "/api/w/{slug}/projects/{id}/invites/{inviteId}/resend", tag = "sharing",
    params(("slug" = String, Path), ("id" = String, Path), ("inviteId" = String, Path)),
    responses((status = 200, description = "Rotated invitation link", body = InviteLink), (status = 404, description = "Project invitation not found")))]
async fn project_resend(
    State(state): State<AppState>,
    ctx: Ctx,
    Path((_slug, project_id, invite_id)): Path<(String, String, String)>,
) -> Result<Json<InviteLink>, AppError> {
    checked_project(&state, &ctx, &project_id).await?;
    let row = find_project_invite(&state, &ctx, &project_id, &invite_id).await?;
    let (_, Json(link)) = create(
        State(state),
        ctx,
        ApiJson(CreateBody { email: row.email, role: row.role, access: row.access }),
    )
    .await?;
    Ok(Json(link))
}

async fn find_project_invite(
    state: &AppState,
    ctx: &trama_auth::WorkspaceContext,
    project_id: &str,
    invite_id: &str,
) -> Result<invites::Model, AppError> {
    let row = invites::Entity::find_by_id(invite_id)
        .filter(invites::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
        .filter(invites::Column::AcceptedAt.is_null())
        .filter(invites::Column::RevokedAt.is_null())
        .one(&state.db)
        .await?;
    row.filter(|row| {
        stored_access(row.access.as_ref())
            .is_some_and(|a| a.projects.project_ids.contains(&project_id.to_owned()))
    })
    .ok_or_else(|| AppError::entity_not_found("Invite", invite_id))
}

#[utoipa::path(delete, path = "/api/w/{slug}/projects/{id}/invites/{inviteId}", tag = "sharing",
    params(("slug" = String, Path), ("id" = String, Path), ("inviteId" = String, Path)),
    responses((status = 204, description = "Project invitation revoked or removed"), (status = 404, description = "Project invitation not found")))]
async fn project_revoke(
    State(state): State<AppState>,
    ctx: Ctx,
    Path((_slug, project_id, invite_id)): Path<(String, String, String)>,
) -> Result<StatusCode, AppError> {
    checked_project(&state, &ctx, &project_id).await?;
    let row = find_project_invite(&state, &ctx, &project_id, &invite_id).await?;
    let mut access = stored_access(row.access.as_ref()).expect("project invite has access");
    access.projects.project_ids.retain(|id| id != &project_id);
    if access.projects.project_ids.is_empty() {
        return revoke(State(state), ctx.clone(), Path((ctx.workspace.slug.clone(), invite_id)))
            .await;
    }
    let mut active: invites::ActiveModel = row.clone().into();
    active.access = Set(Some(serde_json::to_value(access).expect("member access serializes")));
    active.update(&state.db).await?;
    Events::of(&state).publish(
        &ctx.workspace.id,
        LiveChange::updated(trama_contracts::activity::LiveEventEntity::Invite, &invite_id),
    );
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/api/w/{slug}/projects/{id}/share/{membershipId}", tag = "sharing",
    params(("slug" = String, Path), ("id" = String, Path), ("membershipId" = String, Path)),
    responses((status = 200, description = "Project access removed", body = MembershipEnded), (status = 404, description = "Membership not found")))]
async fn project_remove(
    State(state): State<AppState>,
    Ctx(ctx): Ctx,
    Path((_slug, project_id, membership_id)): Path<(String, String, String)>,
) -> Result<Json<MembershipEnded>, AppError> {
    checked_project(&state, &ctx, &project_id).await?;
    let member = memberships::Entity::find_by_id(&membership_id)
        .filter(memberships::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Membership", &membership_id))?;
    let access = stored_access(member.access.as_ref());
    let roles = roles(&ctx.workspace);
    let role = find_workspace_role(&roles.roles, Some(&member.role));
    let effective = effective_member_access(role, access.as_ref());
    if !is_project_limited(effective.as_ref()) {
        return Err(AppError::bad_request(
            "This person sees every project. Change their access in Settings · Members.",
        ));
    }
    if !access_includes_project(effective.as_ref(), &project_id) {
        return Err(AppError::entity_not_found("Membership", &membership_id));
    }
    if !can_grant_role(Some(&ctx.effective_role), role) {
        return Err(AppError::forbidden(
            "You cannot change the access of someone with permissions you do not have",
        ));
    }
    let mut ids = effective.map_or_else(Vec::new, |a| a.projects.project_ids);
    ids.retain(|id| id != &project_id);
    if ids.is_empty() {
        if member.role != GUEST_ROLE_ID {
            return Err(AppError::bad_request(
                "This is their last project. Change their access or remove them in Settings · Members.",
            ));
        }
        memberships::Entity::delete_by_id(&membership_id).exec(&state.db).await?;
        Events::of(&state).publish(
            &ctx.workspace.id,
            LiveChange::deleted(
                trama_contracts::activity::LiveEventEntity::Membership,
                &membership_id,
            ),
        );
        return Ok(Json(MembershipEnded { membership_ended: true }));
    }
    let mut active: memberships::ActiveModel = member.clone().into();
    active.access = Set(Some(
        serde_json::to_value(project_access(ids, access)).expect("member access serializes"),
    ));
    active.update(&state.db).await?;
    Events::of(&state).publish(
        &ctx.workspace.id,
        LiveChange::updated(trama_contracts::activity::LiveEventEntity::Membership, &membership_id),
    );
    Ok(Json(MembershipEnded { membership_ended: false }))
}

async fn by_token(state: &AppState, token: &str) -> Result<invites::Model, AppError> {
    let digest = sha256_hex(token);
    let row = invites::Entity::find()
        .filter(invites::Column::TokenHash.eq(digest))
        .one(&state.db)
        .await?
        .filter(|row| {
            row.accepted_at.is_none()
                && row.revoked_at.is_none()
                && row.expires_at > Utc::now().fixed_offset()
        })
        .ok_or_else(|| AppError::not_found("This invitation is no longer valid"))?;
    Ok(row)
}

#[utoipa::path(get, path = "/api/invites/{token}", tag = "sharing",
    params(("token" = String, Path, description = "Invitation token")),
    responses((status = 200, description = "Invitation preview", body = InvitePreview), (status = 404, description = "Invalid invitation")))]
async fn preview(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<InvitePreview>, AppError> {
    let row = by_token(&state, &token).await?;
    let workspace = workspaces::Entity::find_by_id(&row.workspace_id)
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("This invitation is no longer valid"))?;
    let settings = roles(&workspace);
    let inviter = if let Some(id) = &row.invited_by_user_id {
        users::Entity::find_by_id(id).one(&state.db).await?
    } else {
        None
    };
    Ok(Json(InvitePreview {
        workspace_name: workspace.name,
        role: row.role.clone(),
        role_name: workspace_role_name(Some(&settings.roles), Some(&row.role)),
        email: row.email,
        invited_by_name: inviter.map(|u| u.name),
        expires_at: trama_core::time::to_iso(&row.expires_at),
    }))
}

#[utoipa::path(post, path = "/api/invites/{token}/accept", tag = "sharing",
    params(("token" = String, Path, description = "Invitation token")),
    responses((status = 200, description = "Joined workspace", body = AcceptResult),
        (status = 403, description = "Email mismatch or session required"), (status = 404, description = "Invalid invitation")))]
async fn accept(
    State(state): State<AppState>,
    auth: Auth,
    Path(token): Path<String>,
) -> Result<Json<AcceptResult>, AppError> {
    if auth.method != AuthMethod::Session {
        return Err(AppError::forbidden("This endpoint requires a browser session"));
    }
    let (user_id, user_email) = {
        let user = auth.require_user()?;
        (user.id.clone(), user.email.to_lowercase())
    };
    let row = by_token(&state, &token).await?;
    if user_email != row.email {
        let local = row.email.split('@').next().unwrap_or("");
        return Err(AppError::forbidden(format!(
            "This invitation was sent to {}***@{}. Sign in with that account to accept it.",
            local.chars().next().unwrap_or('*'),
            row.email.split('@').nth(1).unwrap_or("")
        )));
    }
    let workspace = workspaces::Entity::find_by_id(&row.workspace_id)
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("This invitation is no longer valid"))?;
    let settings = roles(&workspace);
    if find_workspace_role(&settings.roles, Some(&row.role)).is_none() {
        return Err(AppError::bad_request("That role no longer exists"));
    }
    let txn = state.db.begin().await?;
    let existing = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(&workspace.id))
        .filter(memberships::Column::UserId.eq(&user_id))
        .one(&txn)
        .await?;
    let mut accepted_role = row.role.clone();
    let membership_id = if let Some(current) = existing {
        accepted_role.clone_from(&current.role);
        if let (Some(existing_access), Some(invite_access)) = (
            current.access.as_ref().and_then(|v| {
                serde_json::from_value::<trama_contracts::access::MemberAccess>(v.clone()).ok()
            }),
            row.access.as_ref().and_then(|v| {
                serde_json::from_value::<trama_contracts::access::MemberAccess>(v.clone()).ok()
            }),
        ) && !existing_access.projects.all
            && !invite_access.projects.all
        {
            let mut merged = existing_access;
            for project_id in invite_access.projects.project_ids {
                if !merged.projects.project_ids.contains(&project_id) {
                    merged.projects.project_ids.push(project_id);
                }
            }
            let mut active: memberships::ActiveModel = current.into();
            active.access =
                Set(Some(serde_json::to_value(merged).expect("member access serializes")));
            active.save(&txn).await?;
        }
        None
    } else {
        let membership = memberships::ActiveModel {
            id: Set(trama_core::ids::uid("mb")),
            workspace_id: Set(workspace.id.clone()),
            user_id: Set(user_id),
            role: Set(row.role.clone()),
            created_at: Set(Utc::now().fixed_offset()),
            access: Set(row.access.clone()),
        };
        Some(membership.insert(&txn).await?.id)
    };
    let mut active: invites::ActiveModel = row.clone().into();
    active.accepted_at = Set(Some(Utc::now().fixed_offset()));
    active.save(&txn).await?;
    txn.commit().await?;
    if let Some(id) = membership_id {
        Events::of(&state).publish(
            &workspace.id,
            LiveChange::created(trama_contracts::activity::LiveEventEntity::Membership, &id),
        );
    }
    Events::of(&state).publish(
        &workspace.id,
        LiveChange::deleted(trama_contracts::activity::LiveEventEntity::Invite, &row.id),
    );
    Ok(Json(AcceptResult {
        workspace: WorkspaceRef { slug: workspace.slug, name: workspace.name },
        role: accepted_role,
    }))
}
