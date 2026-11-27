//! Listing, pinning and unpinning (`favorites.service.ts`).
//!
//! Project scoping reads the request's member access, as NestJS reads `AsyncLocalStorage`: work
//! in a project the person cannot open is not theirs to pin, and stops being listed once access
//! ends.

use std::collections::HashSet;

use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};
use trama_auth::member_access::{current_access, project_hidden};
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::identity::{FAVORITE_TYPES, FavoriteType, MAX_FAVORITES};
use trama_core::ids::uid;
use trama_core::{AppError, AppState};
use trama_entities::{favorites, issues, projects, saved_views};
use trama_events::{Events, LiveChange};

/// The caller's favorites, oldest first. Favorites whose subject was deleted (or, for views, is
/// no longer visible to the caller) are removed here instead of being left dangling.
///
/// # Errors
///
/// 500 when the database fails.
pub async fn list(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
) -> Result<Vec<favorites::Model>, AppError> {
    let db = &state.db;
    let all = favorites::Entity::find()
        .filter(favorites::Column::WorkspaceId.eq(workspace_id))
        .filter(favorites::Column::UserId.eq(user_id))
        .order_by_asc(favorites::Column::CreatedAt)
        .order_by_asc(favorites::Column::Id)
        .all(db)
        .await?;
    let active: Vec<favorites::Model> = all
        .into_iter()
        .filter(|f| FavoriteType::parse(&f.r#type).is_some_and(|t| FAVORITE_TYPES.contains(&t)))
        .collect();
    let mut gone: Vec<String> = Vec::new();
    for kind in FAVORITE_TYPES {
        let mine: Vec<&favorites::Model> =
            active.iter().filter(|f| f.r#type == kind.as_str()).collect();
        if mine.is_empty() {
            continue;
        }
        let ids: Vec<String> = mine.iter().map(|f| f.subject_id.clone()).collect();
        let alive = visible_ids(db, workspace_id, user_id, *kind, &ids).await?;
        gone.extend(mine.iter().filter(|f| !alive.contains(&f.subject_id)).map(|f| f.id.clone()));
    }
    if !gone.is_empty() {
        favorites::Entity::delete_many()
            .filter(favorites::Column::Id.is_in(gone.iter().cloned()))
            .exec(db)
            .await?;
    }
    Ok(active.into_iter().filter(|f| !gone.contains(&f.id)).collect())
}

/// Pins a subject. Pinning something already pinned returns the existing favorite.
///
/// # Errors
///
/// 404 `<type> "<id>" not found` when the subject does not exist or the caller may not see it;
/// 409 when the person already keeps [`MAX_FAVORITES`] in the workspace.
pub async fn add(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
    kind: FavoriteType,
    subject_id: &str,
) -> Result<favorites::Model, AppError> {
    let db = &state.db;
    if let Some(existing) = find(db, workspace_id, user_id, kind, subject_id).await? {
        return Ok(existing);
    }
    let alive = visible_ids(db, workspace_id, user_id, kind, &[subject_id.to_owned()]).await?;
    if !alive.contains(subject_id) {
        return Err(AppError::not_found(format!("{kind} \"{subject_id}\" not found")));
    }
    let count = favorites::Entity::find()
        .filter(favorites::Column::WorkspaceId.eq(workspace_id))
        .filter(favorites::Column::UserId.eq(user_id))
        .count(db)
        .await?;
    if usize::try_from(count).unwrap_or(usize::MAX) >= MAX_FAVORITES {
        return Err(AppError::conflict(format!(
            "You can keep up to {MAX_FAVORITES} favorites per workspace"
        )));
    }
    let row = favorites::ActiveModel {
        id: Set(uid("fav")),
        workspace_id: Set(workspace_id.to_owned()),
        user_id: Set(user_id.to_owned()),
        r#type: Set(kind.as_str().to_owned()),
        subject_id: Set(subject_id.to_owned()),
        ..Default::default()
    };
    let id = row.id.clone().unwrap();
    // A concurrent request may have inserted the same favorite; the unique index decides (a
    // conflict target-less `ON CONFLICT DO NOTHING`, so it covers every unique index).
    favorites::Entity::insert(row)
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .try_insert()
        .exec_without_returning(db)
        .await?;
    let saved = find(db, workspace_id, user_id, kind, subject_id)
        .await?
        .ok_or_else(|| AppError::internal("favorite vanished after insert"))?;
    if saved.id == id {
        Events::of(state)
            .publish(workspace_id, LiveChange::created(LiveEventEntity::Favorite, &saved.id));
    }
    Ok(saved)
}

/// Unpins. Idempotent: unpinning something that is not pinned succeeds.
///
/// # Errors
///
/// 500 when the database fails.
pub async fn remove(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
    kind: FavoriteType,
    subject_id: &str,
) -> Result<(), AppError> {
    let db = &state.db;
    let Some(existing) = find(db, workspace_id, user_id, kind, subject_id).await? else {
        return Ok(());
    };
    favorites::Entity::delete_by_id(existing.id.clone()).exec(db).await?;
    Events::of(state)
        .publish(workspace_id, LiveChange::deleted(LiveEventEntity::Favorite, &existing.id));
    Ok(())
}

async fn find<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    user_id: &str,
    kind: FavoriteType,
    subject_id: &str,
) -> Result<Option<favorites::Model>, AppError> {
    Ok(favorites::Entity::find()
        .filter(favorites::Column::WorkspaceId.eq(workspace_id))
        .filter(favorites::Column::UserId.eq(user_id))
        .filter(favorites::Column::Type.eq(kind.as_str()))
        .filter(favorites::Column::SubjectId.eq(subject_id))
        .one(db)
        .await?)
}

/// Of `ids`, the ones that exist in the workspace and that this user may see.
async fn visible_ids<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    user_id: &str,
    kind: FavoriteType,
    ids: &[String],
) -> Result<HashSet<String>, AppError> {
    match kind {
        FavoriteType::View => {
            let rows = saved_views::Entity::find()
                .filter(saved_views::Column::WorkspaceId.eq(workspace_id))
                .filter(saved_views::Column::Id.is_in(ids.iter().cloned()))
                .all(db)
                .await?;
            Ok(rows
                .into_iter()
                .filter(|v| v.shared || v.owner_id == user_id)
                .map(|v| v.id)
                .collect())
        }
        FavoriteType::Issue => {
            let rows: Vec<(String, Option<String>)> = issues::Entity::find()
                .select_only()
                .column(issues::Column::Id)
                .column(issues::Column::ProjectId)
                .filter(issues::Column::WorkspaceId.eq(workspace_id))
                .filter(issues::Column::Id.is_in(ids.iter().cloned()))
                .into_tuple()
                .all(db)
                .await?;
            let access = current_access();
            Ok(rows
                .into_iter()
                .filter(|(_, project_id)| !project_hidden(access.as_deref(), project_id.as_deref()))
                .map(|(id, _)| id)
                .collect())
        }
        FavoriteType::Project => {
            let rows: Vec<String> = projects::Entity::find()
                .select_only()
                .column(projects::Column::Id)
                .filter(projects::Column::WorkspaceId.eq(workspace_id))
                .filter(projects::Column::Id.is_in(ids.iter().cloned()))
                .into_tuple()
                .all(db)
                .await?;
            let access = current_access();
            Ok(rows.into_iter().filter(|id| !project_hidden(access.as_deref(), Some(id))).collect())
        }
    }
}
