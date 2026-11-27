//! `UploadsService` (`server/src/uploads/uploads.service.ts`): storing files, serving them while
//! some record still mentions them, and keeping the `upload_references` rows in step with the
//! text and artifacts that mention them.
//!
//! Files live in Postgres. Bytes are returned only when a live reference on a record the caller
//! can read still points at them.
//!
//! Functions are generic over the connection (`&state.db` or a transaction) except the ones that
//! open a transaction or record an event themselves ([`attach_artifact`],
//! [`reconcile_upload_references`]).

use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::{Expr, ExprTrait, OnConflict};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DatabaseConnection, DbBackend,
    EntityTrait, QueryFilter, QuerySelect, Set, Statement, TransactionTrait,
};
use serde_json::{Value, json};
use trama_auth::member_access::{current_access, project_hidden};
use trama_auth::upload_caller::{UploadCaller, current_upload_caller};
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_contracts::issues::Artifact;
use trama_core::ids::uid;
use trama_core::{AppError, AppState};
use trama_entities::{
    artifacts, comments, issues, milestones, projects, upload_references, uploads,
};
use trama_events::{Events, RecordEvent};

use crate::rules::{
    AcceptedUpload, UploadKind, UploadRef, UploadResource, can_attach_artifact, can_stage_upload,
    inspect_upload, is_upload_id, markdown_for, same_actor, upload_ids_in, upload_path,
    upload_visible,
};
use crate::schemas::{StagedUpload, artifact_view};

/// A file as received from a client: the name it was sent with and its bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IncomingUpload {
    /// The client's file name (`originalname`); the stored name is derived from it.
    pub original_name: String,
    /// The whole file.
    pub bytes: Vec<u8>,
}

/// What kind of record owns a piece of text or an upload column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadSubjectType {
    /// An issue's `body`.
    Issue,
    /// A project's `description`.
    Project,
    /// A comment's `body`.
    Comment,
    /// An artifact's `uploadId`.
    Artifact,
}

impl UploadSubjectType {
    /// The value stored in `upload_references.subjectType`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Issue => "issue",
            Self::Project => "project",
            Self::Comment => "comment",
            Self::Artifact => "artifact",
        }
    }
}

/// A record whose text or upload column keeps a file alive (`UploadSubject`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadSubject {
    /// Record kind.
    pub kind: UploadSubjectType,
    /// Record id.
    pub id: String,
    /// The project the record belongs to, for the project limit of members.
    pub project_id: Option<String>,
}

impl UploadSubject {
    /// An issue (`{ type: 'issue', id, projectId }`).
    #[must_use]
    pub fn issue(id: impl Into<String>, project_id: Option<String>) -> Self {
        Self { kind: UploadSubjectType::Issue, id: id.into(), project_id }
    }

    /// A project (`{ type: 'project', id, projectId: id }`).
    #[must_use]
    pub fn project(id: impl Into<String>) -> Self {
        let id = id.into();
        Self { kind: UploadSubjectType::Project, project_id: Some(id.clone()), id }
    }

    /// A comment (`{ type: 'comment', id }`); its project comes from the record it is about.
    #[must_use]
    pub fn comment(id: impl Into<String>) -> Self {
        Self { kind: UploadSubjectType::Comment, id: id.into(), project_id: None }
    }

    /// An artifact (`{ type: 'artifact', id, projectId }`).
    #[must_use]
    pub fn artifact(id: impl Into<String>, project_id: Option<String>) -> Self {
        Self { kind: UploadSubjectType::Artifact, id: id.into(), project_id }
    }
}

/// The record about to be deleted, for [`ids_lost_with`] (`{ issueId?, projectId? }`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LostOwner {
    /// The issue being deleted.
    pub issue_id: Option<String>,
    /// The project being deleted.
    pub project_id: Option<String>,
}

fn accept(file: &IncomingUpload) -> Result<AcceptedUpload, AppError> {
    inspect_upload(&file.original_name, &file.bytes).map_err(AppError::bad_request)
}

fn not_found(id: &str) -> AppError {
    AppError::entity_not_found("File", id)
}

