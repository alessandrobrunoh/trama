//! Shared building blocks: ids, actors, subjects, priorities, git providers, URL rules and
//! constants several modules import.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Opaque prefixed id (`ws_…`, `pj_…`).
pub type Id = String;
/// ISO-8601 timestamp, as `trama_core::time::to_iso` writes it.
pub type IsoDate = String;

/// Name of the short-lived tokens minted for an assistant chat turn (hidden from the tokens
/// list). From `server/src/ai/assistant-tools.service.ts`.
pub const ASSISTANT_TOKEN_NAME: &str = "Assistant (temporary)";

/// One hour in milliseconds (`HOUR` of `server/src/database/seed/builder.ts`).
pub const HOUR_MS: i64 = 3_600_000;
/// One day in milliseconds (`DAY` of `server/src/database/seed/builder.ts`).
pub const DAY_MS: i64 = 24 * HOUR_MS;

string_enum! {
    /// Kind of actor behind a change.
    pub enum ActorType {
        User = "user",
        Agent = "agent",
        System = "system",
    }
}

/// Who did something.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
pub struct ActorRef {
    /// Actor kind.
    #[serde(rename = "type")]
    pub kind: ActorType,
    /// Omitted for `system`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
}

impl ActorRef {
    /// A user actor.
    #[must_use]
    pub fn user(id: impl Into<Id>) -> Self {
        Self { kind: ActorType::User, id: Some(id.into()) }
    }

    /// An agent actor.
    #[must_use]
    pub fn agent(id: impl Into<Id>) -> Self {
        Self { kind: ActorType::Agent, id: Some(id.into()) }
    }

    /// The system actor (no id).
    #[must_use]
    pub fn system() -> Self {
        Self { kind: ActorType::System, id: None }
    }
}

string_enum! {
    /// Comment, event and search subject. `issue` is the task discriminator; it is not renamed
    /// to `task`.
    pub enum SubjectType {
        Issue = "issue",
        Artifact = "artifact",
        Project = "project",
        Milestone = "milestone",
        Import = "import",
    }
}

/// A record something is about.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
pub struct SubjectRef {
    /// Record kind.
    #[serde(rename = "type")]
    pub kind: SubjectType,
    /// Record id.
    pub id: Id,
}

string_enum! {
    /// [`SubjectType`] plus the retired `workstream`, which historical rows may still name.
    pub enum LegacySubjectType {
        Issue = "issue",
        Artifact = "artifact",
        Project = "project",
        Milestone = "milestone",
        Import = "import",
        Workstream = "workstream",
    }
}

impl From<SubjectType> for LegacySubjectType {
    fn from(value: SubjectType) -> Self {
        match value {
            SubjectType::Issue => Self::Issue,
            SubjectType::Artifact => Self::Artifact,
            SubjectType::Project => Self::Project,
            SubjectType::Milestone => Self::Milestone,
            SubjectType::Import => Self::Import,
        }
    }
}

/// `SubjectRef | { type: 'workstream'; id }`: historical comments and events may still point at
/// the retired Workstream entity.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
pub struct LegacySubjectRef {
    /// Record kind.
    #[serde(rename = "type")]
    pub kind: LegacySubjectType,
    /// Record id.
    pub id: Id,
}

impl From<SubjectRef> for LegacySubjectRef {
    fn from(value: SubjectRef) -> Self {
        Self { kind: value.kind.into(), id: value.id }
    }
}

string_enum! {
    /// Priority of an issue or project.
    pub enum Priority {
        None = "none",
        Urgent = "urgent",
        High = "high",
        Medium = "medium",
        Low = "low",
    }
}

string_enum! {
    /// Runtimes that can act in a workspace. `human` = a person.
    pub enum ExecutionProvider {
        Human = "human",
        Delta = "delta",
        ClaudeCode = "claude_code",
        Codex = "codex",
        Cursor = "cursor",
        Other = "other",
    }
}

string_enum! {
    /// `Exclude<ExecutionProvider, 'human'>`: the runtime of a registered agent.
    pub enum AgentProvider {
        Delta = "delta",
        ClaudeCode = "claude_code",
        Codex = "codex",
        Cursor = "cursor",
        Other = "other",
    }
}

string_enum! {
    /// A git host.
    pub enum GitProvider {
        Github = "github",
        Gitlab = "gitlab",
        Bitbucket = "bitbucket",
    }
}

