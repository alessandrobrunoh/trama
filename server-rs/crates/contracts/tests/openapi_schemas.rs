//! Every wire type can be listed in a module's `ApiDoc`.

use trama_contracts::{access, activity, identity, imports, insights, integrations, issues};
use trama_contracts::{labels, projects, roles, routing, settings, status, views};
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(components(schemas(
    access::MemberAccess,
    access::MemberGrant,
    activity::WorkspaceSnapshot,
    activity::LiveEvent,
    activity::CommentPage,
    identity::ProjectInviteResult,
    identity::ProjectShare,
    identity::InvitePreview,
    identity::NotificationList,
    identity::NotificationSettings,
    identity::Favorite,
    identity::ExternalIdentity,
    imports::ImportJob,
    imports::ImportPreview,
    insights::InsightsReport,
    integrations::ApiToken,
    integrations::UsableConnection,
    integrations::OutgoingWebhook,
    integrations::WebhookDeliveryLog,
    issues::IssueContext,
    labels::WorkspaceLabel,
    projects::ProjectAiResult,
    projects::ProjectTransferPreview,
    projects::ProjectTransferResult,
    projects::SharedProject,
    roles::ApiPermission,
    roles::TokenLimits,
    routing::RoutingRulesOverview,
    routing::RoutingConnectionOption,
    routing::RoutingSuggestions,
    settings::WorkspaceSettings,
    status::StatusCatalog,
    views::PublicView,
    views::SavedView,
)))]
struct Doc;

#[test]
fn the_contract_schemas_render() {
    let doc = serde_json::to_value(Doc::openapi()).unwrap();
    let schemas = &doc["components"]["schemas"];
    assert_eq!(schemas["MemberGrant"]["enum"][0], "projects:view");
    assert_eq!(schemas["ApiPermission"]["enum"][0], "projects:read");
    assert!(schemas["WorkspaceSnapshot"]["properties"]["myRole"].is_object());
    assert!(schemas["WorkspaceSettings"]["properties"].get("extra").is_none());
}
