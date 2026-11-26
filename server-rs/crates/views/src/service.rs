//! Saved views: listing, reading, creating, editing, sharing and deleting (`views.service.ts`).
//!
//! Every function takes the request's [`WorkspaceContext`], so the caller's permissions apply
//! exactly as in NestJS. [`list`] is also what the workspace snapshot embeds.

use std::collections::HashMap;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder,
};
use serde_json::Value;
use trama_auth::WorkspaceContext;
use trama_common::Secrets;
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::js;
use trama_contracts::roles::Capability;
use trama_contracts::views::{
    FilterValue, SavedView, ShareGrant, ShareLevel, ShareVisibility, SharingSettings, ViewEntity,
    ViewFilter, ViewFilterOp, ViewLayout, ViewSort,
};
use trama_core::ids::uid;
use trama_core::time::to_iso;
use trama_core::{AppError, AppState};
use trama_entities::{memberships, saved_views, users};
use trama_events::{Events, LiveChange};

use crate::access::{
    ViewAccessSubject, ViewActor, can_edit_view, can_manage_sharing, can_read_view, default_sharing,
};
use crate::query::js_string;
use crate::rules::{generate_public_token, hash_public_token, stored_entity, view_layout_problem};

/// At most this many invited people per view.
pub const MAX_GRANTS: usize = 100;

/// The sharing part of a create or update request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SharingInput {
    /// Who may open the view.
    pub visibility: Option<ShareVisibility>,
    /// Replaces the whole list of invited people.
    pub grants: Option<Vec<ShareGrant>>,
}

/// A view to create.
#[derive(Clone, Debug, PartialEq)]
pub struct NewView {
    /// Display name (trimmed when stored).
    pub name: String,
    /// What the view lists.
    pub entity: ViewEntity,
    /// Filters.
    pub filters: Vec<ViewFilter>,
    /// Sort.
    pub sort: Option<ViewSort>,
    /// Grouping field.
    pub group_by: Option<String>,
    /// Layout (`list` when absent).
    pub layout: Option<ViewLayout>,
    /// Legacy flag: `true` = visible to the workspace, `false` = private. Prefer `sharing`.
    pub shared: Option<bool>,
    /// Visibility and invited people.
    pub sharing: Option<SharingInput>,
}

/// Changes to a view; `None` leaves a field alone. For `sort` and `group_by`, `Some(None)`
/// clears them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ViewPatch {
    /// New name.
    pub name: Option<String>,
    /// New entity.
    pub entity: Option<ViewEntity>,
    /// New filters (replaces the list).
    pub filters: Option<Vec<ViewFilter>>,
    /// New sort, or `Some(None)` to clear it.
    pub sort: Option<Option<ViewSort>>,
    /// New grouping field, or `Some(None)` to clear it.
    pub group_by: Option<Option<String>>,
    /// New layout.
    pub layout: Option<ViewLayout>,
    /// Legacy flag. Prefer `sharing`.
    pub shared: Option<bool>,
    /// Visibility and invited people.
    pub sharing: Option<SharingInput>,
}

/// A stored view with its sharing settings read.
struct View {
    row: saved_views::Model,
    entity: ViewEntity,
    sharing: SharingSettings,
}

impl View {
    /// `None` when the stored entity is no view entity (a retired kind).
    fn read(row: saved_views::Model) -> Option<Self> {
        let entity = stored_entity(&row.entity)?;
        let sharing =
            serde_json::from_value(row.sharing.clone()).unwrap_or_else(|_| default_sharing());
        Some(Self { row, entity, sharing })
    }

    fn subject(&self) -> ViewAccessSubject<'_> {
        ViewAccessSubject { owner_id: &self.row.owner_id, sharing: &self.sharing }
    }
}

/// What the caller may see: own views, views shared with the workspace or by link, and views
/// they were invited to, oldest first.
///
/// # Errors
///
/// A database error, or a 500 when a stored public link cannot be decrypted.
pub async fn list(state: &AppState, ctx: &WorkspaceContext) -> Result<Vec<SavedView>, AppError> {
    let actor = ViewActor::of_context(ctx);
    let secrets = Secrets::of(state)?;
    let rows = saved_views::Entity::find()
        .filter(saved_views::Column::WorkspaceId.eq(ctx.workspace.id.as_str()))
        .order_by_asc(saved_views::Column::CreatedAt)
        .order_by_asc(saved_views::Column::Id)
        .all(&state.db)
        .await?;
    rows.into_iter()
        .filter_map(View::read)
        .filter(|view| can_read_view(view.subject(), &actor))
        .map(|view| present(&view, &actor, &secrets))
        .collect()
}

