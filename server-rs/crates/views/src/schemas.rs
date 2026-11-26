//! Request bodies of the views routes (`views.controller.ts` DTOs) and what they become once
//! validated. Responses are `trama_contracts::views::{SavedView, PublicView}`.

use serde::Deserialize;
use serde_json::Value;
use trama_contracts::js::len as js_len;
use trama_contracts::views::{
    FilterValue, ShareGrant, ShareLevel, ShareVisibility, SortDirection, ViewEntity, ViewFilter,
    ViewFilterOp, ViewLayout, ViewSort,
};
use trama_core::AppError;
use trama_core::validation::{Checks, Patch};
use utoipa::ToSchema;

use crate::rules::{VIEW_ENTITIES, VIEW_LAYOUTS};
use crate::service::{MAX_GRANTS, NewView, SharingInput, ViewPatch};

/// Filter operators a saved view accepts.
const OPS: [ViewFilterOp; 9] = [
    ViewFilterOp::Is,
    ViewFilterOp::IsNot,
    ViewFilterOp::In,
    ViewFilterOp::NotIn,
    ViewFilterOp::Contains,
    ViewFilterOp::Before,
    ViewFilterOp::After,
    ViewFilterOp::Gte,
    ViewFilterOp::Lte,
];

const VISIBILITIES: [&str; 3] = ["private", "workspace", "link"];
const LEVELS: [&str; 2] = ["view", "edit"];
const DIRECTIONS: [&str; 2] = ["asc", "desc"];

/// One filter of a view.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct FilterDto {
    /// Filtered field (at most 100 characters).
    #[serde(default)]
    pub field: String,
    /// `is`, `is_not`, `in`, `not_in`, `contains`, `before`, `after`, `gte` or `lte`.
    #[serde(default)]
    pub op: String,
    /// A string or a list of strings.
    #[serde(default)]
    #[schema(value_type = FilterValue)]
    pub value: Value,
}

/// Sort of a view.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct SortDto {
    /// Sorted field.
    #[serde(default)]
    pub field: String,
    /// `asc` or `desc`.
    #[serde(default)]
    pub direction: String,
}

/// One invited person.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GrantDto {
    /// A member of the workspace (1 to 100 characters).
    #[serde(default)]
    pub user_id: String,
    /// `view` or `edit`.
    #[serde(default)]
    pub level: String,
}

/// Who may open a view.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct SharingDto {
    /// `private`, `workspace` or `link`.
    pub visibility: Option<String>,
    /// Replaces the whole list of invited people (workspace members only, at most 100).
    pub grants: Option<Vec<GrantDto>>,
}

/// `POST /api/w/{slug}/views/{id}/invite`.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct InviteViewDto {
    /// Addresses of existing workspace members (1 to 100).
    #[serde(default)]
    pub emails: Vec<String>,
    /// `view` (default) or `edit`.
    pub level: Option<String>,
}

/// `POST /api/w/{slug}/views`.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateViewDto {
    /// Display name (1 to 100 characters).
    #[serde(default)]
    pub name: String,
    /// `issue` or `project`.
    #[serde(default)]
    pub entity: String,
    /// Filters.
    pub filters: Option<Vec<FilterDto>>,
    /// Sort.
    pub sort: Option<SortDto>,
    /// Grouping field.
    pub group_by: Option<String>,
    /// `list` (default), `board` or `timeline` (project views only).
    pub layout: Option<String>,
    /// Legacy flag: `true` = visible to the workspace. Prefer `sharing`.
    pub shared: Option<bool>,
    /// Visibility and invited people.
    pub sharing: Option<SharingDto>,
}

/// `PATCH /api/w/{slug}/views/{id}`. `sort` and `groupBy` accept `null` to clear them; the
/// other fields refuse it.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateViewDto {
    /// New name.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub name: Patch<String>,
    /// New entity.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub entity: Patch<String>,
    /// New filters (replaces the list).
    #[serde(default)]
    #[schema(value_type = Option<Vec<FilterDto>>)]
    pub filters: Patch<Vec<FilterDto>>,
    /// New sort; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<SortDto>)]
    pub sort: Patch<SortDto>,
    /// New grouping field; `null` clears it.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub group_by: Patch<String>,
    /// New layout.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub layout: Patch<String>,
    /// Legacy flag. Prefer `sharing`.
    #[serde(default)]
    #[schema(value_type = Option<bool>)]
    pub shared: Patch<bool>,
    /// Visibility and invited people.
    #[serde(default)]
    #[schema(value_type = Option<SharingDto>)]
    pub sharing: Patch<SharingDto>,
}

