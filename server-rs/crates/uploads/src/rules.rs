//! The upload rules: the port of `server/src/uploads/upload-rules.ts`.
//!
//! Pure functions, no database: which files are accepted ([`inspect_upload`]), how an upload is
//! named in markdown and in a URL, and who may stage, attach or see one.

use std::sync::LazyLock;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use trama_auth::member_access::project_hidden;
use trama_auth::upload_caller::UploadCaller;
use trama_contracts::access::{MemberAccess, MemberAction, MemberGrant, MemberResource};
use trama_contracts::common::ActorRef;
use trama_contracts::js;
use trama_contracts::roles::legacy_role_at_least;

/// Hard cap for one upload (8 MiB). Also enforced by the multipart reader and a database check.
pub const UPLOAD_MAX_BYTES: usize = 8 * 1024 * 1024;

/// How a stored file is shown: images render inline, everything else is downloaded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum UploadKind {
    /// Rendered inline (`![name](url)`).
    Image,
    /// Downloaded as an attachment (`[name](url)`).
    File,
}

impl UploadKind {
    /// `image` or `file`, as stored in an artifact's `kind`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::File => "file",
        }
    }

    /// The kind of a stored content type: `image/*` is an image.
    #[must_use]
    pub fn of_content_type(content_type: &str) -> Self {
        if content_type.starts_with("image/") { Self::Image } else { Self::File }
    }
}

/// What a file's bytes must look like for its extension.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Family {
    Image,
    Pdf,
    Text,
    Office,
}

struct ExtensionSpec {
    content_type: &'static str,
    kind: UploadKind,
    family: Family,
}

/// Extensions we will store. Executables, archives and active content (HTML, SVG, script) are
/// absent on purpose.
fn extension_spec(ext: &str) -> Option<ExtensionSpec> {
    const DOCX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const PPTX: &str = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    let (content_type, kind, family) = match ext {
        "png" => ("image/png", UploadKind::Image, Family::Image),
        "jpg" | "jpeg" => ("image/jpeg", UploadKind::Image, Family::Image),
        "gif" => ("image/gif", UploadKind::Image, Family::Image),
        "webp" => ("image/webp", UploadKind::Image, Family::Image),
        "pdf" => ("application/pdf", UploadKind::File, Family::Pdf),
        "txt" => ("text/plain", UploadKind::File, Family::Text),
        "md" => ("text/markdown", UploadKind::File, Family::Text),
        "csv" => ("text/csv", UploadKind::File, Family::Text),
        "json" => ("application/json", UploadKind::File, Family::Text),
        "docx" => (DOCX, UploadKind::File, Family::Office),
        "xlsx" => (XLSX, UploadKind::File, Family::Office),
        "pptx" => (PPTX, UploadKind::File, Family::Office),
        _ => return None,
    };
    Some(ExtensionSpec { content_type, kind, family })
}

/// A file that passed [`inspect_upload`], with the name and type to store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedUpload {
    /// Sanitized `stem.ext`.
    pub filename: String,
    /// The content type of the extension (never the client's).
    pub content_type: &'static str,
    /// Image or file.
    pub kind: UploadKind,
    /// Size in bytes.
    pub byte_size: usize,
}

static UPLOAD_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^upl_[a-z0-9]{10,24}$").unwrap_or_else(|e| unreachable!("{e}")));
/// A workspace path stored in markdown and on an uploaded artifact: slug-shaped, no query or host.
static UPLOAD_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/api/w/[a-z0-9][a-z0-9-]{0,39}/uploads/(upl_[a-z0-9]{10,24})$")
        .unwrap_or_else(|e| unreachable!("{e}"))
});
/// `\b` is ASCII-only in JavaScript, so Unicode mode is off for it.
static UPLOAD_MENTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/uploads/(upl_[a-z0-9]{10,24})(?-u:\b)").unwrap_or_else(|e| unreachable!("{e}"))
});

/// `isUploadId`: `upl_` and 10 to 24 lowercase letters or digits.
#[must_use]
pub fn is_upload_id(id: &str) -> bool {
    UPLOAD_ID.is_match(id)
}

/// `isWorkspaceUploadUrl`: true for a same-origin upload path. Remote and protocol-relative URLs
/// are not.
#[must_use]
pub fn is_workspace_upload_url(url: Option<&str>) -> bool {
    url.is_some_and(|url| UPLOAD_URL.is_match(url))
}