/// Stores `file` as the caller's draft and returns it with its URL and markdown. It is not
/// fetchable by anyone else until a description or comment that mentions it is saved.
///
/// # Errors
///
/// 403 `You cannot upload files here`; 400 with the reason from [`inspect_upload`].
pub async fn stage<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    slug: &str,
    caller: &UploadCaller,
    file: &IncomingUpload,
) -> Result<StagedUpload, AppError> {
    if !can_stage_upload(caller, current_access().as_deref()) {
        return Err(AppError::forbidden("You cannot upload files here"));
    }
    let accepted = accept(file)?;
    let id = uid("upl");
    let row = uploads::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(workspace_id.to_owned()),
        filename: Set(accepted.filename.clone()),
        content_type: Set(accepted.content_type.to_owned()),
        byte_size: Set(i32::try_from(accepted.byte_size).map_err(AppError::internal)?),
        bytes: Set(file.bytes.clone()),
        referenced: Set(false),
        created_by: Set(actor_json(&caller.actor)),
        ..Default::default()
    }
    .insert(db)
    .await?;
    let url = upload_path(slug, &row.id);
    let kind = UploadKind::of_content_type(&row.content_type);
    Ok(StagedUpload {
        id: row.id,
        markdown: markdown_for(kind, &row.filename, &url),
        filename: row.filename,
        content_type: row.content_type,
        byte_size: u64::from(row.byte_size.unsigned_abs()),
        kind,
        url,
    })
}

/// Stores `file` and attaches it to a task as an `image` or `file` artifact (`POST
/// /w/:slug/tasks/:idOrKey/artifacts/upload`); records `artifact.attached`.
///
/// `issue_id_or_key` is a task id or key (`AUTH-12`, also an alias).
///
/// # Errors
///
/// 403 `You cannot attach files here`; 404 `Issue "<id>" not found` (also for a task in a
/// project the caller cannot reach); 400 with the reason from [`inspect_upload`].
pub async fn attach_artifact(
    state: &AppState,
    workspace_id: &str,
    slug: &str,
    caller: &UploadCaller,
    file: &IncomingUpload,
    issue_id_or_key: &str,
) -> Result<Artifact, AppError> {
    if !can_attach_artifact(caller, current_access().as_deref()) {
        return Err(AppError::forbidden("You cannot attach files here"));
    }
    let (issue_id, project_id) = resolve_owner(&state.db, workspace_id, issue_id_or_key).await?;
    let accepted = accept(file)?;
    let id = uid("upl");
    let url = upload_path(slug, &id);
    let txn = state.db.begin().await?;
    uploads::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(workspace_id.to_owned()),
        filename: Set(accepted.filename.clone()),
        content_type: Set(accepted.content_type.to_owned()),
        byte_size: Set(i32::try_from(accepted.byte_size).map_err(AppError::internal)?),
        bytes: Set(file.bytes.clone()),
        referenced: Set(true),
        created_by: Set(actor_json(&caller.actor)),
        ..Default::default()
    }
    .insert(&txn)
    .await?;
    let artifact = artifacts::ActiveModel {
        id: Set(uid("ar")),
        workspace_id: Set(workspace_id.to_owned()),
        issue_id: Set(Some(issue_id)),
        repository: Set(None),
        description: Set(None),
        kind: Set(accepted.kind.as_str().to_owned()),
        provider: Set("other".to_owned()),
        title: Set(accepted.filename.clone()),
        url: Set(Some(url)),
        upload_id: Set(Some(id.clone())),
        external_id: Set(None),
        state: Set("published".to_owned()),
        ci: Set(None),
        review: Set(None),
        has_conflicts: Set(None),
        environment: Set(None),
        author_ref: Set(Some(actor_json(&caller.actor))),
        ..Default::default()
    }
    .insert(&txn)
    .await?;
    txn.commit().await?;
    link_artifact(&state.db, workspace_id, &artifact.id, &id, project_id.as_deref()).await?;

    let mut data = json!({
        "kind": artifact.kind,
        "title": artifact.title,
        "state": artifact.state,
    });
    if let (Some(issue_id), Some(map)) = (&artifact.issue_id, data.as_object_mut()) {
        map.insert("issueId".to_owned(), Value::String(issue_id.clone()));
    }
    Events::of(state)
        .record(
            &state.db,
            RecordEvent::new(
                workspace_id,
                caller.actor.clone(),
                "artifact.attached",
                SubjectRef { kind: SubjectType::Artifact, id: artifact.id.clone() },
            )
            .data(data),
        )
        .await?;
    Ok(artifact_view(&artifact))
}

