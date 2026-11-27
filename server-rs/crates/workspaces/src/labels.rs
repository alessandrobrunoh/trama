//! The workspace label catalog: `LabelsService` of `server/src/workspaces/labels.service.ts`.
//!
//! [`assign`] is what the issue and project services call to validate the `labels` of a record;
//! the rest backs `/api/w/{slug}/labels`.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseBackend, EntityTrait, QueryFilter, Set,
    Statement, TransactionTrait, Value as SqlValue,
};
use serde_json::{Value, json};
use trama_auth::WorkspaceContext;
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::js;
use trama_contracts::labels::{
    LABEL_NAME_MAX, LABEL_SWATCHES, LabelScope, StoredLabelScope, WorkspaceLabel, assign_label_ids,
    is_label_color, replace_label_id, resolve_label_catalog,
};
use trama_core::ids::uid;
use trama_core::{AppError, AppState};
use trama_entities::{saved_views, workspaces};
use trama_events::{Events, LiveChange};

use crate::schemas::{LabelPatch, NewLabel};
use crate::service::save_settings;

/// Most custom (non-template) labels a workspace can define.
const CUSTOM_MAX: usize = 100;

/// Tables whose records carry a `labels` list. (`repositories` went away with the
/// `RemoveObsoleteFeatures` migration; NestJS still named it here, which made a merge or delete
/// fail on a migrated database.)
const TABLES: [&str; 2] = ["issues", "projects"];

/// The catalog of a workspace row (`resolveLabelCatalog(ws.settings?.labels)`).
#[must_use]
pub fn catalog_of(ws: &workspaces::Model) -> Vec<WorkspaceLabel> {
    resolve_label_catalog(ws.settings.get("labels"))
}

/// Catalog ids for a record, de-duplicated (`assign`). `None` when the caller did not send
/// labels (pass `Some(&[])` for a `null` list). An id from another scope is rejected unless
/// `current` already has it; `scope` `None` (records without a label type) keeps only ids
/// already in `current`.
///
/// # Errors
///
/// 400 with the catalog's message (`Unknown label "x"`, `Label "x" does not apply to issues`, …).
pub async fn assign(
    db: &impl ConnectionTrait,
    workspace_id: &str,
    ids: Option<&[String]>,
    scope: Option<LabelScope>,
    current: Option<&[String]>,
) -> Result<Option<Vec<String>>, AppError> {
    let Some(ids) = ids else { return Ok(None) };
    let ws = workspaces::Entity::find_by_id(workspace_id.to_owned()).one(db).await?;
    let catalog = ws.as_ref().map(catalog_of).unwrap_or_default();
    assign_label_ids(&catalog, ids, scope, current.unwrap_or_default())
        .map(Some)
        .map_err(AppError::bad_request)
}

fn name_error() -> AppError {
    AppError::bad_request(format!("Label name must be 1-{LABEL_NAME_MAX} characters"))
}

fn color_error() -> AppError {
    AppError::bad_request("color must be #rrggbb")
}

fn next_color(catalog: &[WorkspaceLabel]) -> &'static str {
    LABEL_SWATCHES
        .iter()
        .find(|swatch| !catalog.iter().any(|label| label.color == **swatch))
        .copied()
        .unwrap_or(LABEL_SWATCHES[catalog.len() % LABEL_SWATCHES.len()])
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn unknown(id: &str) -> AppError {
    AppError::bad_request(format!("Unknown label \"{id}\""))
}

/// Adds a custom label (`create`).
///
/// # Errors
///
/// 400 for a bad name or color or too many labels, 409 for a duplicate name.
pub async fn create(
    state: &AppState,
    ctx: &WorkspaceContext,
    input: &NewLabel,
) -> Result<workspaces::Model, AppError> {
    let name = js::trim(&input.name);
    if name.is_empty() || js::len(name) > LABEL_NAME_MAX {
        return Err(name_error());
    }
    let mut catalog = catalog_of(&ctx.workspace);
    if catalog.iter().any(|label| same_name(&label.name, name)) {
        return Err(AppError::conflict(format!("Label \"{name}\" already exists")));
    }
    if catalog.iter().filter(|label| !label.template).count() >= CUSTOM_MAX {
        return Err(AppError::bad_request(format!(
            "A workspace can have at most {CUSTOM_MAX} custom labels"
        )));
    }
    let color =
        input.color.clone().unwrap_or_else(|| next_color(&catalog).to_owned()).to_lowercase();
    if !is_label_color(&color) {
        return Err(color_error());
    }
    catalog.push(WorkspaceLabel {
        id: uid("lb"),
        name: name.to_owned(),
        color,
        template: false,
        scope: input.scope.into(),
        archived: None,
    });
    save(state, ctx, &catalog).await
}

