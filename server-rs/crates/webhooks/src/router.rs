use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use ring::hmac;
use sea_orm::{ColumnTrait, ConnectionTrait, DatabaseBackend, EntityTrait, QueryFilter, Statement};
use serde_json::{Value, json};
use trama_auth::{Gate, Routes};
use trama_common::Secrets;
use trama_contracts::common::GitProvider;
use trama_contracts::issues::{ArtifactKind, ArtifactState, CiState, ReviewState};
use trama_core::{AppError, AppState};
use trama_entities::{integration_connections, webhook_deliveries};
use trama_integrations::{ArtifactCandidate, CiPatch, IssueCandidate, ItemMeta, RepoMeta};
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(paths(github, gitlab, bitbucket))]
/// OpenAPI description for inbound webhooks.
pub struct ApiDoc;

/// Public provider endpoint routes.
pub fn router() -> Routes {
    Routes::new()
        .post("/webhooks/github/{connection_id}", Gate::public(), github)
        .post("/webhooks/gitlab/{connection_id}", Gate::public(), gitlab)
        .post("/webhooks/bitbucket/{connection_id}", Gate::public(), bitbucket)
}

#[utoipa::path(post, path="/api/webhooks/github/{connection_id}", tag="webhooks",
    params(("connection_id" = String, Path)), responses(
        (status=200, description="Handled or duplicate"),
        (status=202, description="Accepted but no action"),
        (status=400, description="Malformed payload"),
        (status=401, description="Invalid signature or unavailable secret"),
        (status=404, description="Unknown webhook endpoint"),
        (status=500, description="Processing failed; provider may retry")
    )
)]
async fn github(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, AppError> {
    handle(state, id, GitProvider::Github, headers, body).await
}

#[utoipa::path(post, path="/api/webhooks/gitlab/{connection_id}", tag="webhooks",
    params(("connection_id" = String, Path)), responses((status=200, description="Handled or duplicate"),
    (status=202, description="Accepted but no action"), (status=400, description="Malformed payload"),
    (status=401, description="Invalid token"), (status=404, description="Unknown webhook endpoint"),
    (status=500, description="Processing failed"))
)]
async fn gitlab(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, AppError> {
    handle(state, id, GitProvider::Gitlab, headers, body).await
}

#[utoipa::path(post, path="/api/webhooks/bitbucket/{connection_id}", tag="webhooks",
    params(("connection_id" = String, Path)), responses((status=200, description="Handled or duplicate"),
    (status=202, description="Accepted but no action"), (status=400, description="Malformed payload"),
    (status=401, description="Invalid signature"), (status=404, description="Unknown webhook endpoint"),
    (status=500, description="Processing failed"))
)]
async fn bitbucket(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, AppError> {
    handle(state, id, GitProvider::Bitbucket, headers, body).await
}

fn header<'a>(headers: &'a HeaderMap, key: &str) -> Option<&'a str> {
    headers.get(key)?.to_str().ok()
}

fn equal(a: &[u8], b: &[u8]) -> bool {
    let (Ok(a), Ok(b)) = (<[u8; 32]>::try_from(a), <[u8; 32]>::try_from(b)) else {
        return false;
    };
    subtle::ConstantTimeEq::ct_eq(a.as_slice(), b.as_slice()).into()
}

fn verify(provider: GitProvider, secret: &str, raw: &[u8], headers: &HeaderMap) -> bool {
    match provider {
        GitProvider::Github | GitProvider::Bitbucket => {
            let name = if provider == GitProvider::Github {
                "x-hub-signature-256"
            } else {
                "x-hub-signature"
            };
            let Some(sig) = header(headers, name).and_then(|s| s.strip_prefix("sha256=")) else {
                return false;
            };
            let Ok(sig) = hex::decode(sig) else { return false };
            let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
            let expected = hmac::sign(&key, raw);
            equal(expected.as_ref(), &sig)
        }
        GitProvider::Gitlab => header(headers, "x-gitlab-token")
            .is_some_and(|value| equal(&sha256(secret.as_bytes()), &sha256(value.as_bytes()))),
    }
}

fn sha256(value: &[u8]) -> [u8; 32] {
    use ring::digest::{SHA256, digest};
    digest(&SHA256, value).as_ref().try_into().expect("SHA-256 output has fixed size")
}

