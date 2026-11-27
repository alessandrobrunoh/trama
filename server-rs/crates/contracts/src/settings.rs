//! Workspace settings: defaults and resolution of the stored (partial) settings JSON.
//!
//! A workspace row stores only what was customized. NestJS resolves it with
//! `WorkspaceEntity.resolved()` (`resolveWorkspaceSettings`) before reading roles, labels or
//! statuses and before sending a workspace; [`resolve_workspace_settings`] is that function over
//! the row's `settings` column.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use utoipa::ToSchema;

use crate::labels::{WorkspaceLabel, resolve_label_catalog};
use crate::roles::{
    WorkspaceRole, fresh_workspace_roles, migrate_legacy_roles, normalize_workspace_roles,
};
use crate::status::{StatusCatalog, default_status_catalog, resolve_status_catalog};

string_enum! {
    /// Scale offered for issue estimates. Estimates are stored as numbers either way.
    pub enum EstimateScale {
        Fibonacci = "fibonacci",
        Linear = "linear",
        Exponential = "exponential",
        Tshirt = "tshirt",
        None = "none",
    }
}

/// `ESTIMATE_SCALES`.
pub const ESTIMATE_SCALES: &[EstimateScale] = EstimateScale::ALL;

string_enum! {
    /// First day of the week.
    pub enum WeekStart {
        Monday = "monday",
        Sunday = "sunday",
        Saturday = "saturday",
    }
}

/// `WEEK_STARTS`.
pub const WEEK_STARTS: &[WeekStart] = WeekStart::ALL;

/// Settings of a workspace, always fully resolved on the wire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettings {
    /// Roles people and invitations can hold.
    pub roles: Vec<WorkspaceRole>,
    /// Scale offered for issue estimates.
    pub estimate_scale: EstimateScale,
    /// First day of the week.
    pub week_start: WeekStart,
    /// IANA time zone used to display dates, or `auto` to follow each person's browser.
    pub time_zone: String,
    /// Workspace icon background, `#rrggbb`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_color: Option<String>,
    /// 1-2 characters shown in the workspace icon (defaults to the name's initial).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_initial: Option<String>,
    /// Workspace-defined labels. Assign these ids; do not invent names.
    pub labels: Vec<WorkspaceLabel>,
    /// Status catalogs.
    pub statuses: StatusCatalog,
    /// Any other stored key, passed through unchanged as `resolveWorkspaceSettings` does.
    #[serde(flatten)]
    #[schema(ignore)]
    pub extra: Map<String, Value>,
}

/// `DEFAULT_WORKSPACE_SETTINGS`.
#[must_use]
pub fn default_workspace_settings() -> WorkspaceSettings {
    WorkspaceSettings {
        roles: fresh_workspace_roles(),
        estimate_scale: EstimateScale::Fibonacci,
        week_start: WeekStart::Monday,
        time_zone: "auto".to_owned(),
        icon_color: None,
        icon_initial: None,
        labels: resolve_label_catalog(None),
        statuses: default_status_catalog(),
        extra: Map::new(),
    }
}

/// Keys with a typed field.
const TYPED_KEYS: &[&str] = &[
    "roles",
    "estimateScale",
    "weekStart",
    "timeZone",
    "iconColor",
    "iconInitial",
    "labels",
    "statuses",
];

/// Retired keys `resolveWorkspaceSettings` drops.
const DROPPED_KEYS: &[&str] =
    &["permissions", "roleGrants", "deltaThreads", "defaultTeamId", "customerTiers"];

