//! File uploads of the Trama API: the port of `server/src/uploads`.
//!
//! Files live in the `uploads` table. A file is readable only while a record the caller can read
//! still mentions it (a row in `upload_references`), or, before it is saved anywhere, by the
//! person who uploaded it. Records mention a file by writing its workspace path
//! (`/api/w/<slug>/uploads/<id>`) into a description or comment, or through an artifact's
//! `uploadId`.
//!
//! # Routes
//!
//! | Route | Gate |
//! | --- | --- |
//! | `POST /api/w/{slug}/uploads` (multipart, field `file`) | viewer, multipart; then [`rules::can_stage_upload`] |
//! | `POST /api/w/{slug}/tasks/{idOrKey}/artifacts/upload` (multipart) | member, multipart; then [`rules::can_attach_artifact`] |
//! | `GET /api/w/{slug}/uploads/{id}` | any member (the parent record is checked by [`service::open`]) |
//! | `DELETE /api/w/{slug}/uploads/{id}` | viewer; only the uploader's unreferenced draft |
//!
//! # Public API for other crates
//!
//! The issues, projects, comments and artifacts crates call [`service`] whenever the text or
//! upload column of a record changes, exactly where NestJS calls `UploadsService`. Every
//! function takes the connection (`&state.db`, or a transaction) and the workspace id; the
//! request's member access and upload caller are read from the task-locals of `trama-auth`
//! (re-enter them with `with_access` / `with_upload_caller` after a `tokio::spawn`).
//!
//! | NestJS | Rust | When |
//! | --- | --- | --- |
//! | `assertAttachable(ws, text)` | [`service::assert_attachable`]`(&db, ws, text)` | before saving a description, issue body or comment: 400 `That file is not available to attach here` |
//! | `retained(ws, before, after, subject?)` | [`service::retained`]`(&db, ws, before, after, Some(&subject))` | after saving: keeps the files `after` mentions, deletes the ones it dropped |
//! | `{ type: 'issue', id, projectId }` | [`UploadSubject::issue`]`(id, project_id)` | subject of an issue body |
//! | `{ type: 'project', id, projectId: id }` | [`UploadSubject::project`]`(id)` | subject of a project description |
//! | `{ type: 'comment', id }` | [`UploadSubject::comment`]`(id)` | subject of a comment body |
//! | `{ type: 'artifact', id, projectId }` | [`UploadSubject::artifact`]`(id, project_id)` | subject of an artifact's upload |
//! | `linkArtifact(ws, artifactId, uploadId, projectId, manager?)` | [`service::link_artifact`] | pass the transaction as the connection |
//! | `forgetSubjects(ws, subjects)` | [`service::forget_subjects`] | after deleting records that mentioned files |
//! | `idsLostWith(ws, owner, texts)` then `releaseIds(ws, ids)` | [`service::ids_lost_with`] ([`LostOwner`]) then [`service::release_ids`] | before and after deleting an issue or project with its comments and artifacts |
//! | `reconcileUploadReferences(ws)` | [`service::reconcile_upload_references`] | maintenance and imports |
//! | `stage`, `attachArtifact`, `open`, `discard` | [`service::stage`], [`service::attach_artifact`], [`service::open`], [`service::discard`] | the routes above |
//!
//! Pure rules for the artifacts crate: [`rules::is_workspace_upload_url`] (an artifact `url` may
//! be a workspace path only when its `uploadId` owns it), [`rules::upload_ids_in`],
//! [`rules::upload_path`].
//!
//! ```
//! use trama_uploads::rules::{is_workspace_upload_url, upload_ids_in, upload_path};
//!
//! let url = upload_path("acme", "upl_abcdefghijkl");
//! assert!(is_workspace_upload_url(Some(&url)));
//! assert_eq!(upload_ids_in(Some(&format!("![shot.png]({url})"))), ["upl_abcdefghijkl"]);
//! ```

pub mod router;
pub mod rules;
pub mod schemas;
pub mod service;

pub use router::{ApiDoc, router};
pub use rules::{UPLOAD_MAX_BYTES, UploadKind};
pub use schemas::StagedUpload;
pub use service::{IncomingUpload, LostOwner, UploadSubject, UploadSubjectType};
