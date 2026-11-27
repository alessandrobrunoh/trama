//! Status catalogs: the statuses a workspace offers for issues, projects and project health,
//! plus the lookups of `server/src/status/status-catalog.ts`.
//!
//! Records store a catalog entry id. The seeded ids equal the semantic types (`todo`,
//! `in_progress`, `on_track`, …), so rows that store the legacy enum keep resolving; workspace
//! entries added later get `st_…` ids. Workflow rules read the entry's `type`, never its id.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use sea_orm::{ConnectionTrait, EntityTrait};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use trama_core::AppError;
use utoipa::ToSchema;

string_enum! {
    /// One catalog per subject.
    pub enum StatusSubject {
        Issue = "issue",
        Project = "project",
        ProjectHealth = "project_health",
    }
}

/// `STATUS_SUBJECTS`.
pub const STATUS_SUBJECTS: &[StatusSubject] = StatusSubject::ALL;

impl StatusSubject {
    /// `STATUS_SUBJECT_LABEL[subject]`.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Issue => "Issues",
            Self::Project => "Projects",
            Self::ProjectHealth => "Project health",
        }
    }

    /// `STATUS_CATALOG_KEY[subject]`: the [`StatusCatalog`] field (`issue`, `project`,
    /// `projectHealth`).
    #[must_use]
    pub const fn catalog_key(self) -> &'static str {
        match self {
            Self::Issue => "issue",
            Self::Project => "project",
            Self::ProjectHealth => "projectHealth",
        }
    }
}

/// `isStatusSubject`.
#[must_use]
pub fn is_status_subject(value: &str) -> bool {
    StatusSubject::parse(value).is_some()
}

/// Longest status name.
pub const STATUS_NAME_MAX: usize = 40;
/// Longest status icon, in UTF-16 units.
pub const STATUS_ICON_MAX: usize = 48;
/// `STATUS_ICON_PATTERN`: a Lucide icon name (kebab-case) or one emoji.
pub const STATUS_ICON_PATTERN: &str = r"^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|\p{Extended_Pictographic}[\x{FE0F}\x{1F3FB}-\x{1F3FF}]?(?:\x{200D}\p{Extended_Pictographic}[\x{FE0F}\x{1F3FB}-\x{1F3FF}]?)*|\p{Regional_Indicator}{2})$";

static STATUS_ICON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(STATUS_ICON_PATTERN).expect("valid status icon pattern"));

/// Lucide icon name (kebab-case) or one emoji, at most [`STATUS_ICON_MAX`] long.
#[must_use]
pub fn is_status_icon(value: &str) -> bool {
    !value.is_empty() && crate::js::len(value) <= STATUS_ICON_MAX && STATUS_ICON.is_match(value)
}

/// `STATUS_COLOR`: `#rrggbb`, either case.
#[must_use]
pub fn is_status_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

/// One status of a catalog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct StatusEntry {
    /// Stable id. Seeds use the semantic type string.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Lucide icon name (kebab-case) or a single emoji.
    pub icon: String,
    /// `#rrggbb`.
    pub color: String,
    /// Semantic type (an `IssueStatus`, `ProjectStatus` or `ProjectHealth`). Several entries may
    /// share one.
    #[serde(rename = "type")]
    pub kind: String,
}

/// The three catalogs of a workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusCatalog {
    /// Issue statuses.
    pub issue: Vec<StatusEntry>,
    /// Project statuses.
    pub project: Vec<StatusEntry>,
    /// Project health values.
    pub project_health: Vec<StatusEntry>,
}

impl StatusCatalog {
    /// The entries of one subject.
    #[must_use]
    pub fn entries(&self, subject: StatusSubject) -> &[StatusEntry] {
        match subject {
            StatusSubject::Issue => &self.issue,
            StatusSubject::Project => &self.project,
            StatusSubject::ProjectHealth => &self.project_health,
        }
    }

