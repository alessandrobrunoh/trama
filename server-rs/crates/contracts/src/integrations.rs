//! API tokens, integration connections and outgoing webhooks.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::common::{ActorRef, GitProvider, Id, IsoDate};
use crate::roles::{ApiPermission, TokenLimits, TokenScope};

/// API token (for agents, MCP clients, scripts). The secret is only returned once on creation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiToken {
    /// Token id.
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Display name.
    pub name: String,
    /// First chars of the token for display, e.g. `trm_3f9a…`.
    pub prefix: String,
    /// Token acts as this actor (a user or an agent).
    pub actor: ActorRef,
    /// What the token may do.
    pub scope: TokenScope,
    /// Granted permissions; present only for `custom` tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Vec<ApiPermission>>,
    /// Request / write budget.
    pub limits: TokenLimits,
    /// Last use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<IsoDate>,
    /// Creation time.
    pub created_at: IsoDate,
    /// Expiry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<IsoDate>,
}

string_enum! {
    /// Who owns a connection: a whole workspace (admins manage it) or one person.
    pub enum ConnectionOwnerType {
        Workspace = "workspace",
        User = "user",
    }
}

string_enum! {
    /// `connected`: usable. `error`: the provider rejected it. `revoked`: the credential was
    /// withdrawn on purpose (the token is wiped).
    pub enum ConnectionStatus {
        Connected = "connected",
        Error = "error",
        Revoked = "revoked",
    }
}

string_enum! {
    /// `GitProvider | 'delta'`: what a connection talks to.
    pub enum ConnectionProvider {
        Github = "github",
        Gitlab = "gitlab",
        Bitbucket = "bitbucket",
        Delta = "delta",
    }
}

impl ConnectionProvider {
    /// The git host, `None` for Delta.
    #[must_use]
    pub const fn git(self) -> Option<GitProvider> {
        match self {
            Self::Github => Some(GitProvider::Github),
            Self::Gitlab => Some(GitProvider::Gitlab),
            Self::Bitbucket => Some(GitProvider::Bitbucket),
            Self::Delta => None,
        }
    }
}

impl From<GitProvider> for ConnectionProvider {
    fn from(value: GitProvider) -> Self {
        match value {
            GitProvider::Github => Self::Github,
            GitProvider::Gitlab => Self::Gitlab,
            GitProvider::Bitbucket => Self::Bitbucket,
        }
    }
}

/// Host a connection talks to: the host (with a non-default port) of its base URL, else the
/// provider's public host (`delta` for Delta).
#[must_use]
pub fn connection_host(provider: ConnectionProvider, base_url: Option<&str>) -> String {
    if let Some(base) = base_url.filter(|b| !b.is_empty()) {
        return match url::Url::parse(base) {
            Ok(url) => {
                let host = url.host_str().unwrap_or("");
                match url.port() {
                    Some(port) => format!("{host}:{port}").to_lowercase(),
                    None => host.to_lowercase(),
                }
            }
            Err(_) => base.to_lowercase(),
        };
    }
    provider.git().map_or_else(|| "delta".to_owned(), |git| git.meta().host.to_owned())
}

/// A connection to a git host or Delta.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationConnection {
    /// Connection id.
    pub id: Id,
    /// Who owns it.
    pub owner_type: ConnectionOwnerType,
    /// Set for workspace connections.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<Id>,
    /// Set for personal connections: the only person who sees and manages it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<Id>,
    /// Display name of the owner of a personal connection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    /// Display name, e.g. "GitHub · personal".
    pub label: String,
    /// Provider.
    pub provider: ConnectionProvider,
    /// Display account, e.g. GitHub org/user.
    pub account: String,
    /// Base URL for self-hosted GitLab / GitHub Enterprise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Host this connection talks to.
    pub host: String,
    /// Whether a webhook secret is configured (the secret itself is never returned).
    pub webhook_configured: bool,
    /// Status.
    pub status: ConnectionStatus,
    /// Last sync.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<IsoDate>,
    /// Why the provider rejected it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Creation time.
    pub created_at: IsoDate,
}

/// A connection a person may pick for a project rule. `suggested` marks the one the UI
/// preselects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct UsableConnection {
    /// The connection.
    #[serde(flatten)]
    pub connection: IntegrationConnection,
    /// Preselected.
    pub suggested: bool,
}