/// The stored file, or 404. A staged file (not yet saved onto a record) is readable only by its
/// uploader. Once it was referenced and the reference is gone, the row is deleted so it cannot
/// be fetched again.
///
/// # Errors
///
/// 404 `File "<id>" not found`.
pub async fn open<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id: &str,
    caller: &UploadCaller,
) -> Result<uploads::Model, AppError> {
    if !is_upload_id(id) {
        return Err(not_found(id));
    }
    let Some(row) = uploads::Entity::find_by_id(id)
        .filter(uploads::Column::WorkspaceId.eq(workspace_id))
        .one(db)
        .await?
    else {
        return Err(not_found(id));
    };
    let refs = references_for(db, workspace_id, &[id.to_owned()]).await?;
    let refs = refs.get(id).map_or(&[][..], Vec::as_slice);
    let access = current_access();
    if refs.iter().any(|r| upload_visible(r, access.as_deref(), caller.permissions.as_deref())) {
        return Ok(row);
    }
    let staged = refs.is_empty() && !row.referenced && created_by(&row.created_by, &caller.actor);
    if staged {
        return Ok(row);
    }
    if refs.is_empty() && row.referenced {
        delete_uploads(db, workspace_id, &[id.to_owned()]).await?;
    }
    Err(not_found(id))
}

/// Drops a file that was uploaded and then never saved onto a record. Referenced files stay.
///
/// # Errors
///
/// 404 `File "<id>" not found` (also for somebody else's file); 400 `Remove the attachment from
/// the record instead`.
pub async fn discard<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    caller: &UploadCaller,
    id: &str,
) -> Result<(), AppError> {
    if !is_upload_id(id) {
        return Err(not_found(id));
    }
    let row = uploads::Entity::find_by_id(id)
        .filter(uploads::Column::WorkspaceId.eq(workspace_id))
        .select_only()
        .columns([uploads::Column::CreatedBy, uploads::Column::Referenced])
        .into_tuple::<(Value, bool)>()
        .one(db)
        .await?;
    let Some((owner, referenced)) = row else { return Err(not_found(id)) };
    if !created_by(&owner, &caller.actor) {
        return Err(not_found(id));
    }
    let refs = references_for(db, workspace_id, &[id.to_owned()]).await?;
    if refs.get(id).is_some_and(|list| !list.is_empty()) || referenced {
        return Err(AppError::bad_request("Remove the attachment from the record instead"));
    }
    delete_uploads(db, workspace_id, &[id.to_owned()]).await?;
    Ok(())
}

/// Refuses a description or comment that points at a file the caller cannot read. Call before
/// saving. The caller is the current request's [`current_upload_caller`].
///
/// # Errors
///
/// 400 `That file is not available to attach here`.
pub async fn assert_attachable<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    text: Option<&str>,
) -> Result<(), AppError> {
    let ids = upload_ids_in(text);
    if ids.is_empty() {
        return Ok(());
    }
    let caller = current_upload_caller();
    let rows = uploads::Entity::find()
        .filter(uploads::Column::WorkspaceId.eq(workspace_id))
        .filter(uploads::Column::Id.is_in(ids.clone()))
        .select_only()
        .columns([uploads::Column::Id, uploads::Column::CreatedBy, uploads::Column::Referenced])
        .into_tuple::<(String, Value, bool)>()
        .all(db)
        .await?;
    let by_id: HashMap<String, (Value, bool)> =
        rows.into_iter().map(|(id, owner, referenced)| (id, (owner, referenced))).collect();
    let refs = references_for(db, workspace_id, &ids).await?;
    let access = current_access();
    for id in &ids {
        let list = refs.get(id).map_or(&[][..], Vec::as_slice);
        let ok = match (by_id.get(id), &caller) {
            (Some((owner, referenced)), Some(caller)) => {
                list.iter()
                    .any(|r| upload_visible(r, access.as_deref(), caller.permissions.as_deref()))
                    || (list.is_empty() && !referenced && created_by(owner, &caller.actor))
            }
            _ => false,
        };
        if !ok {
            return Err(AppError::bad_request("That file is not available to attach here"));
        }
    }
    Ok(())
}