    /// The entries of one subject, mutably.
    pub fn entries_mut(&mut self, subject: StatusSubject) -> &mut Vec<StatusEntry> {
        match subject {
            StatusSubject::Issue => &mut self.issue,
            StatusSubject::Project => &mut self.project,
            StatusSubject::ProjectHealth => &mut self.project_health,
        }
    }
}

// v3 palette: todo gray · in progress yellow · in review blue · done green.
const NEUTRAL: &str = "#8c9096";
const SLATE: &str = "#8c9096";
const FAINT: &str = "#5e6269";
const DIM: &str = "#3a3e45";
const BLUE: &str = "#5274e0";
const AMBER: &str = "#e2a93b";
const RED: &str = "#cc4b30";
const GREEN: &str = "#6fae73";

type Seed = (&'static str, &'static str, &'static str, &'static str);

/// Default issue workflow: Backlog → Planning → In Progress → In Review / Waiting Input → Merged,
/// plus Canceled. `draft` is a valid type but is not seeded.
const ISSUE_STATUS_SEEDS: &[Seed] = &[
    ("backlog", "Backlog", "circle-dashed", FAINT),
    ("todo", "Planning", "circle", SLATE),
    ("in_progress", "In Progress", "circle-dot", AMBER),
    ("in_review", "In Review / Waiting Input", "circle-ellipsis", BLUE),
    ("done", "Merged", "circle-check", GREEN),
    ("canceled", "Canceled", "circle-x", DIM),
];

const PROJECT_STATUS_SEEDS: &[Seed] = &[
    ("backlog", "Backlog", "circle-dashed", NEUTRAL),
    ("planned", "Planned", "circle", SLATE),
    ("in_progress", "In progress", "circle-dot", BLUE),
    ("paused", "Paused", "circle-pause", AMBER),
    ("completed", "Completed", "circle-check", GREEN),
    ("canceled", "Canceled", "circle-x", NEUTRAL),
];

const PROJECT_HEALTH_SEEDS: &[Seed] = &[
    ("on_track", "On track", "circle-check", GREEN),
    ("at_risk", "At risk", "triangle-alert", AMBER),
    ("off_track", "Off track", "circle-alert", RED),
];

fn seed_entries(rows: &[Seed]) -> Vec<StatusEntry> {
    rows.iter()
        .map(|(kind, name, icon, color)| StatusEntry {
            id: (*kind).to_owned(),
            name: (*name).to_owned(),
            icon: (*icon).to_owned(),
            color: (*color).to_owned(),
            kind: (*kind).to_owned(),
        })
        .collect()
}

/// Today's statuses: one entry per semantic type, id equal to that type.
#[must_use]
pub fn default_status_catalog() -> StatusCatalog {
    StatusCatalog {
        issue: seed_entries(ISSUE_STATUS_SEEDS),
        project: seed_entries(PROJECT_STATUS_SEEDS),
        project_health: seed_entries(PROJECT_HEALTH_SEEDS),
    }
}

/// The semantic types a subject's entries may have.
#[must_use]
pub fn status_types(subject: StatusSubject) -> Vec<&'static str> {
    match subject {
        StatusSubject::Issue => {
            std::iter::once("draft").chain(ISSUE_STATUS_SEEDS.iter().map(|s| s.0)).collect()
        }
        StatusSubject::Project => PROJECT_STATUS_SEEDS.iter().map(|s| s.0).collect(),
        StatusSubject::ProjectHealth => PROJECT_HEALTH_SEEDS.iter().map(|s| s.0).collect(),
    }
}

/// Display name of a semantic type, from the seed (not a workspace's renamed copy).
#[must_use]
pub fn status_type_label(subject: StatusSubject, kind: &str) -> String {
    let seeds = match subject {
        StatusSubject::Issue => ISSUE_STATUS_SEEDS,
        StatusSubject::Project => PROJECT_STATUS_SEEDS,
        StatusSubject::ProjectHealth => PROJECT_HEALTH_SEEDS,
    };
    if let Some(seed) = seeds.iter().find(|s| s.0 == kind) {
        return seed.1.to_owned();
    }
    if kind == "draft" { "Draft".to_owned() } else { kind.to_owned() }
}

