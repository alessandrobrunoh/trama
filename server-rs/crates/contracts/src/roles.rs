//! Workspace roles, capabilities, token scopes and API permissions.
//!
//! A role is one id with its own set of capabilities and grants: there is no rank, and a higher
//! role does not inherit a lower one. The four old ranks (`owner`, `admin`, `member`, `viewer`)
//! survive only as migrated role ids.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use utoipa::ToSchema;

use crate::access::{
    MEMBER_GRANTS, MemberAccess, MemberGrant, normalize_grant_list, resolve_role_grants,
    role_grants, string_values_schema,
};

/// Id of one workspace role: `owner`, a migrated `admin` / `member` / `viewer`, or a created
/// `role_…`.
pub type Role = String;

/// Default role of a person invited to one or a few projects.
pub const GUEST_ROLE_ID: &str = "guest";
/// Default role that manages projects, milestones and tasks without administering the workspace.
pub const ORGANIZER_ROLE_ID: &str = "organizer";
/// The permanent owner role.
pub const OWNER_ROLE_ID: &str = "owner";
/// Longest role name.
pub const ROLE_NAME_MAX: usize = 40;

string_enum! {
    /// The four ranks a workspace had before roles were defined in settings. Migration only.
    pub enum LegacyRole {
        Owner = "owner",
        Admin = "admin",
        Member = "member",
        Viewer = "viewer",
    }
}

/// `LEGACY_ROLES`.
pub const LEGACY_ROLES: &[LegacyRole] = LegacyRole::ALL;

impl LegacyRole {
    const fn rank(self) -> u8 {
        match self {
            Self::Viewer => 0,
            Self::Member => 1,
            Self::Admin => 2,
            Self::Owner => 3,
        }
    }

    /// Display name of the old rank.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Owner => "Owner",
            Self::Admin => "Admin",
            Self::Member => "Member",
            Self::Viewer => "Viewer",
        }
    }
}

string_enum! {
    /// Capabilities a workspace role can include (Settings → Roles & permissions).
    pub enum Capability {
        ManageProjects = "manageProjects",
        CreateIssues = "createIssues",
        DeleteIssues = "deleteIssues",
        ManageSharedViews = "manageSharedViews",
        InviteMembers = "inviteMembers",
        InviteToProject = "inviteToProject",
        ManageAgents = "manageAgents",
        ManageTokens = "manageTokens",
        ManageIntegrations = "manageIntegrations",
    }
}

/// `CAPABILITIES`, in catalog order.
pub const CAPABILITIES: &[Capability] = Capability::ALL;

string_enum! {
    /// Group a capability is shown under.
    pub enum CapabilityGroup {
        Work = "Work",
        AccessAndAutomation = "Access & automation",
    }
}

/// `CAPABILITY_META[capability]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct CapabilityMeta {
    /// Display name.
    pub label: &'static str,
    /// One-line explanation.
    pub description: &'static str,
    /// Settings group.
    pub group: CapabilityGroup,
}

impl Capability {
    /// `CAPABILITY_META[capability]`.
    #[must_use]
    pub const fn meta(self) -> CapabilityMeta {
        use CapabilityGroup::{AccessAndAutomation as Access, Work};
        let (group, label, description) = match self {
            Self::ManageProjects => {
                (Work, "Manage projects", "Create, edit and delete projects and their milestones.")
            }
            Self::CreateIssues => {
                (Work, "Create issues", "File bugs, features, incidents and other issues.")
            }
            Self::DeleteIssues => {
                (Work, "Delete issues", "Permanently delete an issue (prefer canceling it).")
            }
            Self::ManageSharedViews => {
                (Work, "Share views", "Create or publish saved views for the whole workspace.")
            }
            Self::InviteMembers => (
                Access,
                "Invite members",
                "Add people to the workspace. You can only invite someone into a role whose permissions you already have.",
            ),
            Self::InviteToProject => (
                Access,
                "Share projects",
                "Invite people to a single project as guests, and change or remove their access to it. They never see the rest of the workspace.",
            ),
            Self::ManageAgents => (
                Access,
                "Manage agents",
                "Register agents, edit them, and mint tokens that act as an agent.",
            ),
            Self::ManageTokens => (
                Access,
                "Create API tokens",
                "Create personal API tokens (read / write scope). A write-scoped token cannot create an admin-scoped one.",
            ),
            Self::ManageIntegrations => (
                Access,
                "Manage integrations",
                "Connect GitHub, GitLab and Delta, and manage outgoing webhooks.",
            ),
        };
        CapabilityMeta { label, description, group }
    }