/// One view, or 404 when it does not exist or the caller may not see it.
///
/// # Errors
///
/// 404, or a database error.
pub async fn get(
    state: &AppState,
    ctx: &WorkspaceContext,
    id: &str,
) -> Result<SavedView, AppError> {
    let actor = ViewActor::of_context(ctx);
    let view = load(state, ctx, &actor, id).await?;
    present(&view, &actor, &Secrets::of(state)?)
}

/// Creates a view owned by the caller.
///
/// # Errors
///
/// 403 for an agent token, or without the right to share; 400 for a layout the entity cannot
/// have or grants that are not workspace members.
pub async fn create(
    state: &AppState,
    ctx: &WorkspaceContext,
    input: NewView,
) -> Result<SavedView, AppError> {
    let Some(owner_id) = ctx.user_id.as_deref() else {
        return Err(AppError::forbidden("Agents cannot own saved views"));
    };
    let sharing_input = input.sharing.unwrap_or_default();
    let visibility = sharing_input.visibility.unwrap_or(if input.shared == Some(true) {
        ShareVisibility::Workspace
    } else {
        ShareVisibility::Private
    });
    if visibility != ShareVisibility::Private {
        assert_can_share(ctx)?;
    }
    let layout = input.layout.unwrap_or(ViewLayout::List);
    assert_layout_fits(input.entity, layout.as_str())?;
    let grants =
        check_grants(state, &ctx.workspace.id, owner_id, sharing_input.grants.unwrap_or_default())
            .await?;

    let secrets = Secrets::of(state)?;
    let now = chrono::Utc::now().fixed_offset();
    let mut view = View {
        row: saved_views::Model {
            id: uid("vw"),
            workspace_id: ctx.workspace.id.clone(),
            owner_id: owner_id.to_owned(),
            name: js::trim(&input.name).to_owned(),
            entity: input.entity.as_str().to_owned(),
            filters: to_json(&input.filters),
            sort: input.sort.as_ref().map(to_json),
            group_by: input.group_by,
            layout: layout.as_str().to_owned(),
            shared: false,
            created_at: now,
            updated_at: now,
            sharing: to_json(&default_sharing()),
            public_token_hash: None,
            public_token_enc: None,
        },
        entity: input.entity,
        sharing: default_sharing(),
    };
    apply_sharing(&mut view, SharingSettings { visibility, grants }, &secrets);
    let saved = insert(state, view).await?;
    Events::of(state)
        .publish(&ctx.workspace.id, LiveChange::created(LiveEventEntity::View, &saved.row.id));
    present(&saved, &ViewActor::of_context(ctx), &secrets)
}

/// Edits a view: its definition (owner, editors, admins of shared views) and, separately, who
/// has access (owner, admins of shared views).
///
/// # Errors
///
/// 404, 403, or 400 for a layout the entity cannot have or grants that are not members.
pub async fn update(
    state: &AppState,
    ctx: &WorkspaceContext,
    id: &str,
    patch: ViewPatch,
) -> Result<SavedView, AppError> {
    let actor = ViewActor::of_context(ctx);
    let mut view = load(state, ctx, &actor, id).await?;
    if !can_edit_view(view.subject(), &actor) {
        return Err(AppError::forbidden(
            "You can only view this view; ask the owner for edit access",
        ));
    }
    let entity = patch.entity.unwrap_or(view.entity);
    let layout = patch.layout.map_or_else(|| view.row.layout.clone(), |l| l.as_str().to_owned());
    assert_layout_fits(entity, &layout)?;
    let secrets = Secrets::of(state)?;

    if patch.shared.is_some() || patch.sharing.is_some() {
        if !can_manage_sharing(view.subject(), &actor) {
            return Err(AppError::forbidden(
                "Only the owner (or an admin, for shared views) can change who has access",
            ));
        }
        let current = view.sharing.visibility;
        let sharing = patch.sharing.unwrap_or_default();
        let visibility = sharing.visibility.unwrap_or(match patch.shared {
            // the legacy flag: on opens a private view to the workspace, off closes it
            Some(true) if current == ShareVisibility::Private => ShareVisibility::Workspace,
            Some(true) | None => current,
            Some(false) => ShareVisibility::Private,
        });
        if visibility != current && visibility != ShareVisibility::Private {
            assert_can_share(ctx)?;
        }
        let grants = match sharing.grants {
            Some(grants) => {
                check_grants(state, &ctx.workspace.id, &view.row.owner_id, grants).await?
            }
            None => view.sharing.grants.clone(),
        };
        apply_sharing(&mut view, SharingSettings { visibility, grants }, &secrets);
    }

    if let Some(name) = &patch.name {
        view.row.name = js::trim(name).to_owned();
    }
    if let Some(entity) = patch.entity {
        entity.as_str().clone_into(&mut view.row.entity);
        view.entity = entity;
    }
    if let Some(filters) = &patch.filters {
        view.row.filters = to_json(filters);
    }
    if let Some(sort) = &patch.sort {
        view.row.sort = sort.as_ref().map(to_json);
    }
    if let Some(group_by) = patch.group_by {
        view.row.group_by = group_by;
    }
    if patch.layout.is_some() {
        view.row.layout = layout;
    }
    view.row.updated_at = chrono::Utc::now().fixed_offset();
    let saved = update_row(state, view).await?;
    Events::of(state).publish(&ctx.workspace.id, LiveChange::updated(LiveEventEntity::View, id));
    present(&saved, &actor, &secrets)
}

