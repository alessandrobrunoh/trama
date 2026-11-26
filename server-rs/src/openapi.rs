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
        (name = "auth", description = "Sign-up, sessions and API token introspection"),
        (name = "events", description = "Activity log and the live event stream"),
        (name = "notifications", description = "The inbox, notification settings and Web Push"),
        (name = "system", description = "Health and operations"),
    ),
)]
pub(crate) struct ApiDoc;

/// The full document. Add each new module crate's `ApiDoc` here, sorted by crate name.
#[must_use]
pub fn api_doc() -> Document {
    let mut doc = ApiDoc::openapi();
    doc.merge(trama_auth::ApiDoc::openapi());
    doc.merge(trama_events::ApiDoc::openapi());
    doc.merge(trama_notifications::ApiDoc::openapi());
    doc.merge(trama_system::ApiDoc::openapi());
    doc
}
