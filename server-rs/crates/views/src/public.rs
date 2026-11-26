//! The public, unauthenticated side of "anyone with the link" (`public-views.service.ts`).
//!
//! It resolves a secret token to ONE view and runs that view's saved query; nothing about the
//! request (query string, headers, session) can change the filters, sort, grouping, entity or
//! workspace. The result is a fixed projection of a few display fields per row, never the full
//! entities.

use std::collections::{HashMap, HashSet};

use axum::http::StatusCode;
use sea_orm::{
    ColumnTrait, DatabaseConnection, DerivePartialModel, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use trama_contracts::common::Priority;
use trama_contracts::labels::resolve_label_catalog;
use trama_contracts::views::{
    PublicView, PublicViewGroup, PublicViewItem, SortDirection, ViewEntity, ViewLayout, ViewSort,
};
use trama_core::time::{now_iso, to_iso};
use trama_core::{AppError, AppState};
use trama_entities::{issues, memberships, projects, saved_views, users, workspaces};

use crate::query::{
    QueryFilter as ViewQueryFilter, RefKind, Row, apply_filters, field_spec, field_values,
    group_items, sort_items,
};
use crate::rules::{hash_public_token, is_public_token, stored_entity};

/// Rows returned for one public view; the rest is cut (and flagged as `truncated`).
pub const PUBLIC_VIEW_LIMIT: usize = 500;
/// Maximum workspace rows evaluated for one unauthenticated public-view request.
pub const PUBLIC_VIEW_SCAN_LIMIT: usize = 20_000;

/// One generic error for malformed, unknown, revoked and no-longer-link-shared tokens.
const MISSING: &str = "This shared view does not exist or is no longer shared";

/// The query limit as a database `LIMIT`.
const SCAN_TAKE: u64 = PUBLIC_VIEW_SCAN_LIMIT as u64 + 1;

type Names = HashMap<RefKind, HashMap<String, String>>;

/// The issue columns a view can read or display.
#[derive(DerivePartialModel)]
#[sea_orm(entity = "issues::Entity")]
struct IssueRow {
    id: String,
    key: String,
    title: String,
    kind: String,
    status: String,
    priority: String,
    source: String,
    assignee_id: Option<String>,
    project_id: Option<String>,
    milestone_ids: Value,
    labels: Value,
    created_at: sea_orm::prelude::DateTimeWithTimeZone,
    updated_at: sea_orm::prelude::DateTimeWithTimeZone,
}

/// The project columns a view can read or display.
#[derive(DerivePartialModel)]
#[sea_orm(entity = "projects::Entity")]
struct ProjectRow {
    id: String,
    name: String,
    status: String,
    priority: String,
    health: Option<String>,
    lead_id: Option<String>,
    repository: Option<String>,
    labels: Value,
    start_date: Option<sea_orm::prelude::DateTimeWithTimeZone>,
    target_date: Option<sea_orm::prelude::DateTimeWithTimeZone>,
    created_at: sea_orm::prelude::DateTimeWithTimeZone,
    updated_at: sea_orm::prelude::DateTimeWithTimeZone,
}

fn row_of(fields: Vec<(&str, Value)>) -> Row {
    fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect()
}

fn date(value: &sea_orm::prelude::DateTimeWithTimeZone) -> Value {
    json!(to_iso(value))
}

fn optional_date(value: Option<&sea_orm::prelude::DateTimeWithTimeZone>) -> Value {
    value.map_or(Value::Null, date)
}

impl From<IssueRow> for Row {
    fn from(r: IssueRow) -> Self {
        row_of(vec![
            ("id", json!(r.id)),
            ("key", json!(r.key)),
            ("title", json!(r.title)),
            ("kind", json!(r.kind)),
            ("status", json!(r.status)),
            ("priority", json!(r.priority)),
            ("source", json!(r.source)),
            ("assigneeId", json!(r.assignee_id)),
            ("projectId", json!(r.project_id)),
            ("milestoneIds", r.milestone_ids),
            ("labels", r.labels),
            ("createdAt", date(&r.created_at)),
            ("updatedAt", date(&r.updated_at)),
        ])
    }
}

impl From<ProjectRow> for Row {
    fn from(r: ProjectRow) -> Self {
        row_of(vec![
            ("id", json!(r.id)),
            ("name", json!(r.name)),
            ("status", json!(r.status)),
            ("priority", json!(r.priority)),
            ("health", json!(r.health)),
            ("leadId", json!(r.lead_id)),
            ("repository", json!(r.repository)),
            ("labels", r.labels),
            ("startDate", optional_date(r.start_date.as_ref())),
            ("targetDate", optional_date(r.target_date.as_ref())),
            ("createdAt", date(&r.created_at)),
            ("updatedAt", date(&r.updated_at)),
        ])
    }
}

fn missing() -> AppError {
    AppError::not_found(MISSING)
}

fn over_the_limit() -> AppError {
    AppError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "This shared view exceeds the 20,000-row evaluation limit. Ask the owner to narrow it.",
    )
}