/// The addresses as the service reads them: trimmed, lower case, without blanks or repeats.
#[must_use]
pub fn normalize_emails(emails: &[String]) -> Vec<String> {
    let mut wanted: Vec<String> = Vec::new();
    for email in emails {
        let email = js::trim(email).to_lowercase();
        if !email.is_empty() && !wanted.contains(&email) {
            wanted.push(email);
        }
    }
    wanted
}

/// Invites existing workspace members by email, at `level` (default `view`).
///
/// # Errors
///
/// 404, 403 when the caller cannot manage sharing, 400 for an empty list, for people who are
/// not members, or for more than [`MAX_GRANTS`] people.
pub async fn invite(
    state: &AppState,
    ctx: &WorkspaceContext,
    id: &str,
    emails: &[String],
    level: Option<ShareLevel>,
) -> Result<SavedView, AppError> {
    let level = level.unwrap_or(ShareLevel::View);
    let actor = ViewActor::of_context(ctx);
    let mut view = load(state, ctx, &actor, id).await?;
    if !can_manage_sharing(view.subject(), &actor) {
        return Err(AppError::forbidden(
            "Only the owner (or an admin, for shared views) can invite people",
        ));
    }
    let wanted = normalize_emails(emails);
    if wanted.is_empty() {
        return Err(AppError::bad_request("Enter at least one email address"));
    }
    let members = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(ctx.workspace.id.as_str()))
        .all(&state.db)
        .await?;
    let member_ids: Vec<String> = members.into_iter().map(|m| m.user_id).collect();
    let people = if member_ids.is_empty() {
        Vec::new()
    } else {
        users::Entity::find().filter(users::Column::Id.is_in(member_ids)).all(&state.db).await?
    };
    let by_email: HashMap<String, String> =
        people.into_iter().map(|u| (u.email.to_lowercase(), u.id)).collect();
    let unknown: Vec<&str> =
        wanted.iter().filter(|e| !by_email.contains_key(*e)).map(String::as_str).collect();
    if !unknown.is_empty() {
        return Err(AppError::bad_request(format!(
            "Not members of this workspace: {}. Invite them to the workspace first.",
            unknown.join(", ")
        )));
    }
    let mut grants = view.sharing.grants.clone();
    for email in &wanted {
        let user_id = &by_email[email];
        if *user_id == view.row.owner_id {
            continue;
        }
        match grants.iter_mut().find(|g| g.user_id == *user_id) {
            Some(existing) => existing.level = level,
            None => grants.push(ShareGrant { user_id: user_id.clone(), level }),
        }
    }
    if grants.len() > MAX_GRANTS {
        return Err(too_many_grants());
    }
    view.sharing = SharingSettings { visibility: view.sharing.visibility, grants };
    view.row.sharing = to_json(&view.sharing);
    view.row.updated_at = chrono::Utc::now().fixed_offset();
    let saved = update_row(state, view).await?;
    Events::of(state).publish(&ctx.workspace.id, LiveChange::updated(LiveEventEntity::View, id));
    present(&saved, &actor, &Secrets::of(state)?)
}