/// `uploadPath`: `/api/w/<slug>/uploads/<id>`.
#[must_use]
pub fn upload_path(slug: &str, id: &str) -> String {
    format!("/api/w/{slug}/uploads/{id}")
}

/// `uploadIdsIn`: the distinct upload ids a text mentions through a workspace upload path, in
/// order of first appearance. The match is literal, so `_` in the id is not a wildcard.
#[must_use]
pub fn upload_ids_in(text: Option<&str>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for captures in UPLOAD_MENTION.captures_iter(text.unwrap_or_default()) {
        let id = &captures[1];
        if !ids.iter().any(|seen| seen == id) {
            ids.push(id.to_owned());
        }
    }
    ids
}

/// `markdownFor`: `![label](path)` for an image, `[label](path)` for a file. Brackets and line
/// breaks in the name become spaces; an empty name becomes `file`.
#[must_use]
pub fn markdown_for(kind: UploadKind, filename: &str, path: &str) -> String {
    let spaced = filename.replace(['[', ']', '\n', '\r'], " ");
    let label = match js::trim(&spaced) {
        "" => "file",
        label => label,
    };
    match kind {
        UploadKind::Image => format!("![{label}]({path})"),
        UploadKind::File => format!("[{label}]({path})"),
    }
}

/// What `encodeURIComponent` leaves alone besides letters and digits.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// `contentDisposition`: `inline` for images (so markdown can render them), `attachment` for
/// everything else.
#[must_use]
pub fn content_disposition(kind: UploadKind, filename: &str) -> String {
    let mode = if kind == UploadKind::Image { "inline" } else { "attachment" };
    // JavaScript replaces per UTF-16 code unit: an astral character becomes two underscores
    let mut ascii = String::new();
    for c in filename.chars() {
        if (' '..='~').contains(&c) && c != '"' && c != '\\' {
            ascii.push(c);
        } else {
            ascii.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    let encoded = utf8_percent_encode(filename, URI_COMPONENT);
    format!("{mode}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

/// `inspectUpload`: accepts a file by name and bytes, or says why not (the 400 message).
///
/// # Errors
///
/// The user-facing reason: empty, over 8 MB, extension not allowed, executable or active content,
/// or contents that do not match the type.
pub fn inspect_upload(original_name: &str, bytes: &[u8]) -> Result<AcceptedUpload, &'static str> {
    let byte_size = bytes.len();
    if byte_size == 0 {
        return Err("The file is empty");
    }
    if byte_size > UPLOAD_MAX_BYTES {
        return Err("File is larger than 8 MB");
    }
    let Some((stem, ext)) = parse_filename(original_name) else {
        return Err("This file type is not allowed");
    };
    let Some(spec) = extension_spec(&ext) else {
        return Err("This file type is not allowed");
    };
    if looks_executable(bytes) {
        return Err("Executables and active content are not allowed");
    }
    if !contents_match(spec.family, &ext, bytes) {
        return Err("The file contents do not match its type");
    }
    Ok(AcceptedUpload {
        filename: format!("{stem}.{ext}"),
        content_type: spec.content_type,
        kind: spec.kind,
        byte_size,
    })
}

fn strip_controls(value: &str) -> String {
    value.chars().filter(|c| *c >= ' ' && *c != '\u{7f}').collect()
}

/// The base name split into `(stem, lowercase extension)`; `None` without a usable extension.
fn parse_filename(original: &str) -> Option<(String, String)> {
    let stripped = strip_controls(original).replace('\\', "/");
    let base = js::trim(stripped.rsplit('/').next().unwrap_or_default()).to_owned();
    let cleaned = strip_controls(&base);
    let dot = cleaned.rfind('.')?;
    if dot == 0 || dot == cleaned.len() - 1 {
        return None;
    }
    let ext = cleaned[dot + 1..].to_lowercase();
    let stem = cleaned[..dot].trim_end_matches(['.', ' ']);
    let stem = js::truncate(stem, 120).to_owned();
    if stem.is_empty() || !ext.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
        return None;
    }
    Some((stem, ext))
}

fn contents_match(family: Family, ext: &str, bytes: &[u8]) -> bool {
    match family {
        Family::Pdf => bytes.starts_with(b"%PDF"),
        Family::Office => is_zip(bytes),
        Family::Image => image_matches(ext, bytes),
        Family::Text => is_plain_text(bytes),
    }
}

fn image_matches(ext: &str, bytes: &[u8]) -> bool {
    match ext {
        "png" => bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x50, 0x4b, 0x03, 0x04])
        || bytes.starts_with(&[0x50, 0x4b, 0x05, 0x06])
        || bytes.starts_with(&[0x50, 0x4b, 0x07, 0x08])
}

/// Signatures of programs and bytecode. Checked even when the extension is on the allowlist.
fn looks_executable(bytes: &[u8]) -> bool {
    const SIGNATURES: [&[u8]; 8] = [
        &[0x4d, 0x5a],             // PE
        &[0x7f, 0x45, 0x4c, 0x46], // ELF
        &[0xfe, 0xed, 0xfa, 0xce], // Mach-O
        &[0xfe, 0xed, 0xfa, 0xcf],
        &[0xce, 0xfa, 0xed, 0xfe],
        &[0xcf, 0xfa, 0xed, 0xfe],
        &[0xca, 0xfe, 0xba, 0xbe], // Java class / universal binary
        &[0x00, 0x61, 0x73, 0x6d], // WebAssembly
    ];
    SIGNATURES.iter().any(|sig| bytes.starts_with(sig))
}

/// What text must not start with: scripts and markup a browser would run.
const ACTIVE: [&str; 7] = ["#!", "<!doctype", "<html", "<script", "<svg", "<?xml", "<head"];

fn is_plain_text(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    let Ok(text) = std::str::from_utf8(bytes) else { return false };
    let head: String = text.trim_start_matches(js::is_whitespace).chars().take(64).collect();
    let head = head.to_lowercase();
    !ACTIVE.iter().any(|prefix| head.starts_with(prefix))
}

/// The resource of a record that mentions a file, in the vocabulary of the grants and API
/// permissions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadResource {
    /// An artifact (`artifacts:view`, `artifacts:read`).
    Artifacts,
    /// An issue (`issues:view`, `tasks:read`).
    Issues,
    /// A project (`projects:view`, `projects:read`).
    Projects,
    /// A comment (`comments:view`, `comments:read`).
    Comments,
}

