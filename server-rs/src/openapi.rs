//! The OpenAPI document: the API's metadata plus each module crate's own document.

use utoipa::OpenApi;
use utoipa::openapi::OpenApi as Document;

/// Title, version and tags; module paths are merged in by [`api_doc`].
#[derive(OpenApi)]
#[openapi(
    info(
        title = "Trama API",
        description = "Tasks, projects and Delta thread records.",
        license(name = "PolyForm Shield 1.0.0", identifier = "PolyForm-Shield-1.0.0"),
    ),
    tags(
        (name = "ai", description = "Suggestions, the assistant, SuperGrok and project proposals"),
        (name = "artifacts", description = "What a task produced or points to: pull requests, builds, links, files"),
        (name = "attention", description = "What needs the current user: review requests and failing CI"),
        (name = "auth", description = "Sign-up, sessions and API token introspection"),
        (name = "comments", description = "Comments on issues, projects, milestones and artifacts"),
        (name = "events", description = "Activity log and the live event stream"),
        (name = "external-identities", description = "A person's logins in other tools"),
        (name = "favorites", description = "What a person pins in a workspace"),
        (name = "insights", description = "Health signals, flow metrics and contributors"),
        (name = "importers", description = "Imports from GitHub Issues and Linear"),
        (name = "integrations", description = "Connections to git hosts, workspace-wide and personal"),
        (name = "issues", description = "Tasks: the unit of work, its keys, sub-issues and briefing"),
        (name = "milestones", description = "Project milestones"),
        (name = "notifications", description = "The inbox, notification settings and Web Push"),
        (name = "outgoing-webhooks", description = "Signed webhooks to your own URLs for domain events"),
        (name = "projects", description = "Projects: the unit of planning, their tags, statuses, health, labels and repository"),
        (name = "routing", description = "External source routing rules for project tasks"),
        (name = "search",description = "Search across projects, issues and artifacts"),
        (name = "sharing", description = "Shared with me, Show in placements and project transfer"),
        (name = "snapshot", description = "Everything the client needs to boot a workspace in one call"),
        (name = "system", description = "Health and operations"),
        (name = "time-entries", description = "Personal time entries and timers"),
        (name = "uploads", description = "Files stored in the workspace and attached to records"),
        (name = "views", description = "Saved views, sharing and the public link"),
        (name = "webhooks", description = "Verified inbound git provider webhooks"),
        (name = "workspaces", description = "Workspaces, members, roles, agents, tokens, labels and statuses"),
    ),
)]
pub(crate) struct ApiDoc;

/// The full document. Add each new module crate's `ApiDoc` here, sorted by crate name.
#[must_use]
pub fn api_doc() -> Document {
    let mut doc = ApiDoc::openapi();
    doc.merge(trama_ai::ApiDoc::openapi());
    doc.merge(trama_artifacts::ApiDoc::openapi());
    doc.merge(trama_attention::ApiDoc::openapi());
    doc.merge(trama_auth::ApiDoc::openapi());
    doc.merge(trama_comments::ApiDoc::openapi());
    doc.merge(trama_events::ApiDoc::openapi());
    doc.merge(trama_external_identities::ApiDoc::openapi());
    doc.merge(trama_favorites::ApiDoc::openapi());
    doc.merge(trama_insights::ApiDoc::openapi());
    doc.merge(trama_importers::ApiDoc::openapi());
    doc.merge(trama_integrations::ApiDoc::openapi());
    doc.merge(trama_issues::ApiDoc::openapi());
    doc.merge(trama_milestones::ApiDoc::openapi());
    doc.merge(trama_notifications::ApiDoc::openapi());
    doc.merge(trama_outgoing_webhooks::ApiDoc::openapi());
    doc.merge(trama_projects::ApiDoc::openapi());
    doc.merge(trama_routing::ApiDoc::openapi());
    doc.merge(trama_search::ApiDoc::openapi());
    doc.merge(trama_sharing::ApiDoc::openapi());
    doc.merge(trama_sharing::invites::InviteApiDoc::openapi());
    doc.merge(trama_snapshot::ApiDoc::openapi());
    doc.merge(trama_system::ApiDoc::openapi());
    doc.merge(trama_time_entries::ApiDoc::openapi());
    doc.merge(trama_uploads::ApiDoc::openapi());
    doc.merge(trama_views::ApiDoc::openapi());
    doc.merge(trama_webhooks::ApiDoc::openapi());
    doc.merge(trama_workspaces::ApiDoc::openapi());
    doc
}
