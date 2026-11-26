//! `UploadsController` (`server/src/uploads/uploads.controller.ts`) and the multipart handling of
//! its `FileInterceptor` / `UploadExceptionFilter`, mounted under `/api`.

use axum::Json;
use axum::extract::multipart::MultipartError;
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, Request, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use trama_auth::upload_caller::UploadCaller;
use trama_auth::{Auth, Ctx, Gate, Routes};
use trama_contracts::issues::Artifact;
use trama_contracts::roles::{LegacyRole, TokenScope};
use trama_core::{AppError, AppState};
use utoipa::OpenApi;

use crate::rules::{UPLOAD_MAX_BYTES, UploadKind, content_disposition};
use crate::schemas::{StagedUpload, UploadForm};
use crate::service::{self, IncomingUpload};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(stage, upload_on_issue, open, discard),
    components(schemas(StagedUpload, UploadForm, UploadKind, Artifact))
)]
pub struct ApiDoc;

/// Room for the multipart framing around a file of [`UPLOAD_MAX_BYTES`]; the file itself is
/// limited while it is read.
const MULTIPART_OVERHEAD: usize = 1024 * 1024;

const VIEWER: Gate = Gate::authenticated().roles(LegacyRole::Viewer);

/// Routes of this module.
pub fn router() -> Routes {
    let multipart = |route: axum::routing::MethodRouter<AppState>| {
        route.layer(DefaultBodyLimit::max(UPLOAD_MAX_BYTES + MULTIPART_OVERHEAD))
    };
    Routes::new()
        .route_with(Method::POST, "/w/{slug}/uploads", VIEWER.multipart(), stage, multipart)
        .route_with(
            Method::POST,
            "/w/{slug}/tasks/{idOrKey}/artifacts/upload",
            Gate::authenticated().multipart(),
            upload_on_issue,
            multipart,
        )
        .get("/w/{slug}/uploads/{id}", Gate::authenticated(), open)
        .delete("/w/{slug}/uploads/{id}", VIEWER, discard)
}

/// `callerOf(ctx, auth)`: the actor, the role and, for a `custom` API token, its permissions.
fn caller_of(ctx: &Ctx, auth: &Auth) -> UploadCaller {
    UploadCaller {
        actor: ctx.actor.clone(),
        role: ctx.role.clone(),
        permissions: auth
            .token
            .as_ref()
            .filter(|token| token.scope == Some(TokenScope::Custom))
            .map(|token| token.permissions.clone().unwrap_or_default()),
    }
}

fn too_large() -> AppError {
    AppError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("File is larger than {UPLOAD_MAX_BYTES} bytes"),
    )
}

fn multipart_error(err: &MultipartError) -> AppError {
    if err.status() == StatusCode::PAYLOAD_TOO_LARGE {
        too_large()
    } else {
        AppError::bad_request("Malformed multipart body")
    }
}

