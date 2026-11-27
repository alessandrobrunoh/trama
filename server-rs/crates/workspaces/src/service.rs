//! The database work behind the workspace routes: `WorkspacesService` of
//! `server/src/workspaces/workspaces.service.ts` and the token rules of `TokensController`.
//!
//! Every function takes what NestJS read from the request explicitly (the workspace row, the
//! caller) so other crates can call them. Live events are published exactly where NestJS does.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr,
    EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set, Statement,
    TransactionTrait, Value as SqlValue,
};
use serde_json::{Map, Value, json};
use trama_auth::member_access::{apply_project_scope, current_access};
use trama_auth::personal_workspace::{RESERVED_SLUGS, is_valid_slug};
use trama_auth::tokens::{ApiTokenView, NewToken, create_token, revoke};
use trama_auth::{AuthInfo, WorkspaceContext, WorkspaceWithRole, permissions};
use trama_common::util::{is_unique_violation, slugify};
use trama_contracts::access::{
    MemberAccess, MemberGrant, access_within, effective_member_access, is_project_limited,
    normalize_grant_list, normalize_member_access,
};
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::common::{ActorRef, AgentProvider};
use trama_contracts::identity::{Agent, Membership, User, stored_member_access};
use trama_contracts::js;
use trama_contracts::member_rules::{
    MemberActor, MemberRuleContext, MemberTarget, assert_can_change_role, assert_can_remove_member,
    assert_can_transfer_ownership,
};
use trama_contracts::people_scope::visible_memberships;
use trama_contracts::roles::{
    Capability, OWNER_ROLE_ID, ROLE_NAME_MAX, TokenScope, WorkspaceRole, apply_token_scope,
    can_grant_role, find_workspace_role, fresh_workspace_roles, normalize_capabilities,
    normalize_workspace_roles,
};
use trama_contracts::settings::resolve_workspace_settings;
use trama_core::ids::uid;
use trama_core::validation::Patch;
use trama_core::{AppError, AppState};
use trama_entities::{agents, api_tokens, invites, issues, memberships, users, workspaces};
use trama_events::{Events, LiveChange};

use crate::schemas::{
    AgentPatch, MemberPatch, MemberWithUser, NewAgent, NewApiToken, NewMember, NewRole,
    NewWorkspace, RolePatch, SettingsPatch, TokenCreated, WorkspacePatch,
};

/// A personal workspace belongs to the account for as long as the account exists. It can only be
/// renamed.
#[must_use]
pub fn personal_workspace_fixed(verb: &str) -> String {
    format!("A personal workspace cannot be {verb}. You can rename it.")
}

fn announce(state: &AppState, workspace_id: &str, change: LiveChange) {
    Events::of(state).publish(workspace_id, change);
}

fn workspace_updated(state: &AppState, workspace_id: &str) {
    announce(state, workspace_id, LiveChange::updated(LiveEventEntity::Workspace, workspace_id));
}

fn roles_of(ws: &workspaces::Model) -> Vec<WorkspaceRole> {
    resolve_workspace_settings(&ws.settings).roles
}

fn settings_map(ws: &workspaces::Model) -> Map<String, Value> {
    ws.settings.as_object().cloned().unwrap_or_default()
}

/// Writes the stored `settings` column of a workspace and returns the new row. Callers publish
/// the live event.
pub(crate) async fn save_settings(
    db: &impl ConnectionTrait,
    ws: &workspaces::Model,
    settings: Map<String, Value>,
) -> Result<workspaces::Model, AppError> {
    let mut row: workspaces::ActiveModel = ws.clone().into();
    row.settings = Set(Value::Object(settings));
    Ok(row.update(db).await?)
}

fn unique_or(err: DbErr, conflict: impl FnOnce() -> AppError) -> AppError {
    if is_unique_violation(&err) { conflict() } else { err.into() }
}

fn slug_taken_error(slug: &str) -> AppError {
    AppError::conflict(format!("Slug \"{slug}\" is taken"))
}

async fn slug_exists(db: &impl ConnectionTrait, slug: &str) -> Result<bool, AppError> {
    Ok(workspaces::Entity::find().filter(workspaces::Column::Slug.eq(slug)).count(db).await? > 0)
}

// ───────────────────────────── workspaces ─────────────────────────────

/// The workspaces the user belongs to, each with their role (`listMine`). A token filters this to
/// its own workspace in the route.
///
/// # Errors
///
/// The database error.
pub async fn list_mine(
    db: &impl ConnectionTrait,
    user_id: &str,
) -> Result<Vec<WorkspaceWithRole>, AppError> {
    Ok(trama_auth::service::workspaces_of(db, user_id).await?)
}

