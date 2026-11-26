//! `CommentsService` (`server/src/comments/comments.service.ts`).
//!
//! Reads are generic over the connection (`&state.db` or a transaction). The three writes take
//! the [`AppState`] because they record a domain event and publish live events. Like NestJS they
//! do not open a transaction: the row, the event and the upload references are separate
//! statements.
//!
//! Project scoping reads the request's member access from the task-local of `trama-auth`
//! (`currentAccess()`), so [`list`], [`page`], [`get`] and the writes refuse comments on work a
//! limited person cannot see. [`list_all`] and [`index`] do not: the snapshot scopes its whole
//! result afterwards (`scope_snapshot`).

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, IntoActiveModel,
    QueryFilter, QueryOrder, QuerySelect, Select, Set, Statement,
};
use serde_json::{Value, json};
use trama_auth::WorkspaceContext;
use trama_auth::member_access::{current_access, project_hidden};
use trama_contracts::activity::{
    COMMENT_PAGE_SIZE_MAX, Comment, CommentIndexEntry, CommentPage, LiveEventEntity,
};
use trama_contracts::common::{SubjectRef, SubjectType};
use trama_contracts::js;
use trama_core::ids::uid;
use trama_core::{AppError, AppState};
use trama_entities::{artifacts, comments, issues, milestones};
use trama_events::{Events, LiveChange, RecordEvent};
use trama_uploads::UploadSubject;
use trama_uploads::service::{assert_attachable, retained};

use crate::cursor::{
    CommentCursor, decode_comment_cursor, encode_comment_cursor, parse_comment_limit,
};
use crate::schemas::{PageCommentsQuery, comment_view};

/// How much of a comment the `comment.created` event keeps (`excerpt`).
const EXCERPT_UNITS: usize = 200;

/// The comments of the workspace, oldest first, for one subject or (without `subject_id`) all of
/// them: at most [`COMMENT_PAGE_SIZE_MAX`] (`GET /comments`). An empty filter is no filter.
///
/// # Errors
///
/// 403 `List comments for one subject you can access` for a person limited to some projects who
/// names no subject; 404 for a subject they cannot see.
pub async fn list<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    subject_type: Option<&str>,
    subject_id: Option<&str>,
) -> Result<Vec<Comment>, AppError> {
    let subject_type = subject_type.filter(|s| !s.is_empty());
    let subject_id = subject_id.filter(|s| !s.is_empty());
    if current_access().is_some() {
        let (Some(kind), Some(id)) = (subject_type, subject_id) else {
            return Err(AppError::forbidden("List comments for one subject you can access"));
        };
        assert_subject_visible(db, workspace_id, kind, id).await?;
    }
    let mut query = comments::Entity::find()
        .filter(comments::Column::WorkspaceId.eq(workspace_id))
        .order_by_asc(comments::Column::CreatedAt)
        .order_by_asc(comments::Column::Id);
    if let Some(id) = subject_id {
        query = query.filter(subject_field("id", id));
    }
    if let Some(kind) = subject_type {
        query = query.filter(subject_field("type", kind));
    }
    let rows = query.limit(u64::from(COMMENT_PAGE_SIZE_MAX)).all(db).await?;
    rows.into_iter().map(comment_view).collect()
}

/// Every comment of the workspace, oldest first (the default snapshot).
///
/// # Errors
///
/// The database error, or 500 for a row with a malformed subject or author.
pub async fn list_all<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
) -> Result<Vec<Comment>, AppError> {
    let rows = comments::Entity::find()
        .filter(comments::Column::WorkspaceId.eq(workspace_id))
        .order_by_asc(comments::Column::CreatedAt)
        .order_by_asc(comments::Column::Id)
        .all(db)
        .await?;
    rows.into_iter().map(comment_view).collect()
}