/// `GET /api/public/views/:token`: the result of the view the token names.
///
/// # Errors
///
/// 404 for a malformed, unknown, revoked or no-longer-public token; 422 when the view would
/// have to read more than [`PUBLIC_VIEW_SCAN_LIMIT`] rows.
pub async fn get(state: &AppState, token: &str) -> Result<PublicView, AppError> {
    let db = &state.db;
    if !is_public_token(token) {
        return Err(missing());
    }
    let view = saved_views::Entity::find()
        .filter(saved_views::Column::PublicTokenHash.eq(hash_public_token(token)))
        .one(db)
        .await?
        .ok_or_else(missing)?;
    let is_link = view.sharing.get("visibility").and_then(Value::as_str) == Some("link");
    let entity = stored_entity(&view.entity).filter(|_| is_link).ok_or_else(missing)?;
    let workspace_id = view.workspace_id.as_str();

    let rows = rows_of(db, entity, workspace_id).await?;
    let filters = ViewQueryFilter::list_from_json(&view.filters);
    let layout = ViewLayout::parse(&view.layout);
    let stored_sort: Option<ViewSort> =
        view.sort.as_ref().and_then(|sort| serde_json::from_value(sort.clone()).ok());
    // a view whose stored sort is unreadable sorts like one without
    let sort = stored_sort.or_else(|| {
        (layout == Some(ViewLayout::Timeline))
            .then(|| ViewSort { field: "startDate".into(), direction: SortDirection::Asc })
    });
    let matched = sort_items(entity, apply_filters(entity, &rows, &filters), sort.as_ref());
    let kept: Vec<&Row> = matched.iter().take(PUBLIC_VIEW_LIMIT).copied().collect();
    // A board always has columns: by status unless the view says otherwise.
    let group_by = view
        .group_by
        .clone()
        .or_else(|| (layout == Some(ViewLayout::Board)).then(|| "status".to_owned()));
    let groups = group_items(entity, &kept, group_by.as_deref());

    let names = names_for(db, workspace_id, entity, group_by.as_deref(), &kept).await?;
    let workspace = workspaces::Entity::find_by_id(workspace_id).one(db).await?;

    // Label ids mean nothing to a reader of the link: show the names.
    let label_names: HashMap<String, String> =
        resolve_label_catalog(workspace.as_ref().and_then(|w| w.settings.get("labels")))
            .into_iter()
            .map(|label| (label.id, label.name))
            .collect();
    let groups = groups
        .into_iter()
        .map(|group| PublicViewGroup {
            label: group_label(entity, group_by.as_deref(), &group.key, &names),
            key: group.key,
            items: group
                .items
                .iter()
                .map(|row| project(entity, row, &names, &label_names))
                .collect(),
        })
        .collect();
    Ok(PublicView {
        name: view.name,
        entity,
        layout: layout.unwrap_or(ViewLayout::List),
        group_by: group_by.filter(|g| !g.is_empty()),
        workspace_name: workspace.map(|w| w.name).unwrap_or_default(),
        groups,
        total: i64::try_from(matched.len()).unwrap_or(i64::MAX),
        truncated: matched.len() > kept.len(),
        generated_at: now_iso(),
    })
}

/// The workspace's rows of `entity`, at most [`PUBLIC_VIEW_SCAN_LIMIT`] (422 beyond).
async fn rows_of(
    db: &DatabaseConnection,
    entity: ViewEntity,
    workspace_id: &str,
) -> Result<Vec<Row>, AppError> {
    let rows: Vec<Row> = match entity {
        ViewEntity::Issue => issues::Entity::find()
            .filter(issues::Column::WorkspaceId.eq(workspace_id))
            .order_by_asc(issues::Column::CreatedAt)
            .order_by_asc(issues::Column::Id)
            .limit(SCAN_TAKE)
            .into_partial_model::<IssueRow>()
            .all(db)
            .await?
            .into_iter()
            .map(Row::from)
            .collect(),
        ViewEntity::Project => projects::Entity::find()
            .filter(projects::Column::WorkspaceId.eq(workspace_id))
            .order_by_asc(projects::Column::CreatedAt)
            .order_by_asc(projects::Column::Id)
            .limit(SCAN_TAKE)
            .into_partial_model::<ProjectRow>()
            .all(db)
            .await?
            .into_iter()
            .map(Row::from)
            .collect(),
    };
    bounded(rows)
}