/// Creates a workspace owned by `user` (`create`): a free slug (explicit ones are refused when
/// reserved or taken), the default roles and the owner membership, in one transaction.
///
/// # Errors
///
/// 400 for a malformed slug, 409 for a reserved or taken one.
pub async fn create_workspace(
    db: &DatabaseConnection,
    user: &users::Model,
    input: &NewWorkspace,
) -> Result<WorkspaceWithRole, AppError> {
    let explicit =
        input.slug.as_deref().map(|s| js::trim(s).to_lowercase()).filter(|s| !s.is_empty());
    let from_name = slugify(&input.name);
    let base = explicit
        .clone()
        .or_else(|| (!from_name.is_empty()).then_some(from_name))
        .unwrap_or_else(|| "workspace".to_owned());
    if let Some(explicit) = &explicit
        && !is_valid_slug(explicit)
    {
        return Err(AppError::bad_request(
            "slug must be 3-40 chars: lowercase letters, digits and dashes",
        ));
    }
    let reserved = RESERVED_SLUGS.contains(&base.as_str());
    if reserved && explicit.is_some() {
        return Err(AppError::conflict(format!("Slug \"{base}\" is reserved")));
    }
    let mut slug = if reserved || base.len() < 3 { format!("{base}-ws") } else { base };
    if explicit.is_some() {
        if slug_exists(db, &slug).await? {
            return Err(slug_taken_error(&slug));
        }
    } else {
        let root = slug.clone();
        let mut n = 2;
        while slug_exists(db, &slug).await? {
            slug = format!("{root}-{n}");
            n += 1;
        }
    }
    let txn = db.begin().await?;
    let created = async {
        let workspace = workspaces::ActiveModel {
            id: Set(uid("ws")),
            name: Set(js::trim(&input.name).to_owned()),
            slug: Set(slug.clone()),
            primary_owner_id: Set(Some(user.id.clone())),
            personal: Set(false),
            settings: Set(json!({ "roles": fresh_workspace_roles() })),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        memberships::ActiveModel {
            id: Set(uid("mb")),
            workspace_id: Set(workspace.id.clone()),
            user_id: Set(user.id.clone()),
            role: Set(OWNER_ROLE_ID.to_owned()),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        Ok::<_, DbErr>(workspace)
    }
    .await;
    let workspace = match created {
        Ok(workspace) => {
            txn.commit().await?;
            workspace
        }
        Err(err) => {
            let _ = txn.rollback().await;
            return Err(unique_or(err, || slug_taken_error(&slug)));
        }
    };
    Ok(WorkspaceWithRole::new(&workspace, OWNER_ROLE_ID))
}

/// Renames the workspace and/or changes its slug (`update`).
///
/// # Errors
///
/// 400 for an invalid or reserved slug, 409 when it is taken.
pub async fn update_workspace(
    db: &impl ConnectionTrait,
    ws: &workspaces::Model,
    patch: &WorkspacePatch,
) -> Result<workspaces::Model, AppError> {
    let mut row: workspaces::ActiveModel = ws.clone().into();
    let mut changed = false;
    if let Some(name) = &patch.name {
        row.name = Set(js::trim(name).to_owned());
        changed = true;
    }
    let mut new_slug = None;
    if let Some(slug) = patch.slug.as_deref()
        && slug != ws.slug
    {
        let slug = slug.to_lowercase();
        if !is_valid_slug(&slug) || RESERVED_SLUGS.contains(&slug.as_str()) {
            return Err(AppError::bad_request("Invalid or reserved slug"));
        }
        if slug_exists(db, &slug).await? {
            return Err(slug_taken_error(&slug));
        }
        row.slug = Set(slug.clone());
        new_slug = Some(slug);
        changed = true;
    }
    if !changed {
        return Ok(ws.clone());
    }
    row.update(db)
        .await
        .map_err(|err| unique_or(err, || slug_taken_error(new_slug.as_deref().unwrap_or(&ws.slug))))
}

/// `+hh`, `+hhmm` or `+hh:mm`, which `Intl` also takes as a time zone.
fn is_utc_offset(zone: &str) -> bool {
    static OFFSET: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?$").expect("valid offset pattern")
    });
    OFFSET.is_match(zone)
}

/// Does `Intl.DateTimeFormat('en', { timeZone })` accept it? An IANA name (any case) or a UTC
/// offset.
#[must_use]
pub fn is_valid_time_zone(zone: &str) -> bool {
    chrono_tz::Tz::from_str_insensitive(zone).is_ok() || is_utc_offset(zone)
}

/// Partial update of the customization settings (`updateSettings`). Roles are changed through the
/// role functions.
///
/// # Errors
///
/// 400 for a time zone that is not an IANA name.
pub async fn update_settings(
    state: &AppState,
    ws: &workspaces::Model,
    patch: &SettingsPatch,
) -> Result<workspaces::Model, AppError> {
    let mut next = settings_map(ws);
    if let Some(scale) = patch.estimate_scale {
        next.insert("estimateScale".into(), json!(scale));
    }
    if let Some(start) = patch.week_start {
        next.insert("weekStart".into(), json!(start));
    }
    if let Some(zone) = &patch.time_zone {
        if zone != "auto" && !is_valid_time_zone(zone) {
            return Err(AppError::bad_request(format!("\"{zone}\" is not a valid IANA time zone")));
        }
        next.insert("timeZone".into(), json!(zone));
    }
    match &patch.icon_color {
        Patch::Missing => {}
        Patch::Null => {
            next.remove("iconColor");
        }
        Patch::Value(color) => {
            next.insert("iconColor".into(), json!(color.to_lowercase()));
        }
    }
    match &patch.icon_initial {
        Patch::Missing => {}
        Patch::Null => {
            next.remove("iconInitial");
        }
        Patch::Value(initial) => {
            let initial = js::trim(initial);
            if initial.is_empty() {
                next.remove("iconInitial");
            } else {
                next.insert("iconInitial".into(), json!(initial.to_uppercase()));
            }
        }
    }
    let saved = save_settings(&state.db, ws, next).await?;
    workspace_updated(state, &ws.id);
    Ok(saved)
}

