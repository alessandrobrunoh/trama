//! The pure rules of a project transfer: how statuses and labels map onto the target workspace,
//! which projects a membership is limited to and which role a carried-over guest gets
//! (`server/src/sharing/project-transfer-plan.ts`).

use std::collections::HashMap;

use indexmap::IndexMap;
use serde_json::json;
use trama_contracts::access::effective_member_access;
use trama_contracts::access::{MemberAccess, MemberAction, MemberGrant, MemberResource};
use trama_contracts::common::Id;
use trama_contracts::js;
use trama_contracts::labels::{LABEL_NAME_MAX, WorkspaceLabel, resolve_label_catalog};
use trama_contracts::projects::{
    ProjectTransferMapping, TransferMappingAction, TransferMappingKind,
};
use trama_contracts::roles::{WorkspaceRole, find_workspace_role, role_has_admin_power};
use trama_contracts::settings::WorkspaceSettings;
use trama_contracts::status::{StatusEntry, StatusSubject, resolve_status_entry};

/// Same cap `LabelsService` enforces on a workspace.
pub const TRANSFER_LABEL_CUSTOM_MAX: usize = 100;

/// What the project and its issues carry, so the plan only maps what is actually used.
#[derive(Clone, Debug, Default)]
pub struct TransferUsage {
    /// Stored issue status value -> issues that have it.
    pub issue_statuses: IndexMap<String, i64>,
    /// The project's stored status.
    pub project_status: String,
    /// The project's stored health, when set.
    pub project_health: Option<String>,
    /// Label id -> records (issues and the project) that carry it.
    pub labels: IndexMap<String, i64>,
}

/// Stored value -> target catalog id, for one status subject. A value with no entry is kept as it
/// is.
pub type StatusMap = HashMap<String, String>;

/// `TransferMappingPlan['statuses']`.
#[derive(Clone, Debug, Default)]
pub struct StatusMaps {
    /// Issue statuses.
    pub issue: StatusMap,
    /// Project statuses.
    pub project: StatusMap,
    /// Project health values.
    pub project_health: StatusMap,
}

impl StatusMaps {
    fn of(&mut self, subject: StatusSubject) -> &mut StatusMap {
        match subject {
            StatusSubject::Issue => &mut self.issue,
            StatusSubject::Project => &mut self.project,
            StatusSubject::ProjectHealth => &mut self.project_health,
        }
    }
}

/// How the project's statuses and labels land in the target workspace.
#[derive(Clone, Debug, Default)]
pub struct TransferMappingPlan {
    /// Stored value -> target catalog id, per status subject.
    pub statuses: StatusMaps,
    /// Source label id -> target label id. `None`: the label is not in the source catalog, so it
    /// is dropped.
    pub labels: HashMap<String, Option<String>>,
    /// Labels the target does not have yet.
    pub new_labels: Vec<WorkspaceLabel>,
    /// For the preview.
    pub mappings: Vec<ProjectTransferMapping>,
    /// Anything in here stops the transfer.
    pub blockers: Vec<String>,
}

/// Same name and type wins, then the same id, then the type's seed, then the first entry of that
/// type. `None` when the stored value is not in the source catalog or the target has no entry of
/// that type.
#[must_use]
pub fn map_status_value<'a>(
    source: &'a [StatusEntry],
    target: &'a [StatusEntry],
    stored: &str,
) -> Option<(&'a StatusEntry, &'a StatusEntry)> {
    let from = resolve_status_entry(source, Some(stored))?;
    let of_type: Vec<&StatusEntry> =
        target.iter().filter(|entry| entry.kind == from.kind).collect();
    let first = *of_type.first()?;
    let lower = from.name.to_lowercase();
    let to = of_type
        .iter()
        .find(|entry| entry.name.to_lowercase() == lower)
        .or_else(|| of_type.iter().find(|entry| entry.id == from.id))
        .or_else(|| of_type.iter().find(|entry| entry.id == entry.kind))
        .copied()
        .unwrap_or(first);
    Some((from, to))
}

fn name_of(name: &str) -> String {
    js::trim(name).to_lowercase()
}

