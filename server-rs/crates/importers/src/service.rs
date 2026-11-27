//! Provider discovery for read-only import previews.
use axum::http::Method;
use serde_json::{Value, json};
use trama_core::{AppError, AppState};
use trama_integrations::{Http, HttpRequest};

use crate::credentials::ResolvedCredential;

/// Parse the source repository format accepted by the NestJS import API.
pub fn parse_repository(raw: Option<&str>) -> Result<String, AppError> {
    let input = raw.unwrap_or_default().trim();
    let is_url = input.starts_with("https://") || input.starts_with("http://");
    let value = input
        .strip_prefix("https://")
        .or_else(|| input.strip_prefix("http://"))
        .map_or(input, |rest| rest.split_once('/').map_or("", |(_, path)| path));
    let parts: Vec<_> = value.trim_end_matches('/').split('/').collect();
    let repo =
        parts.get(..2).map(|p| p.join("/")).unwrap_or_default().trim_end_matches(".git").to_owned();
    if (!is_url && parts.len() != 2)
        || parts.len() < 2
        || repo.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || !repo.chars().all(|c| c.is_ascii_alphanumeric() || "_.-/".contains(c))
    {
        return Err(AppError::bad_request("source.repository must look like owner/name"));
    }
    Ok(repo)
}

/// Validate Linear team IDs, deduplicating is done by the caller/provider query.
pub fn validate_team_ids(ids: Option<&[String]>) -> Result<(), AppError> {
    if ids.unwrap_or_default().iter().any(|id| {
        id.is_empty()
            || id.len() > 100
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
    }) {
        return Err(AppError::bad_request("source.teamIds contains an invalid id"));
    }
    Ok(())
}