impl UploadResource {
    const fn member_resource(self) -> MemberResource {
        match self {
            Self::Artifacts => MemberResource::Artifacts,
            Self::Issues => MemberResource::Issues,
            Self::Projects => MemberResource::Projects,
            Self::Comments => MemberResource::Comments,
        }
    }

    /// The API token permission that lets a `custom` token read this resource.
    const fn api_read(self) -> &'static str {
        match self {
            Self::Artifacts => "artifacts:read",
            Self::Issues => "tasks:read",
            Self::Projects => "projects:read",
            Self::Comments => "comments:read",
        }
    }
}

/// A place the bytes are still mentioned. `project_scoped: false` is workspace-wide.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadRef {
    /// What kind of record mentions the file.
    pub resource: UploadResource,
    /// Whether the member's project limit applies to it.
    pub project_scoped: bool,
    /// The project of the record, if any.
    pub project_id: Option<String>,
}

/// Grants that may stage a file into a description or a comment. Attaching an artifact is
/// separate.
const STAGE_GRANTS: [MemberGrant; 5] = [
    MemberGrant::new(MemberResource::Issues, MemberAction::Update),
    MemberGrant::new(MemberResource::Projects, MemberAction::Update),
    MemberGrant::new(MemberResource::Comments, MemberAction::Create),
    MemberGrant::new(MemberResource::Comments, MemberAction::Update),
    MemberGrant::new(MemberResource::Artifacts, MemberAction::Create),
];
const STAGE_PERMISSIONS: [&str; 4] =
    ["tasks:write", "projects:write", "comments:write", "artifacts:write"];