/// Irreversible: the caller must repeat the workspace slug or name so a stray request cannot
/// delete it (`remove`).
///
/// # Errors
///
/// 409 for a personal workspace, 400 when `confirm` is neither the slug nor the name.
pub async fn delete_workspace(
    db: &impl ConnectionTrait,
    ws: &workspaces::Model,
    confirm: &str,
) -> Result<(), AppError> {
    if ws.personal {
        return Err(AppError::conflict(personal_workspace_fixed("deleted")));
    }
    let typed = js::trim(confirm);
    if typed != ws.slug && typed != ws.name {
        return Err(AppError::bad_request(
            "confirm must be the exact slug or name of the workspace you are deleting",
        ));
    }
    workspaces::Entity::delete_by_id(ws.id.clone()).exec(db).await?;
    Ok(())
}

// ───────────────────────────── roles ─────────────────────────────

fn assert_owner(ctx: &WorkspaceContext) -> Result<(), AppError> {
    if ctx.is_owner() { Ok(()) } else { Err(AppError::forbidden("Only an owner can change roles")) }
}

async fn write_roles(
    state: &AppState,
    ws: &workspaces::Model,
    roles: &[WorkspaceRole],
) -> Result<workspaces::Model, AppError> {
    let values: Vec<Value> = roles.iter().map(|r| json!(r)).collect();
    let normalized = normalize_workspace_roles(&values);
    let mut settings = settings_map(ws);
    settings.insert("roles".into(), json!(normalized));
    settings.remove("permissions");
    settings.remove("roleGrants");
    let saved = save_settings(&state.db, ws, settings).await?;
    workspace_updated(state, &ws.id);
    Ok(saved)
}

fn role_name_error() -> AppError {
    AppError::bad_request(format!("A role name is required (at most {ROLE_NAME_MAX} characters)"))
}

fn assert_known_capabilities(input: Option<&[String]>) -> Result<(), AppError> {
    for cap in input.unwrap_or_default() {
        if Capability::parse(cap).is_none() {
            return Err(AppError::bad_request(format!("Unknown capability \"{cap}\"")));
        }
    }
    Ok(())
}

fn strings_to_values(list: &[String]) -> Vec<Value> {
    list.iter().map(|s| Value::String(s.clone())).collect()
}

/// Owner only. The new role starts with exactly the capabilities and grants that were sent
/// (`createRole`).
///
/// # Errors
///
/// 403 for a non-owner, 400 for a bad name or capability, 409 for a duplicate name.
pub async fn create_role(
    state: &AppState,
    ctx: &WorkspaceContext,
    input: &NewRole,
) -> Result<workspaces::Model, AppError> {
    assert_owner(ctx)?;
    let name = js::trim(&input.name);
    if name.is_empty() || js::len(name) > ROLE_NAME_MAX {
        return Err(role_name_error());
    }
    let mut roles = roles_of(&ctx.workspace);
    if roles.iter().any(|role| role.name.to_lowercase() == name.to_lowercase()) {
        return Err(AppError::conflict(format!("A role named \"{name}\" already exists")));
    }
    assert_known_capabilities(input.capabilities.as_deref())?;
    roles.push(WorkspaceRole {
        id: uid("role").to_lowercase(),
        name: name.to_owned(),
        owner: false,
        capabilities: normalize_capabilities(
            &strings_to_values(input.capabilities.as_deref().unwrap_or_default()),
            false,
        ),
        grants: normalize_grant_list(&strings_to_values(
            input.grants.as_deref().unwrap_or_default(),
        )),
    });
    write_roles(state, &ctx.workspace, &roles).await
}

/// Owner only. The owner role stays the owner role and keeps membership management
/// (`updateRole`).
///
/// # Errors
///
/// 403 for a non-owner, 400 when nothing changes or a value is invalid, 404 for an unknown role,
/// 409 for a duplicate name.
pub async fn update_role(
    state: &AppState,
    ctx: &WorkspaceContext,
    role_id: &str,
    patch: &RolePatch,
) -> Result<workspaces::Model, AppError> {
    assert_owner(ctx)?;
    if patch.name.is_none() && patch.capabilities.is_none() && patch.grants.is_none() {
        return Err(AppError::bad_request("Nothing to change"));
    }
    let mut roles = roles_of(&ctx.workspace);
    let Some(index) = roles.iter().position(|r| r.id == role_id) else {
        return Err(AppError::entity_not_found("Role", role_id));
    };
    if let Some(name) = &patch.name {
        let name = js::trim(name);
        if name.is_empty() || js::len(name) > ROLE_NAME_MAX {
            return Err(role_name_error());
        }
        if roles
            .iter()
            .any(|item| item.id != role_id && item.name.to_lowercase() == name.to_lowercase())
        {
            return Err(AppError::conflict(format!("A role named \"{name}\" already exists")));
        }
        name.clone_into(&mut roles[index].name);
    }
    if let Some(capabilities) = &patch.capabilities {
        assert_known_capabilities(Some(capabilities))?;
        roles[index].capabilities =
            normalize_capabilities(&strings_to_values(capabilities), roles[index].owner);
    }
    if let Some(grants) = &patch.grants
        && !roles[index].owner
    {
        roles[index].grants = normalize_grant_list(&strings_to_values(grants));
    }
    write_roles(state, &ctx.workspace, &roles).await
}