/// Renames, recolors, archives or re-scopes a label (`update`).
///
/// # Errors
///
/// 400 for an unknown label, a bad value or a template restriction, 409 for a duplicate name.
pub async fn update(
    state: &AppState,
    ctx: &WorkspaceContext,
    id: &str,
    patch: &LabelPatch,
) -> Result<workspaces::Model, AppError> {
    let catalog = catalog_of(&ctx.workspace);
    let current = catalog.iter().find(|label| label.id == id).ok_or_else(|| unknown(id))?;
    let mut name = current.name.clone();
    if let Some(requested) = &patch.name {
        let requested = js::trim(requested);
        if requested.is_empty() || js::len(requested) > LABEL_NAME_MAX {
            return Err(name_error());
        }
        if current.template && requested != current.name {
            return Err(AppError::bad_request("Template labels cannot be renamed"));
        }
        if catalog.iter().any(|label| label.id != id && same_name(&label.name, requested)) {
            return Err(AppError::conflict(format!("Label \"{requested}\" already exists")));
        }
        requested.clone_into(&mut name);
    }
    let mut color = current.color.clone();
    if let Some(requested) = &patch.color {
        color = requested.to_lowercase();
        if !is_label_color(&color) {
            return Err(color_error());
        }
    }
    if patch.archived == Some(true) && current.template {
        return Err(AppError::bad_request("Template labels cannot be archived"));
    }
    let mut scope = current.scope;
    if let Some(requested) = patch.scope
        && StoredLabelScope::from(requested) != current.scope
    {
        if current.template {
            return Err(AppError::bad_request("Template labels cannot change scope"));
        }
        scope = requested.into();
    }
    let archived = patch.archived.unwrap_or(current.archived == Some(true));
    let next: Vec<WorkspaceLabel> = catalog
        .iter()
        .map(|label| {
            if label.id != id {
                return label.clone();
            }
            WorkspaceLabel {
                id: id.to_owned(),
                name: name.clone(),
                color: color.clone(),
                template: label.template,
                scope: if label.template { StoredLabelScope::Issue } else { scope },
                archived: (archived && !label.template).then_some(true),
            }
        })
        .collect();
    save(state, ctx, &next).await
}

/// Moves every assignment of `id` onto `into`, then drops `id`. Templates cannot be merged away
/// (`merge`).
///
/// # Errors
///
/// 400 for unknown labels, a template, itself, another scope or an archived target.
pub async fn merge(
    state: &AppState,
    ctx: &WorkspaceContext,
    id: &str,
    into: &str,
) -> Result<workspaces::Model, AppError> {
    let catalog = catalog_of(&ctx.workspace);
    let current = catalog.iter().find(|label| label.id == id).ok_or_else(|| unknown(id))?;
    if current.template {
        return Err(AppError::bad_request("Template labels cannot be merged into another label"));
    }
    let target = catalog.iter().find(|label| label.id == into).ok_or_else(|| unknown(into))?;
    if target.id == id {
        return Err(AppError::bad_request("A label cannot be merged into itself"));
    }
    if target.scope != current.scope {
        return Err(AppError::bad_request(format!(
            "Label \"{}\" does not apply to {}s",
            target.name, current.scope
        )));
    }
    if target.archived == Some(true) {
        return Err(AppError::bad_request(format!(
            "Label \"{}\" is archived. Restore it before merging into it",
            target.name
        )));
    }
    drop_label(state, ctx, &catalog, id, Some(into)).await
}

/// Deletes a custom label everywhere (`remove`).
///
/// # Errors
///
/// 400 for an unknown label or a template.
pub async fn remove(
    state: &AppState,
    ctx: &WorkspaceContext,
    id: &str,
) -> Result<workspaces::Model, AppError> {
    let catalog = catalog_of(&ctx.workspace);
    let current = catalog.iter().find(|label| label.id == id).ok_or_else(|| unknown(id))?;
    if current.template {
        return Err(AppError::bad_request("Template labels cannot be removed"));
    }
    drop_label(state, ctx, &catalog, id, None).await
}

/// Replaces `id` by `into` (or removes it) on every record and saved view, then takes it out of
/// the catalog. One transaction.
async fn drop_label(
    state: &AppState,
    ctx: &WorkspaceContext,
    catalog: &[WorkspaceLabel],
    id: &str,
    into: Option<&str>,
) -> Result<workspaces::Model, AppError> {
    let ws = &ctx.workspace;
    let txn = state.db.begin().await?;
    let rewritten = async {
        for table in TABLES {
            replace_in_table(&txn, table, &ws.id, id, into).await?;
        }
        let views = saved_views::Entity::find()
            .filter(saved_views::Column::WorkspaceId.eq(ws.id.clone()))
            .all(&txn)
            .await?;
        for view in views {
            if let Some(filters) = rewrite_filters(&view.filters, id, into) {
                let mut row: saved_views::ActiveModel = view.into();
                row.filters = Set(filters);
                row.update(&txn).await?;
            }
        }
        let remaining: Vec<&WorkspaceLabel> =
            catalog.iter().filter(|label| label.id != id).collect();
        let mut settings = ws.settings.as_object().cloned().unwrap_or_default();
        settings.insert("labels".into(), json!(remaining));
        save_settings(&txn, ws, settings).await
    }
    .await;
    let saved = match rewritten {
        Ok(saved) => {
            txn.commit().await?;
            saved
        }
        Err(err) => {
            let _ = txn.rollback().await;
            return Err(err);
        }
    };
    Events::of(state)
        .publish(&ws.id, LiveChange::updated(LiveEventEntity::Workspace, ws.id.clone()));
    Ok(saved)
}

