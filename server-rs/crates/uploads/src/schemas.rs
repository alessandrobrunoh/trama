//! Request and response bodies of the uploads routes.

use serde::Serialize;
use trama_contracts::issues::{Artifact, ArtifactKind, ArtifactProvider, ArtifactState};
use trama_core::time::to_iso;
use trama_entities::artifacts;
use utoipa::ToSchema;

use crate::rules::UploadKind;

/// `StagedUpload`: a stored file that no record mentions yet, with the markdown to insert.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpload {
    /// Upload id (`upl_…`).
    pub id: String,
    /// Sanitized file name.
    pub filename: String,
    /// Content type derived from the extension.
    pub content_type: String,
    /// Size in bytes.
    pub byte_size: u64,
    /// `image` renders inline, `file` downloads.
    pub kind: UploadKind,
    /// Workspace path of the bytes: `/api/w/<slug>/uploads/<id>`.
    pub url: String,
    /// `![name](url)` for an image, `[name](url)` for a file.
    pub markdown: String,
}

/// The multipart body of an upload: one file in the `file` field.
#[derive(ToSchema)]
#[allow(dead_code, missing_docs)]
pub struct UploadForm {
    /// The file (at most 8 MB).
    #[schema(format = Binary)]
    pub file: Vec<u8>,
}

/// The wire form of an artifact row (`ArtifactEntity.toJSON`: nulls dropped, no `workspaceId`
/// or `uploadId`).
pub(crate) fn artifact_view(row: &artifacts::Model) -> Artifact {
    Artifact {
        id: row.id.clone(),
        issue_id: row.issue_id.clone(),
        legacy_workstream_key: row.legacy_workstream_key.clone(),
        repository: row.repository.clone(),
        description: row.description.clone(),
        kind: ArtifactKind::parse(&row.kind).unwrap_or(ArtifactKind::File),
        provider: ArtifactProvider::parse(&row.provider).unwrap_or(ArtifactProvider::Other),
        title: row.title.clone(),
        url: row.url.clone(),
        external_id: row.external_id.clone(),
        state: ArtifactState::parse(&row.state).unwrap_or(ArtifactState::Open),
        ci: row.ci.as_deref().and_then(trama_contracts::issues::CiState::parse),
        review: row.review.as_deref().and_then(trama_contracts::issues::ReviewState::parse),
        has_conflicts: row.has_conflicts,
        environment: row.environment.clone(),
        author_ref: row.author_ref.clone().and_then(|v| serde_json::from_value(v).ok()),
        created_at: to_iso(&row.created_at),
        updated_at: to_iso(&row.updated_at),
    }
}