fn catalog(labels: &[WorkspaceLabel]) -> Vec<WorkspaceLabel> {
    resolve_label_catalog(Some(&json!(labels)))
}

/// `planTransferMappings`. `new_label_id` issues the id of a label whose own id the target
/// already uses.
#[allow(clippy::too_many_lines)]
pub fn plan_transfer_mappings(
    source: &WorkspaceSettings,
    target: &WorkspaceSettings,
    usage: &TransferUsage,
    mut new_label_id: impl FnMut() -> String,
) -> TransferMappingPlan {
    let mut statuses = StatusMaps::default();
    let mut mappings: Vec<ProjectTransferMapping> = Vec::new();
    let mut blockers: Vec<String> = Vec::new();

    let mut map_subject = |subject: StatusSubject,
                           values: &IndexMap<String, i64>,
                           mappings: &mut Vec<ProjectTransferMapping>| {
        let src = source.statuses.entries(subject);
        let dst = target.statuses.entries(subject);
        let mut by_target: IndexMap<String, ProjectTransferMapping> = IndexMap::new();
        for (stored, count) in values {
            let Some((from, to)) = map_status_value(src, dst, stored) else { continue };
            statuses.of(subject).insert(stored.clone(), to.id.clone());
            let key = format!("{}>{}", from.id, to.id);
            if let Some(row) = by_target.get_mut(&key) {
                row.count += count;
            } else {
                by_target.insert(
                    key,
                    ProjectTransferMapping {
                        kind: kind_of(subject),
                        from: from.name.clone(),
                        to: to.name.clone(),
                        action: TransferMappingAction::Map,
                        count: *count,
                    },
                );
            }
        }
        mappings.extend(by_target.into_values());
    };
    map_subject(StatusSubject::Issue, &usage.issue_statuses, &mut mappings);
    map_subject(
        StatusSubject::Project,
        &IndexMap::from([(usage.project_status.clone(), 1)]),
        &mut mappings,
    );
    if let Some(health) = usage.project_health.as_ref().filter(|h| !h.is_empty()) {
        map_subject(
            StatusSubject::ProjectHealth,
            &IndexMap::from([(health.clone(), 1)]),
            &mut mappings,
        );
    }

    let source_labels: HashMap<String, WorkspaceLabel> =
        catalog(&source.labels).into_iter().map(|label| (label.id.clone(), label)).collect();
    let target_labels = catalog(&target.labels);
    let mut target_by_name: HashMap<String, WorkspaceLabel> = HashMap::new();
    for label in &target_labels {
        let key = name_of(&label.name);
        let replace = match target_by_name.get(&key) {
            None => true,
            // an active label is the better home than an archived one of the same name
            Some(known) => known.archived == Some(true) && label.archived != Some(true),
        };
        if replace {
            target_by_name.insert(key, label.clone());
        }
    }
    let mut taken_ids: std::collections::HashSet<String> =
        target_labels.iter().map(|label| label.id.clone()).collect();
    let mut labels: HashMap<String, Option<String>> = HashMap::new();
    let mut new_labels: Vec<WorkspaceLabel> = Vec::new();
    for (id, count) in &usage.labels {
        let Some(from) = source_labels.get(id) else {
            labels.insert(id.clone(), None);
            continue;
        };
        if let Some(existing) = target_by_name.get(&name_of(&from.name)) {
            labels.insert(id.clone(), Some(existing.id.clone()));
            mappings.push(ProjectTransferMapping {
                kind: TransferMappingKind::Label,
                from: from.name.clone(),
                to: existing.name.clone(),
                action: TransferMappingAction::Map,
                count: *count,
            });
            continue;
        }
        let next_id = if taken_ids.contains(&from.id) { new_label_id() } else { from.id.clone() };
        taken_ids.insert(next_id.clone());
        let created = WorkspaceLabel {
            id: next_id.clone(),
            name: js::truncate(&from.name, LABEL_NAME_MAX).to_owned(),
            color: from.color.clone(),
            template: false,
            scope: from.scope,
            archived: (from.archived == Some(true)).then_some(true),
        };
        target_by_name.insert(name_of(&created.name), created.clone());
        mappings.push(ProjectTransferMapping {
            kind: TransferMappingKind::Label,
            from: from.name.clone(),
            to: created.name.clone(),
            action: TransferMappingAction::Create,
            count: *count,
        });
        new_labels.push(created);
        labels.insert(id.clone(), Some(next_id));
    }
    let customs = target_labels.iter().filter(|label| !label.template).count();
    if customs + new_labels.len() > TRANSFER_LABEL_CUSTOM_MAX {
        blockers.push(format!(
            "The target workspace would have more than {TRANSFER_LABEL_CUSTOM_MAX} labels. Remove some of its labels first."
        ));
    }
    TransferMappingPlan { statuses, labels, new_labels, mappings, blockers }
}

