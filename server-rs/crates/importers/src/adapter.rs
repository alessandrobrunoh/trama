//! Picking the tracker adapter and turning its failures into HTTP errors
//! (`createAdapter` / `providerFailure` of `importers/credentials.service.ts`).

use axum::http::StatusCode;
use trama_contracts::imports::{ExternalProvider, ImportSource};
use trama_core::AppError;
use trama_integrations::Http;

use crate::credentials::ResolvedCredential;
use crate::github_adapter::GithubAdapter;
use crate::linear_adapter::LinearAdapter;
use crate::mapping::redact_secrets;
use crate::types::{ImportSourceAdapter, SourceError};

/// The adapter for `provider`, reading `source` with `cred`.
///
/// # Errors
///
/// 400 when a GitHub source has no repository or a Linear import has no API key.
pub fn create_adapter(
    http: Http,
    provider: ExternalProvider,
    cred: &ResolvedCredential,
    source: &ImportSource,
) -> Result<Box<dyn ImportSourceAdapter>, AppError> {
    match provider {
        ExternalProvider::Github => {
            let repository =
                source.repository.clone().filter(|r| !r.is_empty()).ok_or_else(|| {
                    AppError::bad_request("source.repository is required (owner/name)")
                })?;
            Ok(Box::new(GithubAdapter::new(
                http,
                cred.token.clone(),
                repository,
                cred.base_url.clone(),
            )))
        }
        ExternalProvider::Linear => {
            let token = cred
                .token
                .clone()
                .ok_or_else(|| AppError::bad_request("A Linear API key is required"))?;
            Ok(Box::new(LinearAdapter::new(
                http,
                token,
                source.team_ids.clone().unwrap_or_default(),
            )))
        }
    }
}

/// Turns a failed provider call into the HTTP error the caller should see. The message never
/// carries a token.
#[must_use]
pub fn provider_failure(label: &str, e: &SourceError, secrets: &[Option<&str>]) -> AppError {
    match e {
        SourceError::Provider(p) => {
            let message = redact_secrets(&p.message, secrets);
            if let Some(until) = p.rate_limited_until {
                return AppError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    format!(
                        "{label} rate limit reached; try again after {}",
                        trama_core::time::to_iso(&until)
                    ),
                );
            }
            if matches!(p.status, 401 | 403 | 404) {
                return AppError::bad_request(format!("{label} rejected the request ({message})"));
            }
            AppError::new(StatusCode::BAD_GATEWAY, format!("{label} failed: {message}"))
        }
        SourceError::Transport(_) | SourceError::Unexpected(_) => AppError::new(
            StatusCode::BAD_GATEWAY,
            format!("{label} is unreachable: {}", redact_secrets(&e.to_string(), secrets)),
        ),
    }
}