/// The `file` part of a multipart body (multer with `files: 1` and a size limit). Text fields are
/// ignored; a file part with another name, a second file, or one over [`UPLOAD_MAX_BYTES`] is
/// refused. `None` when the request is not multipart or has no file.
async fn read_file(req: Request) -> Result<Option<IncomingUpload>, AppError> {
    let Ok(mut multipart) = Multipart::from_request(req, &()).await else { return Ok(None) };
    let mut file = None;
    while let Some(mut field) = multipart.next_field().await.map_err(|e| multipart_error(&e))? {
        let Some(name) = field.file_name().map(ToOwned::to_owned) else { continue };
        // a file input left empty arrives with an empty name; multer skips it
        if name.is_empty() {
            continue;
        }
        if field.name() != Some("file") || file.is_some() {
            return Err(AppError::bad_request("Upload a single file in the \"file\" field"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(|e| multipart_error(&e))? {
            if bytes.len() + chunk.len() > UPLOAD_MAX_BYTES {
                return Err(too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        file = Some(IncomingUpload { original_name: name, bytes });
    }
    Ok(file)
}

/// `asFile`: the file, or 400 `Choose a file to upload`.
fn as_file(file: Option<IncomingUpload>) -> Result<IncomingUpload, AppError> {
    file.filter(|file| !file.bytes.is_empty())
        .ok_or_else(|| AppError::bad_request("Choose a file to upload"))
}

/// Stores a file to insert into a description or a comment. It is not fetchable by anyone else
/// until that text is saved.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/uploads",
    tag = "uploads",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body(content = UploadForm, content_type = "multipart/form-data"),
    responses(
        (status = 201, description = "The stored file and the markdown to insert", body = StagedUpload),
        (status = 400, description = "No file, a second file, or a file that is not allowed"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "The caller cannot write descriptions or comments"),
        (status = 404, description = "Unknown workspace, or not a member"),
        (status = 413, description = "The file is larger than 8 MB"),
    )
)]
async fn stage(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    req: Request,
) -> Result<(StatusCode, Json<StagedUpload>), AppError> {
    let file = as_file(read_file(req).await?)?;
    let staged = service::stage(
        &state.db,
        &ctx.workspace.id,
        &ctx.workspace.slug,
        &caller_of(&ctx, &auth),
        &file,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(staged)))
}

/// Stores a file and attaches it to a task as an `image` or `file` artifact.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/tasks/{idOrKey}/artifacts/upload",
    tag = "uploads",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("idOrKey" = String, Path, description = "Task id or key"),
    ),
    request_body(content = UploadForm, content_type = "multipart/form-data"),
    responses(
        (status = 201, description = "The new artifact", body = Artifact),
        (status = 400, description = "No file, a second file, or a file that is not allowed"),
        (status = 401, description = "Not signed in"),
        (status = 403, description = "The caller cannot attach artifacts"),
        (status = 404, description = "Unknown workspace or task"),
        (status = 413, description = "The file is larger than 8 MB"),
    )
)]
async fn upload_on_issue(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    Path((_slug, id_or_key)): Path<(String, String)>,
    req: Request,
) -> Result<(StatusCode, Json<Artifact>), AppError> {
    let file = as_file(read_file(req).await?)?;
    let artifact = service::attach_artifact(
        &state,
        &ctx.workspace.id,
        &ctx.workspace.slug,
        &caller_of(&ctx, &auth),
        &file,
        &id_or_key,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(artifact)))
}

/// The file's bytes, while a record the caller can read still mentions it (or to its uploader
/// before it is saved). Images are shown inline, everything else downloads.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/uploads/{id}",
    tag = "uploads",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Upload id"),
    ),
    responses(
        (status = 200, description = "The file", content_type = "application/octet-stream", body = Vec<u8>),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown file, or none the caller may read"),
    )
)]
async fn open(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let row = service::open(&state.db, &ctx.workspace.id, &id, &caller_of(&ctx, &auth)).await?;
    let kind = UploadKind::of_content_type(&row.content_type);
    let value =
        |text: &str| HeaderValue::from_str(text).map_err(|e| AppError::internal(e.to_string()));
    let headers: [(HeaderName, HeaderValue); 6] = [
        (header::CONTENT_TYPE, value(&row.content_type)?),
        (header::CONTENT_DISPOSITION, value(&content_disposition(kind, &row.filename))?),
        (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        (header::CACHE_CONTROL, HeaderValue::from_static("private, no-store")),
        (header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")),
        (header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox")),
    ];
    Ok((headers, row.bytes).into_response())
}

/// Drops a file that was uploaded and then never saved onto a record. Referenced files stay.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/uploads/{id}",
    tag = "uploads",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Upload id"),
    ),
    responses(
        (status = 204, description = "Deleted"),
        (status = 400, description = "A record still mentions the file"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown file, or not the caller's"),
    )
)]
async fn discard(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    service::discard(&state.db, &ctx.workspace.id, &caller_of(&ctx, &auth), &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
