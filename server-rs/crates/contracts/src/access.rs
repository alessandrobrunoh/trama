//! Member access: the work grants a role or a person has, and the projects they reach.
//!
//! A membership's `access` is added on top of its role: extra grants, and an optional project
//! limit. [`effective_member_access`] combines the two; `None` means "unlimited" (every action
//! on every project).

use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use utoipa::ToSchema;

use crate::common::Id;
use crate::roles::{GUEST_ROLE_ID, LegacyRole, WorkspaceRole};

string_enum! {
    /// What a person can be allowed to do, independently, inside the workspace role.
    pub enum MemberAction {
        View = "view",
        Create = "create",
        Update = "update",
        Delete = "delete",
    }
}

string_enum! {
    /// Work a membership grant names. Stays `issues` (not `tasks`): these strings are stored on
    /// roles. Public HTTP and API-token permissions use `tasks` instead.
    pub enum MemberResource {
        Projects = "projects",
        Milestones = "milestones",
        Issues = "issues",
        Artifacts = "artifacts",
        Views = "views",
        Comments = "comments",
    }
}

string_enum! {
    /// Group a member resource is shown under.
    pub enum MemberResourceGroup {
        Planning = "Planning",
        Work = "Work",
        Collaboration = "Collaboration",
    }
}

/// `MEMBER_RESOURCES[resource]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct MemberResourceMeta {
    /// Display name.
    pub label: &'static str,
    /// One-line explanation.
    pub description: &'static str,
    /// Settings group.
    pub group: MemberResourceGroup,
    /// Actions the resource offers.
    pub actions: &'static [MemberAction],
}

impl MemberResource {
    /// `MEMBER_RESOURCES[resource]`.
    #[must_use]
    pub const fn meta(self) -> MemberResourceMeta {
        let (group, label, description) = match self {
            Self::Projects => (
                MemberResourceGroup::Planning,
                "Projects",
                "The planning container: name, status, dates, lead.",
            ),
            Self::Milestones => {
                (MemberResourceGroup::Planning, "Milestones", "Targets inside a project.")
            }
            Self::Issues => (
                MemberResourceGroup::Work,
                "Issues",
                "File an issue without being able to edit or delete it, or the other way around.",
            ),
            Self::Artifacts => (
                MemberResourceGroup::Work,
                "Artifacts",
                "Pull requests, builds and other proof attached to work.",
            ),
            Self::Views => (
                MemberResourceGroup::Work,
                "Views",
                "Saved filters. Sharing a view with the workspace still follows Roles & permissions.",
            ),
            Self::Comments => (
                MemberResourceGroup::Collaboration,
                "Comments",
                "Read a thread, write in it, or edit and delete comments.",
            ),
        };
        MemberResourceMeta { label, description, group, actions: MemberAction::ALL }
    }
}

/// `MEMBER_RESOURCE_ORDER`.
pub const MEMBER_RESOURCE_ORDER: &[MemberResource] = MemberResource::ALL;

/// `MEMBER_ACTION_META`: the label of each action.
pub const MEMBER_ACTION_META: &[(MemberAction, &str)] = &[
    (MemberAction::View, "View"),
    (MemberAction::Create, "Create"),
    (MemberAction::Update, "Edit"),
    (MemberAction::Delete, "Delete"),
];

/// `${MemberResource}:${MemberAction}`, e.g. `issues:create`. On the wire it is that string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct MemberGrant {
    /// The resource.
    pub resource: MemberResource,
    /// The action on it.
    pub action: MemberAction,
}

impl MemberGrant {
    /// A grant.
    #[must_use]
    pub const fn new(resource: MemberResource, action: MemberAction) -> Self {
        Self { resource, action }
    }

    /// `resource:action`, or `None` when it is not in the catalog.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        let (resource, action) = value.split_once(':')?;
        Some(Self::new(MemberResource::parse(resource)?, MemberAction::parse(action)?))
    }

    /// The `view` grant of the same resource (create, edit and delete imply view).
    #[must_use]
    pub const fn view(self) -> Self {
        Self::new(self.resource, MemberAction::View)
    }

    /// `grant.endsWith(':view')`.
    #[must_use]
    pub fn is_view(self) -> bool {
        self.action == MemberAction::View
    }
}