    /// The old rank `DEFAULT_PERMISSIONS` required for this capability.
    #[must_use]
    pub const fn default_rank(self) -> LegacyRole {
        match self {
            Self::InviteMembers
            | Self::InviteToProject
            | Self::ManageAgents
            | Self::ManageIntegrations => LegacyRole::Admin,
            _ => LegacyRole::Member,
        }
    }

    /// One of `ADMIN_CAPABILITIES` (used to require an admin; a write token cannot use it).
    #[must_use]
    pub fn is_admin(self) -> bool {
        self.default_rank() == LegacyRole::Admin
    }
}

/// What each old rank was allowed, before workspace roles (`PermissionMap`). Migration reads
/// this; it is not the live policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PermissionMap([LegacyRole; 9]);

impl PermissionMap {
    /// The minimum rank for `capability`.
    #[must_use]
    pub fn get(&self, capability: Capability) -> LegacyRole {
        self.0[capability as usize]
    }

    /// Sets the minimum rank for `capability`.
    pub fn set(&mut self, capability: Capability, role: LegacyRole) {
        self.0[capability as usize] = role;
    }
}

/// `DEFAULT_PERMISSIONS`: everyday work for members, structure and access for admins.
pub const DEFAULT_PERMISSIONS: PermissionMap = {
    let mut out = [LegacyRole::Member; 9];
    let mut i = 0;
    while i < 9 {
        out[i] = CAPABILITIES[i].default_rank();
        i += 1;
    }
    PermissionMap(out)
};

/// `ADMIN_CAPABILITIES`: capabilities that used to require an admin.
pub const ADMIN_CAPABILITIES: &[Capability] = &[
    Capability::InviteMembers,
    Capability::InviteToProject,
    Capability::ManageAgents,
    Capability::ManageIntegrations,
];

/// The owner role always keeps these, so someone can still manage members.
pub const OWNER_REQUIRED_CAPABILITIES: &[Capability] =
    &[Capability::InviteMembers, Capability::InviteToProject];

/// Capabilities a write-scoped token lacks but that do not make their holder a workspace
/// administrator (an organizer shares projects, nothing more).
const ADMIN_POWER_EXEMPT: &[Capability] = &[Capability::InviteToProject];

/// A role defined by the workspace. `owner` is permanent; every other role can be renamed or
/// deleted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceRole {
    /// Role id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// True only for the permanent owner role.
    pub owner: bool,
    /// Capabilities this role has. Nothing is inherited from another role.
    pub capabilities: Vec<Capability>,
    /// Base work permissions. The owner role always has every grant.
    pub grants: Vec<MemberGrant>,
}

/// True when both ids are old ranks and `role` is at least `min`. Custom role ids are never
/// ranked.
#[must_use]
pub fn legacy_role_at_least(role: &str, min: &str) -> bool {
    match (LegacyRole::parse(role), LegacyRole::parse(min)) {
        (Some(a), Some(b)) => a.rank() >= b.rank(),
        _ => false,
    }
}

/// Deprecated alias of [`legacy_role_at_least`] (`roleAtLeast`); also `hasRole` of
/// `server/src/auth/request-context.ts`.
#[must_use]
pub fn role_at_least(role: &str, min: &str) -> bool {
    legacy_role_at_least(role, min)
}

