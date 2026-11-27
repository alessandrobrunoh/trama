//! GitHub Issues as an import source (`importers/github-adapter.ts`).
//!
//! PLACEHOLDER: the adapter is being ported; every call fails until it lands.

use async_trait::async_trait;
use trama_contracts::imports::{ExternalProvider, ImportOptions};
use trama_integrations::Http;

use crate::types::{
    Discovery, ExternalComment, ExternalIssue, ImportSourceAdapter, Page, SourceError,
};

/// Reads one repository's issues, labels, milestones and comments.
pub struct GithubAdapter {
    #[allow(dead_code)]
    http: Http,
    #[allow(dead_code)]
    token: Option<String>,
    #[allow(dead_code)]
    repository: String,
    #[allow(dead_code)]
    base_url: Option<String>,
}

impl GithubAdapter {
    /// An adapter for `repository` (`owner/name`), unauthenticated when `token` is `None`, on
    /// GitHub Enterprise when `base_url` is set.
    #[must_use]
    pub const fn new(
        http: Http,
        token: Option<String>,
        repository: String,
        base_url: Option<String>,
    ) -> Self {
        Self { http, token, repository, base_url }
    }
}

fn pending() -> SourceError {
    SourceError::Unexpected("The GitHub import adapter is not available yet".into())
}

#[async_trait]
impl ImportSourceAdapter for GithubAdapter {
    fn provider(&self) -> ExternalProvider {
        ExternalProvider::Github
    }
    async fn discover(&self) -> Result<Discovery, SourceError> {
        Err(pending())
    }
    async fn issues(
        &self,
        _cursor: Option<&str>,
        _options: &ImportOptions,
    ) -> Result<Page<ExternalIssue>, SourceError> {
        Err(pending())
    }
    async fn comments(&self, _cursor: Option<&str>) -> Result<Page<ExternalComment>, SourceError> {
        Err(pending())
    }
    async fn get_issue(&self, _id: &str) -> Result<ExternalIssue, SourceError> {
        Err(pending())
    }
}
