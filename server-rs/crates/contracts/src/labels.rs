//! Workspace labels: the catalog stored in settings, assigning ids to records, adopting free
//! text, and rewriting saved-view filters when a label is merged or deleted
//! (`server/src/labels/label-filters.ts`).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;
use utoipa::ToSchema;

use crate::common::Id;
use crate::views::{FilterValue, ViewFilter};

string_enum! {
    /// Which records a label can be added to.
    pub enum LabelScope {
        Issue = "issue",
        Project = "project",
    }
}

/// `LABEL_SCOPES`.
pub const LABEL_SCOPES: &[LabelScope] = LabelScope::ALL;

string_enum! {
    /// A stored label's scope: former Workstream-scoped labels are preserved, but are not
    /// assignable to active records.
    pub enum StoredLabelScope {
        Issue = "issue",
        Project = "project",
        Workstream = "workstream",
    }
}

impl From<LabelScope> for StoredLabelScope {
    fn from(value: LabelScope) -> Self {
        match value {
            LabelScope::Issue => Self::Issue,
            LabelScope::Project => Self::Project,
        }
    }
}

/// Missing or unknown scope is `issue`.
fn as_label_scope(value: Option<&Value>) -> StoredLabelScope {
    value
        .and_then(Value::as_str)
        .and_then(StoredLabelScope::parse)
        .unwrap_or(StoredLabelScope::Issue)
}

/// A label defined once for the workspace and assigned by id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceLabel {
    /// Label id (`lb_…`).
    pub id: Id,
    /// Display name.
    pub name: String,
    /// `#rrggbb`.
    pub color: String,
    /// Built-in labels are managed by the application rather than the workspace.
    pub template: bool,
    /// Exactly one record type.
    pub scope: StoredLabelScope,
    /// Archived labels stay on what already carries them but are no longer offered. Only ever
    /// `true`; an active label omits the field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

/// A built-in label (`LABEL_TEMPLATES` entry).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LabelTemplate {
    /// Label id.
    pub id: &'static str,
    /// Display name.
    pub name: &'static str,
    /// Default color.
    pub color: &'static str,
}

/// No type labels are pre-created; workspace labels are user-defined.
pub const LABEL_TEMPLATES: &[LabelTemplate] = &[];

/// Swatches offered when creating or recoloring a label.
pub const LABEL_SWATCHES: [&str; 12] = [
    "#e11d48", "#f97316", "#eab308", "#84cc16", "#16a34a", "#14b8a6", "#0891b2", "#2563eb",
    "#6366f1", "#7c3aed", "#db2777", "#64748b",
];

/// Longest label name.
pub const LABEL_NAME_MAX: usize = 40;
/// Most labels one record can carry.
pub const LABEL_ASSIGN_MAX: usize = 20;

/// `#rrggbb` in lower case (`LABEL_COLOR`).
#[must_use]
pub fn is_label_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[0] == b'#'
        && bytes[1..].iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

/// Configured built-in labels first, then the valid stored workspace labels (the `labels` array
/// of stored settings; anything else is an empty catalog).
#[must_use]
pub fn resolve_label_catalog(stored: Option<&Value>) -> Vec<WorkspaceLabel> {
    let incoming: &[Value] = match stored {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let field = |item: &'_ Value, key: &str| item.get(key).cloned();
    let templates: Vec<WorkspaceLabel> = LABEL_TEMPLATES
        .iter()
        .map(|template| {
            let saved = incoming.iter().rev().find(|item| {
                crate::js::truthy(item)
                    && item.get("id").and_then(Value::as_str) == Some(template.id)
            });
            let color = saved
                .and_then(|s| s.get("color"))
                .and_then(Value::as_str)
                .filter(|c| is_label_color(c))
                .unwrap_or(template.color);
            WorkspaceLabel {
                id: template.id.to_owned(),
                name: template.name.to_owned(),
                color: color.to_owned(),
                template: true,
                scope: StoredLabelScope::Issue,
                archived: None,
            }
        })
        .collect();
    let mut custom: Vec<WorkspaceLabel> = Vec::new();
    for item in incoming {
        if !matches!(item, Value::Object(_)) {
            continue;
        }
        let Some(id) = item.get("id").and_then(Value::as_str) else { continue };
        if field(item, "template").is_some_and(|v| crate::js::truthy(&v))
            || templates.iter().any(|t| t.id == id)
            || custom.iter().any(|l| l.id == id)
        {
            continue;
        }
        let name = item.get("name").and_then(Value::as_str).map_or("", crate::js::trim);
        let color = item.get("color").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() || crate::js::len(name) > LABEL_NAME_MAX || !is_label_color(color) {
            continue;
        }
        custom.push(WorkspaceLabel {
            id: id.to_owned(),
            name: name.to_owned(),
            color: color.to_owned(),
            template: false,
            scope: as_label_scope(item.get("scope")),
            archived: (item.get("archived") == Some(&Value::Bool(true))).then_some(true),
        });
    }
    let mut out = templates;
    out.extend(custom);
    out
}

/// The ids of one record after `from` is merged into `into` (or removed when `into` is `None`).
/// Keeps the order, never lists an id twice.
#[must_use]
pub fn replace_label_id(ids: &[String], from: &str, into: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let next = if id == from { into } else { Some(id.as_str()) };
        if let Some(next) = next.filter(|n| !n.is_empty())
            && !out.iter().any(|o| o == next)
        {
            out.push(next.to_owned());
        }
    }
    out
}