/// Replaces the public link with a new one; the old link stops working immediately.
///
/// # Errors
///
/// 404, 403 when the caller cannot manage sharing, 400 when the view is not shared by link.
pub async fn rotate_link(
    state: &AppState,
    ctx: &WorkspaceContext,
    id: &str,
) -> Result<SavedView, AppError> {
    let actor = ViewActor::of_context(ctx);
    let mut view = load(state, ctx, &actor, id).await?;
    if !can_manage_sharing(view.subject(), &actor) {
        return Err(AppError::forbidden(
            "Only the owner (or an admin, for shared views) can change the public link",
        ));
    }
    if view.sharing.visibility != ShareVisibility::Link {
        return Err(AppError::bad_request("This view is not shared by link"));
    }
    let secrets = Secrets::of(state)?;
    mint_token(&mut view.row, &secrets);
    view.row.updated_at = chrono::Utc::now().fixed_offset();
    let saved = update_row(state, view).await?;
    Events::of(state).publish(&ctx.workspace.id, LiveChange::updated(LiveEventEntity::View, id));
    present(&saved, &actor, &secrets)
}

/// Deletes a view.
///
/// # Errors
///
/// 404, or 403 when the caller cannot manage sharing.
pub async fn remove(state: &AppState, ctx: &WorkspaceContext, id: &str) -> Result<(), AppError> {
    let actor = ViewActor::of_context(ctx);
    let view = load(state, ctx, &actor, id).await?;
    if !can_manage_sharing(view.subject(), &actor) {
        return Err(AppError::forbidden(
            "Only the owner (or an admin, for shared views) can delete a view",
        ));
    }
    saved_views::Entity::delete_by_id(id).exec(&state.db).await?;
    Events::of(state).publish(&ctx.workspace.id, LiveChange::deleted(LiveEventEntity::View, id));
    Ok(())
}

// ── internals ──

fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn too_many_grants() -> AppError {
    AppError::bad_request(format!("A view can be shared with at most {MAX_GRANTS} people"))
}

/// The view, or 404 when it does not exist or the caller may not see it (existence is not
/// leaked).
async fn load(
    state: &AppState,
    ctx: &WorkspaceContext,
    actor: &ViewActor,
    id: &str,
) -> Result<View, AppError> {
    let row = saved_views::Entity::find_by_id(id)
        .filter(saved_views::Column::WorkspaceId.eq(ctx.workspace.id.as_str()))
        .one(&state.db)
        .await?;
    row.and_then(View::read)
        .filter(|view| can_read_view(view.subject(), actor))
        .ok_or_else(|| AppError::entity_not_found("View", id))
}

async fn insert(state: &AppState, view: View) -> Result<View, AppError> {
    let row = view.row.into_active_model().reset_all().insert(&state.db).await?;
    Ok(View { row, entity: view.entity, sharing: view.sharing })
}

async fn update_row(state: &AppState, view: View) -> Result<View, AppError> {
    let row = view.row.into_active_model().reset_all().update(&state.db).await?;
    Ok(View { row, entity: view.entity, sharing: view.sharing })
}

/// Wire shape: the secret link is included only for people who can manage sharing.
fn present(view: &View, actor: &ViewActor, secrets: &Secrets) -> Result<SavedView, AppError> {
    let row = &view.row;
    let public_token = match &row.public_token_enc {
        Some(enc)
            if view.sharing.visibility == ShareVisibility::Link
                && can_manage_sharing(view.subject(), actor) =>
        {
            Some(secrets.decrypt_secret(enc).map_err(AppError::internal)?)
        }
        _ => None,
    };
    Ok(SavedView {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        owner_id: row.owner_id.clone(),
        name: row.name.clone(),
        entity: view.entity,
        filters: read_filters(&row.filters),
        sort: row.sort.as_ref().and_then(|sort| serde_json::from_value(sort.clone()).ok()),
        group_by: row.group_by.clone(),
        layout: ViewLayout::parse(&row.layout).unwrap_or(ViewLayout::List),
        shared: row.shared,
        sharing: view.sharing.clone(),
        public_token,
        created_at: to_iso(&row.created_at),
        updated_at: to_iso(&row.updated_at),
    })
}