impl fmt::Display for MemberGrant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.resource, self.action)
    }
}

impl Serialize for MemberGrant {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for MemberGrant {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown member grant \"{raw}\"")))
    }
}

pub(crate) fn string_values_schema(
    values: impl IntoIterator<Item = String>,
) -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
    utoipa::openapi::schema::ObjectBuilder::new()
        .schema_type(utoipa::openapi::schema::Type::String)
        .enum_values(Some(values))
        .into()
}

impl utoipa::PartialSchema for MemberGrant {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        string_values_schema(MEMBER_GRANTS.iter().map(ToString::to_string))
    }
}

impl ToSchema for MemberGrant {}

const fn build_member_grants() -> [MemberGrant; 24] {
    let mut out = [MemberGrant::new(MemberResource::Projects, MemberAction::View); 24];
    let mut i = 0;
    while i < 24 {
        out[i] = MemberGrant::new(MEMBER_RESOURCE_ORDER[i / 4], MemberAction::ALL[i % 4]);
        i += 1;
    }
    out
}

/// `MEMBER_GRANTS`: every grant, in catalog order (resource order, then view, create, update,
/// delete).
pub const MEMBER_GRANTS: [MemberGrant; 24] = build_member_grants();

/// Every project, or a list of them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberProjectScope {
    /// Every project, including ones created later.
    pub all: bool,
    /// Used when `all` is false.
    pub project_ids: Vec<Id>,
}

impl MemberProjectScope {
    /// Every project.
    #[must_use]
    pub fn every() -> Self {
        Self { all: true, project_ids: Vec::new() }
    }
}

/// What one person has beyond their role. `grants` are added to the role; they never remove a
/// permission the role already gives. `projects` can still hide projects the role would see.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberAccess {
    /// Projects the person reaches.
    pub projects: MemberProjectScope,
    /// When `projects.all` is false, work with no project stays visible only if this is true.
    pub include_unassigned: bool,
    /// Actions added on top of the role. Permissions the role already has are not repeated.
    pub grants: Vec<MemberGrant>,
}

/// Granular work permissions of the four old ranks (`RoleGrantMap`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct RoleGrantMap {
    /// Owner grants.
    pub owner: Vec<MemberGrant>,
    /// Admin grants.
    pub admin: Vec<MemberGrant>,
    /// Member grants.
    pub member: Vec<MemberGrant>,
    /// Viewer grants.
    pub viewer: Vec<MemberGrant>,
}

impl RoleGrantMap {
    /// The grants of one rank.
    #[must_use]
    pub fn get(&self, role: LegacyRole) -> &[MemberGrant] {
        match role {
            LegacyRole::Owner => &self.owner,
            LegacyRole::Admin => &self.admin,
            LegacyRole::Member => &self.member,
            LegacyRole::Viewer => &self.viewer,
        }
    }

    fn set(&mut self, role: LegacyRole, grants: Vec<MemberGrant>) {
        match role {
            LegacyRole::Owner => self.owner = grants,
            LegacyRole::Admin => self.admin = grants,
            LegacyRole::Member => self.member = grants,
            LegacyRole::Viewer => self.viewer = grants,
        }
    }
}