/// After the text is saved: keeps the files it still mentions and deletes the ones it dropped.
///
/// `subject` is the record that owns this text. Without it, only the `referenced` flag moves.
///
/// # Errors
///
/// Database errors.
pub async fn retained<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    before: Option<&str>,
    after: Option<&str>,
    subject: Option<&UploadSubject>,
) -> Result<(), AppError> {
    let next = upload_ids_in(after);
    let Some(subject) = subject else {
        mark_referenced(db, workspace_id, &next).await?;
        let kept: HashSet<&String> = next.iter().collect();
        let dropped: Vec<String> =
            upload_ids_in(before).into_iter().filter(|id| !kept.contains(id)).collect();
        return release_ids(db, workspace_id, &dropped).await;
    };
    let existing = subject_upload_ids(db, workspace_id, subject).await?;
    replace_subject(db, workspace_id, subject, &next).await?;
    mark_referenced(db, workspace_id, &next).await?;
    let kept: HashSet<&String> = next.iter().collect();
    let dropped: Vec<String> = existing.into_iter().filter(|id| !kept.contains(id)).collect();
    release_ids(db, workspace_id, &dropped).await
}

/// Records that an artifact row is what keeps this file alive (`linkArtifact`). Pass the
/// transaction as `db` to write with it.
///
/// # Errors
///
/// Database errors.
pub async fn link_artifact<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    artifact_id: &str,
    upload_id: &str,
    project_id: Option<&str>,
) -> Result<(), AppError> {
    upsert_references(
        db,
        vec![reference_row(
            workspace_id,
            upload_id,
            UploadSubjectType::Artifact,
            artifact_id,
            project_id,
        )],
    )
    .await?;
    mark_referenced(db, workspace_id, &[upload_id.to_owned()]).await
}

/// Drops the mention rows of records that were just deleted, then releases the files nothing
/// else names.
///
/// # Errors
///
/// Database errors.
pub async fn forget_subjects<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    subjects: &[UploadSubject],
) -> Result<(), AppError> {
    if subjects.is_empty() {
        return Ok(());
    }
    let mut any = Condition::any();
    for subject in subjects {
        any = any.add(
            Condition::all()
                .add(upload_references::Column::SubjectType.eq(subject.kind.as_str()))
                .add(upload_references::Column::SubjectId.eq(subject.id.as_str())),
        );
    }
    let removed = upload_references::Entity::delete_many()
        .filter(upload_references::Column::WorkspaceId.eq(workspace_id))
        .filter(any)
        .exec_with_returning(db)
        .await?;
    let ids: Vec<String> = removed.into_iter().map(|row| row.upload_id).collect();
    release_ids(db, workspace_id, &ids).await
}