/// Unique catalog ids, in order.
///
/// `scope` `None` means the record is not a scoped type: only ids already in `current` are kept.
/// Ids already stored stay, even when they no longer match.
///
/// # Errors
///
/// The message NestJS sends as a 400 (`LabelsService` wraps it in `BadRequestException`): an
/// unknown id, a label of another scope that is not already on the record, or more than
/// [`LABEL_ASSIGN_MAX`] labels.
pub fn assign_label_ids(
    catalog: &[WorkspaceLabel],
    ids: &[String],
    scope: Option<LabelScope>,
    current: &[String],
) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let Some(label) = catalog.iter().find(|l| &l.id == id) else {
            return Err(format!("Unknown label \"{id}\""));
        };
        let matches = scope.is_some_and(|s| label.scope == StoredLabelScope::from(s));
        if !matches && !current.contains(id) {
            let target = scope.map_or_else(|| "this record".to_owned(), |s| format!("{s}s"));
            return Err(format!("Label \"{id}\" does not apply to {target}"));
        }
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    if out.len() > LABEL_ASSIGN_MAX {
        return Err(format!("A record can have at most {LABEL_ASSIGN_MAX} labels"));
    }
    Ok(out)
}

/// One group of free-text labels for [`adopt_free_text_labels`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FreeTextLabels {
    /// Scope new labels of this group get.
    pub scope: StoredLabelScope,
    /// Names or ids as typed.
    pub labels: Vec<String>,
}

/// Result of [`adopt_free_text_labels`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdoptedLabels {
    /// The catalog with the new labels appended.
    pub catalog: Vec<WorkspaceLabel>,
    /// Each group's labels as catalog ids, in the same order, without duplicates.
    pub groups: Vec<Vec<String>>,
    /// Trimmed input text → id.
    pub lookup: HashMap<String, String>,
}

/// Turns free-text label lists into catalog ids. A string that is already a catalog id is kept;
/// a name that matches a label (case-insensitive) reuses it; anything else becomes a custom label
/// with that group's scope.
#[must_use]
pub fn adopt_free_text_labels(stored: Option<&Value>, groups: &[FreeTextLabels]) -> AdoptedLabels {
    let mut catalog = resolve_label_catalog(stored);
    let mut by_name: HashMap<String, String> = HashMap::new();
    for label in &catalog {
        by_name.insert(label.name.to_lowercase(), label.id.clone());
    }
    let mut taken: HashSet<String> = catalog.iter().map(|l| l.id.clone()).collect();
    let mut lookup: HashMap<String, String> = HashMap::new();
    let mut color_at = catalog.iter().filter(|l| !l.template).count();
    let mut map_one = |raw: &str, scope: StoredLabelScope| -> String {
        let name = crate::js::trim(raw);
        if name.is_empty() {
            return String::new();
        }
        let known = lookup.get(name).cloned().or_else(|| {
            if taken.contains(name) {
                Some(name.to_owned())
            } else {
                by_name.get(&name.to_lowercase()).cloned()
            }
        });
        if let Some(known) = known {
            lookup.insert(name.to_owned(), known.clone());
            return known;
        }
        let slug: String = name
            .to_lowercase()
            .nfkd()
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            .take(20)
            .collect();
        let slug = if slug.is_empty() { "label".to_owned() } else { slug };
        let mut id = format!("lb_{slug}");
        let mut n = 2;
        while taken.contains(&id) {
            id = format!("lb_{slug}{n}");
            n += 1;
        }
        let color = LABEL_SWATCHES[color_at % LABEL_SWATCHES.len()];
        color_at += 1;
        catalog.push(WorkspaceLabel {
            id: id.clone(),
            name: crate::js::truncate(name, LABEL_NAME_MAX).to_owned(),
            color: color.to_owned(),
            template: false,
            scope,
            archived: None,
        });
        taken.insert(id.clone());
        by_name.insert(name.to_lowercase(), id.clone());
        lookup.insert(name.to_owned(), id.clone());
        id
    };
    let rewritten: Vec<Vec<String>> = groups
        .iter()
        .map(|group| {
            let mut ids: Vec<String> = Vec::new();
            for raw in &group.labels {
                let id = map_one(raw, group.scope);
                if !id.is_empty() && !ids.contains(&id) {
                    ids.push(id);
                }
            }
            ids
        })
        .collect();
    AdoptedLabels { catalog, groups: rewritten, lookup }
}