/// `subject->>'<key>' = <value>`.
fn subject_field(key: &str, value: &str) -> sea_orm::sea_query::SimpleExpr {
    Expr::cust_with_values(format!(r#""comments"."subject"->>'{key}' = $1"#), [value.to_owned()])
}

/// The query of one page (`pageQuery`): the workspace's comments of one subject, newest first,
/// keyset-paginated on `(createdAt, id)`, one row more than `limit` to learn whether another
/// page exists.
///
/// `createdAt` is compared at millisecond precision (the precision of the cursor), so rows
/// written with the database `now()` default are never skipped.
#[must_use]
pub fn page_query(
    workspace_id: &str,
    subject_type: SubjectType,
    subject_id: &str,
    cursor: Option<&CommentCursor>,
    limit: u64,
) -> Select<comments::Entity> {
    const TS: &str = r#"date_trunc('milliseconds', "comments"."createdAt")"#;
    let mut query = comments::Entity::find()
        .filter(comments::Column::WorkspaceId.eq(workspace_id))
        .filter(subject_field("type", subject_type.as_str()))
        .filter(subject_field("id", subject_id))
        .order_by_desc(Expr::cust(TS))
        .order_by_desc(comments::Column::Id)
        .limit(limit + 1);
    if let Some(cursor) = cursor {
        query = query.filter(Expr::cust_with_values(
            format!(r#"({TS} < $1 OR ({TS} = $1 AND "comments"."id" < $2))"#),
            [sea_orm::Value::from(cursor.at), sea_orm::Value::from(cursor.id.clone())],
        ));
    }
    query
}

/// One page of the comments of a single subject, newest first (`GET /comments/page`).
///
/// # Errors
///
/// 400 `cursor is not valid`; 404 for a subject a limited person cannot see.
pub async fn page<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    q: &PageCommentsQuery,
) -> Result<CommentPage, AppError> {
    assert_subject_visible(db, workspace_id, q.subject_type.as_str(), &q.subject_id).await?;
    let limit = parse_comment_limit(q.limit.map(Value::from).as_ref())?;
    let cursor = q.cursor.as_deref().map(decode_comment_cursor).transpose()?;
    let rows =
        page_query(workspace_id, q.subject_type, &q.subject_id, cursor.as_ref(), u64::from(limit))
            .all(db)
            .await?;
    let has_more = rows.len() > limit as usize;
    let mut items = rows;
    items.truncate(limit as usize);
    let next_cursor = match items.last() {
        Some(last) if has_more => Some(encode_comment_cursor(&CommentCursor {
            at: last.created_at.to_utc(),
            id: last.id.clone(),
        })),
        _ => None,
    };
    Ok(CommentPage {
        items: items.into_iter().map(comment_view).collect::<Result<_, _>>()?,
        next_cursor,
    })
}

/// One row of [`index`]'s query.
#[derive(Debug, FromQueryResult)]
struct IndexRow {
    st: Option<String>,
    sid: Option<String>,
    atype: Option<String>,
    aid: Option<String>,
    n: i64,
}

/// Comments per (subject, author) of the whole workspace: the slim snapshot's stand-in for the
/// comments (`commentIndex`).
///
/// # Errors
///
/// The database error, or 500 for a row with a malformed subject or author.
pub async fn index<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
) -> Result<Vec<CommentIndexEntry>, AppError> {
    let rows = IndexRow::find_by_statement(Statement::from_sql_and_values(
        db.get_database_backend(),
        r#"SELECT subject->>'type' AS st, subject->>'id' AS sid,
                  author->>'type' AS atype, author->>'id' AS aid, COUNT(*) AS n
             FROM comments
            WHERE "workspaceId" = $1
            GROUP BY 1, 2, 3, 4
            ORDER BY 1, 2, 3, 4"#,
        [workspace_id.into()],
    ))
    .all(db)
    .await?;
    rows.into_iter()
        .map(|row| {
            let author = match row.aid {
                Some(id) => json!({ "type": row.atype, "id": id }),
                None => json!({ "type": row.atype }),
            };
            let malformed = |what: &str, err: serde_json::Error| {
                AppError::internal(format!("a comment has a malformed {what}: {err}"))
            };
            Ok(CommentIndexEntry {
                subject: serde_json::from_value(json!({ "type": row.st, "id": row.sid }))
                    .map_err(|e| malformed("subject", e))?,
                author: serde_json::from_value(author).map_err(|e| malformed("author", e))?,
                count: row.n,
            })
        })
        .collect()
}

/// The comment row, if its subject is one the caller may see.
async fn load<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id: &str,
) -> Result<comments::Model, AppError> {
    let row = comments::Entity::find()
        .filter(comments::Column::WorkspaceId.eq(workspace_id))
        .filter(comments::Column::Id.eq(id))
        .one(db)
        .await?
        .ok_or_else(|| AppError::entity_not_found("Comment", id))?;
    let (kind, subject_id) = (str_at(&row.subject, "type"), str_at(&row.subject, "id"));
    assert_subject_visible(db, workspace_id, &kind, &subject_id).await?;
    Ok(row)
}