/// Owner only. The owner role cannot be deleted, and neither can a role someone still holds
/// (`deleteRole`).
///
/// # Errors
///
/// 403 for a non-owner or the owner role, 404 for an unknown role, 409 while the role is in use.
pub async fn delete_role(
    state: &AppState,
    ctx: &WorkspaceContext,
    role_id: &str,
) -> Result<workspaces::Model, AppError> {
    assert_owner(ctx)?;
    let roles = roles_of(&ctx.workspace);
    let Some(role) = find_workspace_role(&roles, Some(role_id)) else {
        return Err(AppError::entity_not_found("Role", role_id));
    };
    if role.owner || role.id == OWNER_ROLE_ID {
        return Err(AppError::forbidden("The owner role cannot be deleted"));
    }
    let held = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
        .filter(memberships::Column::Role.eq(role.id.clone()))
        .count(&state.db)
        .await?
        > 0;
    if held {
        return Err(AppError::conflict("Move everyone off this role before deleting it"));
    }
    let pending = invites::Entity::find()
        .filter(invites::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
        .filter(invites::Column::Role.eq(role.id.clone()))
        .filter(invites::Column::AcceptedAt.is_null())
        .filter(invites::Column::RevokedAt.is_null())
        .count(&state.db)
        .await?
        > 0;
    if pending {
        return Err(AppError::conflict("Revoke invitations for this role before deleting it"));
    }
    let remaining: Vec<WorkspaceRole> = roles.iter().filter(|r| r.id != role.id).cloned().collect();
    write_roles(state, &ctx.workspace, &remaining).await
}

// ───────────────────────────── members ─────────────────────────────

/// Who is changing a membership: what `MemberActor` carries plus the token cap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemberCaller {
    /// Role id of the caller.
    pub role: String,
    /// The caller's user id (absent for an agent token).
    pub user_id: Option<String>,
    /// The API token scope of the request.
    pub token_scope: Option<TokenScope>,
    /// `hasAdminPower(ctx)`: may act on someone who is not an owner.
    pub can_manage_members: bool,
}

impl MemberCaller {
    /// The caller of a `/w/{slug}` request (`actor(ctx)` of the members controller).
    #[must_use]
    pub fn of(ctx: &WorkspaceContext) -> Self {
        Self {
            role: ctx.role.clone(),
            user_id: ctx.user_id.clone(),
            token_scope: ctx.token_scope,
            can_manage_members: ctx.has_admin_power(),
        }
    }

    fn actor(&self) -> MemberActor<'_> {
        MemberActor {
            role: &self.role,
            user_id: self.user_id.as_deref(),
            can_manage_members: Some(self.can_manage_members),
            token_scope: self.token_scope,
        }
    }
}

/// Who is looking at the member list (`viewer` of `listMembers`).
#[derive(Clone, Copy, Debug)]
pub struct MemberViewer<'a> {
    /// The workspace's roles.
    pub roles: &'a [WorkspaceRole],
    /// The viewer's access; project-limited viewers see fewer people.
    pub access: Option<&'a MemberAccess>,
    /// The viewer's user id.
    pub user_id: Option<&'a str>,
}

impl<'a> MemberViewer<'a> {
    /// The viewer of a `/w/{slug}` request.
    #[must_use]
    pub fn of(ctx: &'a WorkspaceContext) -> Self {
        Self {
            roles: &ctx.settings.roles,
            access: ctx.access.as_ref(),
            user_id: ctx.user_id.as_deref(),
        }
    }
}

fn with_user(m: &memberships::Model, user: Option<&users::Model>) -> MemberWithUser {
    MemberWithUser { membership: Membership::from(m), user: user.map(User::from) }
}

/// Everyone in the workspace, or, for someone limited to some projects, the people on those
/// projects (`listMembers`), oldest first, with their accounts.
///
/// # Errors
///
/// The database error.
pub async fn list_members(
    db: &impl ConnectionTrait,
    workspace_id: &str,
    viewer: Option<MemberViewer<'_>>,
) -> Result<Vec<MemberWithUser>, AppError> {
    let all = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(workspace_id))
        .order_by_asc(memberships::Column::CreatedAt)
        .all(db)
        .await?;
    let wires: Vec<Membership> = all.iter().map(Membership::from).collect();
    let rows = match viewer {
        Some(viewer) => visible_memberships(&wires, viewer.roles, viewer.access, viewer.user_id),
        None => wires,
    };
    let ids: Vec<String> = rows.iter().map(|r| r.user_id.clone()).collect();
    let people: HashMap<String, users::Model> = users::Entity::find()
        .filter(users::Column::Id.is_in(ids))
        .all(db)
        .await?
        .into_iter()
        .map(|u| (u.id.clone(), u))
        .collect();
    Ok(rows
        .into_iter()
        .map(|membership| {
            let user = people.get(&membership.user_id).map(User::from);
            MemberWithUser { membership, user }
        })
        .collect())
}

