//! Routing rules: per project, work from one external source arrives there through one
//! connection.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::common::{ActorRef, GitProvider, Id, IsoDate};
use crate::integrations::ConnectionOwnerType;

string_enum! {
    /// Whether a rule only reads, or also writes back.
    pub enum RoutingDirection {
        Inbound = "inbound",
        TwoWay = "two_way",
    }
}

/// `ROUTING_DIRECTIONS`.
pub const ROUTING_DIRECTIONS: &[RoutingDirection] = RoutingDirection::ALL;

/// What a source can do today (`ROUTING_PROVIDER_SUPPORT[provider]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)] // the contract's shape
pub struct RoutingProviderSupport {
    /// Issues can be routed.
    pub issues: bool,
    /// Pull requests can be placed.
    pub pull_requests: bool,
    /// Two-way rules are offered.
    pub two_way: bool,
}

impl GitProvider {
    /// `ROUTING_PROVIDER_SUPPORT[provider]`.
    #[must_use]
    pub const fn routing_support(self) -> RoutingProviderSupport {
        match self {
            Self::Github | Self::Gitlab => {
                RoutingProviderSupport { issues: true, pull_requests: true, two_way: true }
            }
            Self::Bitbucket => {
                RoutingProviderSupport { issues: false, pull_requests: true, two_way: false }
            }
        }
    }
}

/// Narrows which items of the source a rule takes. Every set filter must match.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct RoutingFilters {
    /// The item must carry all of these labels (case-insensitive).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    /// The item's milestone title (case-insensitive).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<String>,
}

/// Longest source path.
pub const ROUTING_SOURCE_PATH_MAX: usize = 300;
/// Most label filters.
pub const ROUTING_FILTER_LABELS_MAX: usize = 10;
/// Longest filter value.
pub const ROUTING_FILTER_VALUE_MAX: usize = 100;

string_enum! {
    /// `repo` is one repository; `group` ends with `/*` and means everything under that owner.
    pub enum RoutingSourceKind {
        Repo = "repo",
        Group = "group",
    }
}

/// `routingSourceKind`.
#[must_use]
pub fn routing_source_kind(source_path: &str) -> RoutingSourceKind {
    if source_path.ends_with("/*") { RoutingSourceKind::Group } else { RoutingSourceKind::Repo }
}

/// Chips for a rule's filters: `label = bug`, `milestone = v1.2`.
#[must_use]
pub fn routing_filter_chips(filters: Option<&RoutingFilters>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(filters) = filters else { return out };
    for label in filters.labels.iter().flatten() {
        out.push(format!("label = {label}"));
    }
    if let Some(milestone) = filters.milestone.as_deref().filter(|m| !m.is_empty()) {
        out.push(format!("milestone = {milestone}"));
    }
    out
}

/// The connection a rule reads through, as people see it. Never carries credentials.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRuleConnection {
    /// Connection id.
    pub id: Id,
    /// Provider.
    pub provider: GitProvider,
    /// Display name, e.g. "GitHub · Acme".
    pub label: String,
    /// Owner kind.
    pub owner_type: ConnectionOwnerType,
    /// Name of the person for a personal connection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    /// True when the caller owns it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mine: Option<bool>,
}

string_enum! {
    /// Health of a rule.
    pub enum RoutingRuleHealth {
        Ok = "ok",
        Error = "error",
    }
}

/// A routing rule.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRule {
    /// Rule id (`rr_…`).
    pub id: Id,
    /// Workspace id.
    pub workspace_id: Id,
    /// Project id.
    pub project_id: Id,
    /// Absent when the connection was removed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<Id>,
    /// Provider.
    pub provider: GitProvider,
    /// Lower-case host, e.g. `github.com`.
    pub host: String,
    /// `owner/name`, or a group path ending with `/*`.
    pub source_path: String,
    /// Filters.
    pub filters: RoutingFilters,
    /// Direction.
    pub direction: RoutingDirection,
    /// The connection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<RoutingRuleConnection>,
    /// Health.
    pub health: RoutingRuleHealth,
    /// Why the rule is failing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_reason: Option<String>,
    /// Last sync.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<IsoDate>,
    /// Last error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Tasks and placed pull requests this rule created.
    pub task_count: i64,
    /// The `Project.repository` value this rule was created from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migrated_from: Option<String>,
    /// Who created it.
    pub created_by: ActorRef,
    /// Creation time.
    pub created_at: IsoDate,
    /// Last update.
    pub updated_at: IsoDate,
}

/// Seven-day stats of a project's rules.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRuleStats {
    /// Tasks created by this project's rules in the last 7 days.
    pub tasks_arrived: i64,
    /// Pull requests without a task key that a rule placed here in the last 7 days.
    pub unmatched_placed: i64,
    /// Failing rules.
    pub rules_failing: i64,
}

/// A project's rules.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRulesOverview {
    /// Rules.
    pub rules: Vec<RoutingRule>,
    /// Stats.
    pub stats: RoutingRuleStats,
    /// Whether the caller may add, change and remove rules here.
    pub can_manage: bool,
}

/// A connection the caller may read through for a rule.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct RoutingConnectionOption {
    /// The connection.
    #[serde(flatten)]
    pub connection: RoutingRuleConnection,
    /// Account.
    pub account: String,
    /// The workspace connection is suggested: it keeps working when people leave.
    pub suggested: bool,
    /// Usable now.
    pub healthy: bool,
}

string_enum! {
    /// Whether a source is free, already here, or routed elsewhere.
    pub enum RoutingSuggestionStatus {
        Available = "available",
        ThisProject = "this_project",
        OtherProject = "other_project",
    }
}

/// A source the provider lists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutingSourceSuggestion {
    /// Source path.
    pub source_path: String,
    /// Link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Private repository.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private: Option<bool>,
    /// Availability.
    pub status: RoutingSuggestionStatus,
    /// The project that already receives it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Id>,
    /// Its name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
}

/// Sources a connection offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct RoutingSuggestions {
    /// Sources.
    pub items: Vec<RoutingSourceSuggestion>,
    /// Set when the provider could not be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_kinds_and_chips() {
        assert_eq!(routing_source_kind("acme/*"), RoutingSourceKind::Group);
        assert_eq!(routing_source_kind("acme/api"), RoutingSourceKind::Repo);
        let filters =
            RoutingFilters { labels: Some(vec!["bug".into()]), milestone: Some("v1.2".into()) };
        assert_eq!(routing_filter_chips(Some(&filters)), ["label = bug", "milestone = v1.2"]);
        assert!(routing_filter_chips(None).is_empty());
        assert!(!GitProvider::Bitbucket.routing_support().two_way);
    }
}