fn str_at(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// One comment (`GET /comments/{id}`).
///
/// # Errors
///
/// 404 `Comment "<id>" not found`, also when its subject is hidden from a limited person.
pub async fn get<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id: &str,
) -> Result<Comment, AppError> {
    comment_view(load(db, workspace_id, id).await?)
}

/// Adds a comment (`POST /comments`) and records `comment.created`.
///
/// # Errors
///
/// 404 for a subject a limited person cannot see; 400 `Unknown <type> "<id>"` when it does not
/// exist; 400 `That file is not available to attach here`.
pub async fn create(
    state: &AppState,
    ctx: &WorkspaceContext,
    subject: SubjectRef,
    body: &str,
) -> Result<Comment, AppError> {
    let workspace_id = ctx.workspace.id.as_str();
    assert_subject_visible(&state.db, workspace_id, subject.kind.as_str(), &subject.id).await?;
    if !trama_common::refs::subject_exists(
        &state.db,
        workspace_id,
        subject.kind.as_str(),
        &subject.id,
    )
    .await?
    {
        return Err(AppError::bad_request(format!("Unknown {} \"{}\"", subject.kind, subject.id)));
    }
    assert_attachable(&state.db, workspace_id, Some(body)).await?;
    let row = comments::ActiveModel {
        id: Set(uid("cm")),
        workspace_id: Set(workspace_id.to_owned()),
        subject: Set(to_json(&subject)?),
        author: Set(to_json(&ctx.actor)?),
        body: Set(js::trim(body).to_owned()),
        ..Default::default()
    }
    .insert(&state.db)
    .await?;
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(workspace_id, ctx.actor.clone(), "comment.created", subject)
                .data(json!({
                    "commentId": row.id,
                    "excerpt": js::truncate(&row.body, EXCERPT_UNITS),
                }))
                .live(LiveChange::created(LiveEventEntity::Comment, &row.id)),
        )
        .await?;
    retained(
        &state.db,
        workspace_id,
        None,
        Some(&row.body),
        Some(&UploadSubject::comment(&row.id)),
    )
    .await?;
    comment_view(row)
}

/// Edits a comment (`PATCH /comments/{id}`); only its author may.
///
/// # Errors
///
/// 404 for an unknown comment or one on hidden work; 403 `Only the author can edit a comment`;
/// 400 `That file is not available to attach here`.
pub async fn update(
    state: &AppState,
    ctx: &WorkspaceContext,
    id: &str,
    body: &str,
) -> Result<Comment, AppError> {
    let workspace_id = ctx.workspace.id.as_str();
    let row = load(&state.db, workspace_id, id).await?;
    let current = comment_view(row.clone())?;
    if current.author != ctx.actor {
        return Err(AppError::forbidden("Only the author can edit a comment"));
    }
    let previous = row.body.clone();
    assert_attachable(&state.db, workspace_id, Some(body)).await?;
    let mut active = row.into_active_model();
    active.body = Set(js::trim(body).to_owned());
    active.updated_at = Set(now_millis());
    let saved = active.update(&state.db).await?;
    retained(
        &state.db,
        workspace_id,
        Some(&previous),
        Some(&saved.body),
        Some(&UploadSubject::comment(id)),
    )
    .await?;
    Events::of(state).publish_with(
        workspace_id,
        LiveChange::updated(LiveEventEntity::Comment, id),
        None,
        Some(current.subject),
    );
    comment_view(saved)
}