async fn get_membership(
    db: &impl ConnectionTrait,
    workspace_id: &str,
    id: &str,
) -> Result<memberships::Model, AppError> {
    memberships::Entity::find_by_id(id.to_owned())
        .filter(memberships::Column::WorkspaceId.eq(workspace_id))
        .one(db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Membership", id))
}

fn unknown_role(id: &str) -> AppError {
    AppError::bad_request(format!("Unknown role \"{id}\""))
}

fn effective_caller(
    roles: &[WorkspaceRole],
    caller_role: &str,
    token_scope: Option<TokenScope>,
) -> Option<WorkspaceRole> {
    find_workspace_role(roles, Some(caller_role)).map(|role| apply_token_scope(role, token_scope))
}

/// The target role, when the caller may grant it (`assertCanGrant`).
fn assert_can_grant(
    roles: &[WorkspaceRole],
    caller_role: &str,
    target_id: &str,
    token_scope: Option<TokenScope>,
) -> Result<WorkspaceRole, AppError> {
    let target =
        find_workspace_role(roles, Some(target_id)).ok_or_else(|| unknown_role(target_id))?;
    let caller = effective_caller(roles, caller_role, token_scope);
    if !can_grant_role(caller.as_ref(), Some(target)) {
        return Err(AppError::forbidden(
            "You cannot grant a role with permissions you do not have",
        ));
    }
    Ok(target.clone())
}

async fn rule_context(
    db: &impl ConnectionTrait,
    ws: &workspaces::Model,
) -> Result<(Option<String>, u64), AppError> {
    let owners = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(ws.id.clone()))
        .filter(memberships::Column::Role.eq(OWNER_ROLE_ID))
        .count(db)
        .await?;
    Ok((ws.primary_owner_id.clone(), owners))
}

/// Adds an existing account to the workspace (`addMember`).
///
/// # Errors
///
/// 400/403 when the role is unknown or the caller cannot grant it, 404 for an unknown account,
/// 409 when they already belong.
pub async fn add_member(
    state: &AppState,
    ws: &workspaces::Model,
    caller: &MemberCaller,
    input: &NewMember,
) -> Result<MemberWithUser, AppError> {
    assert_can_grant(&roles_of(ws), &caller.role, &input.role, caller.token_scope)?;
    let email = js::trim(&input.email).to_lowercase();
    let user = users::Entity::find()
        .filter(users::Column::Email.eq(email))
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("User", &input.email))?;
    let belongs = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(ws.id.clone()))
        .filter(memberships::Column::UserId.eq(user.id.clone()))
        .count(&state.db)
        .await?
        > 0;
    if belongs {
        return Err(AppError::conflict("User is already a member"));
    }
    let m = memberships::ActiveModel {
        id: Set(uid("mb")),
        workspace_id: Set(ws.id.clone()),
        user_id: Set(user.id.clone()),
        role: Set(input.role.clone()),
        ..Default::default()
    }
    .insert(&state.db)
    .await
    .map_err(|err| unique_or(err, || AppError::conflict("User is already a member")))?;
    announce(state, &ws.id, LiveChange::created(LiveEventEntity::Membership, &m.id));
    Ok(with_user(&m, Some(&user)))
}

fn parse_access(input: &Value, baseline: &[MemberGrant]) -> Result<Option<MemberAccess>, AppError> {
    match input {
        Value::Null => Ok(None),
        Value::Object(_) | Value::Array(_) => Ok(normalize_member_access(input, baseline)),
        _ => Err(AppError::bad_request("access must be an object")),
    }
}

async fn assert_can_grant_access(
    db: &impl ConnectionTrait,
    ws: &workspaces::Model,
    caller: &MemberCaller,
    access: Option<&MemberAccess>,
    baseline: &[MemberGrant],
) -> Result<(), AppError> {
    let Some(user_id) = caller.user_id.as_deref().filter(|id| !id.is_empty()) else {
        if access.is_some() {
            return Err(AppError::forbidden("Only a person can set access limits"));
        }
        return Ok(());
    };
    let caller_role = effective_caller(&roles_of(ws), &caller.role, caller.token_scope);
    if caller_role.as_ref().is_some_and(|r| r.owner) {
        return Ok(());
    }
    let mine = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(ws.id.clone()))
        .filter(memberships::Column::UserId.eq(user_id))
        .one(db)
        .await?;
    let stored = mine.as_ref().and_then(|m| stored_member_access(m.access.as_ref()));
    let caller_access = effective_member_access(caller_role.as_ref(), stored.as_ref());
    if !access_within(access, caller_access.as_ref(), baseline) {
        return Err(AppError::forbidden("You cannot grant access wider than your own"));
    }
    Ok(())
}