/// A custom integration: Trama POSTs a signed JSON body to `url` for every matching domain event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingWebhook {
    /// Webhook id.
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Display name.
    pub name: String,
    /// Target URL.
    pub url: String,
    /// Event types, `entity.*` wildcards (`issue.*`) or `*`.
    pub events: Vec<String>,
    /// Enabled.
    pub enabled: bool,
    /// Creation time.
    pub created_at: IsoDate,
    /// Last delivery.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_delivery_at: Option<IsoDate>,
    /// HTTP status of the last delivery, or 0 when it failed before getting a response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_status: Option<i32>,
}

/// One delivery attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebhookDeliveryLog {
    /// Delivery id.
    pub id: Id,
    /// Webhook id.
    pub webhook_id: Id,
    /// Event type.
    pub event: String,
    /// 0 when there was no HTTP response (timeout, DNS, connection refused).
    pub status: i32,
    /// 2xx.
    pub ok: bool,
    /// Duration.
    pub duration_ms: i32,
    /// Failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 1 or 2 (one retry at most).
    pub attempt: i32,
    /// When.
    pub at: IsoDate,
}

/// Event types of one entity a webhook can subscribe to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct WebhookEventGroup {
    /// Entity.
    pub entity: &'static str,
    /// Display name.
    pub label: &'static str,
    /// Event types.
    pub events: &'static [&'static str],
}

/// `WEBHOOK_EVENT_GROUPS`, for pickers.
pub const WEBHOOK_EVENT_GROUPS: &[WebhookEventGroup] = &[
    WebhookEventGroup {
        entity: "project",
        label: "Projects",
        events: &[
            "project.created",
            "project.updated",
            "project.status_changed",
            "project.health_changed",
            "project.deleted",
        ],
    },
    WebhookEventGroup {
        entity: "issue",
        label: "Tasks",
        events: &["issue.created", "issue.updated", "issue.status_changed", "issue.deleted"],
    },
    WebhookEventGroup {
        entity: "artifact",
        label: "Artifacts",
        events: &["artifact.attached", "artifact.updated", "artifact.deleted"],
    },
    WebhookEventGroup { entity: "comment", label: "Comments", events: &["comment.created"] },
    WebhookEventGroup {
        entity: "import",
        label: "Imports",
        events: &["import.started", "import.completed", "import.failed", "import.canceled"],
    },
];

/// Does a webhook subscription pattern (`*`, `issue.*`, `issue.created`) match an event type?
#[must_use]
pub fn webhook_event_matches<S: AsRef<str>>(patterns: &[S], kind: &str) -> bool {
    patterns.iter().map(AsRef::as_ref).any(|p| {
        p == "*"
            || p == kind
            || p.strip_suffix('*')
                .is_some_and(|prefix| p.ends_with(".*") && kind.starts_with(prefix))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_webhook_patterns() {
        assert!(webhook_event_matches(&["*"], "issue.created"));
        assert!(webhook_event_matches(&["issue.*"], "issue.created"));
        assert!(webhook_event_matches(&["issue.created"], "issue.created"));
        assert!(!webhook_event_matches(&["issue.*"], "issues.created"));
        assert!(!webhook_event_matches(&["project.*", "comment.created"], "issue.created"));
        assert!(!webhook_event_matches::<&str>(&[], "issue.created"));
    }

    #[test]
    fn computes_connection_hosts() {
        assert_eq!(connection_host(ConnectionProvider::Github, None), "github.com");
        assert_eq!(connection_host(ConnectionProvider::Delta, None), "delta");
        assert_eq!(
            connection_host(ConnectionProvider::Gitlab, Some("https://Git.Acme.dev:8443/x")),
            "git.acme.dev:8443"
        );
        assert_eq!(
            connection_host(ConnectionProvider::Gitlab, Some("https://git.acme.dev:443/")),
            "git.acme.dev"
        );
        assert_eq!(connection_host(ConnectionProvider::Gitlab, Some("Not A Url")), "not a url");
        assert_eq!(connection_host(ConnectionProvider::Bitbucket, Some("")), "bitbucket.org");
    }
}