async fn handle(
    state: AppState,
    id: String,
    provider: GitProvider,
    headers: HeaderMap,
    raw: Bytes,
) -> Result<axum::response::Response, AppError> {
    let row = integration_connections::Entity::find_by_id(&id)
        .filter(integration_connections::Column::Provider.eq(provider.as_str()))
        .one(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("Unknown webhook endpoint"))?;
    let stored =
        row.webhook_secret.as_deref().filter(|s| !s.is_empty()).ok_or_else(|| {
            AppError::new(StatusCode::UNAUTHORIZED, "Webhook secret not configured")
        })?;
    let secret = Secrets::of(&state)?
        .decrypt(stored, &trama_integrations::service::webhook_aad(&id))
        .map_err(|_| AppError::new(StatusCode::UNAUTHORIZED, "Webhook secret unavailable"))?;
    if !verify(provider, &secret, &raw, &headers) {
        return Err(AppError::new(StatusCode::UNAUTHORIZED, "Invalid webhook signature"));
    }
    let payload: Value = serde_json::from_slice(&raw).map_err(|_| {
        AppError::bad_request("Malformed webhook payload: body must be a JSON object")
    })?;
    if !payload.is_object() {
        return Err(AppError::bad_request("Malformed webhook payload: body must be a JSON object"));
    }
    let delivery = match provider {
        GitProvider::Github => header(&headers, "x-github-delivery"),
        GitProvider::Gitlab => header(&headers, "x-gitlab-event-uuid"),
        GitProvider::Bitbucket => header(&headers, "x-request-uuid"),
    };
    if let Some(delivery) = delivery {
        let key = format!("{id}:{delivery}");
        let claim = state.db.query_one_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            r#"INSERT INTO "webhook_deliveries" ("id","connectionId") VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING "id""#,
            [key.clone().into(), id.clone().into()])).await?;
        if claim.is_none() {
            return Ok((StatusCode::OK, Json(json!({"status":"duplicate"}))).into_response());
        }
        if rand::random::<u8>() < 5 {
            let db = state.db.clone();
            tokio::spawn(async move {
                if let Err(error) = db.execute_unprepared(
                    r#"DELETE FROM "webhook_deliveries" WHERE "receivedAt" < now() - interval '7 days'"#,
                ).await {
                    tracing::debug!("webhook delivery pruning failed: {error}");
                }
            });
        }
        let result = dispatch(&state, &row, provider, &headers, &payload).await;
        if result.is_err() {
            webhook_deliveries::Entity::delete_by_id(key).exec(&state.db).await?;
        } else {
            touch_connection(&state, &row).await;
        }
        result
    } else {
        let result = dispatch(&state, &row, provider, &headers, &payload).await;
        if result.is_ok() {
            touch_connection(&state, &row).await;
        }
        result
    }
}