/// Saved-view filters after label `from` is merged into `into`, or removed when `into` is
/// `None`. Only `labels` filters change; a filter left with no value is dropped. Returns `None`
/// when nothing changed.
#[must_use]
pub fn rewrite_label_filters(
    filters: &[ViewFilter],
    from: &str,
    into: Option<&str>,
) -> Option<Vec<ViewFilter>> {
    let touches = |filter: &ViewFilter| {
        filter.field == "labels"
            && match &filter.value {
                FilterValue::Many(values) => values.iter().any(|v| v == from),
                FilterValue::One(value) => value == from,
            }
    };
    if !filters.iter().any(touches) {
        return None;
    }
    let mut out = Vec::new();
    for filter in filters {
        if !touches(filter) {
            out.push(filter.clone());
            continue;
        }
        let (list, many) = match &filter.value {
            FilterValue::Many(values) => (values.clone(), true),
            FilterValue::One(value) => (vec![value.clone()], false),
        };
        let mut value = replace_label_id(&list, from, into);
        if value.is_empty() {
            continue;
        }
        let value = if many { FilterValue::Many(value) } else { FilterValue::One(value.remove(0)) };
        out.push(ViewFilter { value, ..filter.clone() });
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::views::ViewFilterOp;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    // labels/catalog.spec.ts
    #[test]
    fn starts_without_type_labels_and_keeps_a_legacy_type_label_as_a_custom_label() {
        assert_eq!(resolve_label_catalog(None), Vec::new());
        let catalog = resolve_label_catalog(Some(&json!([
            { "id": "lb_bug", "name": "Bug", "color": "#111111", "template": false, "scope": "issue" },
            { "id": "lb_custom", "name": "Auth", "color": "#334455", "template": false, "scope": "issue" },
            { "id": "lb_road", "name": "Roadmap", "color": "#0891b2", "template": false, "scope": "project" },
            { "id": "lb_bad", "name": "Nope", "color": "#0891b2", "template": false, "scope": "elsewhere" },
        ])));
        assert_eq!(
            catalog.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
            ["Bug", "Auth", "Roadmap", "Nope"]
        );
        let bug = catalog.iter().find(|l| l.id == "lb_bug").unwrap();
        assert_eq!(
            (bug.color.as_str(), bug.template, bug.scope, bug.name.as_str()),
            ("#111111", false, StoredLabelScope::Issue, "Bug")
        );
        assert_eq!(catalog[1].scope, StoredLabelScope::Issue);
        assert_eq!(catalog[2].scope, StoredLabelScope::Project);
        assert_eq!(catalog[3].scope, StoredLabelScope::Issue);
    }

    #[test]
    fn turns_free_text_into_custom_ids_including_names_formerly_supplied_as_templates() {
        let out = adopt_free_text_labels(
            None,
            &[
                FreeTextLabels { scope: StoredLabelScope::Issue, labels: ids(&["Bug", "auth"]) },
                FreeTextLabels { scope: StoredLabelScope::Issue, labels: ids(&["auth", "auth"]) },
            ],
        );
        assert_eq!(out.groups[0][0], "lb_bug");
        assert_eq!(out.groups[1], vec![out.groups[0][1].clone()]);
        assert_eq!(out.lookup.get("auth"), Some(&out.groups[0][1]));
        let bug = out.catalog.iter().find(|l| l.id == "lb_bug").unwrap();
        assert_eq!((bug.name.as_str(), bug.template), ("Bug", false));
        assert_eq!(out.catalog.iter().find(|l| l.id == out.groups[0][1]).unwrap().name, "auth");
        assert!(out.catalog.iter().all(|l| !l.template));
        assert_eq!(bug.color, LABEL_SWATCHES[0]);
    }

    #[test]
    fn gives_each_new_free_text_label_the_scope_of_its_own_group() {
        let out = adopt_free_text_labels(
            None,
            &[
                FreeTextLabels { scope: StoredLabelScope::Issue, labels: ids(&["auth"]) },
                FreeTextLabels {
                    scope: StoredLabelScope::Project,
                    labels: ids(&["auth", "launch"]),
                },
            ],
        );
        assert_eq!(
            out.catalog.iter().find(|l| l.name == "auth").unwrap().scope,
            StoredLabelScope::Issue
        );
        assert_eq!(
            out.catalog.iter().find(|l| l.name == "launch").unwrap().scope,
            StoredLabelScope::Project
        );
        assert_eq!(out.groups[1][0], out.groups[0][0]);
    }

    #[test]
    fn slugs_new_ids_and_avoids_taken_ones() {
        let out = adopt_free_text_labels(
            Some(&json!([{ "id": "lb_bug", "name": "Old bug", "color": "#334455" }])),
            &[FreeTextLabels {
                scope: StoredLabelScope::Issue,
                labels: ids(&["Bug", "Éte!", "  ", "lb_bug", "!!!"]),
            }],
        );
        assert_eq!(out.groups[0], ids(&["lb_bug2", "lb_ete", "lb_bug", "lb_label"]));
        assert_eq!(out.catalog[1].color, LABEL_SWATCHES[1]);
    }

    #[test]
    fn rejects_an_unknown_id_a_label_from_another_scope_and_more_than_20() {
        let mut stored = vec![
            json!({ "id": "lb_bug", "name": "Bug", "color": "#e11d48", "template": false, "scope": "issue" }),
            json!({ "id": "lb_road", "name": "Roadmap", "color": "#334455", "template": false, "scope": "project" }),
        ];
        for i in 0..21 {
            stored.push(json!({ "id": format!("lb_{i}"), "name": format!("L{i}"), "color": "#334455", "template": false, "scope": "issue" }));
        }
        let catalog = resolve_label_catalog(Some(&Value::Array(stored)));
        let issue = Some(LabelScope::Issue);
        assert!(
            assign_label_ids(&catalog, &ids(&["lb_missing"]), issue, &[])
                .unwrap_err()
                .contains("Unknown label")
        );
        assert_eq!(
            assign_label_ids(&catalog, &ids(&["lb_bug", "lb_bug"]), issue, &[]).unwrap(),
            ids(&["lb_bug"])
        );
        assert_eq!(
            assign_label_ids(&catalog, &ids(&["lb_road"]), issue, &[]).unwrap_err(),
            "Label \"lb_road\" does not apply to issues"
        );
        assert_eq!(
            assign_label_ids(&catalog, &ids(&["lb_bug", "lb_road"]), issue, &ids(&["lb_road"]))
                .unwrap(),
            ids(&["lb_bug", "lb_road"])
        );
        assert_eq!(
            assign_label_ids(&catalog, &ids(&["lb_bug"]), None, &[]).unwrap_err(),
            "Label \"lb_bug\" does not apply to this record"
        );
        assert_eq!(
            assign_label_ids(&catalog, &ids(&["lb_bug"]), None, &ids(&["lb_bug"])).unwrap(),
            ids(&["lb_bug"])
        );
        let issue_ids: Vec<String> = catalog
            .iter()
            .filter(|l| l.scope == StoredLabelScope::Issue && !l.template)
            .map(|l| l.id.clone())
            .take(21)
            .collect();
        assert_eq!(
            assign_label_ids(&catalog, &issue_ids, issue, &[]).unwrap_err(),
            "A record can have at most 20 labels"
        );
    }

    // labels/label-filters.spec.ts
    #[test]
    fn merges_into_the_target_without_listing_it_twice_keeping_order() {
        assert_eq!(
            replace_label_id(&ids(&["lb_a", "lb_b", "lb_c"]), "lb_a", Some("lb_c")),
            ids(&["lb_c", "lb_b"])
        );
        assert_eq!(
            replace_label_id(&ids(&["lb_a", "lb_b"]), "lb_a", Some("lb_z")),
            ids(&["lb_z", "lb_b"])
        );
    }

    #[test]
    fn removes_the_id_when_there_is_no_target() {
        assert_eq!(replace_label_id(&ids(&["lb_a", "lb_b"]), "lb_a", None), ids(&["lb_b"]));
        assert_eq!(replace_label_id(&ids(&["lb_b"]), "lb_a", None), ids(&["lb_b"]));
    }

    fn filter(field: &str, op: ViewFilterOp, value: FilterValue) -> ViewFilter {
        ViewFilter { field: field.to_owned(), op, value }
    }

    fn many(list: &[&str]) -> FilterValue {
        FilterValue::Many(ids(list))
    }

    fn one(value: &str) -> FilterValue {
        FilterValue::One(value.to_owned())
    }

    #[test]
    fn leaves_filters_that_do_not_mention_the_label_alone() {
        let filters = [
            filter("labels", ViewFilterOp::In, many(&["lb_x"])),
            filter("status", ViewFilterOp::Is, one("lb_a")),
        ];
        assert_eq!(rewrite_label_filters(&filters, "lb_a", None), None);
        assert_eq!(rewrite_label_filters(&[], "lb_a", Some("lb_b")), None);
    }

    #[test]
    fn replaces_the_id_on_a_merge_and_dedupes() {
        assert_eq!(
            rewrite_label_filters(
                &[filter("labels", ViewFilterOp::In, many(&["lb_a", "lb_b"]))],
                "lb_a",
                Some("lb_b")
            ),
            Some(vec![filter("labels", ViewFilterOp::In, many(&["lb_b"]))])
        );
        assert_eq!(
            rewrite_label_filters(
                &[filter("labels", ViewFilterOp::Is, one("lb_a"))],
                "lb_a",
                Some("lb_b")
            ),
            Some(vec![filter("labels", ViewFilterOp::Is, one("lb_b"))])
        );
    }

    #[test]
    fn drops_a_filter_that_would_be_left_empty_on_delete_keeps_the_others() {
        let filters = [
            filter("status", ViewFilterOp::Is, one("todo")),
            filter("labels", ViewFilterOp::In, many(&["lb_a"])),
            filter("labels", ViewFilterOp::NotIn, many(&["lb_a", "lb_b"])),
        ];
        assert_eq!(
            rewrite_label_filters(&filters, "lb_a", None),
            Some(vec![
                filter("status", ViewFilterOp::Is, one("todo")),
                filter("labels", ViewFilterOp::NotIn, many(&["lb_b"])),
            ])
        );
    }

    #[test]
    fn keeps_the_archived_flag_on_custom_labels_only() {
        let catalog = resolve_label_catalog(Some(&json!([
            { "id": "lb_bug", "name": "Bug", "color": "#e11d48", "template": true, "archived": true },
            { "id": "lb_old", "name": "Old", "color": "#334455", "template": false, "archived": true },
            { "id": "lb_new", "name": "New", "color": "#334455", "template": false },
        ])));
        assert!(catalog.iter().find(|l| l.id == "lb_bug").is_none_or(|l| l.archived.is_none()));
        assert_eq!(catalog.iter().find(|l| l.id == "lb_old").unwrap().archived, Some(true));
        let fresh = catalog.iter().find(|l| l.id == "lb_new").unwrap();
        assert!(serde_json::to_value(fresh).unwrap().get("archived").is_none());
    }

    #[test]
    fn skips_invalid_stored_labels() {
        let catalog = resolve_label_catalog(Some(&json!([
            { "id": "lb_a", "name": "A", "color": "#ABCDEF" },
            { "id": "lb_b", "name": "", "color": "#abcdef" },
            { "id": "lb_c", "name": "x".repeat(41), "color": "#abcdef" },
            { "id": "lb_d", "name": " D ", "color": "#abcdef" },
            { "id": "lb_d", "name": "Dup", "color": "#abcdef" },
            null,
        ])));
        assert_eq!(
            catalog.iter().map(|l| (l.id.as_str(), l.name.as_str())).collect::<Vec<_>>(),
            [("lb_d", "D")]
        );
    }
}