fn normalize_status_entries(
    subject: StatusSubject,
    incoming: Option<&Value>,
    defaults: Vec<StatusEntry>,
) -> Vec<StatusEntry> {
    let items = match incoming {
        Some(Value::Array(items)) if !items.is_empty() => items,
        _ => return defaults,
    };
    let allowed: HashSet<&str> = status_types(subject).into_iter().collect();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut entries: Vec<StatusEntry> = Vec::new();
    for item in items {
        let text = |key: &str| item.get(key).and_then(Value::as_str);
        let Some(id) = text("id") else { continue };
        if crate::js::trim(id).is_empty() || seen.contains(id) {
            continue;
        }
        let name = text("name").map_or("", crate::js::trim);
        if name.is_empty() || crate::js::len(name) > STATUS_NAME_MAX {
            continue;
        }
        let Some(icon) = text("icon").filter(|i| is_status_icon(i)) else { continue };
        let Some(color) = text("color").filter(|c| is_status_color(c)) else { continue };
        let Some(kind) = text("type").filter(|t| allowed.contains(t)) else { continue };
        seen.insert(id);
        entries.push(StatusEntry {
            id: id.to_owned(),
            name: name.to_owned(),
            icon: icon.to_owned(),
            color: color.to_lowercase(),
            kind: kind.to_owned(),
        });
    }
    for seed in defaults {
        if !entries.iter().any(|e| e.kind == seed.kind) {
            entries.push(seed);
        }
    }
    entries
}

/// Stored catalog (the `statuses` object of stored settings), or today's seeds when a workspace
/// has none yet. Every semantic type keeps at least one entry.
#[must_use]
pub fn resolve_status_catalog(stored: Option<&Value>) -> StatusCatalog {
    let defaults = default_status_catalog();
    let part = |key: &str| stored.and_then(|s| s.get(key));
    StatusCatalog {
        issue: normalize_status_entries(StatusSubject::Issue, part("issue"), defaults.issue),
        project: normalize_status_entries(
            StatusSubject::Project,
            part("project"),
            defaults.project,
        ),
        project_health: normalize_status_entries(
            StatusSubject::ProjectHealth,
            part("projectHealth"),
            defaults.project_health,
        ),
    }
}

/// The catalog entry a stored value names. An id matches first. A legacy enum string is the
/// seeded entry of that type: the one whose id is still the type, else the first of the type.
#[must_use]
pub fn resolve_status_entry<'a>(
    entries: &'a [StatusEntry],
    stored: Option<&str>,
) -> Option<&'a StatusEntry> {
    let stored = stored.filter(|s| !s.is_empty())?;
    if let Some(by_id) = entries.iter().find(|e| e.id == stored) {
        return Some(by_id);
    }
    let mut of_type = entries.iter().filter(|e| e.kind == stored);
    let first = of_type.clone().next();
    of_type.find(|e| e.id == e.kind).or(first)
}

/// Semantic type of a stored id or legacy enum. `None` when the value is not in the catalog.
#[must_use]
pub fn status_type_of<'a>(entries: &'a [StatusEntry], stored: Option<&str>) -> Option<&'a str> {
    resolve_status_entry(entries, stored).map(|e| e.kind.as_str())
}

/// Every id of these types, plus the type strings themselves so rows that still store the enum
/// match.
#[must_use]
pub fn status_ids_for_types(entries: &[StatusEntry], types: &[&str]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut push = |id: &str| {
        if !ids.iter().any(|i| i == id) {
            ids.push(id.to_owned());
        }
    };
    for entry in entries.iter().filter(|e| types.contains(&e.kind.as_str())) {
        push(&entry.id);
    }
    for kind in types {
        push(kind);
    }
    ids
}