fn is_member_id(id: &str) -> bool {
    (1..=80).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Keeps `chosen` in catalog order.
fn in_catalog_order(chosen: &HashSet<MemberGrant>) -> Vec<MemberGrant> {
    MEMBER_GRANTS.iter().copied().filter(|g| chosen.contains(g)).collect()
}

/// Default work permissions of an old rank. Viewer is view-only; the others can do all four
/// actions.
#[must_use]
pub fn role_grants(role: LegacyRole) -> Vec<MemberGrant> {
    if role == LegacyRole::Viewer {
        return MEMBER_GRANTS.iter().copied().filter(|g| g.is_view()).collect();
    }
    MEMBER_GRANTS.to_vec()
}

/// `defaultRoleGrantMap()`.
#[must_use]
pub fn default_role_grant_map() -> RoleGrantMap {
    RoleGrantMap {
        owner: role_grants(LegacyRole::Owner),
        admin: role_grants(LegacyRole::Admin),
        member: role_grants(LegacyRole::Member),
        viewer: role_grants(LegacyRole::Viewer),
    }
}

/// Keeps known grants, in catalog order, and makes every other action imply view.
#[must_use]
pub fn normalize_grant_list(input: &[Value]) -> Vec<MemberGrant> {
    let mut chosen: HashSet<MemberGrant> =
        input.iter().filter_map(Value::as_str).filter_map(MemberGrant::parse).collect();
    let views: Vec<MemberGrant> = chosen.iter().map(|g| g.view()).collect();
    chosen.extend(views);
    in_catalog_order(&chosen)
}

/// Fills missing ranks with the defaults. Stored lists replace a rank entirely.
#[must_use]
pub fn resolve_role_grants(raw: Option<&Value>) -> RoleGrantMap {
    let mut out = default_role_grant_map();
    let Some(raw) = raw.filter(|v| crate::js::truthy(v)) else { return out };
    for role in LegacyRole::ALL {
        if let Some(Value::Array(listed)) = raw.get(role.as_str()) {
            out.set(*role, normalize_grant_list(listed));
        }
    }
    out
}

/// No extras and every project: the person is exactly their role.
#[must_use]
pub fn empty_member_access() -> MemberAccess {
    MemberAccess {
        projects: MemberProjectScope::every(),
        include_unassigned: true,
        grants: Vec::new(),
    }
}

/// Normalizes client or stored access. `grants` on `input` are extras on top of `baseline` (the
/// role); grants the role already has are dropped. Returns `None` when nothing is added and every
/// project stays visible.
#[must_use]
pub fn normalize_member_access(input: &Value, baseline: &[MemberGrant]) -> Option<MemberAccess> {
    let raw = match input {
        Value::Object(map) => Some(map),
        Value::Array(_) => None,
        _ => return None,
    };
    let field = |key: &str| raw.and_then(|m| m.get(key));
    let mut all = true;
    let mut project_ids: Vec<Id> = Vec::new();
    if let Some(Value::Object(projects)) = field("projects") {
        all = projects.get("all") != Some(&Value::Bool(false));
        if !all && let Some(Value::Array(listed)) = projects.get("projectIds") {
            for id in listed.iter().filter_map(Value::as_str) {
                if is_member_id(id) && !project_ids.iter().any(|p| p == id) {
                    project_ids.push(id.to_owned());
                }
            }
        }
    }
    let include_unassigned = all || field("includeUnassigned") != Some(&Value::Bool(false));
    let base: HashSet<MemberGrant> = baseline.iter().copied().collect();
    let mut chosen: HashSet<MemberGrant> = HashSet::new();
    if let Some(Value::Array(grants)) = field("grants") {
        for grant in grants.iter().filter_map(Value::as_str).filter_map(MemberGrant::parse) {
            if !base.contains(&grant) {
                chosen.insert(grant);
            }
        }
    }
    let views: Vec<MemberGrant> =
        chosen.iter().map(|g| g.view()).filter(|v| !base.contains(v)).collect();
    chosen.extend(views);
    let grants = in_catalog_order(&chosen);
    if all && include_unassigned && grants.is_empty() {
        return None;
    }
    Some(MemberAccess {
        projects: MemberProjectScope {
            all,
            project_ids: if all { Vec::new() } else { project_ids },
        },
        include_unassigned,
        grants,
    })
}

/// Role grants plus this person's extras. `None` for the owner role (always full), and when the
/// result is every action on every project. Unknown role (`None`): nothing. The guest role never
/// means "every project": without a project list it sees no project at all.
#[must_use]
pub fn effective_member_access(
    role: Option<&WorkspaceRole>,
    stored: Option<&MemberAccess>,
) -> Option<MemberAccess> {
    let Some(role) = role else {
        return Some(MemberAccess {
            projects: MemberProjectScope { all: false, project_ids: Vec::new() },
            include_unassigned: false,
            grants: Vec::new(),
        });
    };
    if role.owner {
        return None;
    }
    let mut base: HashSet<MemberGrant> = role.grants.iter().copied().collect();
    if let Some(stored) = stored {
        base.extend(stored.grants.iter().copied());
    }
    let grants = in_catalog_order(&base);
    let is_guest = role.id == GUEST_ROLE_ID;
    let guest_without_projects = is_guest && stored.is_none_or(|s| s.projects.all);
    let projects = if guest_without_projects {
        MemberProjectScope { all: false, project_ids: Vec::new() }
    } else {
        stored.map_or_else(MemberProjectScope::every, |s| s.projects.clone())
    };
    let include_unassigned =
        !is_guest && (projects.all || stored.is_none_or(|s| s.include_unassigned));
    if projects.all && include_unassigned && grants.len() == MEMBER_GRANTS.len() {
        return None;
    }
    Some(MemberAccess {
        projects: if projects.all { MemberProjectScope::every() } else { projects },
        include_unassigned,
        grants,
    })
}

/// `requested` `None` means the role itself, on every project. `caller` `None` means the caller
/// is not limited. A limited caller can only invite someone whose role (`baseline`), extras and
/// projects are inside what they already have.
#[must_use]
pub fn access_within(
    requested: Option<&MemberAccess>,
    caller: Option<&MemberAccess>,
    baseline: &[MemberGrant],
) -> bool {
    let Some(caller) = caller else { return true };
    let requested_grants = requested.map_or(&[][..], |r| &r.grants[..]);
    if !baseline.iter().chain(requested_grants).all(|g| caller.grants.contains(g)) {
        return false;
    }
    let every = MemberProjectScope::every();
    let projects = requested.map_or(&every, |r| &r.projects);
    if projects.all {
        return caller.projects.all;
    }
    if !caller.projects.all {
        let include_unassigned = requested.is_none_or(|r| r.include_unassigned);
        if include_unassigned && !caller.include_unassigned {
            return false;
        }
        if projects.project_ids.iter().any(|id| !caller.projects.project_ids.contains(id)) {
            return false;
        }
    }
    true
}

/// The person works only on some projects (a guest, or a member limited to a list).
#[must_use]
pub fn is_project_limited(access: Option<&MemberAccess>) -> bool {
    access.is_some_and(|a| !a.projects.all)
}

/// Does this access reach the project? `None` access reaches every project.
#[must_use]
pub fn access_includes_project(access: Option<&MemberAccess>, project_id: &str) -> bool {
    access.is_none_or(|a| a.projects.all || a.projects.project_ids.iter().any(|p| p == project_id))
}

/// Do the two people have at least one project in common? Someone with every project shares
/// with everybody.
#[must_use]
pub fn accesses_share_project(a: Option<&MemberAccess>, b: Option<&MemberAccess>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) if !a.projects.all && !b.projects.all => {
            a.projects.project_ids.iter().any(|id| b.projects.project_ids.contains(id))
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn grants(list: &[&str]) -> Vec<MemberGrant> {
        list.iter().map(|g| MemberGrant::parse(g).unwrap()).collect()
    }

    fn role(grants: Vec<MemberGrant>) -> WorkspaceRole {
        WorkspaceRole {
            id: "custom".into(),
            name: "Custom".into(),
            owner: false,
            capabilities: Vec::new(),
            grants,
        }
    }

    #[test]
    fn grants_are_the_catalog_strings() {
        assert_eq!(MEMBER_GRANTS[0].to_string(), "projects:view");
        assert_eq!(MEMBER_GRANTS[23].to_string(), "comments:delete");
        assert_eq!(
            serde_json::to_value(grants(&["issues:create"])).unwrap(),
            json!(["issues:create"])
        );
        assert!(serde_json::from_value::<MemberGrant>(json!("tasks:view")).is_err());
        assert_eq!(role_grants(LegacyRole::Viewer).len(), 6);
    }

    #[test]
    fn normalizing_a_grant_list_implies_view() {
        let out = normalize_grant_list(&[json!("issues:delete"), json!("bogus"), json!(3)]);
        assert_eq!(out, grants(&["issues:view", "issues:delete"]));
    }

    // member-access.spec.ts: normalizeMemberAccess
    #[test]
    fn stores_no_extras_and_every_project_as_nothing_on_top_of_the_role() {
        let member = role_grants(LegacyRole::Member);
        let all: Vec<String> = member.iter().map(ToString::to_string).collect();
        assert_eq!(
            normalize_member_access(
                &json!({ "projects": { "all": true }, "grants": all }),
                &member
            ),
            None
        );
        assert_eq!(normalize_member_access(&Value::Null, &member), None);
    }

    #[test]
    fn keeps_an_action_the_role_does_not_have_and_implies_view_when_the_role_lacks_it() {
        let viewer = role_grants(LegacyRole::Viewer);
        let access = normalize_member_access(
            &json!({ "projects": { "all": true }, "grants": ["issues:create"] }),
            &viewer,
        );
        assert_eq!(access.unwrap().grants, grants(&["issues:create"]));
        let from_scratch =
            normalize_member_access(&json!({ "grants": ["issues:create"] }), &[]).unwrap();
        assert!(from_scratch.grants.contains(&MemberGrant::parse("issues:create").unwrap()));
        assert!(from_scratch.grants.contains(&MemberGrant::parse("issues:view").unwrap()));
        assert!(!from_scratch.grants.contains(&MemberGrant::parse("issues:update").unwrap()));
    }

    #[test]
    fn drops_an_extra_the_role_already_includes() {
        let viewer = role_grants(LegacyRole::Viewer);
        let access = normalize_member_access(
            &json!({ "grants": ["issues:view", "issues:create"] }),
            &viewer,
        );
        assert_eq!(access.unwrap().grants, grants(&["issues:create"]));
    }

    #[test]
    fn refuses_to_hand_out_a_role_or_projects_the_caller_does_not_have() {
        let viewer = role_grants(LegacyRole::Viewer);
        let member = role_grants(LegacyRole::Member);
        let stored = normalize_member_access(
            &json!({
                "projects": { "all": false, "projectIds": ["pj_1"] },
                "includeUnassigned": false,
                "grants": ["issues:create"],
            }),
            &viewer,
        )
        .unwrap();
        let caller = effective_member_access(Some(&role(viewer.clone())), Some(&stored)).unwrap();
        assert!(!access_within(None, Some(&caller), &viewer));
        assert!(access_within(Some(&stored), Some(&caller), &viewer));
        assert_eq!(
            normalize_member_access(&json!({ "projects": { "all": true }, "grants": [] }), &viewer),
            None
        );
        assert!(!access_within(None, Some(&caller), &member));
    }

    #[test]
    fn drops_invalid_and_duplicate_project_ids() {
        let access = normalize_member_access(
            &json!({ "projects": { "all": false, "projectIds": ["pj_1", "pj_1", "bad id", 4] } }),
            &[],
        )
        .unwrap();
        assert_eq!(access.projects.project_ids, vec!["pj_1".to_owned()]);
        assert!(access.include_unassigned);
    }

    // member-access.spec.ts: effectiveMemberAccess
    #[test]
    fn is_unlimited_for_owners_and_for_a_member_with_the_full_default_role() {
        let owner = WorkspaceRole { owner: true, ..role(role_grants(LegacyRole::Owner)) };
        assert_eq!(effective_member_access(Some(&owner), None), None);
        assert_eq!(
            effective_member_access(Some(&role(role_grants(LegacyRole::Member))), None),
            None
        );
    }

    #[test]
    fn adds_an_extra_on_top_of_a_viewer_who_otherwise_only_views() {
        let viewer = role(role_grants(LegacyRole::Viewer));
        let access = effective_member_access(
            Some(&viewer),
            Some(&MemberAccess {
                projects: MemberProjectScope::every(),
                include_unassigned: true,
                grants: grants(&["issues:create", "issues:view"]),
            }),
        )
        .unwrap();
        assert!(access.grants.contains(&MemberGrant::parse("issues:view").unwrap()));
        assert!(access.grants.contains(&MemberGrant::parse("issues:create").unwrap()));
        assert!(!access.grants.contains(&MemberGrant::parse("issues:update").unwrap()));
    }

    #[test]
    fn an_unknown_role_reaches_nothing() {
        let none = effective_member_access(None, None).unwrap();
        assert!(!none.projects.all);
        assert!(none.grants.is_empty());
    }

    #[test]
    fn project_helpers() {
        let limited = MemberAccess {
            projects: MemberProjectScope { all: false, project_ids: vec!["pj_1".into()] },
            include_unassigned: false,
            grants: Vec::new(),
        };
        assert!(is_project_limited(Some(&limited)));
        assert!(!is_project_limited(None));
        assert!(access_includes_project(Some(&limited), "pj_1"));
        assert!(!access_includes_project(Some(&limited), "pj_2"));
        assert!(access_includes_project(None, "pj_2"));
    }
}