/// Changes the role, the custom access, or both. Access can only narrow, and only within what
/// the caller has (`updateMember`).
///
/// # Errors
///
/// 400 when nothing changes or the role or access is invalid, 403 when the caller may not, 404
/// for an unknown membership.
pub async fn update_member(
    state: &AppState,
    ws: &workspaces::Model,
    caller: &MemberCaller,
    id: &str,
    patch: &MemberPatch,
) -> Result<MemberWithUser, AppError> {
    if patch.role.is_missing() && patch.access.is_missing() {
        return Err(AppError::bad_request("Nothing to change"));
    }
    let db = &state.db;
    let m = get_membership(db, &ws.id, id).await?;
    let roles = roles_of(ws);
    let target_role = match &patch.role {
        Patch::Missing => find_workspace_role(&roles, Some(&m.role))
            .cloned()
            .ok_or_else(|| unknown_role(&m.role))?,
        // `String(null)`: the DTO lets a null role through and the lookup then fails
        Patch::Null => return Err(unknown_role("null")),
        Patch::Value(role) => assert_can_grant(&roles, &caller.role, role, caller.token_scope)?,
    };
    let mut row: memberships::ActiveModel = m.clone().into();
    if let Patch::Value(role) = &patch.role
        && m.role != *role
    {
        let (primary_owner_id, owner_count) = rule_context(db, ws).await?;
        assert_can_change_role(
            &MemberRuleContext { primary_owner_id: primary_owner_id.as_deref(), owner_count },
            &caller.actor(),
            &MemberTarget { user_id: &m.user_id, role: &m.role },
            role,
        )?;
        row.role = Set(role.clone());
    }
    let baseline = &target_role.grants;
    let to_json = |access: Option<MemberAccess>| access.map(|a| json!(a));
    if target_role.owner {
        row.access = Set(None);
    } else if !patch.access.is_missing() {
        let requested = match &patch.access {
            Patch::Value(value) => parse_access(value, baseline)?,
            _ => None,
        };
        assert_can_grant_access(db, ws, caller, requested.as_ref(), baseline).await?;
        row.access = Set(to_json(requested));
    } else if !patch.role.is_missing() {
        let stored = m.access.clone().unwrap_or(Value::Null);
        row.access = Set(to_json(normalize_member_access(&stored, baseline)));
    }
    let saved = row.update(db).await?;
    announce(state, &ws.id, LiveChange::updated(LiveEventEntity::Membership, &saved.id));
    let user = users::Entity::find_by_id(saved.user_id.clone()).one(db).await?;
    Ok(with_user(&saved, user.as_ref()))
}

/// `changeRole`: [`update_member`] with a role only.
///
/// # Errors
///
/// As [`update_member`].
pub async fn change_role(
    state: &AppState,
    ws: &workspaces::Model,
    caller: &MemberCaller,
    id: &str,
    role: &str,
) -> Result<MemberWithUser, AppError> {
    let patch = MemberPatch { role: Patch::Value(role.to_owned()), access: Patch::Missing };
    update_member(state, ws, caller, id, &patch).await
}

/// Removes a membership: admins remove anyone below owner, a member can remove themselves
/// (`removeMember`).
///
/// # Errors
///
/// 404 for an unknown membership, 403/409 as the member rules decide.
pub async fn remove_member(
    state: &AppState,
    ws: &workspaces::Model,
    caller: &MemberCaller,
    id: &str,
) -> Result<(), AppError> {
    let db = &state.db;
    let m = get_membership(db, &ws.id, id).await?;
    if ws.personal && ws.primary_owner_id.as_deref() == Some(m.user_id.as_str()) {
        return Err(AppError::conflict(personal_workspace_fixed("left")));
    }
    let (primary_owner_id, owner_count) = rule_context(db, ws).await?;
    assert_can_remove_member(
        &MemberRuleContext { primary_owner_id: primary_owner_id.as_deref(), owner_count },
        &caller.actor(),
        &MemberTarget { user_id: &m.user_id, role: &m.role },
    )?;
    memberships::Entity::delete_by_id(id.to_owned()).exec(db).await?;
    announce(state, &ws.id, LiveChange::deleted(LiveEventEntity::Membership, id));
    Ok(())
}

/// The primary owner hands the workspace over: the target becomes owner and primary owner; the
/// caller stays an owner (`transferOwnership`).
///
/// # Errors
///
/// 409 for a personal workspace or a target who already owns it, 404 for an unknown membership,
/// 403 unless the caller is the primary owner.
pub async fn transfer_ownership(
    state: &AppState,
    ws: &workspaces::Model,
    caller_role: &str,
    caller_user_id: Option<&str>,
    membership_id: &str,
) -> Result<WorkspaceWithRole, AppError> {
    if ws.personal {
        return Err(AppError::conflict(personal_workspace_fixed("handed over")));
    }
    let db = &state.db;
    let target = get_membership(db, &ws.id, membership_id).await?;
    let actor = MemberActor {
        role: caller_role,
        user_id: caller_user_id,
        can_manage_members: None,
        token_scope: None,
    };
    assert_can_transfer_ownership(ws.primary_owner_id.as_deref(), &actor, &target.user_id)?;
    if target.role != OWNER_ROLE_ID {
        let mut row: memberships::ActiveModel = target.clone().into();
        row.role = Set(OWNER_ROLE_ID.to_owned());
        row.update(db).await?;
        announce(state, &ws.id, LiveChange::updated(LiveEventEntity::Membership, &target.id));
    }
    let mut row: workspaces::ActiveModel = ws.clone().into();
    row.primary_owner_id = Set(Some(target.user_id.clone()));
    let saved = row.update(db).await?;
    workspace_updated(state, &ws.id);
    Ok(WorkspaceWithRole::new(&saved, caller_role))
}

// ───────────────────────────── agents ─────────────────────────────