/// The upload ids that will have no row left after `owner` is deleted: files named in `texts` or
/// in comments on that record, and uploads whose only artifact owner is that record. Call before
/// the delete, then [`release_ids`].
///
/// # Errors
///
/// Database errors.
pub async fn ids_lost_with<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    owner: &LostOwner,
    texts: &[Option<&str>],
) -> Result<Vec<String>, AppError> {
    let mut ids: Vec<String> = Vec::new();
    let mut add = |id: String| {
        if !ids.contains(&id) {
            ids.push(id);
        }
    };
    for text in texts {
        upload_ids_in(*text).into_iter().for_each(&mut add);
    }
    let owned_artifacts = match &owner.issue_id {
        Some(issue_id) => {
            artifacts::Entity::find()
                .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
                .filter(artifacts::Column::IssueId.eq(issue_id.as_str()))
                .select_only()
                .columns([artifacts::Column::Id, artifacts::Column::UploadId])
                .into_tuple::<(String, Option<String>)>()
                .all(db)
                .await?
        }
        None => Vec::new(),
    };
    let mut subjects: Vec<String> = [owner.issue_id.clone(), owner.project_id.clone()]
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .collect();
    subjects.extend(owned_artifacts.iter().map(|(id, _)| id.clone()));
    for (_, upload_id) in owned_artifacts {
        if let Some(upload_id) = upload_id {
            add(upload_id);
        }
    }
    if !subjects.is_empty() {
        let bodies = comments::Entity::find()
            .filter(comments::Column::WorkspaceId.eq(workspace_id))
            .filter(Expr::cust(r#""comments"."subject"->>'id'"#).is_in(subjects))
            .select_only()
            .column(comments::Column::Body)
            .into_tuple::<String>()
            .all(db)
            .await?;
        for body in bodies {
            upload_ids_in(Some(&body)).into_iter().for_each(&mut add);
        }
    }
    Ok(ids)
}

/// Deletes the files in `ids` that no record mentions any more.
///
/// # Errors
///
/// Database errors.
pub async fn release_ids<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<(), AppError> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if is_upload_id(id) && !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    if unique.is_empty() {
        return Ok(());
    }
    let refs = references_for(db, workspace_id, &unique).await?;
    let gone: Vec<String> =
        unique.into_iter().filter(|id| refs.get(id).is_none_or(Vec::is_empty)).collect();
    delete_uploads(db, workspace_id, &gone).await
}

/// `<uploadId>` scans of the text and artifact columns the read path used to search. Each scan
/// fills the temporary `upload_reference_scan` table.
const SCAN_INSERTS: [&str; 4] = [
    r#"INSERT INTO "upload_reference_scan" ("uploadId", "subjectType", "subjectId", "projectId")
   SELECT DISTINCT m.match[1], 'issue', i."id", i."projectId"
   FROM "issues" i
   CROSS JOIN LATERAL regexp_matches(coalesce(i."body", ''), '/uploads/(upl_[a-z0-9]{10,24})', 'g') AS m(match)
   WHERE i."workspaceId" = $1
   ON CONFLICT DO NOTHING"#,
    r#"INSERT INTO "upload_reference_scan" ("uploadId", "subjectType", "subjectId", "projectId")
   SELECT DISTINCT m.match[1], 'project', p."id", p."id"
   FROM "projects" p
   CROSS JOIN LATERAL regexp_matches(coalesce(p."description", ''), '/uploads/(upl_[a-z0-9]{10,24})', 'g') AS m(match)
   WHERE p."workspaceId" = $1
   ON CONFLICT DO NOTHING"#,
    r#"INSERT INTO "upload_reference_scan" ("uploadId", "subjectType", "subjectId", "projectId")
   SELECT DISTINCT m.match[1], 'comment', c."id", NULL
   FROM "comments" c
   CROSS JOIN LATERAL regexp_matches(c."body", '/uploads/(upl_[a-z0-9]{10,24})', 'g') AS m(match)
   WHERE c."workspaceId" = $1
   ON CONFLICT DO NOTHING"#,
    r#"INSERT INTO "upload_reference_scan" ("uploadId", "subjectType", "subjectId", "projectId")
   SELECT a."uploadId", 'artifact', a."id", i."projectId"
   FROM "artifacts" a
   LEFT JOIN "issues" i ON i."id" = a."issueId" AND i."workspaceId" = a."workspaceId"
   WHERE a."workspaceId" = $1 AND a."uploadId" IS NOT NULL
   ON CONFLICT DO NOTHING"#,
];

/// Rebuilds the mention rows of one workspace from the text and artifact columns the read path
/// used to scan. Not called from a request: inserts mentions a write missed and drops rows whose
/// text is gone, then releases blobs that no longer have a mention. Staged drafts (never
/// referenced) are left alone.
///
/// # Errors
///
/// Database errors.
pub async fn reconcile_upload_references(
    db: &DatabaseConnection,
    workspace_id: &str,
) -> Result<(), AppError> {
    let ws = || vec![workspace_id.into()];
    let run = |sql: &str| Statement::from_sql_and_values(DbBackend::Postgres, sql, ws());
    let txn = db.begin().await?;
    txn.execute_unprepared(
        r#"CREATE TEMP TABLE "upload_reference_scan" (
           "uploadId" character varying NOT NULL,
           "subjectType" character varying NOT NULL,
           "subjectId" character varying NOT NULL,
           "projectId" character varying,
           PRIMARY KEY ("uploadId", "subjectType", "subjectId")
         ) ON COMMIT DROP"#,
    )
    .await?;
    for sql in SCAN_INSERTS {
        txn.execute_raw(run(sql)).await?;
    }
    txn.execute_raw(run(r#"DELETE FROM "upload_reference_scan" s
         WHERE NOT EXISTS (
           SELECT 1 FROM "uploads" u
           WHERE u."id" = s."uploadId" AND u."workspaceId" = $1
         )"#))
        .await?;
    let dropped = txn
        .query_all_raw(run(r#"DELETE FROM "upload_references" r
         WHERE r."workspaceId" = $1
           AND NOT EXISTS (
             SELECT 1 FROM "upload_reference_scan" s
             WHERE s."uploadId" = r."uploadId"
               AND s."subjectType" = r."subjectType"
               AND s."subjectId" = r."subjectId"
           )
         RETURNING r."uploadId""#))
        .await?;
    let mut removed = Vec::with_capacity(dropped.len());
    for row in &dropped {
        removed.push(row.try_get::<String>("", "uploadId")?);
    }
    txn.execute_raw(run(r#"INSERT INTO "upload_references"
           ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId")
         SELECT $1, s."uploadId", s."subjectType", s."subjectId", s."projectId"
         FROM "upload_reference_scan" s
         ON CONFLICT ("workspaceId", "uploadId", "subjectType", "subjectId")
         DO UPDATE SET "projectId" = EXCLUDED."projectId""#))
        .await?;
    txn.execute_raw(run(r#"UPDATE "uploads" u SET "referenced" = true
         WHERE u."workspaceId" = $1 AND u."referenced" = false
           AND EXISTS (
             SELECT 1 FROM "upload_references" r
             WHERE r."workspaceId" = u."workspaceId" AND r."uploadId" = u."id"
           )"#))
        .await?;
    txn.commit().await?;
    release_ids(db, workspace_id, &removed).await
}

fn actor_json(actor: &ActorRef) -> Value {
    serde_json::to_value(actor).unwrap_or(Value::Null)
}

/// Is `owner` (a stored `createdBy`) the same actor as `actor`?
fn created_by(owner: &Value, actor: &ActorRef) -> bool {
    serde_json::from_value::<ActorRef>(owner.clone()).is_ok_and(|owner| same_actor(&owner, actor))
}

async fn delete_uploads<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<(), AppError> {
    if ids.is_empty() {
        return Ok(());
    }
    uploads::Entity::delete_many()
        .filter(uploads::Column::WorkspaceId.eq(workspace_id))
        .filter(uploads::Column::Id.is_in(ids.to_vec()))
        .exec(db)
        .await?;
    Ok(())
}

async fn mark_referenced<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<(), AppError> {
    if ids.is_empty() {
        return Ok(());
    }
    uploads::Entity::update_many()
        .col_expr(uploads::Column::Referenced, Expr::value(true))
        .filter(uploads::Column::WorkspaceId.eq(workspace_id))
        .filter(uploads::Column::Id.is_in(ids.to_vec()))
        .exec(db)
        .await?;
    Ok(())
}

fn reference_row(
    workspace_id: &str,
    upload_id: &str,
    kind: UploadSubjectType,
    subject_id: &str,
    project_id: Option<&str>,
) -> upload_references::ActiveModel {
    upload_references::ActiveModel {
        workspace_id: Set(workspace_id.to_owned()),
        upload_id: Set(upload_id.to_owned()),
        subject_type: Set(kind.as_str().to_owned()),
        subject_id: Set(subject_id.to_owned()),
        project_id: Set(project_id.map(ToOwned::to_owned)),
    }
}

/// `INSERT … ON CONFLICT (workspaceId, uploadId, subjectType, subjectId) DO UPDATE SET
/// projectId`.
async fn upsert_references<C: ConnectionTrait>(
    db: &C,
    rows: Vec<upload_references::ActiveModel>,
) -> Result<(), AppError> {
    if rows.is_empty() {
        return Ok(());
    }
    upload_references::Entity::insert_many(rows)
        .on_conflict(
            OnConflict::columns([
                upload_references::Column::WorkspaceId,
                upload_references::Column::UploadId,
                upload_references::Column::SubjectType,
                upload_references::Column::SubjectId,
            ])
            .update_column(upload_references::Column::ProjectId)
            .to_owned(),
        )
        .exec_without_returning(db)
        .await?;
    Ok(())
}

async fn subject_upload_ids<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    subject: &UploadSubject,
) -> Result<Vec<String>, AppError> {
    Ok(upload_references::Entity::find()
        .filter(upload_references::Column::WorkspaceId.eq(workspace_id))
        .filter(upload_references::Column::SubjectType.eq(subject.kind.as_str()))
        .filter(upload_references::Column::SubjectId.eq(subject.id.as_str()))
        .select_only()
        .column(upload_references::Column::UploadId)
        .into_tuple::<String>()
        .all(db)
        .await?)
}

async fn replace_subject<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    subject: &UploadSubject,
    upload_ids: &[String],
) -> Result<(), AppError> {
    upload_references::Entity::delete_many()
        .filter(upload_references::Column::WorkspaceId.eq(workspace_id))
        .filter(upload_references::Column::SubjectType.eq(subject.kind.as_str()))
        .filter(upload_references::Column::SubjectId.eq(subject.id.as_str()))
        .exec(db)
        .await?;
    let rows = upload_ids
        .iter()
        .map(|upload_id| {
            reference_row(
                workspace_id,
                upload_id,
                subject.kind,
                &subject.id,
                subject.project_id.as_deref(),
            )
        })
        .collect();
    upsert_references(db, rows).await
}

/// `ISSUE_KEY`: `AUTH-12`.
fn is_issue_key(value: &str) -> bool {
    value.split_once('-').is_some_and(|(prefix, number)| {
        !prefix.is_empty()
            && prefix.chars().all(|c| c.is_ascii_alphabetic())
            && !number.is_empty()
            && number.chars().all(|c| c.is_ascii_digit())
    })
}

/// The task an upload is attached to: by key (or alias) when it looks like one, else by id.
/// 404 `Issue "<value>" not found` when it does not exist or sits outside the caller's projects.
async fn resolve_owner<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    issue_id_or_key: &str,
) -> Result<(String, Option<String>), AppError> {
    let base = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .select_only()
        .columns([issues::Column::Id, issues::Column::ProjectId]);
    let row = if is_issue_key(issue_id_or_key) {
        let key = issue_id_or_key.to_uppercase();
        let by_key = base
            .clone()
            .filter(issues::Column::Key.eq(key.as_str()))
            .into_tuple::<(String, Option<String>)>()
            .one(db)
            .await?;
        match by_key {
            Some(row) => Some(row),
            None => {
                base.filter(Expr::cust_with_values(r#""issues"."aliases" @> $1"#, [json!([key])]))
                    .into_tuple::<(String, Option<String>)>()
                    .one(db)
                    .await?
            }
        }
    } else {
        base.filter(issues::Column::Id.eq(issue_id_or_key))
            .into_tuple::<(String, Option<String>)>()
            .one(db)
            .await?
    };
    match row {
        Some((id, project_id))
            if !project_hidden(current_access().as_deref(), project_id.as_deref()) =>
        {
            Ok((id, project_id))
        }
        _ => Err(AppError::entity_not_found("Issue", issue_id_or_key)),
    }
}

/// Every current mention of the files in `ids`, by upload id. A file without an entry is
/// unreferenced. Mentions of records that no longer exist are ignored, as a scan of the rows
/// that still exist would.
async fn references_for<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<HashMap<String, Vec<UploadRef>>, AppError> {
    let mut out: HashMap<String, Vec<UploadRef>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let rows = upload_references::Entity::find()
        .filter(upload_references::Column::WorkspaceId.eq(workspace_id))
        .filter(upload_references::Column::UploadId.is_in(ids.to_vec()))
        .all(db)
        .await?;
    if rows.is_empty() {
        return Ok(out);
    }
    let ids_of = |kind: UploadSubjectType| -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        for row in rows.iter().filter(|row| row.subject_type == kind.as_str()) {
            if !seen.contains(&row.subject_id) {
                seen.push(row.subject_id.clone());
            }
        }
        seen
    };
    let issue_projects =
        issue_projects(db, workspace_id, &ids_of(UploadSubjectType::Issue)).await?;
    let live_projects =
        existing_projects(db, workspace_id, &ids_of(UploadSubjectType::Project)).await?;
    let comment_refs =
        comment_subjects(db, workspace_id, &ids_of(UploadSubjectType::Comment)).await?;
    let artifact_projects =
        artifact_projects(db, workspace_id, &ids_of(UploadSubjectType::Artifact)).await?;
    for row in rows {
        let reference = match row.subject_type.as_str() {
            "issue" => issue_projects.get(&row.subject_id).map(|project| UploadRef {
                resource: UploadResource::Issues,
                project_scoped: true,
                project_id: project.clone(),
            }),
            "project" => live_projects.contains(&row.subject_id).then(|| UploadRef {
                resource: UploadResource::Projects,
                project_scoped: true,
                project_id: Some(row.subject_id.clone()),
            }),
            "comment" => comment_refs.get(&row.subject_id).cloned(),
            "artifact" => artifact_projects.get(&row.subject_id).map(|project| UploadRef {
                resource: UploadResource::Artifacts,
                project_scoped: true,
                project_id: project.clone(),
            }),
            _ => None,
        };
        if let Some(reference) = reference {
            out.entry(row.upload_id).or_default().push(reference);
        }
    }
    Ok(out)
}

async fn existing_projects<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<HashSet<String>, AppError> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows = projects::Entity::find()
        .filter(projects::Column::WorkspaceId.eq(workspace_id))
        .filter(projects::Column::Id.is_in(ids.to_vec()))
        .select_only()
        .column(projects::Column::Id)
        .into_tuple::<String>()
        .all(db)
        .await?;
    Ok(rows.into_iter().collect())
}

async fn issue_projects<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<HashMap<String, Option<String>>, AppError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = issues::Entity::find()
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .filter(issues::Column::Id.is_in(ids.to_vec()))
        .select_only()
        .columns([issues::Column::Id, issues::Column::ProjectId])
        .into_tuple::<(String, Option<String>)>()
        .all(db)
        .await?;
    Ok(rows.into_iter().collect())
}

async fn milestone_projects<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<HashMap<String, Option<String>>, AppError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = milestones::Entity::find()
        .filter(milestones::Column::WorkspaceId.eq(workspace_id))
        .filter(milestones::Column::Id.is_in(ids.to_vec()))
        .select_only()
        .columns([milestones::Column::Id, milestones::Column::ProjectId])
        .into_tuple::<(String, String)>()
        .all(db)
        .await?;
    Ok(rows.into_iter().map(|(id, project)| (id, Some(project))).collect())
}

/// The project an artifact belongs to through its task (`LEFT JOIN issues`).
async fn artifact_projects<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<HashMap<String, Option<String>>, AppError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = artifacts::Entity::find()
        .filter(artifacts::Column::WorkspaceId.eq(workspace_id))
        .filter(artifacts::Column::Id.is_in(ids.to_vec()))
        .select_only()
        .columns([artifacts::Column::Id, artifacts::Column::IssueId])
        .into_tuple::<(String, Option<String>)>()
        .all(db)
        .await?;
    let issue_ids: Vec<String> = rows.iter().filter_map(|(_, issue)| issue.clone()).collect();
    let projects = issue_projects(db, workspace_id, &issue_ids).await?;
    Ok(rows
        .into_iter()
        .map(|(id, issue)| {
            let project = issue.and_then(|issue| projects.get(&issue).cloned().flatten());
            (id, project)
        })
        .collect())
}

/// The mention of each comment: what it is about decides its project. A comment on a record we
/// cannot place (or about an import) is workspace-wide.
async fn comment_subjects<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    ids: &[String],
) -> Result<HashMap<String, UploadRef>, AppError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = comments::Entity::find()
        .filter(comments::Column::WorkspaceId.eq(workspace_id))
        .filter(comments::Column::Id.is_in(ids.to_vec()))
        .select_only()
        .columns([comments::Column::Id, comments::Column::Subject])
        .into_tuple::<(String, Value)>()
        .all(db)
        .await?;
    let subject = |value: &Value| {
        let text =
            |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        (text("type"), text("id"))
    };
    let wanted = |kind: &str| -> Vec<String> {
        rows.iter()
            .map(|(_, value)| subject(value))
            .filter(|(t, _)| t == kind)
            .map(|(_, id)| id)
            .collect()
    };
    let issue_projects = issue_projects(db, workspace_id, &wanted("issue")).await?;
    let milestone_projects = milestone_projects(db, workspace_id, &wanted("milestone")).await?;
    let mut out = HashMap::new();
    for (id, value) in &rows {
        let (kind, subject_id) = subject(value);
        let reference = match kind.as_str() {
            "issue" => UploadRef {
                resource: UploadResource::Comments,
                project_scoped: true,
                project_id: issue_projects.get(&subject_id).cloned().flatten(),
            },
            "milestone" => UploadRef {
                resource: UploadResource::Comments,
                project_scoped: true,
                project_id: milestone_projects.get(&subject_id).cloned().flatten(),
            },
            "project" => UploadRef {
                resource: UploadResource::Comments,
                project_scoped: true,
                project_id: Some(subject_id),
            },
            _ => UploadRef {
                resource: UploadResource::Comments,
                project_scoped: false,
                project_id: None,
            },
        };
        out.insert(id.clone(), reference);
    }
    Ok(out)
}