/// Values a record may store for this entry: its id, and the legacy enum when this entry is the
/// seed of its type. A custom status of the same type does not claim rows that still say `todo`.
#[must_use]
pub fn status_stored_values(entry: &StatusEntry, entries: &[StatusEntry]) -> Vec<String> {
    let mut values = vec![entry.id.clone()];
    let seed = entries
        .iter()
        .find(|e| e.kind == entry.kind && e.id == e.kind)
        .or_else(|| entries.iter().find(|e| e.kind == entry.kind));
    if seed.is_some_and(|s| s.id == entry.id) && entry.kind != entry.id {
        values.push(entry.kind.clone());
    }
    values
}

/// The workspace catalog, or today's seeds when the workspace or its settings are missing or the
/// lookup itself fails (`loadStatusCatalog`).
pub async fn load_status_catalog(db: &impl ConnectionTrait, workspace_id: &str) -> StatusCatalog {
    match trama_entities::workspaces::Entity::find_by_id(workspace_id.to_owned()).one(db).await {
        Ok(Some(ws)) => resolve_status_catalog(ws.settings.get("statuses")),
        _ => resolve_status_catalog(None),
    }
}

/// The entry `stored` names (`requireStatus`).
///
/// # Errors
///
/// 400 `Unknown <label> "<stored>"` when the catalog has no such entry.
pub fn require_status<'a>(
    entries: &'a [StatusEntry],
    stored: &str,
    label: &str,
) -> Result<&'a StatusEntry, AppError> {
    resolve_status_entry(entries, Some(stored))
        .ok_or_else(|| AppError::bad_request(format!("Unknown {label} \"{stored}\"")))
}