/// `uploadVisible`: may a caller with this member access and token permissions read a file
/// through this mention?
#[must_use]
pub fn upload_visible(
    reference: &UploadRef,
    access: Option<&MemberAccess>,
    permissions: Option<&[String]>,
) -> bool {
    if reference.project_scoped && project_hidden(access, reference.project_id.as_deref()) {
        return false;
    }
    if let Some(access) = access {
        let view = MemberGrant::new(reference.resource.member_resource(), MemberAction::View);
        if !access.grants.contains(&view) {
            return false;
        }
    }
    if let Some(permissions) = permissions
        && !permissions.iter().any(|p| p == reference.resource.api_read())
    {
        return false;
    }
    true
}

/// `canStageUpload`: a description or comment upload. Full members pass; a narrowed person needs
/// a write grant on one of those records.
#[must_use]
pub fn can_stage_upload(caller: &UploadCaller, access: Option<&MemberAccess>) -> bool {
    if let Some(permissions) = &caller.permissions
        && !STAGE_PERMISSIONS.iter().any(|p| permissions.iter().any(|x| x == p))
    {
        return false;
    }
    if let Some(access) = access {
        return STAGE_GRANTS.iter().any(|grant| access.grants.contains(grant));
    }
    if caller.permissions.is_some() {
        return true;
    }
    legacy_role_at_least(&caller.role, "member")
}

/// `canAttachArtifact`: attaching an uploaded file to a task as an artifact.
#[must_use]
pub fn can_attach_artifact(caller: &UploadCaller, access: Option<&MemberAccess>) -> bool {
    if let Some(permissions) = &caller.permissions
        && !permissions.iter().any(|p| p == "artifacts:write")
    {
        return false;
    }
    if let Some(access) = access {
        return access
            .grants
            .contains(&MemberGrant::new(MemberResource::Artifacts, MemberAction::Create));
    }
    if caller.permissions.is_some() {
        return true;
    }
    legacy_role_at_least(&caller.role, "member")
}

/// `sameActor`: same kind and the same non-empty id.
#[must_use]
pub fn same_actor(a: &ActorRef, b: &ActorRef) -> bool {
    a.kind == b.kind && a.id.as_deref().is_some_and(|id| !id.is_empty()) && a.id == b.id
}

#[cfg(test)]
mod tests {
    use trama_contracts::access::MemberProjectScope;

    use super::*;

    const PNG: [u8; 10] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
    const EXE: [u8; 4] = [0x4d, 0x5a, 0x90, 0x00];

    fn member() -> UploadCaller {
        UploadCaller {
            actor: ActorRef::user("usr_1"),
            role: "member".to_owned(),
            permissions: None,
        }
    }

