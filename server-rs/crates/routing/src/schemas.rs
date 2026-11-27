//! Routing-rule request bodies.

use serde::Deserialize;
use trama_contracts::common::GitProvider;
use trama_contracts::routing::{RoutingDirection, RoutingFilters};
use trama_core::validation::Patch;
use utoipa::ToSchema;

/// Creates a source-to-project rule.
#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateRuleBody {
    /// Source provider.
    pub provider: trama_contracts::common::GitProvider,
    /// Repository path or URL, or a supported group path.
    pub source_path: String,
    /// A connection the caller is allowed to use.
    pub connection_id: String,
    /// Optional all-of filters.
    #[serde(default)]
    pub filters: Option<RoutingFilters>,
    /// Defaults to inbound.
    #[serde(default)]
    pub direction: Option<RoutingDirection>,
}

/// Updates the connection, full filter set or direction.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRuleBody {
    /// Replacement usable connection.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub connection_id: Patch<String>,
    /// Replaces the whole set; an empty object clears it.
    #[serde(default)]
    #[schema(value_type = Option<RoutingFilters>)]
    pub filters: Patch<RoutingFilters>,
    /// New direction.
    #[serde(default)]
    #[schema(value_type = Option<RoutingDirection>)]
    pub direction: Patch<RoutingDirection>,
}

/// Optional connection filter for the connection picker.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionQuery {
    /// Limit connections to this provider.
    pub provider: Option<GitProvider>,
}

/// Provider repository lookup query.
#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionsQuery {
    /// Git host provider.
    pub provider: GitProvider,
    /// Restrict to one usable connection.
    pub connection_id: Option<String>,
    /// Narrow by repository name.
    pub q: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_distinguishes_missing_values_from_replacements_and_nulls() {
        let body: UpdateRuleBody = serde_json::from_value(serde_json::json!({
            "connectionId": "ic_1",
            "filters": { "labels": ["bug"] },
            "direction": "two_way"
        }))
        .unwrap();
        assert!(matches!(body.connection_id, Patch::Value(ref id) if id == "ic_1"));
        assert!(matches!(body.filters, Patch::Value(RoutingFilters { labels: Some(_), .. })));
        assert!(matches!(body.direction, Patch::Value(RoutingDirection::TwoWay)));

        let nulls: UpdateRuleBody =
            serde_json::from_value(serde_json::json!({ "filters": null })).unwrap();
        assert!(matches!(nulls.connection_id, Patch::Missing));
        assert!(matches!(nulls.filters, Patch::Null));
        assert!(matches!(nulls.direction, Patch::Missing));
    }
}