/// Fills the gaps of stored (partial) settings with the defaults. Missing `roles` becomes the
/// migrated old ranks (from the legacy `permissions` / `roleGrants` matrix when present), and
/// labels and statuses are normalized.
///
/// A stored `estimateScale` or `weekStart` outside the catalog falls back to the default (NestJS
/// would echo it); the settings endpoint never stores one.
#[must_use]
pub fn resolve_workspace_settings(raw: &Value) -> WorkspaceSettings {
    let empty = Map::new();
    let r = raw.as_object().unwrap_or(&empty);
    let roles = match r.get("roles") {
        Some(Value::Array(items)) => normalize_workspace_roles(items),
        _ => migrate_legacy_roles(r.get("permissions"), r.get("roleGrants")),
    };
    let text = |key: &str| r.get(key).and_then(Value::as_str);
    let defaults = default_workspace_settings();
    WorkspaceSettings {
        roles,
        estimate_scale: text("estimateScale")
            .and_then(EstimateScale::parse)
            .unwrap_or(defaults.estimate_scale),
        week_start: text("weekStart").and_then(WeekStart::parse).unwrap_or(defaults.week_start),
        time_zone: text("timeZone").map_or(defaults.time_zone, ToOwned::to_owned),
        icon_color: text("iconColor").map(ToOwned::to_owned),
        icon_initial: text("iconInitial").map(ToOwned::to_owned),
        labels: resolve_label_catalog(r.get("labels")),
        statuses: resolve_status_catalog(r.get("statuses")),
        extra: r
            .iter()
            .filter(|(k, _)| {
                !TYPED_KEYS.contains(&k.as_str()) && !DROPPED_KEYS.contains(&k.as_str())
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::access::{MemberGrant, role_grants};
    use crate::roles::{
        Capability, DEFAULT_PERMISSIONS, LegacyRole, RoleGate, find_workspace_role,
        normalize_workspace_roles, role_allows, role_has_capability,
    };

    fn permissions_json(over: &[(Capability, LegacyRole)]) -> Value {
        let mut map = Map::new();
        for cap in crate::roles::CAPABILITIES {
            let role =
                over.iter().find(|(c, _)| c == cap).map_or(DEFAULT_PERMISSIONS.get(*cap), |o| o.1);
            map.insert(cap.as_str().to_owned(), json!(role.as_str()));
        }
        Value::Object(map)
    }

    fn grant_strings(role: LegacyRole) -> Vec<String> {
        role_grants(role).iter().map(ToString::to_string).collect()
    }

    // workspaces/roles.spec.ts: migration
    #[test]
    fn migrates_a_member_who_was_member_onto_a_role_with_the_same_capabilities() {
        let settings = resolve_workspace_settings(&json!({
            "permissions": permissions_json(&[(Capability::ManageProjects, LegacyRole::Admin)]),
            "roleGrants": { "member": grant_strings(LegacyRole::Member), "viewer": grant_strings(LegacyRole::Viewer) },
        }));
        let member = find_workspace_role(&settings.roles, Some("member")).unwrap();
        assert_eq!((member.name.as_str(), member.owner), ("Member", false));
        assert!(member.capabilities.contains(&Capability::CreateIssues));
        assert!(!member.capabilities.contains(&Capability::ManageProjects));
        assert!(!member.capabilities.contains(&Capability::InviteMembers));
        assert_eq!(member.grants, role_grants(LegacyRole::Member));
        assert!(role_has_capability(&settings.roles, "member", Capability::CreateIssues));
        let write = RoleGate {
            capability: None,
            min: LegacyRole::Member,
            needed_grant: MemberGrant::parse("issues:create"),
        };
        assert!(role_allows(Some(member), &write, None));
        let invite = RoleGate {
            capability: Some(Capability::InviteMembers),
            min: LegacyRole::Member,
            needed_grant: None,
        };
        assert!(!role_allows(Some(member), &invite, None));
        let fresh = resolve_workspace_settings(
            &json!({ "roles": serde_json::to_value(fresh_workspace_roles()).unwrap() }),
        );
        assert_eq!(
            fresh.roles.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["owner", "admin", "member", "viewer", "organizer", "guest"]
        );
    }

    // workspaces/roles.spec.ts: a created role is enforced as configured
    #[test]
    fn enforces_a_custom_role_and_refuses_a_capability_it_does_not_have() {
        let mut roles = serde_json::to_value(fresh_workspace_roles()).unwrap();
        roles.as_array_mut().unwrap().push(json!({
            "id": "role_support", "name": "Support", "owner": false,
            "capabilities": ["manageProjects"], "grants": ["issues:view"],
        }));
        let settings = resolve_workspace_settings(&json!({ "roles": roles }));
        let support = settings.roles.iter().find(|r| r.name == "Support").unwrap();
        assert!(!support.owner);
        assert_eq!(support.capabilities, [Capability::ManageProjects]);
        assert_eq!(support.grants, [MemberGrant::parse("issues:view").unwrap()]);
        let gate = |cap, min| RoleGate { capability: Some(cap), min, needed_grant: None };
        assert!(role_allows(
            Some(support),
            &gate(Capability::ManageProjects, LegacyRole::Member),
            None
        ));
        assert!(!role_allows(
            Some(support),
            &gate(Capability::ManageIntegrations, LegacyRole::Member),
            None
        ));
        assert!(!role_allows(
            Some(support),
            &gate(Capability::InviteMembers, LegacyRole::Admin),
            None
        ));
        assert!(role_has_capability(&settings.roles, "owner", Capability::InviteMembers));
    }

    // workspaces/roles.spec.ts: the owner role keeps invite members
    #[test]
    fn keeps_invite_members_on_the_owner_role_even_when_a_save_tries_to_remove_it() {
        let roles = normalize_workspace_roles(&[
            json!({ "id": "owner", "name": "Owner", "capabilities": ["createIssues"] }),
        ]);
        let owner = roles.iter().find(|r| r.owner).unwrap();
        assert!(owner.capabilities.contains(&Capability::InviteMembers));
        assert!(owner.capabilities.contains(&Capability::CreateIssues));
        assert!(!owner.capabilities.contains(&Capability::ManageAgents));
        assert_eq!(owner.grants.len(), crate::access::MEMBER_GRANTS.len());
    }

    #[test]
    fn fills_defaults_and_passes_other_keys_through() {
        let settings = resolve_workspace_settings(&json!({
            "weekStart": "sunday",
            "iconColor": "#112233",
            "customerTiers": ["gold"],
            "deltaThreads": true,
            "somethingNew": 1,
        }));
        assert_eq!(settings.week_start, WeekStart::Sunday);
        assert_eq!(settings.estimate_scale, EstimateScale::Fibonacci);
        assert_eq!(settings.time_zone, "auto");
        let out = serde_json::to_value(&settings).unwrap();
        assert_eq!(out["iconColor"], "#112233");
        assert!(out.get("iconInitial").is_none());
        assert!(out.get("customerTiers").is_none() && out.get("deltaThreads").is_none());
        assert_eq!(out["somethingNew"], 1);
        assert_eq!(out["labels"], json!([]));
        assert_eq!(out["statuses"]["projectHealth"][0]["type"], "on_track");
        assert_eq!(out["roles"][0]["grants"][0], "projects:view");
        assert_eq!(resolve_workspace_settings(&Value::Null), default_workspace_settings());
    }
}
