//! Identity and workspace: users, workspaces, memberships, invitations, project sharing, agents,
//! notifications, favorites and external identities.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::access::MemberAccess;
use crate::common::{ActorRef, AgentProvider, GitProvider, Id, IsoDate, LegacySubjectRef};
use crate::roles::Role;
use crate::settings::{WorkspaceSettings, resolve_workspace_settings};

/// A person's account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct User {
    /// User id (`u_…`).
    pub id: Id,
    /// Display name.
    pub name: String,
    /// Email, stored lower-cased.
    pub email: String,
    /// Avatar hue (0–359).
    pub avatar_hue: i32,
    /// Sign-up time.
    pub created_at: IsoDate,
}

impl From<&trama_entities::users::Model> for User {
    fn from(row: &trama_entities::users::Model) -> Self {
        Self {
            id: row.id.clone(),
            name: row.name.clone(),
            email: row.email.clone(),
            avatar_hue: row.avatar_hue,
            created_at: trama_core::time::to_iso(&row.created_at),
        }
    }
}

/// A workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    /// Workspace id (`ws_…`).
    pub id: Id,
    /// Display name.
    pub name: String,
    /// URL slug.
    pub slug: String,
    /// Always fully resolved by the server (defaults filled in).
    pub settings: WorkspaceSettings,
    /// The user who owns the workspace: its creator until ownership is transferred. Absent on
    /// legacy rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_owner_id: Option<Id>,
    /// The person's own workspace, created on sign-up. Rows always carry it (`false` on every
    /// other workspace).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub personal: Option<bool>,
    /// Creation time.
    pub created_at: IsoDate,
}

impl From<&trama_entities::workspaces::Model> for Workspace {
    /// What `WorkspaceEntity.toJSON()` sends: the row with resolved settings.
    fn from(row: &trama_entities::workspaces::Model) -> Self {
        Self {
            id: row.id.clone(),
            name: row.name.clone(),
            slug: row.slug.clone(),
            settings: resolve_workspace_settings(&row.settings),
            primary_owner_id: row.primary_owner_id.clone(),
            personal: Some(row.personal),
            created_at: trama_core::time::to_iso(&row.created_at),
        }
    }
}

/// One person's membership of a workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    /// Membership id (`mb_…`).
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// User id.
    pub user_id: Id,
    /// Workspace role id.
    pub role: Role,
    /// Join time.
    pub created_at: IsoDate,
    /// Added on top of the role: extra actions and an optional project limit. Absent means the
    /// role as configured, on every project.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<MemberAccess>,
}

/// The stored `access` column as [`MemberAccess`] (`None` for SQL or JSON null).
#[must_use]
pub fn stored_member_access(value: Option<&Value>) -> Option<MemberAccess> {
    value.filter(|v| !v.is_null()).and_then(|v| serde_json::from_value(v.clone()).ok())
}

impl From<&trama_entities::memberships::Model> for Membership {
    fn from(row: &trama_entities::memberships::Model) -> Self {
        Self {
            id: row.id.clone(),
            workspace_id: row.workspace_id.clone(),
            user_id: row.user_id.clone(),
            role: row.role.clone(),
            created_at: trama_core::time::to_iso(&row.created_at),
            access: stored_member_access(row.access.as_ref()),
        }
    }
}

/// A registered agent identity inside a workspace (its own actor, with API tokens).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    /// Agent id.
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Display name.
    pub name: String,
    /// Runtime.
    pub provider: AgentProvider,
    /// What it does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The person responsible for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<Id>,
    /// Creation time.
    pub created_at: IsoDate,
}

// ───────────────────────────── Invitations and sharing ─────────────────────────────

/// Days an invitation stays valid. Resending an invitation starts a new period.
pub const INVITE_TTL_DAYS: i64 = 7;

/// A pending invitation to join a workspace, bound to one email address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInvite {
    /// Invitation id (`inv_…`).
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Invited address.
    pub email: String,
    /// Role they get.
    pub role: Role,
    /// Same shape as a membership. Absent means the role applies in full once they join.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<MemberAccess>,
    /// Who invited them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invited_by_user_id: Option<Id>,
    /// Creation time.
    pub created_at: IsoDate,
    /// Expiry.
    pub expires_at: IsoDate,
    /// When an email was last sent (absent when the server has no mail configured).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emailed_at: Option<IsoDate>,
}

/// Response of creating or resending an invitation: share `url` if the email did not arrive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct InviteLink {
    /// The invitation.
    pub invite: WorkspaceInvite,
    /// The secret link.
    pub url: String,
    /// False when the server has no mail transport configured (`SMTP_URL`).
    pub emailed: bool,
}