/// Capabilities an old rank had under `permissions`.
#[must_use]
pub fn capabilities_for_legacy_role(
    role: LegacyRole,
    permissions: &PermissionMap,
) -> Vec<Capability> {
    CAPABILITIES.iter().copied().filter(|cap| role.rank() >= permissions.get(*cap).rank()).collect()
}

/// Known capabilities in catalog order; the owner role gets the required ones back.
#[must_use]
pub fn normalize_capabilities(input: &[Value], owner: bool) -> Vec<Capability> {
    let mut chosen: Vec<Capability> =
        input.iter().filter_map(Value::as_str).filter_map(Capability::parse).collect();
    if owner {
        chosen.extend_from_slice(OWNER_REQUIRED_CAPABILITIES);
    }
    CAPABILITIES.iter().copied().filter(|cap| chosen.contains(cap)).collect()
}

fn capability_values(caps: &[Capability]) -> Vec<Value> {
    caps.iter().map(|c| Value::String(c.as_str().to_owned())).collect()
}

/// The owner role with `capabilities` (plus the required ones).
#[must_use]
pub fn owner_workspace_role(capabilities: &[Capability]) -> WorkspaceRole {
    WorkspaceRole {
        id: OWNER_ROLE_ID.to_owned(),
        name: "Owner".to_owned(),
        owner: true,
        capabilities: normalize_capabilities(&capability_values(capabilities), true),
        grants: MEMBER_GRANTS.to_vec(),
    }
}

/// A brand-new workspace starts with the four old ranks as editable roles, plus Organizer and
/// Guest.
#[must_use]
pub fn fresh_workspace_roles() -> Vec<WorkspaceRole> {
    migrate_legacy_roles(None, None)
}

/// Turns the old owner / admin / member / viewer matrix (`permissions`, `roleGrants` of stored
/// settings) into editable roles with the same capabilities, followed by
/// [`default_project_roles`].
#[must_use]
pub fn migrate_legacy_roles(
    permissions: Option<&Value>,
    grants: Option<&Value>,
) -> Vec<WorkspaceRole> {
    let mut perms = DEFAULT_PERMISSIONS;
    for cap in CAPABILITIES {
        let value = permissions.and_then(|p| p.get(cap.as_str())).and_then(Value::as_str);
        if let Some(role) = value.and_then(LegacyRole::parse) {
            perms.set(*cap, role);
        }
    }
    let by_role = resolve_role_grants(grants);
    let mut roles: Vec<WorkspaceRole> = LEGACY_ROLES
        .iter()
        .map(|id| {
            let owner = *id == LegacyRole::Owner;
            WorkspaceRole {
                id: id.as_str().to_owned(),
                name: id.name().to_owned(),
                owner,
                capabilities: capabilities_for_legacy_role(*id, &perms),
                grants: if owner { MEMBER_GRANTS.to_vec() } else { by_role.get(*id).to_vec() },
            }
        })
        .collect();
    roles.extend(default_project_roles());
    roles
}

/// The Organizer and Guest roles every workspace gets next to the four old ranks.
#[must_use]
pub fn default_project_roles() -> Vec<WorkspaceRole> {
    let guest_grants = [
        "projects:view",
        "milestones:view",
        "issues:view",
        "issues:create",
        "issues:update",
        "artifacts:view",
        "comments:view",
        "comments:create",
        "comments:update",
    ]
    .iter()
    .filter_map(|g| MemberGrant::parse(g))
    .collect();
    vec![
        WorkspaceRole {
            id: ORGANIZER_ROLE_ID.to_owned(),
            name: "Organizer".to_owned(),
            owner: false,
            capabilities: vec![
                Capability::ManageProjects,
                Capability::CreateIssues,
                Capability::DeleteIssues,
                Capability::ManageSharedViews,
                Capability::InviteToProject,
            ],
            grants: MEMBER_GRANTS.to_vec(),
        },
        WorkspaceRole {
            id: GUEST_ROLE_ID.to_owned(),
            name: "Guest".to_owned(),
            owner: false,
            capabilities: vec![Capability::CreateIssues],
            grants: guest_grants,
        },
    ]
}

