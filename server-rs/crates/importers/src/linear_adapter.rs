//! Linear as an import source (`importers/linear-adapter.ts`).
//!
//! PLACEHOLDER: the adapter is being ported; every call fails until it lands.

use async_trait::async_trait;
use trama_contracts::imports::{ExternalProvider, ImportOptions};
use trama_integrations::Http;

use crate::types::{
    Discovery, ExternalComment, ExternalIssue, ImportSourceAdapter, Page, SourceError,
};

/// Reads the issues, projects, cycles-as-milestones, labels and comments of Linear teams.
pub struct LinearAdapter {
    #[allow(dead_code)]
    http: Http,
    #[allow(dead_code)]
    token: String,
    #[allow(dead_code)]
    team_ids: Vec<String>,
}

impl LinearAdapter {
    /// An adapter over `team_ids` (empty = every team).
    #[must_use]
    pub const fn new(http: Http, token: String, team_ids: Vec<String>) -> Self {
        Self { http, token, team_ids }
    }
}

fn pending() -> SourceError {
    SourceError::Unexpected("The Linear import adapter is not available yet".into())
}

#[async_trait]
impl ImportSourceAdapter for LinearAdapter {
    fn provider(&self) -> ExternalProvider {
        ExternalProvider::Linear
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
