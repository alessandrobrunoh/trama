//! What an artifact needs to know about a pull / merge request, read from its URL
//! (`server/src/threads/pull-request-url.ts`).

use std::sync::LazyLock;

use regex::Regex;
use trama_contracts::issues::{ArtifactKind, ArtifactProvider};
use trama_contracts::js;
use url::Url;

/// A pull or merge request, as far as its URL tells.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullRequestRef {
    /// `pull_request` or `merge_request`.
    pub kind: ArtifactKind,
    /// The git host.
    pub provider: ArtifactProvider,
    /// `owner/name` of the repository, when the URL shows it.
    pub repository: Option<String>,
    /// `#423` (GitHub, Bitbucket) or `!17` (GitLab).
    pub external_id: Option<String>,
    /// What the artifact is called.
    pub title: String,
}

const TITLE_MAX: usize = 200;

static GITHUB: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/([^/]+/[^/]+)/pull/([0-9]+)(?:/|$)").unwrap_or_else(|e| unreachable!("{e}"))
});
static GITLAB: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/(.+?)/(?:-/)?merge_requests/([0-9]+)(?:/|$)")
        .unwrap_or_else(|e| unreachable!("{e}"))
});
static BITBUCKET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/([^/]+/[^/]+)/pull-requests/([0-9]+)(?:/|$)")
        .unwrap_or_else(|e| unreachable!("{e}"))
});

fn title(text: &str) -> String {
    js::truncate(text, TITLE_MAX).to_owned()
}

/// Reads `https://github.com/acme/web/pull/423`,
/// `https://gitlab.com/acme/web/-/merge_requests/17` and
/// `https://bitbucket.org/acme/web/pull-requests/9`. Any other URL is a pull request of an
/// unknown provider, titled after the URL.
#[must_use]
pub fn parse_pull_request_url(raw: &str) -> PullRequestRef {
    let Ok(url) = Url::parse(raw) else {
        return PullRequestRef {
            kind: ArtifactKind::PullRequest,
            provider: ArtifactProvider::Other,
            repository: None,
            external_id: None,
            title: title(raw),
        };
    };
    let host = url.host_str().unwrap_or_default().to_lowercase();
    let path = url.path().trim_end_matches('/');

    if let Some(found) = GITHUB.captures(path)
        && (host == "github.com" || host.starts_with("github."))
    {
        return PullRequestRef {
            kind: ArtifactKind::PullRequest,
            provider: ArtifactProvider::Github,
            repository: Some(found[1].to_owned()),
            external_id: Some(format!("#{}", &found[2])),
            title: format!("{}#{}", &found[1], &found[2]),
        };
    }
    if let Some(found) = GITLAB.captures(path)
        && host.contains("gitlab")
    {
        return PullRequestRef {
            kind: ArtifactKind::MergeRequest,
            provider: ArtifactProvider::Gitlab,
            repository: Some(found[1].to_owned()),
            external_id: Some(format!("!{}", &found[2])),
            title: format!("{}!{}", &found[1], &found[2]),
        };
    }
    if let Some(found) = BITBUCKET.captures(path)
        && host.contains("bitbucket")
    {
        return PullRequestRef {
            kind: ArtifactKind::PullRequest,
            provider: ArtifactProvider::Bitbucket,
            repository: Some(found[1].to_owned()),
            external_id: Some(format!("#{}", &found[2])),
            title: format!("{}#{}", &found[1], &found[2]),
        };
    }
    // `URL.host`: the host with its port unless it is the default one
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    PullRequestRef {
        kind: ArtifactKind::PullRequest,
        provider: ArtifactProvider::Other,
        repository: None,
        external_id: None,
        title: title(&format!("{authority}{path}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_github_pull_request() {
        assert_eq!(
            parse_pull_request_url("https://github.com/acme/web/pull/423"),
            PullRequestRef {
                kind: ArtifactKind::PullRequest,
                provider: ArtifactProvider::Github,
                repository: Some("acme/web".into()),
                external_id: Some("#423".into()),
                title: "acme/web#423".into(),
            }
        );
        assert_eq!(
            parse_pull_request_url("https://github.com/acme/web/pull/423/files?x=1")
                .external_id
                .as_deref(),
            Some("#423")
        );
    }

    #[test]
    fn reads_a_gitlab_merge_request_including_groups() {
        assert_eq!(
            parse_pull_request_url("https://gitlab.com/acme/platform/web/-/merge_requests/17"),
            PullRequestRef {
                kind: ArtifactKind::MergeRequest,
                provider: ArtifactProvider::Gitlab,
                repository: Some("acme/platform/web".into()),
                external_id: Some("!17".into()),
                title: "acme/platform/web!17".into(),
            }
        );
    }

    #[test]
    fn reads_a_bitbucket_pull_request() {
        assert_eq!(
            parse_pull_request_url("https://bitbucket.org/acme/web/pull-requests/9").provider,
            ArtifactProvider::Bitbucket
        );
    }

    #[test]
    fn keeps_any_other_url_as_a_pull_request_of_an_unknown_provider() {
        assert_eq!(
            parse_pull_request_url("https://git.example.com/review/42/"),
            PullRequestRef {
                kind: ArtifactKind::PullRequest,
                provider: ArtifactProvider::Other,
                repository: None,
                external_id: None,
                title: "git.example.com/review/42".into(),
            }
        );
    }

    #[test]
    fn a_pull_request_path_on_an_unrelated_host_is_not_a_github_one() {
        let other = parse_pull_request_url("https://example.com:8443/acme/web/pull/1");
        assert_eq!(other.provider, ArtifactProvider::Other);
        assert_eq!(other.title, "example.com:8443/acme/web/pull/1");
    }

    #[test]
    fn a_value_that_is_not_a_url_is_titled_after_itself() {
        let other = parse_pull_request_url("not a url");
        assert_eq!(other.provider, ArtifactProvider::Other);
        assert_eq!(other.title, "not a url");
    }
}