fn bounded<T>(rows: Vec<T>) -> Result<Vec<T>, AppError> {
    if rows.len() > PUBLIC_VIEW_SCAN_LIMIT {
        return Err(over_the_limit());
    }
    Ok(rows)
}

/// Display names for the people and projects the returned rows point at.
async fn names_for(
    db: &DatabaseConnection,
    workspace_id: &str,
    entity: ViewEntity,
    group_by: Option<&str>,
    rows: &[&Row],
) -> Result<Names, AppError> {
    let mut fields: Vec<&str> = match entity {
        ViewEntity::Issue => vec!["assigneeId", "projectId"],
        ViewEntity::Project => vec!["leadId"],
    };
    if let Some(group_by) = group_by.filter(|g| !g.is_empty()) {
        fields.push(group_by);
    }
    let mut ids: HashMap<RefKind, HashSet<String>> = HashMap::new();
    let mut reference_count = 0usize;
    for field in fields {
        let Some(refers_to) = field_spec(entity, field).and_then(|spec| spec.refers_to) else {
            continue;
        };
        for row in rows {
            for id in field_values(entity, row, field) {
                if ids.entry(refers_to).or_default().insert(id) {
                    reference_count += 1;
                    if reference_count > PUBLIC_VIEW_SCAN_LIMIT {
                        return Err(over_the_limit());
                    }
                }
            }
        }
    }

    let mut names = Names::new();
    if let Some(project_ids) = ids.remove(&RefKind::Project).filter(|ids| !ids.is_empty()) {
        let found = projects::Entity::find()
            .filter(projects::Column::WorkspaceId.eq(workspace_id))
            .filter(projects::Column::Id.is_in(project_ids))
            .select_only()
            .columns([projects::Column::Id, projects::Column::Name])
            .limit(SCAN_TAKE)
            .into_tuple::<(String, String)>()
            .all(db)
            .await?;
        names.insert(RefKind::Project, bounded(found)?.into_iter().collect());
    }
    if let Some(user_ids) = ids.remove(&RefKind::User).filter(|ids| !ids.is_empty()) {
        let members = bounded(
            memberships::Entity::find()
                .filter(memberships::Column::WorkspaceId.eq(workspace_id))
                .filter(memberships::Column::UserId.is_in(user_ids))
                .select_only()
                .column(memberships::Column::UserId)
                .limit(SCAN_TAKE)
                .into_tuple::<String>()
                .all(db)
                .await?,
        )?;
        let found = if members.is_empty() {
            Vec::new()
        } else {
            bounded(
                users::Entity::find()
                    .filter(users::Column::Id.is_in(members))
                    .select_only()
                    .columns([users::Column::Id, users::Column::Name])
                    .limit(SCAN_TAKE)
                    .into_tuple::<(String, String)>()
                    .all(db)
                    .await?,
            )?
        };
        names.insert(RefKind::User, found.into_iter().collect());
    }
    Ok(names)
}

fn group_label(entity: ViewEntity, group_by: Option<&str>, key: &str, names: &Names) -> String {
    if key.is_empty() {
        return String::new();
    }
    let refers_to = group_by.and_then(|g| field_spec(entity, g)).and_then(|spec| spec.refers_to);
    refers_to
        .and_then(|kind| names.get(&kind))
        .and_then(|known| known.get(key))
        .filter(|name| !name.is_empty())
        .cloned()
        .unwrap_or_else(|| key.to_owned())
}

/// A non-empty string property.
fn text(row: &Row, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(ToOwned::to_owned)
}