fn is_role_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=49).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

/// Drops unknown ids, keeps a single owner role, and puts the required capabilities back on it.
#[must_use]
pub fn normalize_workspace_roles(input: &[Value]) -> Vec<WorkspaceRole> {
    let mut roles: Vec<WorkspaceRole> = Vec::new();
    for item in input {
        let Value::Object(raw) = item else { continue };
        let id = raw.get("id").and_then(Value::as_str).map_or("", crate::js::trim);
        if !is_role_id(id) || roles.iter().any(|r| r.id == id) || id == "agent" {
            continue;
        }
        let name = raw.get("name").and_then(Value::as_str).map_or("", crate::js::trim);
        if name.is_empty() || crate::js::len(name) > ROLE_NAME_MAX {
            continue;
        }
        let owner = id == OWNER_ROLE_ID;
        let list = |key: &str| match raw.get(key) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        roles.push(WorkspaceRole {
            id: id.to_owned(),
            name: name.to_owned(),
            owner,
            capabilities: normalize_capabilities(&list("capabilities"), owner),
            grants: if owner {
                MEMBER_GRANTS.to_vec()
            } else {
                normalize_grant_list(&list("grants"))
            },
        });
    }
    if !roles.iter().any(|r| r.owner) {
        roles.insert(0, owner_workspace_role(CAPABILITIES));
    }
    roles
}

/// The role with this id.
#[must_use]
pub fn find_workspace_role<'a>(
    roles: &'a [WorkspaceRole],
    role_id: Option<&str>,
) -> Option<&'a WorkspaceRole> {
    let role_id = role_id.filter(|id| !id.is_empty())?;
    roles.iter().find(|r| r.id == role_id)
}

/// Display name of a role id: the role's name, the old rank's name, or the id itself.
#[must_use]
pub fn workspace_role_name(roles: Option<&[WorkspaceRole]>, role_id: Option<&str>) -> String {
    let Some(role_id) = role_id.filter(|id| !id.is_empty()) else { return String::new() };
    if let Some(found) = roles.and_then(|r| find_workspace_role(r, Some(role_id))) {
        return found.name.clone();
    }
    LegacyRole::parse(role_id).map_or_else(|| role_id.to_owned(), |r| r.name().to_owned())
}

/// Does the role with this id hold `capability`?
#[must_use]
pub fn role_has_capability(roles: &[WorkspaceRole], role_id: &str, capability: Capability) -> bool {
    find_workspace_role(roles, Some(role_id)).is_some_and(|r| r.capabilities.contains(&capability))
}

/// Owner, or a role that holds a capability which used to require an admin.
#[must_use]
pub fn role_has_admin_power(role: Option<&WorkspaceRole>) -> bool {
    role.is_some_and(|role| {
        role.owner
            || ADMIN_CAPABILITIES
                .iter()
                .any(|cap| !ADMIN_POWER_EXEMPT.contains(cap) && role.capabilities.contains(cap))
    })
}

/// Can change everyday work: the owner role, a grant that is not view-only, or a capability that
/// is not workspace administration.
#[must_use]
pub fn role_can_write(role: Option<&WorkspaceRole>) -> bool {
    let Some(role) = role else { return false };
    role.owner
        || role.grants.iter().any(|g| !g.is_view())
        || role.capabilities.iter().any(|cap| !cap.is_admin())
}

/// Agents are not a workspace role. They receive the historical member permissions and never
/// own the workspace.
#[must_use]
pub fn agent_workspace_role() -> WorkspaceRole {
    WorkspaceRole {
        id: "agent".to_owned(),
        name: "Agent".to_owned(),
        owner: false,
        capabilities: capabilities_for_legacy_role(LegacyRole::Member, &DEFAULT_PERMISSIONS),
        grants: role_grants(LegacyRole::Member),
    }
}