/// An agent row as the API sends it.
#[must_use]
pub fn agent_view(row: &agents::Model) -> Agent {
    Agent {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        name: row.name.clone(),
        provider: AgentProvider::parse(&row.provider).unwrap_or(AgentProvider::Other),
        description: row.description.clone(),
        owner_user_id: row.owner_user_id.clone(),
        created_at: trama_core::time::to_iso(&row.created_at),
    }
}

/// Every agent, or, for someone limited to some projects, the agents with a task on those
/// projects (`listAgents`), oldest first.
///
/// # Errors
///
/// The database error.
pub async fn list_agents(
    db: &impl ConnectionTrait,
    workspace_id: &str,
) -> Result<Vec<agents::Model>, AppError> {
    let rows = agents::Entity::find()
        .filter(agents::Column::WorkspaceId.eq(workspace_id))
        .order_by_asc(agents::Column::CreatedAt)
        .all(db)
        .await?;
    if rows.is_empty() || !is_project_limited(current_access().as_deref()) {
        return Ok(rows);
    }
    let query = issues::Entity::find()
        .select_only()
        .column(issues::Column::AssigneeId)
        .distinct()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::AssigneeId.is_in(rows.iter().map(|row| row.id.clone())));
    let used: Vec<Option<String>> =
        apply_project_scope(query, issues::Column::ProjectId).into_tuple().all(db).await?;
    let used: Vec<String> = used.into_iter().flatten().collect();
    Ok(rows.into_iter().filter(|row| used.contains(&row.id)).collect())
}

/// One agent (`getAgent`).
///
/// # Errors
///
/// 404 `Agent "<id>" not found`.
pub async fn get_agent(
    db: &impl ConnectionTrait,
    workspace_id: &str,
    id: &str,
) -> Result<agents::Model, AppError> {
    agents::Entity::find_by_id(id.to_owned())
        .filter(agents::Column::WorkspaceId.eq(workspace_id))
        .one(db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Agent", id))
}

async fn assert_workspace_member(
    db: &impl ConnectionTrait,
    workspace_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    let belongs = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(workspace_id))
        .filter(memberships::Column::UserId.eq(user_id))
        .count(db)
        .await?
        > 0;
    if belongs {
        Ok(())
    } else {
        Err(AppError::bad_request("ownerUserId must be a workspace member"))
    }
}

/// Registers an agent (`createAgent`).
///
/// # Errors
///
/// 400 when `ownerUserId` is not a member.
pub async fn create_agent(
    state: &AppState,
    workspace_id: &str,
    input: &NewAgent,
) -> Result<agents::Model, AppError> {
    if let Some(owner) = input.owner_user_id.as_deref().filter(|o| !o.is_empty()) {
        assert_workspace_member(&state.db, workspace_id, owner).await?;
    }
    let agent = agents::ActiveModel {
        id: Set(uid("ag")),
        workspace_id: Set(workspace_id.to_owned()),
        name: Set(js::trim(&input.name).to_owned()),
        provider: Set(input.provider.as_str().to_owned()),
        description: Set(input.description.clone()),
        owner_user_id: Set(input.owner_user_id.clone().filter(|o| !o.is_empty())),
        ..Default::default()
    }
    .insert(&state.db)
    .await?;
    announce(state, workspace_id, LiveChange::created(LiveEventEntity::Agent, &agent.id));
    Ok(agent)
}

/// Edits an agent (`updateAgent`); `null` clears the description or the owner.
///
/// # Errors
///
/// 404 for an unknown agent, 400 when `ownerUserId` is not a member.
pub async fn update_agent(
    state: &AppState,
    workspace_id: &str,
    id: &str,
    patch: &AgentPatch,
) -> Result<agents::Model, AppError> {
    let db = &state.db;
    let agent = get_agent(db, workspace_id, id).await?;
    if let Patch::Value(owner) = &patch.owner_user_id
        && !owner.is_empty()
    {
        assert_workspace_member(db, workspace_id, owner).await?;
    }
    let mut row: agents::ActiveModel = agent.clone().into();
    let mut changed = false;
    if let Some(name) = &patch.name {
        row.name = Set(name.clone());
        changed = true;
    }
    if let Some(provider) = patch.provider {
        row.provider = Set(provider.as_str().to_owned());
        changed = true;
    }
    if let Some(description) = patch.description.clone().into_option() {
        row.description = Set(description);
        changed = true;
    }
    if let Some(owner) = patch.owner_user_id.clone().into_option() {
        row.owner_user_id = Set(owner);
        changed = true;
    }
    let saved = if changed { row.update(db).await? } else { agent };
    announce(state, workspace_id, LiveChange::updated(LiveEventEntity::Agent, id));
    Ok(saved)
}

/// Removes an agent with the API tokens that act as it (`removeAgent`).
///
/// # Errors
///
/// 404 for an unknown agent.
pub async fn remove_agent(state: &AppState, workspace_id: &str, id: &str) -> Result<(), AppError> {
    get_agent(&state.db, workspace_id, id).await?;
    let txn = state.db.begin().await?;
    let removed = async {
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"DELETE FROM "api_tokens" WHERE "workspaceId" = $1 AND "actor"->>'id' = $2"#,
            [SqlValue::from(workspace_id), SqlValue::from(id)],
        ))
        .await?;
        agents::Entity::delete_by_id(id.to_owned()).exec(&txn).await?;
        Ok::<_, DbErr>(())
    }
    .await;
    match removed {
        Ok(()) => txn.commit().await?,
        Err(err) => {
            let _ = txn.rollback().await;
            return Err(err.into());
        }
    }
    announce(state, workspace_id, LiveChange::deleted(LiveEventEntity::Agent, id));
    Ok(())
}