/// What anyone holding an invitation link may see before signing in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreview {
    /// Workspace name.
    pub workspace_name: String,
    /// Role id.
    pub role: Role,
    /// Display name of `role`.
    pub role_name: String,
    /// Invited address.
    pub email: String,
    /// Who invited them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invited_by_name: Option<String>,
    /// Expiry.
    pub expires_at: IsoDate,
}

/// One person with access to a project, as listed by its Share dialog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShareMember {
    /// The membership.
    #[serde(flatten)]
    pub membership: Membership,
    /// The person.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<User>,
    /// Sees every project of the workspace, so this project cannot be taken away on its own.
    pub all_projects: bool,
}

/// `GET /projects/:id/share`: who can open the project, and who was invited and has not joined.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProjectShare {
    /// People with access.
    pub members: Vec<ProjectShareMember>,
    /// Pending invitations.
    pub invites: Vec<WorkspaceInvite>,
}

/// `POST /projects/:id/invites`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProjectInviteResult {
    /// A person without access got an invitation (share `link.url` if the email did not
    /// arrive).
    Invited {
        /// The invitation link.
        link: InviteLink,
    },
    /// An existing guest or limited member now also sees this project.
    Added {
        /// Their share row.
        member: ProjectShareMember,
    },
}

// ───────────────────────────── Notifications ─────────────────────────────

string_enum! {
    /// Why a notification was sent. Each kind can be switched on or off per person and channel.
    pub enum NotificationKind {
        Assigned = "assigned",
        ReviewRequested = "review_requested",
        CiFailed = "ci_failed",
        Comment = "comment",
    }
}

/// `NOTIFICATION_KINDS`.
pub const NOTIFICATION_KINDS: &[NotificationKind] = NotificationKind::ALL;

impl NotificationKind {
    /// `NOTIFICATION_KIND_META[kind]`: label and description.
    #[must_use]
    pub const fn meta(self) -> (&'static str, &'static str) {
        match self {
            Self::Assigned => ("Assigned to me", "An issue is assigned to you."),
            Self::ReviewRequested => {
                ("Review requested", "A pull request attached to your issue needs a review.")
            }
            Self::CiFailed => ("Failing checks", "CI fails on an artifact attached to your issue."),
            Self::Comment => ("Comments", "New comments on issues you are assigned or reported."),
        }
    }
}

string_enum! {
    /// Kind of a stored notification: stored rows from the retired Workstream updater remain
    /// readable.
    pub enum NotificationRecordKind {
        Assigned = "assigned",
        ReviewRequested = "review_requested",
        CiFailed = "ci_failed",
        Comment = "comment",
        WorkstreamUpdate = "workstream_update",
    }
}

string_enum! {
    /// Delivery channel.
    pub enum NotificationChannel {
        InApp = "inApp",
        Email = "email",
        Push = "push",
    }
}

/// Per channel on/off.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationChannels {
    /// In-app inbox.
    pub in_app: bool,
    /// Email.
    pub email: bool,
    /// Web push.
    pub push: bool,
}

impl NotificationChannels {
    /// Whether `channel` is on.
    #[must_use]
    pub const fn get(&self, channel: NotificationChannel) -> bool {
        match channel {
            NotificationChannel::InApp => self.in_app,
            NotificationChannel::Email => self.email,
            NotificationChannel::Push => self.push,
        }
    }
}

/// In-app on, email off, push on (a push only reaches devices where the person turned it on).
pub const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannels =
    NotificationChannels { in_app: true, email: false, push: true };

/// Per kind and channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct NotificationSettings {
    /// `assigned`.
    pub assigned: NotificationChannels,
    /// `review_requested`.
    pub review_requested: NotificationChannels,
    /// `ci_failed`.
    pub ci_failed: NotificationChannels,
    /// `comment`.
    pub comment: NotificationChannels,
}

impl NotificationSettings {
    /// The channels of one kind.
    #[must_use]
    pub const fn get(&self, kind: NotificationKind) -> NotificationChannels {
        match kind {
            NotificationKind::Assigned => self.assigned,
            NotificationKind::ReviewRequested => self.review_requested,
            NotificationKind::CiFailed => self.ci_failed,
            NotificationKind::Comment => self.comment,
        }
    }
}