/// An owner can grant any role. Anyone else can only grant a role whose capabilities and grants
/// they already have.
#[must_use]
pub fn can_grant_role(caller: Option<&WorkspaceRole>, target: Option<&WorkspaceRole>) -> bool {
    let (Some(caller), Some(target)) = (caller, target) else { return false };
    if target.owner && !caller.owner {
        return false;
    }
    if caller.owner {
        return true;
    }
    target.capabilities.iter().all(|c| caller.capabilities.contains(c))
        && target.grants.iter().all(|g| caller.grants.contains(g))
}

string_enum! {
    /// What a token may do: read = GET only, write = everyday work, admin = everything the
    /// actor's role allows, custom = only the listed permissions.
    pub enum TokenScope {
        Read = "read",
        Write = "write",
        Admin = "admin",
        Custom = "custom",
    }
}

impl TokenScope {
    /// `TOKEN_SCOPES[scope]`: label and description.
    #[must_use]
    pub const fn meta(self) -> (&'static str, &'static str) {
        match self {
            Self::Read => ("Read", "Read-only: GET requests. Good for dashboards and reporting."),
            Self::Write => (
                "Write",
                "Create and update Issues, comments and other work records with at most the member role. Cannot change workspace settings.",
            ),
            Self::Admin => (
                "Admin",
                "Everything the acting user's role allows, including members, integrations and settings. Only admins can create one.",
            ),
            Self::Custom => (
                "Custom",
                "Only the listed permissions (resource × action), always within the acting user's role.",
            ),
        }
    }
}

/// `read` drops every capability and keeps view grants. `write` drops admin capabilities and the
/// owner flag. Other scopes (and none) leave the role as is.
#[must_use]
pub fn apply_token_scope(role: &WorkspaceRole, scope: Option<TokenScope>) -> WorkspaceRole {
    match scope {
        Some(TokenScope::Read) => WorkspaceRole {
            owner: false,
            capabilities: Vec::new(),
            grants: role.grants.iter().copied().filter(|g| g.is_view()).collect(),
            ..role.clone()
        },
        Some(TokenScope::Write) => WorkspaceRole {
            owner: false,
            capabilities: role.capabilities.iter().copied().filter(|c| !c.is_admin()).collect(),
            ..role.clone()
        },
        _ => role.clone(),
    }
}

/// What a route requires (`RoleGate`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoleGate {
    /// Set by `@Can`. A missing capability is rejected, with no grant fallback.
    pub capability: Option<Capability>,
    /// `@Roles`, or the default: `member` for writes and `viewer` for reads.
    pub min: LegacyRole,
    /// The member grant that can stand in for a role that cannot write.
    pub needed_grant: Option<MemberGrant>,
}

/// Whether this role may pass the gate. Personal extras can cover a write that the role itself
/// cannot.
#[must_use]
pub fn role_allows(
    role: Option<&WorkspaceRole>,
    gate: &RoleGate,
    access: Option<&MemberAccess>,
) -> bool {
    let Some(role) = role else { return false };
    if let Some(cap) = gate.capability {
        return role.capabilities.contains(&cap);
    }
    match gate.min {
        LegacyRole::Owner => return role.owner,
        LegacyRole::Admin => {
            if role_has_admin_power(Some(role)) {
                return true;
            }
        }
        LegacyRole::Viewer => return true,
        LegacyRole::Member => {
            if role_can_write(Some(role)) {
                return true;
            }
        }
    }
    gate.needed_grant.is_some_and(|g| access.is_some_and(|a| a.grants.contains(&g)))
}

// ───────────────────────────── API permissions ─────────────────────────────

string_enum! {
    /// Action of an API permission: GET → read, POST/PUT/PATCH → write, DELETE → delete.
    pub enum ApiAction {
        Read = "read",
        Write = "write",
        Delete = "delete",
    }
}

string_enum! {
    /// Resource of an API permission: the `/w/:slug/<resource>/…` route segment. Listed in the
    /// order of `API_RESOURCES`.
    pub enum ApiResource {
        Projects = "projects",
        Tasks = "tasks",
        Milestones = "milestones",
        Comments = "comments",
        Artifacts = "artifacts",
        Views = "views",
        Attention = "attention",
        Search = "search",
        Events = "events",
        Snapshot = "snapshot",
        Insights = "insights",
        Workspace = "workspace",
        Members = "members",
        Agents = "agents",
        Tokens = "tokens",
        Integrations = "integrations",
        OutgoingWebhooks = "outgoing-webhooks",
    }
}