#[allow(clippy::too_many_lines)]
async fn dispatch(
    state: &AppState,
    connection: &integration_connections::Model,
    provider: GitProvider,
    headers: &HeaderMap,
    p: &Value,
) -> Result<axum::response::Response, AppError> {
    let event = match provider {
        GitProvider::Github => header(headers, "x-github-event").ok_or_else(|| {
            AppError::bad_request("Malformed webhook payload: missing X-GitHub-Event header")
        })?,
        GitProvider::Gitlab => p
            .get("object_kind")
            .or_else(|| p.get("event_type"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::bad_request(
                    "Malformed webhook payload: \"object_kind\" must be a non-empty string",
                )
            })?,
        GitProvider::Bitbucket => header(headers, "x-event-key").ok_or_else(|| {
            AppError::bad_request("Malformed webhook payload: missing X-Event-Key header")
        })?,
    };
    if provider != GitProvider::Github {
        return dispatch_non_github(state, connection, provider, event, p).await;
    }
    if provider == GitProvider::Github && event == "ping" {
        return Ok((StatusCode::OK, Json(json!({"status":"pong"}))).into_response());
    }
    if !matches!(event, "pull_request" | "issues" | "check_suite" | "check_run" | "status") {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({"status":"ignored","reason":format!("event \"{event}\" is not handled")})),
        )
            .into_response());
    }
    let action = p.get("action").and_then(Value::as_str);
    let outcome: Result<axum::response::Response, AppError> = match event {
        "pull_request" => {
            let Some(action) = action else {
                return malformed("\"action\" must be a non-empty string");
            };
            if ![
                "opened",
                "reopened",
                "edited",
                "synchronize",
                "closed",
                "ready_for_review",
                "converted_to_draft",
                "review_requested",
                "review_request_removed",
            ]
            .contains(&action)
            {
                return Ok((StatusCode::ACCEPTED, Json(json!({"status":"ignored","reason":format!("pull_request action \"{action}\" is not handled")}))).into_response());
            }
            let pr = object(p, "pull_request")?;
            let repo = github_repo(object(p, "repository")?)?;
            let head = pr
                .get("head")
                .and_then(Value::as_object)
                .ok_or_else(|| malformed_error("\"pull_request.head\" must be an object"))?;
            let title = required(pr, "title", "pull_request.title")?;
            let number = pr
                .get("number")
                .and_then(Value::as_i64)
                .ok_or_else(|| malformed_error("\"pull_request.number\" must be a number"))?;
            let labels = label_names(pr.get("labels"));
            let mut candidate = ArtifactCandidate::new(
                ArtifactKind::PullRequest,
                provider,
                format!("#{number}"),
                title,
            );
            candidate.url = string(pr.get("html_url"));
            candidate.state = Some(if pr.get("merged") == Some(&Value::Bool(true)) {
                ArtifactState::Merged
            } else if pr.get("state").and_then(Value::as_str) == Some("closed") {
                ArtifactState::Closed
            } else if pr.get("draft") == Some(&Value::Bool(true)) {
                ArtifactState::Draft
            } else {
                ArtifactState::Open
            });
            candidate.head_sha = head.get("sha").and_then(Value::as_str).map(str::to_owned);
            candidate.head_branch = head.get("ref").and_then(Value::as_str).map(str::to_owned);
            candidate.texts = vec![title.to_owned(), string(pr.get("body")).unwrap_or_default()];
            candidate.branch_texts = vec![candidate.head_branch.clone().unwrap_or_default()];
            candidate.has_conflicts = if pr.get("mergeable_state").and_then(Value::as_str)
                == Some("dirty")
                || pr.get("mergeable") == Some(&Value::Bool(false))
            {
                Some(true)
            } else if pr.get("mergeable") == Some(&Value::Bool(true)) {
                Some(false)
            } else {
                None
            };
            if action == "synchronize" {
                candidate.ci = Some(CiState::Pending);
            }
            let reviewers =
                pr.get("requested_reviewers").and_then(Value::as_array).map_or(0, Vec::len)
                    + pr.get("requested_teams").and_then(Value::as_array).map_or(0, Vec::len);
            match action {
                "review_requested" => candidate.review = Some(ReviewState::Requested),
                "review_request_removed" if reviewers == 0 => {
                    candidate.review = Some(ReviewState::None);
                    candidate.review_only_from = Some(vec![ReviewState::Requested]);
                }
                "opened" if reviewers > 0 => {
                    candidate.review = Some(ReviewState::Requested);
                    candidate.review_only_from = Some(vec![ReviewState::None]);
                }
                _ => {}
            }
            candidate.actor_login =
                p.pointer("/sender/login").and_then(Value::as_str).map(str::to_owned);
            let meta = ItemMeta {
                labels,
                milestone: p
                    .pointer("/pull_request/milestone/title")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            };
            if connection.status == "revoked" {
                return Ok(accepted("connection revoked"));
            }
            let Some(workspace) = connection.workspace_id.as_deref() else {
                let placed = trama_routing::inbound::route_pull_request(
                    state,
                    &connection.id,
                    provider,
                    &repo,
                    &candidate,
                    &meta,
                )
                .await?;
                return Ok(if let Some(key) = placed.key {
                    (StatusCode::OK, Json(json!({"status":"processed","routed":if placed.placed {"created"} else {"updated"},"issues":[key]}))).into_response()
                } else {
                    accepted("no routing rule takes this pull request")
                });
            };
            let linked = trama_integrations::linker::upsert(
                state,
                workspace,
                &repo.full_name,
                &candidate,
                Some(&connection.host),
            )
            .await?;
            if linked.created == 0 && linked.updated == 0 && linked.issue_keys.is_empty() {
                let placed = trama_routing::inbound::route_pull_request(
                    state,
                    &connection.id,
                    provider,
                    &repo,
                    &candidate,
                    &meta,
                )
                .await?;
                if let Some(key) = placed.key {
                    return Ok((StatusCode::OK, Json(json!({"status":"processed","routed":if placed.placed {"created"} else {"updated"},"issues":[key]}))).into_response());
                }
                return Ok(accepted("no issue key found"));
            }
            Ok((StatusCode::OK, Json(json!({"status":"processed","artifactsCreated":linked.created,"artifactsUpdated":linked.updated,"issues":linked.issue_keys}))).into_response())
        }
        "issues" => {
            let Some(action) = action else {
                return malformed("\"action\" must be a non-empty string");
            };
            if ![
                "opened",
                "reopened",
                "closed",
                "edited",
                "labeled",
                "unlabeled",
                "milestoned",
                "demilestoned",
            ]
            .contains(&action)
            {
                return Ok((StatusCode::ACCEPTED, Json(json!({"status":"ignored","reason":format!("issues action \"{action}\" is not handled")}))).into_response());
            }
            let issue = object(p, "issue")?;
            if issue.get("pull_request").is_some() {
                return Ok(ignored("a pull request is not an issue"));
            }
            let number = issue
                .get("number")
                .and_then(Value::as_i64)
                .ok_or_else(|| malformed_error("\"issue.number\" must be a number"))?;
            let title = required(issue, "title", "issue.title")?;
            let repo = github_repo(object(p, "repository")?)?;
            let candidate = IssueCandidate {
                provider,
                external_id: format!("#{number}"),
                number,
                title: title.to_owned(),
                body: string(issue.get("body")),
                url: string(issue.get("html_url")),
                state: if issue.get("state").and_then(Value::as_str) == Some("closed") {
                    trama_integrations::candidates::IssueCandidateState::Closed
                } else {
                    trama_integrations::candidates::IssueCandidateState::Open
                },
                state_reason: if issue.get("state_reason").and_then(Value::as_str)
                    == Some("not_planned")
                {
                    Some(trama_integrations::candidates::StateReason::NotPlanned)
                } else if issue.get("state").and_then(Value::as_str) == Some("closed") {
                    Some(trama_integrations::candidates::StateReason::Completed)
                } else {
                    None
                },
                labels: label_names(issue.get("labels")),
                milestone: issue
                    .get("milestone")
                    .and_then(|m| m.get("title"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                author: issue
                    .get("user")
                    .and_then(|u| u.get("login"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            };
            if connection.status == "revoked" {
                return Ok(accepted("connection revoked"));
            }
            let routed = trama_routing::inbound::route_issue(
                state,
                &connection.id,
                provider,
                &repo,
                &candidate,
            )
            .await?;
            match routed.status {
                trama_routing::inbound::RoutedIssueStatus::Ignored | trama_routing::inbound::RoutedIssueStatus::Unchanged =>
                    Ok(accepted("nothing to change")),
                status => Ok((StatusCode::OK, Json(json!({"status":"processed","routed":match status { trama_routing::inbound::RoutedIssueStatus::Created => "created", _ => "updated" },"issues":routed.key.into_iter().collect::<Vec<_>>()}))).into_response()),
            }
        }
        _ => {
            let repo = github_repo(object(p, "repository")?)?;
            let (sha, ids, ci) = if event == "status" {
                let obj = p
                    .as_object()
                    .ok_or_else(|| malformed_error("\"payload\" must be an object"))?;
                let sha = required(obj, "sha", "sha")?;
                let state_value = required(obj, "state", "state")?;
                (Some(sha.to_owned()), vec![], github_ci_state(state_value))
            } else {
                let run = object(p, event)?;
                let sha = required(run, "head_sha", &format!("{event}.head_sha"))?;
                let ids = run
                    .get("pull_requests")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.get("number").and_then(Value::as_i64))
                    .map(|n| format!("#{n}"))
                    .collect();
                (Some(sha.to_owned()), ids, github_check_state(run))
            };
            if connection.status == "revoked" {
                return Ok(accepted("connection revoked"));
            }
            let Some(workspace) = connection.workspace_id.as_deref() else {
                return Ok(accepted("personal connection without a workspace"));
            };
            let count = trama_integrations::linker::apply_ci(
                state,
                workspace,
                &repo.full_name,
                &CiPatch { sha, pr_external_ids: ids, ci },
            )
            .await?;
            if count == 0 {
                Ok(accepted("no matching pull/merge request"))
            } else {
                Ok((StatusCode::OK, Json(json!({"status":"processed","artifactsUpdated":count})))
                    .into_response())
            }
        }
    };
    let outcome = outcome?;
    Ok(outcome)
}

#[allow(clippy::too_many_lines)]
async fn dispatch_non_github(
    state: &AppState,
    connection: &integration_connections::Model,
    provider: GitProvider,
    event: &str,
    payload: &Value,
) -> Result<axum::response::Response, AppError> {
    if provider == GitProvider::Gitlab {
        let kind = payload
            .get("object_kind")
            .or_else(|| payload.get("event_type"))
            .and_then(Value::as_str)
            .ok_or_else(|| malformed_error("\"object_kind\" must be a non-empty string"))?;
        let project = object(payload, "project")?;
        let repo = RepoMeta {
            full_name: required(project, "path_with_namespace", "project.path_with_namespace")?
                .to_owned(),
            url: string(project.get("web_url")),
            default_branch: string(project.get("default_branch")),
        };
        match kind {
            "merge_request" => {
                let attrs = object(payload, "object_attributes")?;
                let iid = attrs
                    .get("iid")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| malformed_error("\"object_attributes.iid\" must be a number"))?;
                let title = required(attrs, "title", "object_attributes.title")?;
                let action = string(attrs.get("action"));
                let mut candidate = ArtifactCandidate::new(
                    ArtifactKind::MergeRequest,
                    provider,
                    format!("!{iid}"),
                    title,
                );
                candidate.url = string(attrs.get("url"));
                candidate.state =
                    Some(if attrs.get("state").and_then(Value::as_str) == Some("merged") {
                        ArtifactState::Merged
                    } else if attrs.get("state").and_then(Value::as_str) == Some("closed") {
                        ArtifactState::Closed
                    } else if attrs.get("draft") == Some(&Value::Bool(true))
                        || attrs.get("work_in_progress") == Some(&Value::Bool(true))
                    {
                        ArtifactState::Draft
                    } else {
                        ArtifactState::Open
                    });
                candidate.head_sha = attrs
                    .get("last_commit")
                    .and_then(|v| v.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                candidate.head_branch = string(attrs.get("source_branch"));
                candidate.texts =
                    vec![title.to_owned(), string(attrs.get("description")).unwrap_or_default()];
                candidate.branch_texts = vec![candidate.head_branch.clone().unwrap_or_default()];
                candidate.has_conflicts = if attrs
                    .get("detailed_merge_status")
                    .and_then(Value::as_str)
                    == Some("conflict")
                    || attrs.get("merge_status").and_then(Value::as_str) == Some("cannot_be_merged")
                {
                    Some(true)
                } else if attrs.get("merge_status").and_then(Value::as_str) == Some("can_be_merged")
                {
                    Some(false)
                } else {
                    None
                };
                if action.as_deref() == Some("update") && attrs.get("oldrev").is_some() {
                    candidate.ci = Some(CiState::Pending);
                }
                let reviewers =
                    payload.get("reviewers").and_then(Value::as_array).map_or(0, Vec::len);
                match action.as_deref() {
                    Some("approved" | "approval") => candidate.review = Some(ReviewState::Approved),
                    Some("unapproved" | "unapproval") => {
                        candidate.review = Some(if reviewers > 0 {
                            ReviewState::Requested
                        } else {
                            ReviewState::None
                        });
                        candidate.review_only_from = Some(vec![ReviewState::Approved]);
                    }
                    Some("open") if reviewers > 0 => {
                        candidate.review = Some(ReviewState::Requested);
                        candidate.review_only_from = Some(vec![ReviewState::None]);
                    }
                    _ => {}
                }
                candidate.reviewer_logins = payload
                    .get("reviewers")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|r| string(r.get("username")))
                    .collect();
                candidate.actor_login = payload.get("user").and_then(|u| string(u.get("username")));
                let meta =
                    ItemMeta { labels: gitlab_labels(payload.get("labels")), milestone: None };
                process_pr(state, connection, provider, &repo, &candidate, &meta).await
            }
            "issue" => {
                let attrs = object(payload, "object_attributes")?;
                let iid = attrs
                    .get("iid")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| malformed_error("\"object_attributes.iid\" must be a number"))?;
                let action = string(attrs.get("action"));
                if action
                    .as_deref()
                    .is_some_and(|a| !["open", "close", "reopen", "update"].contains(&a))
                {
                    return Ok(accepted("issue action is not handled"));
                }
                let title = required(attrs, "title", "object_attributes.title")?;
                let closed = attrs.get("state").and_then(Value::as_str) == Some("closed");
                let candidate = IssueCandidate {
                    provider,
                    external_id: format!("#{iid}"),
                    number: iid,
                    title: title.to_owned(),
                    body: string(attrs.get("description")),
                    url: string(attrs.get("url")),
                    state: if closed {
                        trama_integrations::candidates::IssueCandidateState::Closed
                    } else {
                        trama_integrations::candidates::IssueCandidateState::Open
                    },
                    state_reason: closed
                        .then_some(trama_integrations::candidates::StateReason::Completed),
                    labels: gitlab_labels(payload.get("labels")),
                    milestone: None,
                    author: payload.get("user").and_then(|u| string(u.get("username"))),
                };
                process_issue(state, connection, provider, &repo, &candidate).await
            }
            "pipeline" => {
                let attrs = object(payload, "object_attributes")?;
                let sha = required(attrs, "sha", "object_attributes.sha")?.to_owned();
                let ids = payload
                    .get("merge_request")
                    .and_then(|mr| mr.get("iid"))
                    .and_then(Value::as_i64)
                    .map(|iid| vec![format!("!{iid}")])
                    .unwrap_or_default();
                process_ci(
                    state,
                    connection,
                    &repo,
                    CiPatch {
                        sha: Some(sha),
                        pr_external_ids: ids,
                        ci: gitlab_ci(attrs.get("status").and_then(Value::as_str)),
                    },
                )
                .await
            }
            _ => Ok(accepted(&format!("event \"{kind}\" is not handled"))),
        }
    } else {
        if event == "diagnostics:ping" {
            return Ok((StatusCode::OK, Json(json!({"status":"pong"}))).into_response());
        }
        let payload = object_value(payload, "payload")?;
        if let Some(action) = event.strip_prefix("pullrequest:") {
            if ![
                "created",
                "updated",
                "approved",
                "unapproved",
                "fulfilled",
                "rejected",
                "changes_request_created",
                "changes_request_removed",
            ]
            .contains(&action)
            {
                return Ok(accepted(&format!("event \"{event}\" is not handled")));
            }
            let pr = object(payload, "pullrequest")?;
            let source = pr
                .get("source")
                .and_then(Value::as_object)
                .ok_or_else(|| malformed_error("\"pullrequest.source\" must be an object"))?;
            let repo = bitbucket_repo(object(payload, "repository")?)?;
            let id = pr
                .get("id")
                .and_then(Value::as_i64)
                .ok_or_else(|| malformed_error("\"pullrequest.id\" must be a number"))?;
            let title = required(pr, "title", "pullrequest.title")?;
            let branch = source.get("branch").and_then(|b| string(b.get("name")));
            let mut candidate = ArtifactCandidate::new(
                ArtifactKind::PullRequest,
                provider,
                format!("#{id}"),
                title,
            );
            candidate.url =
                pr.get("links").and_then(|l| l.get("html")).and_then(|h| string(h.get("href")));
            candidate.state = Some(match pr.get("state").and_then(Value::as_str) {
                Some("MERGED") => ArtifactState::Merged,
                Some("DECLINED" | "SUPERSEDED") => ArtifactState::Closed,
                _ if pr.get("draft") == Some(&Value::Bool(true)) => ArtifactState::Draft,
                _ => ArtifactState::Open,
            });
            candidate.head_sha = source.get("commit").and_then(|c| string(c.get("hash")));
            candidate.head_branch = branch.clone();
            candidate.texts =
                vec![title.to_owned(), string(pr.get("description")).unwrap_or_default()];
            candidate.branch_texts = vec![branch.unwrap_or_default()];
            let reviewers = pr.get("reviewers").and_then(Value::as_array).map_or(0, Vec::len);
            match action {
                "approved" => candidate.review = Some(ReviewState::Approved),
                "unapproved" => {
                    candidate.review = Some(if reviewers > 0 {
                        ReviewState::Requested
                    } else {
                        ReviewState::None
                    });
                    candidate.review_only_from = Some(vec![ReviewState::Approved]);
                }
                "changes_request_created" => candidate.review = Some(ReviewState::ChangesRequested),
                "changes_request_removed" => {
                    candidate.review = Some(if reviewers > 0 {
                        ReviewState::Requested
                    } else {
                        ReviewState::None
                    });
                    candidate.review_only_from = Some(vec![ReviewState::ChangesRequested]);
                }
                "created" if reviewers > 0 => {
                    candidate.review = Some(ReviewState::Requested);
                    candidate.review_only_from = Some(vec![ReviewState::None]);
                }
                _ => {}
            }
            candidate.reviewer_logins = pr
                .get("reviewers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|r| string(r.get("nickname")).or_else(|| string(r.get("username"))))
                .collect();
            candidate.actor_login = payload
                .get("actor")
                .and_then(|a| string(a.get("nickname")).or_else(|| string(a.get("username"))));
            return process_pr(
                state,
                connection,
                provider,
                &repo,
                &candidate,
                &ItemMeta::default(),
            )
            .await;
        }
        if matches!(event, "repo:commit_status_created" | "repo:commit_status_updated") {
            let status = object(payload, "commit_status")?;
            let commit = status
                .get("commit")
                .and_then(Value::as_object)
                .ok_or_else(|| malformed_error("\"commit_status.commit\" must be an object"))?;
            let repo = bitbucket_repo(object(payload, "repository")?)?;
            let sha = required(commit, "hash", "commit_status.commit.hash")?.to_owned();
            return process_ci(
                state,
                connection,
                &repo,
                CiPatch {
                    sha: Some(sha),
                    pr_external_ids: vec![],
                    ci: bitbucket_ci(status.get("state").and_then(Value::as_str)),
                },
            )
            .await;
        }
        Ok(accepted(&format!("event \"{event}\" is not handled")))
    }
}

async fn process_pr(
    state: &AppState,
    connection: &integration_connections::Model,
    provider: GitProvider,
    repo: &RepoMeta,
    candidate: &ArtifactCandidate,
    meta: &ItemMeta,
) -> Result<axum::response::Response, AppError> {
    if connection.status == "revoked" {
        return Ok(accepted("connection revoked"));
    }
    let Some(workspace) = connection.workspace_id.as_deref() else {
        let placed = trama_routing::inbound::route_pull_request(
            state,
            &connection.id,
            provider,
            repo,
            candidate,
            meta,
        )
        .await?;
        return Ok(if let Some(key) = placed.key {
            (StatusCode::OK, Json(json!({"status":"processed","routed":if placed.placed {"created"} else {"updated"},"issues":[key]}))).into_response()
        } else {
            accepted("no routing rule takes this pull request")
        });
    };
    let linked = trama_integrations::linker::upsert(
        state,
        workspace,
        &repo.full_name,
        candidate,
        Some(&connection.host),
    )
    .await?;
    if linked.created == 0 && linked.updated == 0 && linked.issue_keys.is_empty() {
        let placed = trama_routing::inbound::route_pull_request(
            state,
            &connection.id,
            provider,
            repo,
            candidate,
            meta,
        )
        .await?;
        if let Some(key) = placed.key {
            return Ok((StatusCode::OK, Json(json!({"status":"processed","routed":if placed.placed {"created"} else {"updated"},"issues":[key]}))).into_response());
        }
        return Ok(accepted("no issue key found"));
    }
    Ok((StatusCode::OK, Json(json!({"status":"processed","artifactsCreated":linked.created,"artifactsUpdated":linked.updated,"issues":linked.issue_keys}))).into_response())
}

async fn process_issue(
    state: &AppState,
    connection: &integration_connections::Model,
    provider: GitProvider,
    repo: &RepoMeta,
    candidate: &IssueCandidate,
) -> Result<axum::response::Response, AppError> {
    if connection.status == "revoked" {
        return Ok(accepted("connection revoked"));
    }
    let routed =
        trama_routing::inbound::route_issue(state, &connection.id, provider, repo, candidate)
            .await?;
    match routed.status {
        trama_routing::inbound::RoutedIssueStatus::Ignored | trama_routing::inbound::RoutedIssueStatus::Unchanged => Ok(accepted("nothing to change")),
        trama_routing::inbound::RoutedIssueStatus::Created => Ok((StatusCode::OK, Json(json!({"status":"processed","routed":"created","issues":routed.key.into_iter().collect::<Vec<_>>()}))).into_response()),
        trama_routing::inbound::RoutedIssueStatus::Updated => Ok((StatusCode::OK, Json(json!({"status":"processed","routed":"updated","issues":routed.key.into_iter().collect::<Vec<_>>()}))).into_response()),
    }
}

async fn process_ci(
    state: &AppState,
    connection: &integration_connections::Model,
    repo: &RepoMeta,
    patch: CiPatch,
) -> Result<axum::response::Response, AppError> {
    if connection.status == "revoked" {
        return Ok(accepted("connection revoked"));
    }
    let Some(workspace) = connection.workspace_id.as_deref() else {
        return Ok(accepted("personal connection without a workspace"));
    };
    let count =
        trama_integrations::linker::apply_ci(state, workspace, &repo.full_name, &patch).await?;
    if count == 0 {
        Ok(accepted("no matching pull/merge request"))
    } else {
        Ok((StatusCode::OK, Json(json!({"status":"processed","artifactsUpdated":count})))
            .into_response())
    }
}

fn object_value<'a>(value: &'a Value, name: &str) -> Result<&'a Value, AppError> {
    if value.is_object() {
        Ok(value)
    } else {
        Err(malformed_error(&format!("\"{name}\" must be an object")))
    }
}
fn gitlab_labels(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| string(l.get("title")))
        .collect()
}
fn gitlab_ci(status: Option<&str>) -> CiState {
    match status {
        Some("success" | "skipped") => CiState::Passing,
        Some("failed") => CiState::Failing,
        _ => CiState::Pending,
    }
}
fn bitbucket_ci(status: Option<&str>) -> CiState {
    match status {
        Some("SUCCESSFUL") => CiState::Passing,
        Some("FAILED") => CiState::Failing,
        _ => CiState::Pending,
    }
}
fn bitbucket_repo(repo: &serde_json::Map<String, Value>) -> Result<RepoMeta, AppError> {
    Ok(RepoMeta {
        full_name: required(repo, "full_name", "repository.full_name")?.to_owned(),
        url: repo.get("links").and_then(|v| v.get("html")).and_then(|v| string(v.get("href"))),
        default_branch: repo.get("mainbranch").and_then(|v| string(v.get("name"))),
    })
}