// ───────────────────────────── tokens ─────────────────────────────

/// The workspace's tokens, newest first; `only_user_id` limits them to the ones that person
/// created (`listTokens`).
///
/// # Errors
///
/// The database error.
pub async fn list_tokens(
    db: &impl ConnectionTrait,
    workspace_id: &str,
    only_user_id: Option<&str>,
) -> Result<Vec<ApiTokenView>, AppError> {
    let mut query = api_tokens::Entity::find()
        .filter(api_tokens::Column::WorkspaceId.eq(workspace_id))
        .order_by_desc(api_tokens::Column::CreatedAt);
    if let Some(user_id) = only_user_id {
        query = query.filter(api_tokens::Column::CreatedByUserId.eq(user_id));
    }
    Ok(query.all(db).await?.iter().map(ApiTokenView::from).collect())
}

/// Revokes a token; `only_user_id` restricts it to the ones that person created, which look
/// missing to everyone else (`removeToken`).
///
/// # Errors
///
/// 404 `Token "<id>" not found`.
pub async fn remove_token(
    db: &impl ConnectionTrait,
    workspace_id: &str,
    id: &str,
    only_user_id: Option<&str>,
) -> Result<(), AppError> {
    let token = api_tokens::Entity::find_by_id(id.to_owned())
        .filter(api_tokens::Column::WorkspaceId.eq(workspace_id))
        .one(db)
        .await?;
    match token {
        Some(t) if only_user_id.is_none_or(|u| t.created_by_user_id.as_deref() == Some(u)) => {
            revoke(db, id).await?;
            Ok(())
        }
        _ => Err(AppError::entity_not_found("Token", id)),
    }
}

/// Mints a token (`TokensController.create`): resolves the scope and permissions, refuses
/// privilege escalation from the calling token, and returns the secret once.
///
/// # Errors
///
/// 400 for contradictory scope and permissions or an admin agent token, 403 when the calling
/// token or role may not mint it, 404 for an unknown agent.
pub async fn create_api_token(
    state: &AppState,
    ctx: &WorkspaceContext,
    auth: &AuthInfo,
    input: &NewApiToken,
) -> Result<TokenCreated, AppError> {
    let scope = input.scope.unwrap_or(if input.permissions.is_some() {
        TokenScope::Custom
    } else {
        TokenScope::Write
    });
    let permissions = (scope == TokenScope::Custom).then(|| {
        permissions::normalize_permissions(input.permissions.as_deref().unwrap_or_default())
    });
    if scope == TokenScope::Custom && permissions.as_ref().is_none_or(Vec::is_empty) {
        return Err(AppError::bad_request("A custom token needs at least one valid permission"));
    }
    if scope != TokenScope::Custom && input.permissions.is_some() {
        return Err(AppError::bad_request("permissions can only be set on custom tokens"));
    }
    // A custom token can only mint custom tokens that are a subset of itself (no escalation).
    if let Some(token) = auth.token.as_ref()
        && token.scope == Some(TokenScope::Custom)
    {
        let own = token.permissions.as_deref().unwrap_or_default();
        let wider = permissions
            .as_ref()
            .is_some_and(|list| list.iter().any(|p| !own.contains(&p.to_string())));
        if scope != TokenScope::Custom || wider {
            return Err(AppError::forbidden(
                "A custom token can only create custom tokens with a subset of its own permissions",
            ));
        }
    }
    // A write token is capped at member; custom tokens are not capped by role, so minting one
    // from a write token would hand out the user's full role (and any permission) to the new
    // secret.
    if auth.token_scope() == Some(TokenScope::Write)
        && scope != TokenScope::Write
        && scope != TokenScope::Read
    {
        return Err(AppError::forbidden(
            "A write-scoped token can only create read or write tokens",
        ));
    }
    if scope == TokenScope::Admin && !ctx.has_admin_power() {
        return Err(AppError::forbidden(
            "Only someone who can administer the workspace can create admin-scoped tokens",
        ));
    }
    let mut actor = ctx.actor.clone();
    if let Some(agent_id) = &input.agent_id {
        if !ctx.can_do(Capability::ManageAgents) {
            return Err(AppError::forbidden("You are not allowed to create agent tokens"));
        }
        if scope == TokenScope::Admin {
            return Err(AppError::bad_request(
                "Agents act with the member role: use the read or write scope",
            ));
        }
        let agent = get_agent(&state.db, &ctx.workspace.id, agent_id).await?;
        actor = ActorRef::agent(agent.id);
    }
    let (row, secret) = create_token(
        &state.db,
        NewToken {
            workspace_id: ctx.workspace.id.clone(),
            name: input.name.clone(),
            actor,
            scope: Some(scope),
            permissions,
            limits: input.limits.clone(),
            created_by_user_id: ctx.user_id.clone(),
            expires_at: input.expires_at,
        },
    )
    .await?;
    Ok(TokenCreated { token: ApiTokenView::from(&row), secret })
}