/// `GIT_PROVIDERS`.
pub const GIT_PROVIDERS: &[GitProvider] = GitProvider::ALL;

/// What differs between git hosts (`GIT_PROVIDER_META`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitProviderMeta {
    /// Display name.
    pub label: &'static str,
    /// Public web host used to build repository URLs (`https://<host>/<fullName>`).
    pub host: &'static str,
    /// Whether a connection may point at another instance via its base URL.
    pub self_hosted: bool,
}

impl GitProvider {
    /// `GIT_PROVIDER_META[provider]`.
    #[must_use]
    pub const fn meta(self) -> GitProviderMeta {
        match self {
            Self::Github => {
                GitProviderMeta { label: "GitHub", host: "github.com", self_hosted: true }
            }
            Self::Gitlab => {
                GitProviderMeta { label: "GitLab", host: "gitlab.com", self_hosted: true }
            }
            Self::Bitbucket => {
                GitProviderMeta { label: "Bitbucket", host: "bitbucket.org", self_hosted: false }
            }
        }
    }
}

/// Longest `Project.repository` / artifact repository string, in characters.
pub const PROJECT_REPOSITORY_MAX: usize = 2048;

/// Longest `Issue.threadUrl`, in characters.
pub const ISSUE_THREAD_URL_MAX: usize = 2048;

/// https URL on delta.dev (or a subdomain), e.g. a Delta thread.
#[must_use]
pub fn is_delta_thread_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false };
    let host = url.host_str().unwrap_or("").to_lowercase();
    url.scheme() == "https" && (host == "delta.dev" || host.ends_with(".delta.dev"))
}

fn is_http_with_host(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(|h| !h.is_empty())
    })
}

/// The URL (trimmed) when it is a plain `http(s)` URL of at most 2000 characters, otherwise
/// `None`. Never `javascript:` or `data:`.
#[must_use]
pub fn normalize_http_url(input: &str) -> Option<String> {
    let raw = crate::js::trim(input);
    if raw.is_empty() || crate::js::len(raw) > 2000 {
        return None;
    }
    is_http_with_host(raw).then(|| raw.to_owned())
}

/// True when the value is a plain `http(s)` URL with a host, without surrounding spaces, of at
/// most [`ISSUE_THREAD_URL_MAX`] characters.
#[must_use]
pub fn is_thread_url(value: &str) -> bool {
    let raw = crate::js::trim(value);
    if raw.is_empty() || raw != value || crate::js::len(raw) > ISSUE_THREAD_URL_MAX {
        return false;
    }
    is_http_with_host(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actor_ref_omits_the_system_id() {
        assert_eq!(serde_json::to_string(&ActorRef::system()).unwrap(), r#"{"type":"system"}"#);
        assert_eq!(
            serde_json::to_string(&ActorRef::user("u_1")).unwrap(),
            r#"{"type":"user","id":"u_1"}"#
        );
    }

    #[test]
    fn checks_urls_like_the_contract() {
        assert!(is_delta_thread_url("https://delta.dev/t/1"));
        assert!(is_delta_thread_url("https://app.Delta.dev/t/1"));
        assert!(!is_delta_thread_url("http://delta.dev/t/1"));
        assert!(!is_delta_thread_url("https://evildelta.dev"));
        assert_eq!(normalize_http_url("  https://x.io/a "), Some("https://x.io/a".into()));
        assert_eq!(normalize_http_url("javascript:alert(1)"), None);
        assert_eq!(normalize_http_url("data:text/html,hi"), None);
        assert!(is_thread_url("https://x.io/t"));
        assert!(!is_thread_url(" https://x.io/t"));
        assert!(!is_thread_url("ftp://x.io/t"));
        assert!(!is_thread_url(&format!("https://x.io/{}", "a".repeat(2048))));
    }

    #[test]
    fn enums_use_the_wire_strings() {
        assert_eq!(
            serde_json::to_string(&ExecutionProvider::ClaudeCode).unwrap(),
            "\"claude_code\""
        );
        assert_eq!(Priority::parse("urgent"), Some(Priority::Urgent));
        assert_eq!(Priority::parse("URGENT"), None);
        assert_eq!(GitProvider::Bitbucket.meta().host, "bitbucket.org");
    }
}