/// Ids a status filter matches: the resolved entry, plus the raw value when it is still a
/// legacy enum (`statusFilterIds`).
#[must_use]
pub fn status_filter_ids(entries: &[StatusEntry], stored: &str) -> Vec<String> {
    match resolve_status_entry(entries, Some(stored)) {
        None => vec![stored.to_owned()],
        Some(entry) if entry.id == stored => vec![entry.id.clone()],
        Some(entry) => vec![entry.id.clone(), stored.to_owned()],
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::settings::resolve_workspace_settings;

    // workspaces/statuses.service.spec.ts (pure cases)
    #[test]
    fn seeds_a_new_workspace_with_todays_statuses_one_per_type() {
        let settings = resolve_workspace_settings(&json!({}));
        let seeded = default_status_catalog();
        assert_eq!(
            settings.statuses.issue.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            seeded.issue.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>()
        );
        for subject in STATUS_SUBJECTS {
            let entries = settings.statuses.entries(*subject);
            let types: HashSet<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
            assert_eq!(types.len(), entries.len());
            assert!(entries.iter().all(|e| !e.icon.is_empty() && e.color.starts_with('#')));
        }
    }

    #[test]
    fn defaults_the_issue_workflow() {
        let issue = resolve_workspace_settings(&json!({})).statuses.issue;
        let pairs: Vec<(&str, &str)> =
            issue.iter().map(|e| (e.kind.as_str(), e.name.as_str())).collect();
        assert_eq!(
            pairs,
            [
                ("backlog", "Backlog"),
                ("todo", "Planning"),
                ("in_progress", "In Progress"),
                ("in_review", "In Review / Waiting Input"),
                ("done", "Merged"),
                ("canceled", "Canceled"),
            ]
        );
    }

    #[test]
    fn keeps_a_stored_draft_status() {
        let mut stored = serde_json::to_value(default_status_catalog().issue).unwrap();
        stored.as_array_mut().unwrap().push(
            json!({ "id": "draft", "name": "Draft", "icon": "circle-dashed", "color": "#5e6269", "type": "draft" }),
        );
        let resolved = resolve_status_catalog(Some(&json!({ "issue": stored }))).issue;
        assert!(resolved.iter().any(|e| e.kind == "draft"));
    }

    #[test]
    fn resolves_an_old_enum_value_to_the_seeded_status_of_that_type() {
        let rewritten: Vec<StatusEntry> = default_status_catalog()
            .issue
            .into_iter()
            .map(|e| StatusEntry { id: format!("st_{}", e.kind), ..e })
            .collect();
        let todo = resolve_status_entry(&rewritten, Some("todo")).unwrap();
        assert_eq!((todo.id.as_str(), todo.kind.as_str()), ("st_todo", "todo"));
        let done = resolve_status_entry(&rewritten, Some("st_done")).unwrap();
        assert_eq!((done.id.as_str(), done.kind.as_str()), ("st_done", "done"));
        let mut with_extra = rewritten.clone();
        with_extra.push(StatusEntry {
            id: "st_ready".into(),
            name: "Ready".into(),
            icon: "circle".into(),
            color: "#5f6a7a".into(),
            kind: "todo".into(),
        });
        assert_eq!(resolve_status_entry(&with_extra, Some("todo")).unwrap().id, "st_todo");
    }

    #[test]
    fn normalizes_stored_entries_and_fills_missing_types() {
        let resolved = resolve_status_catalog(Some(&json!({
            "project": [
                { "id": "st_x", "name": " Doing ", "icon": "🚀", "color": "#ABCDEF", "type": "in_progress" },
                { "id": "st_x", "name": "Dup", "icon": "circle", "color": "#abcdef", "type": "paused" },
                { "id": "st_bad", "name": "Bad", "icon": "Not An Icon", "color": "#abcdef", "type": "paused" },
                { "id": "st_bad2", "name": "Bad", "icon": "circle", "color": "abcdef", "type": "paused" },
                { "id": "st_bad3", "name": "Bad", "icon": "circle", "color": "#abcdef", "type": "working" },
                { "id": "  ", "name": "Blank", "icon": "circle", "color": "#abcdef", "type": "paused" },
            ],
        })));
        assert_eq!(resolved.project[0].id, "st_x");
        assert_eq!(resolved.project[0].name, "Doing");
        assert_eq!(resolved.project[0].color, "#abcdef");
        let types: Vec<&str> = resolved.project.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(types, ["in_progress", "backlog", "planned", "paused", "completed", "canceled"]);
        assert_eq!(resolved.issue, default_status_catalog().issue);
    }

    #[test]
    fn checks_status_icons() {
        for ok in ["circle", "circle-check", "a1-b2", "🚀", "👍🏽", "👩‍💻", "🇮🇹", "❤️"]
        {
            assert!(is_status_icon(ok), "{ok}");
        }
        for bad in ["", "Circle", "circle-", "-circle", "a b", "🚀🚀", "x".repeat(49).as_str()]
        {
            assert!(!is_status_icon(bad), "{bad}");
        }
    }

    #[test]
    fn labels_ids_and_stored_values() {
        assert_eq!(status_type_label(StatusSubject::Issue, "todo"), "Planning");
        assert_eq!(status_type_label(StatusSubject::Issue, "draft"), "Draft");
        assert_eq!(status_type_label(StatusSubject::ProjectHealth, "x"), "x");
        let mut entries = default_status_catalog().issue;
        entries.push(StatusEntry {
            id: "st_ready".into(),
            name: "Ready".into(),
            icon: "circle".into(),
            color: "#5f6a7a".into(),
            kind: "todo".into(),
        });
        assert_eq!(status_ids_for_types(&entries, &["todo"]), ["todo", "st_ready"]);
        assert_eq!(status_stored_values(&entries[1], &entries), ["todo"]);
        assert_eq!(status_stored_values(&entries[6], &entries), ["st_ready"]);
        let renamed: Vec<StatusEntry> = entries
            .iter()
            .map(|e| StatusEntry { id: format!("st_{}", e.kind), ..e.clone() })
            .collect();
        assert_eq!(status_stored_values(&renamed[1], &renamed), ["st_todo", "todo"]);
        assert_eq!(status_filter_ids(&renamed, "todo"), ["st_todo", "todo"]);
        assert_eq!(status_filter_ids(&renamed, "st_done"), ["st_done"]);
        assert_eq!(status_filter_ids(&renamed, "nope"), ["nope"]);
        let err = require_status(&renamed, "nope", "project status").unwrap_err();
        assert_eq!(err.status_code(), 400);
        assert_eq!(err.to_string(), "400 Bad Request: Unknown project status \"nope\"");
    }
}