/// `@IsFilterValue()`: a string or a list of strings, so the evaluators never meet anything
/// else.
fn is_filter_value(value: &Value) -> bool {
    match value {
        Value::String(s) => js_len(s) <= 500,
        Value::Array(items) => {
            items.len() <= 200
                && items.iter().all(|item| item.as_str().is_some_and(|s| js_len(s) <= 500))
        }
        _ => false,
    }
}

fn check_filter(c: &mut Checks, prefix: &str, filter: &FilterDto) {
    let field = format!("{prefix}.field");
    c.max_length(&field, &filter.field, 100);
    let ops: Vec<&str> = OPS.iter().map(|op| op.as_str()).collect();
    c.one_of(&format!("{prefix}.op"), &filter.op, &ops);
    c.check(
        is_filter_value(&filter.value),
        format!("{prefix}.value must be a string or an array of strings"),
    );
}

fn check_filters(c: &mut Checks, filters: &[FilterDto]) {
    for (i, filter) in filters.iter().enumerate() {
        check_filter(c, &format!("filters.{i}"), filter);
    }
}

fn check_sort(c: &mut Checks, sort: &SortDto) {
    c.one_of("sort.direction", &sort.direction, &DIRECTIONS);
}

fn check_sharing(c: &mut Checks, sharing: &SharingDto) {
    if let Some(visibility) = &sharing.visibility {
        c.one_of("sharing.visibility", visibility, &VISIBILITIES);
    }
    if let Some(grants) = &sharing.grants {
        c.max_items("sharing.grants", grants.len(), MAX_GRANTS);
        for (i, grant) in grants.iter().enumerate() {
            let prefix = format!("sharing.grants.{i}");
            c.min_length(&format!("{prefix}.userId"), &grant.user_id, 1)
                .max_length(&format!("{prefix}.userId"), &grant.user_id, 100)
                .one_of(&format!("{prefix}.level"), &grant.level, &LEVELS);
        }
    }
}

fn check_entity(c: &mut Checks, entity: &str) {
    let allowed: Vec<&str> = VIEW_ENTITIES.iter().map(|e| e.as_str()).collect();
    c.one_of("entity", entity, &allowed);
}

fn check_layout(c: &mut Checks, layout: &str) {
    let allowed: Vec<&str> = VIEW_LAYOUTS.iter().map(|l| l.as_str()).collect();
    c.one_of("layout", layout, &allowed);
}

fn check_name(c: &mut Checks, name: &str) {
    c.min_length("name", name, 1).max_length("name", name, 100);
}

fn to_filters(filters: Vec<FilterDto>) -> Vec<ViewFilter> {
    filters
        .into_iter()
        .filter_map(|f| {
            let value = match f.value {
                Value::String(s) => FilterValue::One(s),
                Value::Array(items) => FilterValue::Many(
                    items.into_iter().filter_map(|v| v.as_str().map(ToOwned::to_owned)).collect(),
                ),
                _ => return None,
            };
            Some(ViewFilter { field: f.field, op: ViewFilterOp::parse(&f.op)?, value })
        })
        .collect()
}

fn to_sort(sort: SortDto) -> Option<ViewSort> {
    Some(ViewSort { field: sort.field, direction: SortDirection::parse(&sort.direction)? })
}

fn to_sharing(sharing: SharingDto) -> SharingInput {
    SharingInput {
        visibility: sharing.visibility.as_deref().and_then(ShareVisibility::parse),
        grants: sharing.grants.map(|grants| {
            grants
                .into_iter()
                .filter_map(|g| {
                    Some(ShareGrant { user_id: g.user_id, level: ShareLevel::parse(&g.level)? })
                })
                .collect()
        }),
    }
}

impl CreateViewDto {
    /// The class-validator rules of `CreateViewDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<NewView, AppError> {
        let mut c = Checks::new();
        check_name(&mut c, &self.name);
        check_entity(&mut c, &self.entity);
        if let Some(filters) = &self.filters {
            check_filters(&mut c, filters);
        }
        if let Some(sort) = &self.sort {
            check_sort(&mut c, sort);
        }
        if let Some(layout) = &self.layout {
            check_layout(&mut c, layout);
        }
        if let Some(sharing) = &self.sharing {
            check_sharing(&mut c, sharing);
        }
        c.finish()?;
        let entity = ViewEntity::parse(&self.entity)
            .ok_or_else(|| AppError::bad_request("entity is not valid"))?;
        Ok(NewView {
            name: self.name,
            entity,
            filters: self.filters.map(to_filters).unwrap_or_default(),
            sort: self.sort.and_then(to_sort),
            group_by: self.group_by,
            layout: self.layout.as_deref().and_then(ViewLayout::parse),
            shared: self.shared,
            sharing: self.sharing.map(to_sharing),
        })
    }
}