async fn save(
    state: &AppState,
    ctx: &WorkspaceContext,
    labels: &[WorkspaceLabel],
) -> Result<workspaces::Model, AppError> {
    let ws = &ctx.workspace;
    let mut settings = ws.settings.as_object().cloned().unwrap_or_default();
    settings.insert("labels".into(), json!(labels));
    let saved = save_settings(&state.db, ws, settings).await?;
    Events::of(state)
        .publish(&ws.id, LiveChange::updated(LiveEventEntity::Workspace, ws.id.clone()));
    Ok(saved)
}

/// Rewrites the `labels` array of the records that carry `from`: swap for `into` (no duplicates,
/// order kept) or remove.
async fn replace_in_table(
    db: &impl ConnectionTrait,
    table: &str,
    workspace_id: &str,
    from: &str,
    into: Option<&str>,
) -> Result<(), sea_orm::DbErr> {
    let sql = format!(
        r#"UPDATE "{table}" SET "labels" = COALESCE((
       SELECT jsonb_agg(d.x ORDER BY d.ord) FROM (
         SELECT DISTINCT ON (r.x) r.x, r.ord FROM (
           SELECT CASE WHEN e.v = $2 THEN $3 ELSE e.v END AS x, e.ord
           FROM jsonb_array_elements_text("labels") WITH ORDINALITY AS e(v, ord)
         ) r WHERE r.x IS NOT NULL ORDER BY r.x, r.ord
       ) d
     ), '[]'::jsonb)
     WHERE "workspaceId" = $1 AND "labels" @> jsonb_build_array($2::text)"#
    );
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        [
            SqlValue::from(workspace_id),
            SqlValue::from(from),
            SqlValue::from(into.map(ToOwned::to_owned)),
        ],
    ))
    .await?;
    Ok(())
}

/// Saved-view filters after label `from` is merged into `into`, or removed when `into` is
/// `None` (`rewriteLabelFilters`, over the stored JSON so unknown keys survive). Only `labels`
/// filters change; a filter left with no value is dropped. `None` when nothing changed.
fn rewrite_filters(filters: &Value, from: &str, into: Option<&str>) -> Option<Value> {
    let list = filters.as_array()?;
    let touches = |filter: &Value| {
        filter.get("field").and_then(Value::as_str) == Some("labels")
            && match filter.get("value") {
                Some(Value::Array(values)) => values.iter().any(|v| v.as_str() == Some(from)),
                Some(Value::String(value)) => value == from,
                _ => false,
            }
    };
    if !list.iter().any(touches) {
        return None;
    }
    let mut out = Vec::new();
    for filter in list {
        if !touches(filter) {
            out.push(filter.clone());
            continue;
        }
        let (ids, many): (Vec<String>, bool) = match filter.get("value") {
            Some(Value::Array(values)) => {
                (values.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect(), true)
            }
            Some(Value::String(value)) => (vec![value.clone()], false),
            _ => continue,
        };
        let replaced = replace_label_id(&ids, from, into);
        let Some(first) = replaced.first() else { continue };
        let value = if many { json!(replaced) } else { json!(first) };
        let mut next = filter.clone();
        next["value"] = value;
        out.push(next);
    }
    Some(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_only_the_label_filters_that_name_the_label() {
        let filters = json!([
            { "field": "labels", "op": "in", "value": ["lb_a", "lb_b"] },
            { "field": "status", "op": "is", "value": "todo" },
        ]);
        assert_eq!(
            rewrite_filters(&filters, "lb_a", Some("lb_b")),
            Some(json!([
                { "field": "labels", "op": "in", "value": ["lb_b"] },
                { "field": "status", "op": "is", "value": "todo" },
            ]))
        );
        assert_eq!(rewrite_filters(&filters, "lb_zzz", None), None);
        assert_eq!(rewrite_filters(&json!(null), "lb_a", None), None);
        // a filter left without a value is dropped, a single value stays single
        let single = json!([{ "field": "labels", "op": "is", "value": "lb_a", "extra": 1 }]);
        assert_eq!(rewrite_filters(&single, "lb_a", None), Some(json!([])));
        assert_eq!(
            rewrite_filters(&single, "lb_a", Some("lb_b")),
            Some(json!([{ "field": "labels", "op": "is", "value": "lb_b", "extra": 1 }]))
        );
    }

    #[test]
    fn picks_the_next_free_swatch() {
        let label = |color: &str| WorkspaceLabel {
            id: "lb_x".into(),
            name: "x".into(),
            color: color.into(),
            template: false,
            scope: StoredLabelScope::Issue,
            archived: None,
        };
        assert_eq!(next_color(&[]), LABEL_SWATCHES[0]);
        assert_eq!(next_color(&[label(LABEL_SWATCHES[0])]), LABEL_SWATCHES[1]);
        let all: Vec<WorkspaceLabel> = LABEL_SWATCHES.iter().map(|c| label(c)).collect();
        assert_eq!(next_color(&all), LABEL_SWATCHES[0]);
    }
}