string_enum! {
    /// Group an API resource is shown under.
    pub enum ApiResourceGroup {
        Work = "Work",
        Insight = "Insight",
        Organization = "Organization",
        AccessAndAutomation = "Access & automation",
    }
}

/// `API_RESOURCES[resource]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct ApiResourceMeta {
    /// Display name.
    pub label: &'static str,
    /// Settings group.
    pub group: ApiResourceGroup,
    /// Actions that exist for this resource.
    pub actions: &'static [ApiAction],
}

const RWD: &[ApiAction] = ApiAction::ALL;

impl ApiResource {
    /// `API_RESOURCES[resource]`.
    #[must_use]
    pub const fn meta(self) -> ApiResourceMeta {
        use ApiResourceGroup::{AccessAndAutomation as Access, Insight, Organization, Work};
        const READ: &[ApiAction] = &[ApiAction::Read];
        const RW: &[ApiAction] = &[ApiAction::Read, ApiAction::Write];
        let (label, group, actions) = match self {
            Self::Projects => ("Projects", Work, RWD),
            Self::Tasks => ("Tasks", Work, RWD),
            Self::Milestones => ("Milestones", Work, RWD),
            Self::Comments => ("Comments", Work, RWD),
            Self::Artifacts => ("Artifacts", Work, RWD),
            Self::Views => ("Views", Work, RWD),
            Self::Attention => ("Attention", Work, RW),
            Self::Search => ("Search", Insight, READ),
            Self::Events => ("Activity log", Insight, READ),
            Self::Snapshot => ("Snapshot", Insight, READ),
            Self::Insights => ("Insights", Insight, READ),
            Self::Workspace => ("Workspace & settings", Organization, RWD),
            Self::Members => ("Members", Access, RWD),
            Self::Agents => ("Agents", Access, RWD),
            Self::Tokens => ("API tokens", Access, RWD),
            Self::Integrations => ("Integrations", Access, RWD),
            Self::OutgoingWebhooks => ("Outgoing webhooks", Access, RWD),
        };
        ApiResourceMeta { label, group, actions }
    }
}

/// `${ApiResource}:${ApiAction}`, e.g. `tasks:write`. On the wire it is that string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ApiPermission {
    /// The resource.
    pub resource: ApiResource,
    /// The action.
    pub action: ApiAction,
}

impl ApiPermission {
    /// A permission (not checked against the resource's actions).
    #[must_use]
    pub const fn new(resource: ApiResource, action: ApiAction) -> Self {
        Self { resource, action }
    }

    /// `resource:action` when it is one of [`api_permissions`].
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        let (resource, action) = value.split_once(':')?;
        let resource = ApiResource::parse(resource)?;
        let action = ApiAction::parse(action)?;
        resource.meta().actions.contains(&action).then_some(Self { resource, action })
    }
}

impl fmt::Display for ApiPermission {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.resource, self.action)
    }
}

impl Serialize for ApiPermission {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ApiPermission {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown API permission \"{raw}\"")))
    }
}

impl utoipa::PartialSchema for ApiPermission {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        string_values_schema(api_permissions().iter().map(ToString::to_string))
    }
}

impl ToSchema for ApiPermission {}

/// `API_PERMISSIONS`: every permission, resource by resource in `API_RESOURCES` order.
#[must_use]
pub fn api_permissions() -> Vec<ApiPermission> {
    ApiResource::ALL
        .iter()
        .flat_map(|r| r.meta().actions.iter().map(|a| ApiPermission::new(*r, *a)))
        .collect()
}