/// Fetches a GitHub repository and sample issues through the integrations safe HTTP client.
pub async fn github_preview(
    state: &AppState,
    repository: &str,
    credential: ResolvedCredential,
) -> Result<Value, AppError> {
    let api = credential.base_url.as_deref().map_or_else(
        || "https://api.github.com".to_owned(),
        |base| {
            if base.ends_with("/api/v3") { base.to_owned() } else { format!("{base}/api/v3") }
        },
    );
    let http = Http::of(state);
    let mut repo_req = HttpRequest::get(format!("{api}/repos/{repository}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "trama");
    if let Some(token) = credential.token.as_deref() {
        repo_req = repo_req.header("Authorization", format!("Bearer {token}"));
    }
    let response = http.request(repo_req).await.map_err(|e| {
        AppError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            format!("GitHub Issues is unreachable: {e}"),
        )
    })?;
    let response =
        provider_ok(response, "GitHub Issues", credential.token.as_deref().unwrap_or(""))?;
    let label = response.json.get("full_name").and_then(Value::as_str).unwrap_or(repository);
    let url = response.json.get("html_url").cloned().unwrap_or(Value::Null);
    let open_count = response.json.get("open_issues_count").and_then(Value::as_i64);

    let mut sample_request =
        HttpRequest::get(format!("{api}/repos/{repository}/issues?state=all&per_page=5"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "trama");
    if let Some(token) = credential.token.as_deref() {
        sample_request = sample_request.header("Authorization", format!("Bearer {token}"));
    }
    let sample_response = http.request(sample_request).await.map_err(|e| {
        AppError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            format!("GitHub Issues is unreachable: {e}"),
        )
    })?;
    let sample_response =
        provider_ok(sample_response, "GitHub Issues", credential.token.as_deref().unwrap_or(""))?;
    let issues = sample_response.json.as_array().cloned().unwrap_or_default();
    let sample: Vec<Value> = issues.iter().filter(|issue| issue.get("pull_request").is_none()).take(5).map(|issue| json!({
        "key": format!("#{}", issue.get("number").and_then(Value::as_i64).unwrap_or_default()),
        "title": issue.get("title").and_then(Value::as_str).unwrap_or_default(),
        "state": issue.get("state").and_then(Value::as_str).unwrap_or("open")
    })).collect();
    Ok(json!({
        "provider":"github", "account":credential.account.as_deref().unwrap_or("public"),
        "sourceLabel":label, "sourceUrl":url,
        "counts":{"issues":null,"open":open_count,"closed":null,"projects":0,"milestones":0,"labels":0,"users":0},
        "teams":[],"projects":[],"labels":[],"milestones":[],"users":[],"statuses":[],
        "sample":sample,"warnings": if credential.token.is_none() { vec!["No token: public data only; add a token for private repositories or larger imports."] } else { vec![] }
    }))
}

/// Fetches Linear workspace identity and team metadata. Import issue discovery follows in the
/// runner slice; this preview still validates the token and exposes selectable teams.
pub async fn linear_preview(
    state: &AppState,
    credential: ResolvedCredential,
) -> Result<Value, AppError> {
    let token =
        credential.token.ok_or_else(|| AppError::bad_request("A Linear API key is required"))?;
    let response = Http::of(state).request(
        HttpRequest::new(Method::POST, "https://api.linear.app/graphql")
            .header("Authorization", &token)
            .json(json!({"query":"query { viewer { name email } teams { nodes { id name key } } }"})),
    ).await.map_err(|e| AppError::new(axum::http::StatusCode::BAD_GATEWAY,
        format!("Linear is unreachable: {}", e.to_string().replace(&token, "[redacted]"))))?;
    let response = provider_ok(response, "Linear", &token)?;
    let data = response.json.get("data").ok_or_else(|| {
        AppError::bad_request("Linear rejected the request (Unexpected response)")
    })?;
    let teams = data
        .get("teams")
        .and_then(|v| v.get("nodes"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let teams: Vec<Value> = teams
        .into_iter()
        .map(|team| {
            json!({
                "id":team.get("id"), "name":team.get("name"), "key":team.get("key"),
                "suggested":{"action":"skip"}
            })
        })
        .collect();
    Ok(json!({
        "provider":"linear", "account":credential.account.as_deref().unwrap_or_else(||data.get("viewer").and_then(|v| v.get("email")).and_then(Value::as_str).or_else(||data.get("viewer").and_then(|v|v.get("name")).and_then(Value::as_str)).unwrap_or_default()),
        "sourceLabel":"Linear (all teams)", "counts":{"issues":null,"open":null,"closed":null,"projects":0,"milestones":0,"labels":0,"users":0},
        "teams":teams,"projects":[],"labels":[],"milestones":[],"users":[],"statuses":[],"sample":[],"warnings":[]
    }))
}

fn provider_ok(
    response: trama_integrations::HttpResponse,
    label: &str,
    secret: &str,
) -> Result<trama_integrations::HttpResponse, AppError> {
    if (200..300).contains(&response.status) {
        return Ok(response);
    }
    let message =
        response.json.get("message").and_then(Value::as_str).unwrap_or("request rejected");
    let message =
        if secret.is_empty() { message.to_owned() } else { message.replace(secret, "[redacted]") };
    if response.status == 429 {
        return Err(AppError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            format!("{label} rate limit reached"),
        ));
    }
    if matches!(response.status, 401 | 403 | 404) {
        return Err(AppError::bad_request(format!("{label} rejected the request ({message})")));
    }
    Err(AppError::new(axum::http::StatusCode::BAD_GATEWAY, format!("{label} failed: {message}")))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use trama_core::{AppState, Config};
    use trama_integrations::{HttpClient, HttpFailure, HttpRequest, HttpResponse};

    use super::*;

    #[derive(Clone)]
    struct ProviderMock {
        seen: Arc<Mutex<Vec<HttpRequest>>>,
    }

    #[async_trait]
    impl HttpClient for ProviderMock {
        async fn request(&self, request: HttpRequest) -> Result<HttpResponse, HttpFailure> {
            self.seen.lock().unwrap().push(request.clone());
            let json = if request.url.contains("/issues?") {
                json!([
                    {"number": 7, "title": "Bug", "state": "open"},
                    {"number": 8, "title": "Pull request", "state": "closed", "pull_request": {}}
                ])
            } else {
                json!({"full_name":"octo/repo","html_url":"https://github.com/octo/repo","open_issues_count":4})
            };
            Ok(HttpResponse { status: 200, headers: BTreeMap::new(), json })
        }
    }

    #[test]
    fn repository_parser_accepts_plain_and_url_forms_and_rejects_path_traversal() {
        assert_eq!(parse_repository(Some("octo/repo")).unwrap(), "octo/repo");
        assert_eq!(
            parse_repository(Some("https://github.com/octo/repo/issues/12")).unwrap(),
            "octo/repo"
        );
        assert!(parse_repository(Some("octo/../private")).is_err());
        assert!(parse_repository(Some("octo/repo/extra")).is_err());
    }

    #[tokio::test]
    async fn github_preview_uses_mock_transport_and_excludes_pull_requests_from_samples() {
        let Some(test) = trama_core::testkit::TestDb::create().await else { return };
        let state = AppState::new(test.db.clone(), Config::from_vars(&[]));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let state = state.with_extension(Http::new(ProviderMock { seen: seen.clone() }));
        let preview = github_preview(
            &state,
            "octo/repo",
            ResolvedCredential {
                token: Some("sample-token".into()),
                base_url: None,
                account: Some("octocat".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(preview["sourceLabel"], "octo/repo");
        assert_eq!(preview["account"], "octocat");
        assert_eq!(preview["sample"].as_array().unwrap().len(), 1);
        {
            let requests = seen.lock().unwrap();
            assert_eq!(requests.len(), 2);
            assert!(requests.iter().all(|request| {
                request
                    .headers
                    .iter()
                    .any(|(name, value)| name == "Authorization" && value == "Bearer sample-token")
            }));
        }
        test.drop().await;
    }
}