/// A date property, as stored (already an ISO string).
fn iso(row: &Row, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

fn name_of(names: &Names, kind: RefKind, id: Option<&Value>) -> Option<String> {
    let id = id?.as_str()?;
    names.get(&kind)?.get(id).cloned()
}

/// Label names of the ids a row holds; labels deleted since are dropped, and none at all is no
/// `labels` property.
fn label_names(row: &Row, labels: &HashMap<String, String>) -> Option<Vec<String>> {
    let names: Vec<String> = row
        .get("labels")?
        .as_array()?
        .iter()
        .filter_map(|id| labels.get(&crate::query::js_string(id)))
        .cloned()
        .collect();
    (!names.is_empty()).then_some(names)
}

/// The only place that decides which fields leave the server for an anonymous reader.
fn project(
    entity: ViewEntity,
    row: &Row,
    names: &Names,
    labels: &HashMap<String, String>,
) -> PublicViewItem {
    let priority = text(row, "priority").and_then(|p| Priority::parse(&p));
    let mut item = PublicViewItem {
        id: row.get("id").map(crate::query::js_string).unwrap_or_default(),
        key: None,
        title: String::new(),
        kind: None,
        status: text(row, "status"),
        priority,
        health: None,
        assignee: None,
        project: None,
        labels: label_names(row, labels),
        start_date: None,
        target_date: None,
        updated_at: iso(row, "updatedAt").unwrap_or_default(),
    };
    match entity {
        ViewEntity::Issue => {
            item.key = text(row, "key");
            item.title = text(row, "title").unwrap_or_default();
            item.kind = text(row, "kind");
            item.assignee = name_of(names, RefKind::User, row.get("assigneeId"));
            item.project = name_of(names, RefKind::Project, row.get("projectId"));
        }
        ViewEntity::Project => {
            item.title = text(row, "name").unwrap_or_default();
            item.health = text(row, "health");
            item.assignee = name_of(names, RefKind::User, row.get("leadId"));
            item.start_date = iso(row, "startDate");
            item.target_date = iso(row, "targetDate");
        }
    }
    item
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(value: &Value) -> Row {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn projects_only_display_fields() {
        let issue = row(&json!({
            "id": "in_1", "key": "BUG-1", "title": "Issue 1", "kind": "bug", "status": "todo",
            "priority": "high", "assigneeId": "u1", "projectId": null,
            "labels": ["lb_ui", "lb_gone"], "updatedAt": "2026-02-01T00:00:00.000Z",
            "body": "PRIVATE BODY", "reporterName": "Secret Reporter"
        }));
        let mut names = Names::new();
        names.insert(RefKind::User, HashMap::from([("u1".to_owned(), "Ada".to_owned())]));
        let labels = HashMap::from([("lb_ui".to_owned(), "UI".to_owned())]);
        let item = project(ViewEntity::Issue, &issue, &names, &labels);
        assert_eq!(
            serde_json::to_value(&item).unwrap(),
            json!({
                "id": "in_1", "key": "BUG-1", "title": "Issue 1", "kind": "bug", "status": "todo",
                "priority": "high", "assignee": "Ada", "labels": ["UI"],
                "updatedAt": "2026-02-01T00:00:00.000Z"
            })
        );
    }

    #[test]
    fn a_row_with_no_known_label_has_no_labels_property() {
        let issue = row(&json!({"id": "a", "labels": ["lb_gone"], "updatedAt": "x"}));
        let item = project(ViewEntity::Issue, &issue, &Names::new(), &HashMap::new());
        assert_eq!(item.labels, None);
        let none = row(&json!({"id": "a", "labels": [], "updatedAt": "x"}));
        assert_eq!(project(ViewEntity::Issue, &none, &Names::new(), &HashMap::new()).labels, None);
    }

    #[test]
    fn project_rows_show_dates_and_lead() {
        let project_row = row(&json!({
            "id": "pj_1", "name": "Apollo", "status": "in_progress", "priority": "urgent",
            "health": "at_risk", "leadId": "u1", "startDate": "2026-03-01T00:00:00.000Z",
            "targetDate": null, "updatedAt": "2026-02-01T00:00:00.000Z"
        }));
        let mut names = Names::new();
        names.insert(RefKind::User, HashMap::from([("u1".to_owned(), "Ada".to_owned())]));
        let item = project(ViewEntity::Project, &project_row, &names, &HashMap::new());
        assert_eq!(
            serde_json::to_value(&item).unwrap(),
            json!({
                "id": "pj_1", "title": "Apollo", "status": "in_progress", "priority": "urgent",
                "health": "at_risk", "assignee": "Ada", "startDate": "2026-03-01T00:00:00.000Z",
                "updatedAt": "2026-02-01T00:00:00.000Z"
            })
        );
    }

    #[test]
    fn group_labels_resolve_references() {
        let mut names = Names::new();
        names.insert(RefKind::Project, HashMap::from([("p1".to_owned(), "Apollo".to_owned())]));
        let label = |key: &str, group_by: Option<&str>| {
            group_label(ViewEntity::Issue, group_by, key, &names)
        };
        assert_eq!(label("p1", Some("projectId")), "Apollo");
        assert_eq!(label("p2", Some("projectId")), "p2");
        assert_eq!(label("", Some("projectId")), "");
        assert_eq!(label("todo", Some("status")), "todo");
        assert_eq!(label("todo", None), "todo");
    }

    #[test]
    fn the_scan_limit_is_enforced() {
        assert!(bounded(vec![0; PUBLIC_VIEW_SCAN_LIMIT]).is_ok());
        let error = bounded(vec![0; PUBLIC_VIEW_SCAN_LIMIT + 1]).unwrap_err();
        assert_eq!(error.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(error.to_string().contains("20,000-row evaluation limit"));
    }
}