fn accepted(reason: &str) -> axum::response::Response {
    (StatusCode::ACCEPTED, Json(json!({"status":"ignored","reason":reason}))).into_response()
}
fn ignored(reason: &str) -> axum::response::Response {
    accepted(reason)
}
fn malformed<T>(message: &str) -> Result<T, AppError> {
    Err(malformed_error(message))
}
fn malformed_error(message: &str) -> AppError {
    AppError::bad_request(format!("Malformed webhook payload: {message}"))
}
fn object<'a>(
    value: &'a Value,
    name: &str,
) -> Result<&'a serde_json::Map<String, Value>, AppError> {
    value
        .get(name)
        .and_then(Value::as_object)
        .ok_or_else(|| malformed_error(&format!("\"{name}\" must be an object")))
}
fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}
fn required<'a>(
    obj: &'a serde_json::Map<String, Value>,
    key: &str,
    name: &str,
) -> Result<&'a str, AppError> {
    obj.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| malformed_error(&format!("\"{name}\" must be a non-empty string")))
}
fn github_repo(repo: &serde_json::Map<String, Value>) -> Result<RepoMeta, AppError> {
    Ok(RepoMeta {
        full_name: required(repo, "full_name", "repository.full_name")?.to_owned(),
        url: string(repo.get("html_url")),
        default_branch: string(repo.get("default_branch")),
    })
}
fn label_names(labels: Option<&Value>) -> Vec<String> {
    labels
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| string(v.get("name")))
        .collect()
}
fn github_ci_state(state: &str) -> CiState {
    match state {
        "success" | "neutral" | "skipped" => CiState::Passing,
        "failure" | "timed_out" | "action_required" | "startup_failure" | "error" => {
            CiState::Failing
        }
        _ => CiState::Pending,
    }
}
fn github_check_state(run: &serde_json::Map<String, Value>) -> CiState {
    if run.get("status").and_then(Value::as_str).is_some_and(|s| s != "completed") {
        return CiState::Pending;
    }
    run.get("conclusion").and_then(Value::as_str).map_or(CiState::Pending, github_ci_state)
}
async fn touch_connection(state: &AppState, row: &integration_connections::Model) {
    let recent = row
        .config
        .get("lastWebhookAt")
        .and_then(Value::as_str)
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .is_some_and(|v| chrono::Utc::now().signed_duration_since(v).num_seconds() < 60);
    if recent {
        return;
    }
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if let Err(error) = state.db.execute_raw(sea_orm::Statement::from_sql_and_values(DatabaseBackend::Postgres,
        r#"UPDATE "integration_connections" SET "config" = "config" || jsonb_build_object('lastWebhookAt', $2::text) WHERE "id" = $1"#,
        [row.id.clone().into(), timestamp.into()])).await {
        tracing::warn!("lastWebhookAt update failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_signature_is_over_exact_raw_bytes() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"test-secret");
        let raw = br#"{"action":"opened"}"#;
        let sig = format!("sha256={}", hex::encode(hmac::sign(&key, raw)));
        let mut headers = HeaderMap::new();
        headers.insert("x-hub-signature-256", sig.parse().unwrap());
        assert!(verify(GitProvider::Github, "test-secret", raw, &headers));
        assert!(!verify(GitProvider::Github, "test-secret", br#"{"action":"closed"}"#, &headers));
        assert!(!verify(GitProvider::Github, "wrong", raw, &headers));
    }

    #[test]
    fn malformed_signatures_and_tokens_are_rejected() {
        let mut headers = HeaderMap::new();
        headers.insert("x-hub-signature-256", "sha256=xyz".parse().unwrap());
        assert!(!verify(GitProvider::Github, "x", b"{}", &headers));
        headers.insert("x-gitlab-token", "wrong".parse().unwrap());
        assert!(!verify(GitProvider::Gitlab, "secret", b"{}", &headers));
    }

    #[test]
    fn github_ci_events_normalize_provider_states() {
        assert_eq!(github_ci_state("success"), CiState::Passing);
        assert_eq!(github_ci_state("failure"), CiState::Failing);
        assert_eq!(github_ci_state("cancelled"), CiState::Pending);
        let run = serde_json::from_value::<Value>(json!({
            "status": "in_progress",
            "conclusion": "failure"
        }))
        .unwrap();
        assert_eq!(github_check_state(run.as_object().unwrap()), CiState::Pending);
    }

    #[test]
    fn github_candidate_fields_accept_only_provider_shaped_values() {
        let labels = json!([{"name":"bug"}, {"name":"security"}, {"title":"ignored"}, null]);
        assert_eq!(label_names(Some(&labels)), vec!["bug", "security"]);
        let repo = json!({"full_name":"octo/widget","html_url":"https://github.com/octo/widget"});
        let parsed = github_repo(repo.as_object().unwrap()).unwrap();
        assert_eq!(parsed.full_name, "octo/widget");
        assert_eq!(parsed.url.as_deref(), Some("https://github.com/octo/widget"));
        assert!(github_repo(json!({}).as_object().unwrap()).is_err());
    }
}