/// Fills the gaps of stored (partial) settings with the defaults (the users'
/// `notificationSettings` column). A stored channel that is not a boolean keeps the default.
#[must_use]
pub fn resolve_notification_settings(raw: Option<&Value>) -> NotificationSettings {
    let kind = |kind: NotificationKind| {
        let stored = raw.and_then(|r| r.get(kind.as_str()));
        let flag = |key: &str, default: bool| {
            stored.and_then(|s| s.get(key)).and_then(Value::as_bool).unwrap_or(default)
        };
        NotificationChannels {
            in_app: flag("inApp", DEFAULT_NOTIFICATION_CHANNELS.in_app),
            email: flag("email", DEFAULT_NOTIFICATION_CHANNELS.email),
            push: flag("push", DEFAULT_NOTIFICATION_CHANNELS.push),
        }
    };
    NotificationSettings {
        assigned: kind(NotificationKind::Assigned),
        review_requested: kind(NotificationKind::ReviewRequested),
        ci_failed: kind(NotificationKind::CiFailed),
        comment: kind(NotificationKind::Comment),
    }
}

/// A message for one person, created from something that happened in a workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    /// Notification id (`ntf_…`).
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Why it was sent.
    pub kind: NotificationRecordKind,
    /// Headline.
    pub title: String,
    /// A short excerpt (a comment, a question), when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Who caused it.
    pub actor: ActorRef,
    /// The record it is about.
    pub subject: LegacySubjectRef,
    /// Where it leads, relative to the workspace, e.g. `issues/AUTH-142`.
    pub link: String,
    /// Creation time.
    pub created_at: IsoDate,
    /// Absent while unread.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<IsoDate>,
}

/// Response of `GET /w/:slug/notifications`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct NotificationList {
    /// The page.
    pub items: Vec<Notification>,
    /// Unread in this workspace, whatever the page size.
    pub unread: i64,
}

// ───────────────────────────── Favorites ─────────────────────────────

string_enum! {
    /// What a person can pin to their Favorites.
    pub enum FavoriteType {
        Issue = "issue",
        Project = "project",
        View = "view",
    }
}

/// `FAVORITE_TYPES`.
pub const FAVORITE_TYPES: &[FavoriteType] = FavoriteType::ALL;
/// Most favorites one person can keep in a workspace.
pub const MAX_FAVORITES: usize = 100;

/// A pinned entity. Private to its owner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    /// Favorite id (`fav_…`).
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Pinned kind.
    #[serde(rename = "type")]
    pub kind: FavoriteType,
    /// Id (not key) of the issue, project, or view.
    pub subject_id: Id,
    /// Creation time.
    pub created_at: IsoDate,
}

// ───────────────────────────── External identities ─────────────────────────────

string_enum! {
    /// Tools where a person has a login that is not their Trama account.
    pub enum ExternalIdentityProvider {
        Github = "github",
        Gitlab = "gitlab",
        Bitbucket = "bitbucket",
        Linear = "linear",
        Jira = "jira",
    }
}

/// `EXTERNAL_IDENTITY_PROVIDERS`.
pub const EXTERNAL_IDENTITY_PROVIDERS: &[ExternalIdentityProvider] = ExternalIdentityProvider::ALL;

impl ExternalIdentityProvider {
    /// `EXTERNAL_IDENTITY_PROVIDER_META[provider]`: label and default host (Jira has none).
    #[must_use]
    pub const fn meta(self) -> (&'static str, Option<&'static str>) {
        match self {
            Self::Github => ("GitHub", Some("github.com")),
            Self::Gitlab => ("GitLab", Some("gitlab.com")),
            Self::Bitbucket => ("Bitbucket", Some("bitbucket.org")),
            Self::Linear => ("Linear", Some("linear.app")),
            Self::Jira => ("Jira", None),
        }
    }
}

impl From<GitProvider> for ExternalIdentityProvider {
    fn from(value: GitProvider) -> Self {
        match value {
            GitProvider::Github => Self::Github,
            GitProvider::Gitlab => Self::Gitlab,
            GitProvider::Bitbucket => Self::Bitbucket,
        }
    }
}

string_enum! {
    /// `connection`: filled in from a personal connection. `manual`: typed in by the person.
    pub enum ExternalIdentitySource {
        Connection = "connection",
        Manual = "manual",
    }
}

/// `EXTERNAL_IDENTITY_SOURCES`.
pub const EXTERNAL_IDENTITY_SOURCES: &[ExternalIdentitySource] = ExternalIdentitySource::ALL;
/// How many external identities one account can hold.
pub const EXTERNAL_IDENTITIES_MAX: usize = 20;
/// Longest external login.
pub const EXTERNAL_IDENTITY_LOGIN_MAX: usize = 100;

/// A login a person has in another tool.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalIdentity {
    /// Identity id.
    pub id: Id,
    /// Owner.
    pub user_id: Id,
    /// Tool.
    pub provider: ExternalIdentityProvider,
    /// Lower-case host without scheme or path, e.g. `github.com`.
    pub host: String,
    /// The login as the tool spells it. Compared case-insensitively.
    pub login: String,
    /// How it was added.
    pub source: ExternalIdentitySource,
    /// Creation time.
    pub created_at: IsoDate,
}