const fn kind_of(subject: StatusSubject) -> TransferMappingKind {
    match subject {
        StatusSubject::Issue => TransferMappingKind::Issue,
        StatusSubject::Project => TransferMappingKind::Project,
        StatusSubject::ProjectHealth => TransferMappingKind::ProjectHealth,
    }
}

/// The projects a membership is limited to, or `None` when it covers every project. Empty:
/// nothing visible.
#[must_use]
pub fn limited_project_ids(
    roles: &[WorkspaceRole],
    role: &str,
    stored: Option<&MemberAccess>,
) -> Option<Vec<Id>> {
    let role = find_workspace_role(roles, Some(role));
    let access = effective_member_access(role, stored)?;
    if access.projects.all {
        return None;
    }
    let view = MemberGrant::new(MemberResource::Projects, MemberAction::View);
    if !access.grants.contains(&view) {
        return Some(Vec::new());
    }
    Some(access.projects.project_ids)
}

/// The role a carried-over guest gets in the target: the one they had if the target still has it,
/// else `guest`, `viewer`, `member`. Never an owner or a role that administers the workspace.
/// `None` when none fits.
#[must_use]
pub fn guest_role_for(target_roles: &[WorkspaceRole], source_role: &str) -> Option<String> {
    [source_role, "guest", "viewer", "member"].into_iter().find_map(|id| {
        let role = find_workspace_role(target_roles, Some(id))?;
        (!role.owner && !role_has_admin_power(Some(role))).then(|| role.id.clone())
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use trama_contracts::access::MemberProjectScope;
    use trama_contracts::labels::StoredLabelScope;
    use trama_contracts::settings::resolve_workspace_settings;
    use trama_contracts::status::{StatusCatalog, default_status_catalog};

    use super::*;

    fn label(id: &str, name: &str, color: &str, archived: bool) -> WorkspaceLabel {
        WorkspaceLabel {
            id: id.to_owned(),
            name: name.to_owned(),
            color: color.to_owned(),
            template: false,
            scope: StoredLabelScope::Issue,
            archived: archived.then_some(true),
        }
    }

    fn lb(id: &str, name: &str) -> WorkspaceLabel {
        label(id, name, "#2563eb", false)
    }

    fn settings(labels: &[WorkspaceLabel], statuses: Option<&StatusCatalog>) -> WorkspaceSettings {
        let statuses = statuses.cloned().unwrap_or_else(default_status_catalog);
        resolve_workspace_settings(&json!({ "labels": labels, "statuses": statuses }))
    }

    fn entry(id: &str, name: &str, kind: &str) -> StatusEntry {
        StatusEntry {
            id: id.to_owned(),
            name: name.to_owned(),
            icon: "circle-dot".to_owned(),
            color: "#e2a93b".to_owned(),
            kind: kind.to_owned(),
        }
    }

    #[test]
    fn status_mapping_keeps_the_type_and_prefers_the_same_name() {
        let source = default_status_catalog().issue;
        let mut target = source.clone();
        target.push(entry("st_doing", "Doing", "in_progress"));
        let (_, same) = map_status_value(&source, &target, "in_progress").unwrap();
        assert_eq!(same.id, "in_progress");
        let renamed: Vec<StatusEntry> = source
            .iter()
            .map(|e| {
                if e.kind == "in_progress" {
                    StatusEntry { name: "Doing".into(), ..e.clone() }
                } else {
                    e.clone()
                }
            })
            .collect();
        let (_, to) = map_status_value(&renamed, &target, "in_progress").unwrap();
        assert_eq!(to.id, "st_doing");
    }

    #[test]
    fn status_mapping_falls_back_to_the_seed_of_the_type() {
        let source = vec![entry("st_wip", "WIP", "in_progress")];
        let target = default_status_catalog().issue;
        let (_, to) = map_status_value(&source, &target, "st_wip").unwrap();
        assert_eq!((to.id.as_str(), to.kind.as_str()), ("in_progress", "in_progress"));
    }

    #[test]
    fn status_mapping_resolves_a_legacy_enum_and_ignores_unknown_values() {
        let catalog = default_status_catalog().issue;
        assert_eq!(map_status_value(&catalog, &catalog, "done").unwrap().1.id, "done");
        assert!(map_status_value(&catalog, &catalog, "nonsense").is_none());
    }

    fn usage(labels: &[(&str, i64)], statuses: &[(&str, i64)]) -> TransferUsage {
        TransferUsage {
            issue_statuses: statuses.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect(),
            project_status: "in_progress".to_owned(),
            project_health: None,
            labels: labels.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect(),
        }
    }

    fn mapping(
        kind: TransferMappingKind,
        from: &str,
        to: &str,
        action: TransferMappingAction,
        count: i64,
    ) -> ProjectTransferMapping {
        ProjectTransferMapping { kind, from: from.to_owned(), to: to.to_owned(), action, count }
    }

    #[test]
    fn maps_labels_by_name_and_creates_the_missing_ones() {
        let source =
            settings(&[lb("lb_a", "Bug"), label("lb_b", "Urgent fix", "#e11d48", false)], None);
        let target = settings(&[lb("lb_x", "bug")], None);
        let mut n = 0;
        let plan = plan_transfer_mappings(
            &source,
            &target,
            &usage(&[("lb_a", 3), ("lb_b", 1), ("lb_gone", 1)], &[("todo", 2)]),
            || {
                n += 1;
                format!("lb_new{n}")
            },
        );
        assert_eq!(plan.labels["lb_a"], Some("lb_x".to_owned()));
        assert_eq!(plan.labels["lb_gone"], None);
        assert_eq!(plan.new_labels.len(), 1);
        let created = &plan.new_labels[0];
        assert_eq!((created.name.as_str(), created.color.as_str()), ("Urgent fix", "#e11d48"));
        assert!(!created.template);
        assert_eq!(created.scope, StoredLabelScope::Issue);
        assert_eq!(plan.labels["lb_b"], Some(created.id.clone()));
        let label_rows: Vec<_> = plan
            .mappings
            .iter()
            .filter(|row| row.kind == TransferMappingKind::Label)
            .cloned()
            .collect();
        assert_eq!(
            label_rows,
            vec![
                mapping(TransferMappingKind::Label, "Bug", "bug", TransferMappingAction::Map, 3),
                mapping(
                    TransferMappingKind::Label,
                    "Urgent fix",
                    "Urgent fix",
                    TransferMappingAction::Create,
                    1
                ),
            ]
        );
    }

    #[test]
    fn keeps_the_label_id_unless_the_target_uses_it() {
        let source = settings(&[lb("lb_same", "Alpha"), lb("lb_clash", "Beta")], None);
        let target = settings(&[lb("lb_clash", "Something else")], None);
        let plan = plan_transfer_mappings(
            &source,
            &target,
            &usage(&[("lb_same", 1), ("lb_clash", 1)], &[("todo", 2)]),
            || "lb_fresh".to_owned(),
        );
        assert_eq!(plan.labels["lb_same"], Some("lb_same".to_owned()));
        assert_ne!(plan.labels["lb_clash"], Some("lb_clash".to_owned()));
        let names: Vec<&str> = plan.new_labels.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "Beta"]);
    }

    #[test]
    fn prefers_an_active_label_over_an_archived_one_of_the_same_name() {
        let source = settings(&[lb("lb_a", "Bug")], None);
        let target =
            settings(&[label("lb_old", "Bug", "#2563eb", true), lb("lb_new", "bug")], None);
        let plan = plan_transfer_mappings(
            &source,
            &target,
            &usage(&[("lb_a", 1)], &[("todo", 2)]),
            || "x".to_owned(),
        );
        assert_eq!(plan.labels["lb_a"], Some("lb_new".to_owned()));
    }

    #[test]
    fn maps_every_used_status_by_type_and_counts_what_carries_it() {
        let mut renamed = default_status_catalog();
        for e in &mut renamed.issue {
            if e.kind == "todo" {
                e.name = "Up next".to_owned();
            }
        }
        let plan = plan_transfer_mappings(
            &settings(&[], None),
            &settings(&[], Some(&renamed)),
            &usage(&[], &[("todo", 2), ("planning", 1)]),
            || "x".to_owned(),
        );
        assert_eq!(plan.statuses.issue.get("todo"), Some(&"todo".to_owned()));
        assert!(!plan.statuses.issue.contains_key("planning"));
        let row = plan.mappings.iter().find(|row| row.kind == TransferMappingKind::Issue).unwrap();
        assert_eq!((row.from.as_str(), row.to.as_str(), row.count), ("Planning", "Up next", 2));
        assert_eq!(plan.statuses.project.get("in_progress"), Some(&"in_progress".to_owned()));
    }

    #[test]
    fn blocks_when_the_target_would_exceed_the_label_cap() {
        let many: Vec<WorkspaceLabel> = (0..TRANSFER_LABEL_CUSTOM_MAX)
            .map(|i| lb(&format!("lb_{i}"), &format!("Label {i}")))
            .collect();
        let plan = plan_transfer_mappings(
            &settings(&[lb("lb_s", "Extra")], None),
            &settings(&many, None),
            &usage(&[("lb_s", 1)], &[("todo", 2)]),
            || "x".to_owned(),
        );
        assert_eq!(plan.blockers.len(), 1);
    }

    fn limited(ids: &[&str]) -> MemberAccess {
        MemberAccess {
            projects: MemberProjectScope {
                all: false,
                project_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
            },
            include_unassigned: false,
            grants: Vec::new(),
        }
    }

    fn roles() -> Vec<WorkspaceRole> {
        resolve_workspace_settings(&Value::Object(serde_json::Map::new())).roles
    }

    #[test]
    fn limited_ids_are_none_for_everyone_with_every_project_and_for_the_owner() {
        assert_eq!(limited_project_ids(&roles(), "member", None), None);
        assert_eq!(limited_project_ids(&roles(), "owner", Some(&limited(&["pj_1"]))), None);
    }

    #[test]
    fn limited_ids_list_the_projects_a_limited_member_can_see() {
        assert_eq!(
            limited_project_ids(&roles(), "viewer", Some(&limited(&["pj_1", "pj_2"]))),
            Some(vec!["pj_1".to_owned(), "pj_2".to_owned()])
        );
    }

    #[test]
    fn limited_ids_are_empty_for_an_unknown_role() {
        assert_eq!(
            limited_project_ids(&roles(), "ghost", Some(&limited(&["pj_1"]))),
            Some(Vec::new())
        );
    }

    #[test]
    fn guest_role_keeps_the_role_the_guest_had() {
        assert_eq!(guest_role_for(&roles(), "viewer").as_deref(), Some("viewer"));
        assert_eq!(guest_role_for(&roles(), "member").as_deref(), Some("member"));
    }

    #[test]
    fn guest_role_is_never_an_admin_or_owner_role() {
        assert_ne!(guest_role_for(&roles(), "admin").as_deref(), Some("admin"));
        assert_ne!(guest_role_for(&roles(), "owner").as_deref(), Some("owner"));
    }

    #[test]
    fn guest_role_is_none_when_nothing_fits() {
        let only_admins: Vec<WorkspaceRole> =
            roles().into_iter().filter(|role| role.owner || role.id == "admin").collect();
        assert_eq!(guest_role_for(&only_admins, "viewer"), None);
    }
}