/// A starting point offered in Settings (`PERMISSION_PRESETS`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct PermissionPreset {
    /// `read-only`, `contributor` or `everything`.
    pub id: &'static str,
    /// Display name.
    pub label: &'static str,
    /// One-line explanation.
    pub description: &'static str,
    /// The permissions it selects.
    pub permissions: Vec<ApiPermission>,
}

/// `PERMISSION_PRESETS`, in order.
#[must_use]
pub fn permission_presets() -> Vec<PermissionPreset> {
    let all = api_permissions();
    let read_all: Vec<ApiPermission> =
        all.iter().copied().filter(|p| p.action == ApiAction::Read).collect();
    let mut contributor = read_all.clone();
    contributor.extend(
        [
            ApiResource::Projects,
            ApiResource::Tasks,
            ApiResource::Milestones,
            ApiResource::Comments,
            ApiResource::Artifacts,
            ApiResource::Views,
        ]
        .iter()
        .map(|r| ApiPermission::new(*r, ApiAction::Write)),
    );
    contributor.push(ApiPermission::new(ApiResource::Attention, ApiAction::Write));
    vec![
        PermissionPreset {
            id: "read-only",
            label: "Read-only",
            description: "Read every resource. Nothing can be changed.",
            permissions: read_all,
        },
        PermissionPreset {
            id: "contributor",
            label: "Contributor",
            description: "Read everything and create/update work items. No deletes, no members, tokens or integrations.",
            permissions: contributor,
        },
        PermissionPreset {
            id: "everything",
            label: "Everything",
            description: "All permissions. The acting user's role still applies.",
            permissions: all,
        },
    ]
}

/// Request budget of an API token (enforced server-side; sessions are not limited).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TokenLimits {
    /// Requests per minute.
    pub requests_per_minute: i64,
    /// Writes per minute.
    pub writes_per_minute: i64,
    /// Writes per day.
    pub writes_per_day: i64,
}

/// `DEFAULT_TOKEN_LIMITS`.
pub const DEFAULT_TOKEN_LIMITS: TokenLimits =
    TokenLimits { requests_per_minute: 600, writes_per_minute: 60, writes_per_day: 2000 };