    fn accepted(name: &str, bytes: &[u8]) -> AcceptedUpload {
        inspect_upload(name, bytes).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    #[test]
    fn accepts_an_image_and_a_document() {
        let png = accepted("shot.PNG", &PNG);
        assert_eq!(
            (png.filename.as_str(), png.content_type, png.kind),
            ("shot.png", "image/png", UploadKind::Image)
        );
        let md = accepted("notes/readme.md", b"# hi");
        assert_eq!(
            (md.filename.as_str(), md.content_type, md.kind),
            ("readme.md", "text/markdown", UploadKind::File)
        );
        accepted("spec.pdf", b"%PDF-1.7");
        accepted("photo.jpg", &[0xff, 0xd8, 0xff, 0xd9]);
        accepted("anim.gif", b"GIF89a");
        accepted("old.gif", b"GIF87a");
        accepted("sheet.xlsx", &[0x50, 0x4b, 0x03, 0x04, 0x00]);
        accepted("deck.pptx", &[0x50, 0x4b, 0x05, 0x06]);
        accepted("doc.docx", &[0x50, 0x4b, 0x07, 0x08]);
        accepted("pic.webp", b"RIFF\0\0\0\0WEBPVP8 ");
        accepted("data.csv", b"a,b\n1,2");
        accepted("data.json", b"{}");
        assert_eq!(accepted("../secret.png", &PNG).filename, "secret.png");
        assert_eq!(accepted("C:\\Users\\me\\scan.png", &PNG).filename, "scan.png");
    }

    #[test]
    fn rejects_executables_active_content_mismatches_and_big_files() {
        assert!(inspect_upload("run.exe", &EXE).is_err());
        assert_eq!(
            inspect_upload("run.png", &EXE),
            Err("Executables and active content are not allowed")
        );
        assert!(inspect_upload("page.html", b"<html></html>").is_err());
        assert!(inspect_upload("icon.svg", b"<svg></svg>").is_err());
        assert_eq!(
            inspect_upload("page.txt", b"<script>alert(1)</script>"),
            Err("The file contents do not match its type")
        );
        assert!(inspect_upload("tool.txt", b"#!/bin/sh\necho hi").is_err());
        assert!(inspect_upload("page.md", b"  \n<!DOCTYPE html>").is_err());
        assert!(inspect_upload("page.md", b"<?xml version=\"1.0\"?>").is_err());
        assert!(inspect_upload("page.md", b"<head></head>").is_err());
        assert!(inspect_upload("app.js", b"alert(1)").is_err());
        assert_eq!(
            inspect_upload("pic.png", b"not a png"),
            Err("The file contents do not match its type")
        );
        assert_eq!(
            inspect_upload("big.png", &vec![0; UPLOAD_MAX_BYTES + 1]),
            Err("File is larger than 8 MB")
        );
        assert_eq!(inspect_upload("empty.png", b""), Err("The file is empty"));
        assert_eq!(inspect_upload("noext", &PNG), Err("This file type is not allowed"));
        assert_eq!(inspect_upload(".png", &PNG), Err("This file type is not allowed"));
        assert_eq!(inspect_upload("trailing.", &PNG), Err("This file type is not allowed"));
        assert_eq!(inspect_upload(" ..png", &PNG), Err("This file type is not allowed"));
        assert!(inspect_upload("nul.txt", b"a\0b").is_err());
        assert!(inspect_upload("latin1.txt", &[0xe9, 0x41]).is_err());
        // the limit itself is allowed
        assert!(inspect_upload("edge.txt", &vec![b'a'; UPLOAD_MAX_BYTES]).is_ok());
    }

    #[test]
    fn cleans_the_name() {
        assert_eq!(accepted("a\u{1}b\u{7f}.png", &PNG).filename, "ab.png");
        assert_eq!(accepted("report .. .png", &PNG).filename, "report.png");
        let long = format!("{}.png", "x".repeat(300));
        assert_eq!(accepted(&long, &PNG).filename.len(), 124);
        assert_eq!(accepted("café.png", &PNG).filename, "café.png");
    }

    #[test]
    fn recognises_only_a_workspace_path() {
        let url = "/api/w/acme/uploads/upl_abcdefghijkl";
        assert!(is_workspace_upload_url(Some(url)));
        assert!(!is_workspace_upload_url(None));
        assert!(!is_workspace_upload_url(Some(&format!("https://example.com{url}"))));
        assert!(!is_workspace_upload_url(Some("//evil/uploads/upl_abcdefghijkl")));
        assert!(!is_workspace_upload_url(Some(&format!("{url}?x=1"))));
        assert!(!is_workspace_upload_url(Some(&format!("{url}\n"))));
        assert_eq!(upload_ids_in(Some(&format!("see {url} and {url}"))), ["upl_abcdefghijkl"]);
        assert_eq!(upload_ids_in(None), Vec::<String>::new());
        // the match is literal: `_` is not a wildcard, the id must end at a word boundary
        assert!(upload_ids_in(Some("/uploads/uplXabcdefghijkl")).is_empty());
        assert!(upload_ids_in(Some("/uploads/upl_abcdefghijklmnopqrstuvwxyz0")).is_empty());
        assert_eq!(upload_ids_in(Some("/uploads/upl_abcdefghijkl)")), ["upl_abcdefghijkl"]);
        assert_eq!(upload_ids_in(Some("/uploads/upl_abcdefghijklé")), ["upl_abcdefghijkl"]);
        assert!(is_upload_id("upl_abcdefghij"));
        assert!(!is_upload_id("upl_short"));
        assert!(!is_upload_id("upl_abcdefghij\n"));
    }

    #[test]
    fn names_the_file_in_markdown_and_headers() {
        assert_eq!(markdown_for(UploadKind::Image, "shot.png", "/p"), "![shot.png](/p)");
        assert_eq!(markdown_for(UploadKind::File, "a[1]\r\n.pdf", "/p"), "[a 1   .pdf](/p)");
        assert_eq!(markdown_for(UploadKind::File, "[]", "/p"), "[file](/p)");
        assert!(content_disposition(UploadKind::Image, "shot.png").starts_with("inline;"));
        assert_eq!(
            content_disposition(UploadKind::File, "notes.md"),
            "attachment; filename=\"notes.md\"; filename*=UTF-8''notes.md"
        );
        assert_eq!(
            content_disposition(UploadKind::File, "a \"b\" é😀.md"),
            "attachment; filename=\"a _b_ ___.md\"; filename*=UTF-8''a%20%22b%22%20%C3%A9%F0%9F%98%80.md"
        );
    }

    fn limited() -> MemberAccess {
        let grants = ["issues:view", "artifacts:view", "comments:view", "projects:view"]
            .iter()
            .filter_map(|g| MemberGrant::parse(g))
            .collect();
        MemberAccess {
            projects: MemberProjectScope { all: false, project_ids: vec!["pj_1".to_owned()] },
            include_unassigned: false,
            grants,
        }
    }

    fn reference(resource: UploadResource, scoped: bool, project: Option<&str>) -> UploadRef {
        UploadRef { resource, project_scoped: scoped, project_id: project.map(ToOwned::to_owned) }
    }

    #[test]
    fn hides_a_file_whose_parent_project_is_outside_the_caller() {
        let access = limited();
        let issue = |p| reference(UploadResource::Issues, true, Some(p));
        assert!(!upload_visible(&issue("pj_2"), Some(&access), None));
        assert!(upload_visible(&issue("pj_1"), Some(&access), None));
        assert!(!upload_visible(&issue("pj_1"), Some(&access), Some(&["projects:read".into()])));
        assert!(upload_visible(&issue("pj_1"), Some(&access), Some(&["tasks:read".into()])));
        let comment = reference(UploadResource::Comments, false, None);
        assert!(upload_visible(&comment, Some(&access), None));
        // no project on a scoped record: hidden unless unassigned work is included
        assert!(!upload_visible(
            &reference(UploadResource::Issues, true, None),
            Some(&access),
            None
        ));
        // a grant the person lacks
        let mut no_comments = access.clone();
        no_comments.grants.retain(|g| g.resource != MemberResource::Comments);
        assert!(!upload_visible(&comment, Some(&no_comments), None));
        assert!(upload_visible(&issue("pj_2"), None, None));
    }

    #[test]
    fn lets_a_member_stage_a_file_and_refuses_a_viewer_or_a_token_without_a_write() {
        let viewer = UploadCaller { role: "viewer".to_owned(), ..member() };
        let token = |p: &str| UploadCaller { permissions: Some(vec![p.to_owned()]), ..member() };
        assert!(can_stage_upload(&member(), None));
        assert!(!can_stage_upload(&viewer, None));
        assert!(!can_stage_upload(&token("issues:read"), None));
        assert!(can_stage_upload(&token("tasks:write"), None));
        assert!(!can_attach_artifact(&viewer, None));
        assert!(can_attach_artifact(&member(), None));
        assert!(!can_attach_artifact(&token("tasks:write"), None));
        assert!(can_attach_artifact(&token("artifacts:write"), None));
        // custom role ids are never ranked
        assert!(!can_stage_upload(&UploadCaller { role: "triager".to_owned(), ..member() }, None));
    }

    #[test]
    fn a_narrowed_person_needs_a_write_grant() {
        let read_only = limited();
        assert!(!can_stage_upload(&member(), Some(&read_only)));
        assert!(!can_attach_artifact(&member(), Some(&read_only)));
        let mut writer = limited();
        writer.grants.push(MemberGrant::parse("comments:create").unwrap_or_else(|| unreachable!()));
        assert!(can_stage_upload(&member(), Some(&writer)));
        assert!(!can_attach_artifact(&member(), Some(&writer)));
        writer
            .grants
            .push(MemberGrant::parse("artifacts:create").unwrap_or_else(|| unreachable!()));
        assert!(can_attach_artifact(&member(), Some(&writer)));
    }

    #[test]
    fn same_actor_needs_an_id() {
        assert!(same_actor(&ActorRef::user("a"), &ActorRef::user("a")));
        assert!(!same_actor(&ActorRef::user("a"), &ActorRef::agent("a")));
        assert!(!same_actor(&ActorRef::user("a"), &ActorRef::user("b")));
        assert!(!same_actor(&ActorRef::system(), &ActorRef::system()));
    }
}