impl UpdateViewDto {
    /// The class-validator rules of `UpdateViewDto`: `@OptionalNotNull()` fields refuse `null`,
    /// `@Clearable()` ones accept it.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<ViewPatch, AppError> {
        let mut c = Checks::new();
        match &self.name {
            Patch::Missing => {}
            Patch::Null => {
                c.check(false, "name must be a string");
            }
            Patch::Value(name) => check_name(&mut c, name),
        }
        match &self.entity {
            Patch::Missing => {}
            Patch::Null => check_entity(&mut c, ""),
            Patch::Value(entity) => check_entity(&mut c, entity),
        }
        match &self.filters {
            Patch::Missing => {}
            Patch::Null => {
                c.check(false, "filters must be an array");
            }
            Patch::Value(filters) => check_filters(&mut c, filters),
        }
        if let Patch::Value(sort) = &self.sort {
            check_sort(&mut c, sort);
        }
        match &self.layout {
            Patch::Missing => {}
            Patch::Null => check_layout(&mut c, ""),
            Patch::Value(layout) => check_layout(&mut c, layout),
        }
        if self.shared == Patch::Null {
            c.check(false, "shared must be a boolean value");
        }
        match &self.sharing {
            Patch::Missing => {}
            Patch::Null => {
                c.check(false, "sharing must be an object");
            }
            Patch::Value(sharing) => check_sharing(&mut c, sharing),
        }
        c.finish()?;
        Ok(ViewPatch {
            name: self.name.into_option().flatten(),
            entity: self.entity.as_value().and_then(|e| ViewEntity::parse(e)),
            filters: self.filters.into_option().flatten().map(to_filters),
            sort: self.sort.into_option().map(|sort| sort.and_then(to_sort)),
            group_by: self.group_by.into_option(),
            layout: self.layout.as_value().and_then(|l| ViewLayout::parse(l)),
            shared: self.shared.into_option().flatten(),
            sharing: self.sharing.into_option().flatten().map(to_sharing),
        })
    }
}