/// `MAX_TOKEN_LIMITS`: upper bounds a token can be configured with.
pub const MAX_TOKEN_LIMITS: TokenLimits =
    TokenLimits { requests_per_minute: 6000, writes_per_minute: 600, writes_per_day: 20000 };

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn api_permissions_follow_the_resource_catalog() {
        let all = api_permissions();
        assert_eq!(all.len(), 42);
        assert_eq!(all[0].to_string(), "projects:read");
        assert_eq!(all.last().unwrap().to_string(), "outgoing-webhooks:delete");
        assert_eq!(ApiPermission::parse("search:write"), None);
        assert_eq!(ApiPermission::parse("issues:read"), None);
        assert!(ApiPermission::parse("attention:write").is_some());
        let presets = permission_presets();
        assert_eq!(presets[0].permissions.len(), 17);
        assert_eq!(presets[1].permissions.len(), 17 + 7);
        assert_eq!(presets[2].permissions, all);
    }

    #[test]
    fn default_permissions_and_admin_capabilities() {
        assert_eq!(DEFAULT_PERMISSIONS.get(Capability::ManageTokens), LegacyRole::Member);
        assert_eq!(DEFAULT_PERMISSIONS.get(Capability::ManageAgents), LegacyRole::Admin);
        let admin: Vec<Capability> =
            CAPABILITIES.iter().copied().filter(|c| c.is_admin()).collect();
        assert_eq!(admin, ADMIN_CAPABILITIES);
    }

    #[test]
    fn legacy_ranks_compare_only_known_ids() {
        assert!(legacy_role_at_least("owner", "admin"));
        assert!(legacy_role_at_least("member", "member"));
        assert!(!legacy_role_at_least("viewer", "member"));
        assert!(!legacy_role_at_least("organizer", "viewer"));
        assert!(!legacy_role_at_least("member", "organizer"));
    }

    #[test]
    fn normalizes_stored_roles() {
        let roles = normalize_workspace_roles(&[
            json!({ "id": " support ", "name": " Support ", "capabilities": ["manageProjects", "nope"], "grants": ["issues:create"] }),
            json!({ "id": "support", "name": "Dup" }),
            json!({ "id": "agent", "name": "Agent" }),
            json!({ "id": "Bad", "name": "Bad" }),
            json!({ "id": "empty", "name": "  " }),
            json!("junk"),
        ]);
        assert_eq!(roles.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["owner", "support"]);
        assert_eq!(roles[0].capabilities, CAPABILITIES);
        assert_eq!(roles[1].name, "Support");
        assert_eq!(roles[1].capabilities, [Capability::ManageProjects]);
        assert_eq!(
            roles[1].grants.iter().map(ToString::to_string).collect::<Vec<_>>(),
            ["issues:view", "issues:create"]
        );
    }

    #[test]
    fn names_roles() {
        let roles = fresh_workspace_roles();
        assert_eq!(workspace_role_name(Some(&roles), Some("guest")), "Guest");
        assert_eq!(workspace_role_name(None, Some("admin")), "Admin");
        assert_eq!(workspace_role_name(None, Some("role_x")), "role_x");
        assert_eq!(workspace_role_name(None, None), "");
    }

    #[test]
    fn granting_needs_the_target_within_the_caller() {
        let roles = fresh_workspace_roles();
        let find = |id| find_workspace_role(&roles, Some(id));
        assert!(can_grant_role(find("owner"), find("owner")));
        assert!(!can_grant_role(find("admin"), find("owner")));
        assert!(can_grant_role(find("admin"), find("member")));
        assert!(!can_grant_role(find("member"), find("admin")));
        assert!(!can_grant_role(None, find("member")));
    }

    #[test]
    fn token_scopes_narrow_the_role() {
        let roles = fresh_workspace_roles();
        let owner = find_workspace_role(&roles, Some("owner")).unwrap();
        let read = apply_token_scope(owner, Some(TokenScope::Read));
        assert!(!read.owner && read.capabilities.is_empty());
        assert!(read.grants.iter().all(|g| g.is_view()));
        let write = apply_token_scope(owner, Some(TokenScope::Write));
        assert!(!write.owner);
        assert!(!write.capabilities.contains(&Capability::InviteMembers));
        assert!(write.capabilities.contains(&Capability::ManageTokens));
        assert_eq!(apply_token_scope(owner, Some(TokenScope::Admin)), *owner);
        assert_eq!(apply_token_scope(owner, None), *owner);
    }

    #[test]
    fn agents_get_the_member_permissions() {
        let agent = agent_workspace_role();
        assert!(!agent.owner);
        assert!(agent.capabilities.contains(&Capability::CreateIssues));
        assert!(!agent.capabilities.contains(&Capability::InviteMembers));
        assert_eq!(agent.grants, role_grants(LegacyRole::Member));
    }

    #[test]
    fn viewer_gates() {
        let roles = fresh_workspace_roles();
        let viewer = find_workspace_role(&roles, Some("viewer"));
        let write = RoleGate {
            capability: None,
            min: LegacyRole::Member,
            needed_grant: MemberGrant::parse("issues:create"),
        };
        assert!(!role_allows(viewer, &write, None));
        let extra = MemberAccess {
            projects: crate::access::MemberProjectScope::every(),
            include_unassigned: true,
            grants: vec![MemberGrant::parse("issues:create").unwrap()],
        };
        assert!(role_allows(viewer, &write, Some(&extra)));
        let read = RoleGate { capability: None, min: LegacyRole::Viewer, needed_grant: None };
        assert!(role_allows(viewer, &read, None));
        assert!(!role_allows(None, &read, None));
        let owner_only = RoleGate { capability: None, min: LegacyRole::Owner, needed_grant: None };
        assert!(!role_allows(find_workspace_role(&roles, Some("admin")), &owner_only, None));
        assert!(role_allows(find_workspace_role(&roles, Some("owner")), &owner_only, None));
    }
}