/// Body that adds an external identity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ExternalIdentityInput {
    /// Tool.
    pub provider: ExternalIdentityProvider,
    /// Defaults to the provider's public host. Required for Jira.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// Login.
    pub login: String,
}

/// `https://GitHub.com/` → `github.com`; `None` when it is not a plain host (optionally with a
/// port).
#[must_use]
pub fn normalize_identity_host(raw: &str) -> Option<String> {
    let lower = crate::js::trim(raw).to_lowercase();
    let mut host = lower.as_str();
    // ^[a-z][a-z0-9+.-]*:\/\/
    if let Some(at) = host.find("://") {
        let scheme = &host[..at];
        let mut bytes = scheme.bytes();
        if bytes.next().is_some_and(|b| b.is_ascii_lowercase())
            && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"+.-".contains(&b))
        {
            host = &host[at + 3..];
        }
    }
    let host = host.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.strip_suffix('.').unwrap_or(host);
    is_plain_host(host).then(|| host.to_owned())
}

/// `^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$`
fn is_plain_host(value: &str) -> bool {
    let (name, port) = match value.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (value, None),
    };
    if let Some(port) = port
        && !((1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    let bytes = name.as_bytes();
    let edge = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    match bytes.len() {
        0 => false,
        1 => edge(&bytes[0]),
        n if n <= 253 => {
            edge(&bytes[0])
                && edge(&bytes[n - 1])
                && bytes[1..n - 1].iter().all(|b| edge(b) || *b == b'.' || *b == b'-')
        }
        _ => false,
    }
}

/// Drops a leading `@` and surrounding spaces; `None` when nothing usable is left.
#[must_use]
pub fn normalize_identity_login(raw: &str) -> Option<String> {
    let trimmed = crate::js::trim(raw);
    let login = trimmed.strip_prefix('@').unwrap_or(trimmed);
    let usable = !login.is_empty()
        && crate::js::len(login) <= EXTERNAL_IDENTITY_LOGIN_MAX
        && !login.chars().any(|c| crate::js::is_whitespace(c) || c == '/' || c == '\\');
    usable.then(|| login.to_owned())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn normalizes_identity_hosts_and_logins() {
        assert_eq!(normalize_identity_host("https://GitHub.com/").as_deref(), Some("github.com"));
        assert_eq!(
            normalize_identity_host(" git.acme.dev:8443/x?y ").as_deref(),
            Some("git.acme.dev:8443")
        );
        assert_eq!(normalize_identity_host("github.com.").as_deref(), Some("github.com"));
        assert_eq!(normalize_identity_host("a").as_deref(), Some("a"));
        assert_eq!(normalize_identity_host("-bad.com"), None);
        assert_eq!(normalize_identity_host("bad_host.com"), None);
        assert_eq!(normalize_identity_host("host:123456"), None);
        assert_eq!(normalize_identity_host(""), None);
        assert_eq!(normalize_identity_login("  @alessandro-b ").as_deref(), Some("alessandro-b"));
        assert_eq!(normalize_identity_login("@"), None);
        assert_eq!(normalize_identity_login("a b"), None);
        assert_eq!(normalize_identity_login("a/b"), None);
        assert_eq!(normalize_identity_login(&"x".repeat(101)), None);
    }

    #[test]
    fn resolves_notification_settings() {
        let out = resolve_notification_settings(Some(
            &json!({ "comment": { "email": true, "push": "no" } }),
        ));
        assert_eq!(out.comment, NotificationChannels { in_app: true, email: true, push: true });
        assert_eq!(out.assigned, DEFAULT_NOTIFICATION_CHANNELS);
        assert_eq!(
            serde_json::to_value(resolve_notification_settings(None)).unwrap()["review_requested"],
            json!({ "inApp": true, "email": false, "push": true })
        );
    }

    #[test]
    fn invite_results_are_tagged_by_status() {
        let member = ProjectShareMember {
            membership: Membership {
                id: "mb_1".into(),
                workspace_id: "ws_1".into(),
                user_id: "u_1".into(),
                role: "guest".into(),
                created_at: "2026-01-01T00:00:00.000Z".into(),
                access: None,
            },
            user: None,
            all_projects: false,
        };
        let out = serde_json::to_value(ProjectInviteResult::Added { member }).unwrap();
        assert_eq!(out["status"], "added");
        assert_eq!(out["member"]["userId"], "u_1");
        assert_eq!(out["member"]["allProjects"], false);
        assert!(out["member"].get("access").is_none());
    }
}