/// Deletes a comment (`DELETE /comments/{id}`); its author, or someone with admin power, may.
///
/// # Errors
///
/// 404 for an unknown comment or one on hidden work; 403
/// `Only the author or an admin can delete a comment`.
pub async fn remove(state: &AppState, ctx: &WorkspaceContext, id: &str) -> Result<(), AppError> {
    let workspace_id = ctx.workspace.id.as_str();
    let row = load(&state.db, workspace_id, id).await?;
    let current = comment_view(row.clone())?;
    if current.author != ctx.actor && !ctx.has_admin_power() {
        return Err(AppError::forbidden("Only the author or an admin can delete a comment"));
    }
    comments::Entity::delete_by_id(id).exec(&state.db).await?;
    retained(&state.db, workspace_id, Some(&row.body), None, Some(&UploadSubject::comment(id)))
        .await?;
    Events::of(state).publish_with(
        workspace_id,
        LiveChange::deleted(LiveEventEntity::Comment, id),
        None,
        Some(current.subject),
    );
    Ok(())
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(AppError::internal)
}

/// `new Date()`: the current time in whole milliseconds.
fn now_millis() -> sea_orm::prelude::DateTimeWithTimeZone {
    let now = chrono::Utc::now();
    chrono::DateTime::from_timestamp_millis(now.timestamp_millis()).unwrap_or(now).fixed_offset()
}

/// A limited person can only read or write comments on work they are allowed to see
/// (`assertSubjectVisible`). Subjects of other types (`import`) are not scoped.
async fn assert_subject_visible<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    kind: &str,
    id: &str,
) -> Result<(), AppError> {
    let Some(access) = current_access() else { return Ok(()) };
    let access = Some(access.as_ref());
    match kind {
        "project" => {
            if project_hidden(access, Some(id)) {
                return Err(AppError::entity_not_found("Project", id));
            }
        }
        "artifact" => {
            // An artifact belongs to the project of the task it is attached to.
            let artifact = artifacts::Entity::find()
                .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
                .filter(artifacts::Column::Id.eq(id))
                .one(db)
                .await?;
            let project_id = match artifact.as_ref().and_then(|a| a.issue_id.as_deref()) {
                Some(issue_id) => issues::Entity::find()
                    .filter(issues::Column::WorkspaceId.eq(workspace_id))
                    .filter(issues::Column::Id.eq(issue_id))
                    .one(db)
                    .await?
                    .and_then(|issue| issue.project_id),
                None => None,
            };
            if artifact.is_none() || project_hidden(access, project_id.as_deref()) {
                return Err(AppError::entity_not_found(kind, id));
            }
        }
        "issue" => {
            let row = issues::Entity::find()
                .filter(issues::Column::WorkspaceId.eq(workspace_id))
                .filter(issues::Column::Id.eq(id))
                .one(db)
                .await?;
            if row.as_ref().is_none_or(|r| project_hidden(access, r.project_id.as_deref())) {
                return Err(AppError::entity_not_found(kind, id));
            }
        }
        "milestone" => {
            let row = milestones::Entity::find()
                .filter(milestones::Column::WorkspaceId.eq(workspace_id))
                .filter(milestones::Column::Id.eq(id))
                .one(db)
                .await?;
            if row.as_ref().is_none_or(|r| project_hidden(access, Some(&r.project_id))) {
                return Err(AppError::entity_not_found(kind, id));
            }
        }
        _ => {}
    }
    Ok(())
}