impl InviteViewDto {
    /// The class-validator rules of `InviteViewDto`.
    ///
    /// # Errors
    ///
    /// 400 listing every failed rule.
    pub fn validate(self) -> Result<(Vec<String>, Option<ShareLevel>), AppError> {
        let mut c = Checks::new();
        c.check(!self.emails.is_empty(), "emails must contain at least 1 elements").max_items(
            "emails",
            self.emails.len(),
            MAX_GRANTS,
        );
        for email in &self.emails {
            c.email("each value in emails", email);
        }
        if let Some(level) = &self.level {
            c.one_of("level", level, &LEVELS);
        }
        c.finish()?;
        Ok((self.emails, self.level.as_deref().and_then(ShareLevel::parse)))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn create(body: &Value) -> Result<NewView, AppError> {
        serde_json::from_value::<CreateViewDto>(body.clone()).unwrap().validate()
    }

    fn update(body: &Value) -> Result<ViewPatch, AppError> {
        serde_json::from_value::<UpdateViewDto>(body.clone()).unwrap().validate()
    }

    fn messages(error: &AppError) -> String {
        error.to_string()
    }

    #[test]
    fn validates_a_project_timeline_view() {
        let view =
            create(&json!({"name": "Roadmap", "entity": "project", "layout": "timeline"})).unwrap();
        assert_eq!(view.entity, ViewEntity::Project);
        assert_eq!(view.layout, Some(ViewLayout::Timeline));
        let err = create(&json!({"name": "Q4", "entity": "workstream", "layout": "timeline"}))
            .unwrap_err();
        assert!(
            messages(&err).contains("entity must be one of the following values: issue, project")
        );
    }

    #[test]
    fn rejects_unknown_entities_and_layouts() {
        assert!(
            messages(&create(&json!({"name": "x", "entity": "execution"})).unwrap_err())
                .contains("entity")
        );
        assert!(
            messages(
                &create(&json!({"name": "x", "entity": "issue", "layout": "gantt"})).unwrap_err()
            )
            .contains("layout")
        );
        assert!(update(&json!({"entity": "project", "layout": "timeline"})).is_ok());
        assert!(messages(&update(&json!({"layout": "calendar"})).unwrap_err()).contains("layout"));
    }

    #[test]
    fn names_are_one_to_a_hundred_characters() {
        assert!(create(&json!({"name": "", "entity": "issue"})).is_err());
        assert!(create(&json!({"name": "a".repeat(101), "entity": "issue"})).is_err());
        assert!(create(&json!({"name": "a".repeat(100), "entity": "issue"})).is_ok());
        assert!(update(&json!({"name": null})).is_err());
        assert!(update(&json!({"name": ""})).is_err());
    }

    fn filters_of(value: &Value) -> Result<NewView, AppError> {
        create(&json!({
            "name": "v", "entity": "issue",
            "filters": [{"field": "title", "op": "contains", "value": value}]
        }))
    }

    #[test]
    fn filter_values_are_a_string_or_a_list_of_strings() {
        for ok in [json!("bug"), json!(["a", "b"]), json!("")] {
            assert!(filters_of(&ok).is_ok(), "{ok}");
        }
        // each would crash the public link evaluator
        for bad in [json!(5), Value::Null, json!({"a": 1}), json!([1, 2]), json!(true)] {
            let err = filters_of(&bad).unwrap_err();
            assert!(
                messages(&err).contains("filters.0.value must be a string or an array of strings"),
                "{bad}"
            );
        }
        assert!(filters_of(&json!("x".repeat(501))).is_err());
        assert!(filters_of(&json!(vec!["x"; 201])).is_err());
    }

    #[test]
    fn filter_operators_and_fields_are_checked() {
        let err = create(&json!({
            "name": "v", "entity": "issue",
            "filters": [{"field": "f".repeat(101), "op": "all", "value": "x"}]
        }))
        .unwrap_err();
        let text = messages(&err);
        assert!(text.contains("filters.0.field must be shorter than or equal to 100 characters"));
        assert!(text.contains("filters.0.op must be one of the following values: is, is_not"));
    }

    #[test]
    fn sort_needs_a_direction() {
        assert!(create(&json!({"name": "v", "entity": "issue", "sort": {"field": "title", "direction": "up"}})).is_err());
        let ok = create(&json!({"name": "v", "entity": "issue", "sort": {"field": "title", "direction": "desc"}})).unwrap();
        assert_eq!(ok.sort.unwrap().direction, SortDirection::Desc);
        // `null` clears the sort on update, the other fields refuse it
        let patch = update(&json!({"sort": null, "groupBy": null})).unwrap();
        assert_eq!(patch.sort, Some(None));
        assert_eq!(patch.group_by, Some(None));
        for field in ["entity", "filters", "layout", "shared", "sharing"] {
            assert!(update(&json!({ field: null })).is_err(), "{field}");
        }
    }

    #[test]
    fn accepts_a_visibility_and_grants_rejects_unknown_values() {
        assert!(
            create(&json!({"name": "x", "entity": "issue", "sharing": {"visibility": "link"}}))
                .is_ok()
        );
        assert!(update(&json!({"sharing": {"visibility": "workspace", "grants": [{"userId": "u2", "level": "edit"}]}})).is_ok());
        assert!(update(&json!({"sharing": {"visibility": "public"}})).is_err());
        assert!(
            update(&json!({"sharing": {"grants": [{"userId": "u2", "level": "owner"}]}})).is_err()
        );
        assert!(
            update(&json!({"sharing": {"grants": [{"userId": "", "level": "view"}]}})).is_err()
        );
        let too_many: Vec<Value> =
            (0..=MAX_GRANTS).map(|i| json!({"userId": format!("u{i}"), "level": "view"})).collect();
        assert!(update(&json!({"sharing": {"grants": too_many}})).is_err());
    }

    #[test]
    fn validates_invitation_emails() {
        let invite =
            |body: Value| serde_json::from_value::<InviteViewDto>(body).unwrap().validate();
        assert!(invite(json!({"emails": ["a@example.com", "b@example.com"]})).is_ok());
        assert!(invite(json!({"emails": []})).is_err());
        assert!(invite(json!({})).is_err());
        assert!(invite(json!({"emails": ["not-an-email"]})).is_err());
        assert!(invite(json!({"emails": ["a@example.com"], "level": "owner"})).is_err());
        let (_, level) = invite(json!({"emails": ["a@example.com"], "level": "edit"})).unwrap();
        assert_eq!(level, Some(ShareLevel::Edit));
        let too_many: Vec<String> = (0..=MAX_GRANTS).map(|i| format!("u{i}@example.com")).collect();
        assert!(invite(json!({"emails": too_many})).is_err());
    }
}