/// The stored filters as the contract types them. A row saved before the DTO validated `value`
/// may hold numbers or `null`: they read as the text JavaScript would make of them. A filter
/// with an operator the contract does not know is left out.
fn read_filters(stored: &Value) -> Vec<ViewFilter> {
    let Some(list) = stored.as_array() else { return Vec::new() };
    list.iter()
        .filter_map(|filter| {
            let field = filter.get("field")?.as_str()?.to_owned();
            let op = ViewFilterOp::parse(filter.get("op")?.as_str()?)?;
            let value = match filter.get("value") {
                Some(Value::Array(items)) => {
                    FilterValue::Many(items.iter().map(js_string).collect())
                }
                Some(other) => FilterValue::One(js_string(other)),
                None => FilterValue::One(String::new()),
            };
            Some(ViewFilter { field, op, value })
        })
        .collect()
}

/// Sets visibility and grants and keeps the legacy `shared` flag and the public token in step.
fn apply_sharing(view: &mut View, next: SharingSettings, secrets: &Secrets) {
    view.row.shared = next.visibility != ShareVisibility::Private;
    if next.visibility == ShareVisibility::Link {
        if view.row.public_token_hash.is_none() || view.row.public_token_enc.is_none() {
            mint_token(&mut view.row, secrets);
        }
    } else {
        // Leaving link sharing revokes the public URL for good; going back creates a new one.
        view.row.public_token_hash = None;
        view.row.public_token_enc = None;
    }
    view.sharing = next;
    view.row.sharing = to_json(&view.sharing);
}

fn mint_token(row: &mut saved_views::Model, secrets: &Secrets) {
    let token = generate_public_token();
    row.public_token_hash = Some(hash_public_token(&token));
    row.public_token_enc = Some(secrets.encrypt_secret(&token));
}

/// Grants must name distinct workspace members other than the owner.
async fn check_grants(
    state: &AppState,
    workspace_id: &str,
    owner_id: &str,
    grants: Vec<ShareGrant>,
) -> Result<Vec<ShareGrant>, AppError> {
    // one entry per person, in the order first named, the last level wins
    let mut by_user: Vec<ShareGrant> = Vec::new();
    for grant in grants {
        if grant.user_id == owner_id {
            continue;
        }
        match by_user.iter_mut().find(|g| g.user_id == grant.user_id) {
            Some(existing) => existing.level = grant.level,
            None => by_user.push(grant),
        }
    }
    if by_user.len() > MAX_GRANTS {
        return Err(too_many_grants());
    }
    if !by_user.is_empty() {
        let wanted: Vec<&str> = by_user.iter().map(|g| g.user_id.as_str()).collect();
        let members = memberships::Entity::find()
            .filter(memberships::Column::WorkspaceId.eq(workspace_id))
            .filter(memberships::Column::UserId.is_in(wanted.clone()))
            .all(&state.db)
            .await?;
        let found: Vec<&str> = members.iter().map(|m| m.user_id.as_str()).collect();
        if wanted.iter().any(|user| !found.contains(user)) {
            return Err(AppError::bad_request(
                "You can only share a view with members of this workspace",
            ));
        }
    }
    Ok(by_user)
}

fn assert_layout_fits(entity: ViewEntity, layout: &str) -> Result<(), AppError> {
    match view_layout_problem(entity, layout) {
        Some(problem) => Err(AppError::bad_request(problem)),
        None => Ok(()),
    }
}

fn assert_can_share(ctx: &WorkspaceContext) -> Result<(), AppError> {
    if ctx.can_do(Capability::ManageSharedViews) {
        Ok(())
    } else {
        Err(AppError::forbidden("You are not allowed to share views with the workspace"))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_stored_filters_leniently() {
        let stored = json!([
            {"field": "title", "op": "contains", "value": 5},
            {"field": "status", "op": "in", "value": ["todo", "done"]},
            {"field": "status", "op": "is", "value": null},
            {"field": "status", "op": "bogus", "value": "x"},
            {"op": "is", "value": "x"},
        ]);
        let filters = read_filters(&stored);
        assert_eq!(filters.len(), 3);
        assert_eq!(filters[0].value, FilterValue::One("5".into()));
        assert_eq!(filters[1].value, FilterValue::Many(vec!["todo".into(), "done".into()]));
        assert_eq!(filters[2].value, FilterValue::One(String::new()));
        assert!(read_filters(&json!("nope")).is_empty());
    }

    #[test]
    fn normalizes_invitation_addresses() {
        let emails = [
            " TWO@example.com".to_owned(),
            "three@example.com".into(),
            "two@Example.com ".into(),
            "  ".into(),
        ];
        assert_eq!(normalize_emails(&emails), ["two@example.com", "three@example.com"]);
    }
}
