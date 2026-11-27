//! Linear as an import source (`importers/linear-adapter.ts`).
//!
//! Reads a Linear workspace over GraphQL with a personal API key. Read-only: only `query`
//! documents are sent. Rate limiting is reported as `ProviderHttpError::rate_limited_until` so
//! the runner can wait and retry the same page.

use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use serde_json::{Map, Value, json};
use trama_contracts::imports::{DEFAULT_IMPORT_OPTIONS, ExternalProvider, ImportOptions};
use trama_core::config::js_number;
use trama_integrations::{Http, HttpRequest, ProviderHttpError};

use crate::adapter::{js_string, non_empty};
use crate::mapping::{map_linear_priority, redact_secrets};
use crate::types::{
    DiscoveredEntity, DiscoveredState, Discovery, DiscoveryCounts, ExternalComment, ExternalIssue,
    ExternalLabel, ExternalMilestone, ExternalState, ExternalUser, ImportSourceAdapter, Page,
    SampleIssue, SourceError,
};

/// The GraphQL endpoint.
pub const LINEAR_API: &str = "https://api.linear.app/graphql";
const ISSUE_PAGE: u32 = 50;
const COMMENT_PAGE: u32 = 100;
const MAX_LIST_PAGES: u32 = 20;

const ISSUE_FIELDS: &str = "
  id identifier title description priority estimate url createdAt updatedAt startedAt completedAt canceledAt
  state { id name type }
  assignee { id name email }
  creator { id name email }
  team { id }
  project { id }
  projectMilestone { id name description targetDate project { id } }
  labels(first: 25) { nodes { id name color } }
";

fn linear_user(raw: Option<&Value>) -> Option<ExternalUser> {
    let raw = raw?;
    let id = non_empty(raw.get("id"))?;
    Some(ExternalUser {
        id,
        login: None,
        name: non_empty(raw.get("name")),
        email: non_empty(raw.get("email")).map(|e| e.to_lowercase()),
    })
}

/// Linear sends the reset time as epoch seconds (some deployments in milliseconds).
fn reset_date(value: Option<&str>, wait: Duration) -> DateTime<Utc> {
    let fallback = || Utc::now() + wait;
    let Some(n) = value.and_then(js_number).filter(|n| n.is_finite() && *n > 0.0) else {
        return fallback();
    };
    let millis = if n > 1e12 { n } else { n * 1000.0 };
    #[allow(clippy::cast_possible_truncation)]
    DateTime::from_timestamp_millis(millis as i64).unwrap_or_else(fallback)
}

fn rate_limited(until: DateTime<Utc>) -> SourceError {
    SourceError::Provider(ProviderHttpError {
        status: 429,
        message: "Rate limited by Linear".to_owned(),
        rate_limited_until: Some(until),
    })
}

fn failure(status: u16, message: impl Into<String>) -> SourceError {
    SourceError::Provider(ProviderHttpError::new(status, message))
}

/// The `nodes` and `pageInfo` of a connection.
struct Connection {
    nodes: Vec<Value>,
    has_next: bool,
    end_cursor: Option<String>,
}

impl Connection {
    fn of(data: &Value, field: &str) -> Result<Self, SourceError> {
        let conn = data
            .get(field)
            .filter(|c| c.is_object())
            .ok_or_else(|| SourceError::Unexpected(format!("Linear answered without {field}")))?;
        Ok(Self {
            nodes: conn.get("nodes").and_then(Value::as_array).cloned().unwrap_or_default(),
            has_next: conn
                .get("pageInfo")
                .and_then(|p| p.get("hasNextPage"))
                .is_some_and(trama_contracts::js::truthy),
            end_cursor: conn
                .get("pageInfo")
                .and_then(|p| p.get("endCursor"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    fn next(&self) -> Option<String> {
        if self.has_next { self.end_cursor.clone() } else { None }
    }
}

fn id_of(value: Option<&Value>) -> String {
    js_string(value.and_then(|v| v.get("id")))
}

/// Reads the issues, projects, cycles-as-milestones, labels and comments of Linear teams.
pub struct LinearAdapter {
    http: Http,
    api_key: String,
    team_ids: Vec<String>,
}

impl LinearAdapter {
    /// An adapter over `team_ids` (empty = every team).
    #[must_use]
    pub const fn new(http: Http, api_key: String, team_ids: Vec<String>) -> Self {
        Self { http, api_key, team_ids }
    }

    async fn gql(&self, query: &str, variables: Value) -> Result<Value, SourceError> {
        let req = HttpRequest::new(axum::http::Method::POST, LINEAR_API)
            .header("Authorization", self.api_key.as_str())
            .header("User-Agent", "trama-importer")
            .json(json!({ "query": query, "variables": variables }));
        let res = self.http.request(req).await?;
        let errors: &[Value] =
            res.json.get("errors").and_then(Value::as_array).map_or(&[], Vec::as_slice);
        let limited = res.status == 429
            || errors.iter().any(|e| {
                e.get("extensions").and_then(|x| x.get("code")).and_then(Value::as_str)
                    == Some("RATELIMITED")
            });
        if limited {
            let reset = res
                .header("x-ratelimit-requests-reset")
                .or_else(|| res.header("x-ratelimit-complexity-reset"));
            return Err(rate_limited(reset_date(reset, Duration::seconds(60))));
        }
        if res.status == 401 || res.status == 403 {
            return Err(failure(res.status, "Linear rejected the API key"));
        }
        if let Some(first) = errors.first() {
            let code = first.get("extensions").and_then(|x| x.get("code")).and_then(Value::as_str);
            let status = if code == Some("AUTHENTICATION_ERROR") {
                401
            } else if res.status >= 400 {
                res.status
            } else {
                502
            };
            let message = match first.get("message") {
                None | Some(Value::Null) => "GraphQL error".to_owned(),
                other => js_string(other),
            };
            return Err(failure(
                status,
                redact_secrets(&format!("Linear: {message}"), &[Some(&self.api_key)]),
            ));
        }
        let data = res.json.get("data").filter(|d| trama_contracts::js::truthy(d));
        match data {
            Some(data) if res.status < 400 => Ok(data.clone()),
            _ => Err(failure(
                if res.status >= 400 { res.status } else { 502 },
                format!("Linear answered {}", res.status),
            )),
        }
    }

    async fn list(&self, field: &str, node_fields: &str) -> Result<Vec<Value>, SourceError> {
        let mut out = Vec::new();
        let mut after = Value::Null;
        for _ in 0..MAX_LIST_PAGES {
            let data = self
                .gql(
                    &format!(
                        "query($after:String){{ {field}(first:250, after:$after){{ nodes{{ {node_fields} }} pageInfo{{ hasNextPage endCursor }} }} }}"
                    ),
                    json!({ "after": after }),
                )
                .await?;
            let conn = Connection::of(&data, field)?;
            let next = conn.next();
            out.extend(conn.nodes);
            let Some(next) = next else { break };
            after = Value::String(next);
        }
        Ok(out)
    }

    fn team_filter(&self) -> Option<Value> {
        (!self.team_ids.is_empty()).then(|| json!({ "team": { "id": { "in": self.team_ids } } }))
    }

    /// Validates the key and names the account (used when a credential is saved).
    ///
    /// # Errors
    ///
    /// The provider's failure, e.g. 401 for a rejected key.
    pub async fn whoami(&self) -> Result<String, SourceError> {
        let data = self.gql("{ viewer { id name email } }", json!({})).await?;
        let viewer = data.get("viewer");
        Ok(non_empty(viewer.and_then(|v| v.get("name")))
            .or_else(|| non_empty(viewer.and_then(|v| v.get("email"))))
            .unwrap_or_else(|| "linear".to_owned()))
    }

    fn to_issue(raw: &Value) -> ExternalIssue {
        let state = raw.get("state");
        let state_field = |key: &str| js_string(state.and_then(|s| s.get(key)));
        let milestone = raw.get("projectMilestone").filter(|m| m.is_object());
        let labels = raw
            .get("labels")
            .and_then(|l| l.get("nodes"))
            .and_then(Value::as_array)
            .map(|nodes| {
                nodes
                    .iter()
                    .map(|l| ExternalLabel {
                        id: js_string(l.get("id")),
                        name: js_string(l.get("name")),
                        color: non_empty(l.get("color")),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let created_at = js_string(raw.get("createdAt"));
        ExternalIssue {
            id: js_string(raw.get("id")),
            key: js_string(raw.get("identifier")),
            url: js_string(raw.get("url")),
            title: non_empty(raw.get("title")).unwrap_or_default(),
            body: non_empty(raw.get("description")),
            state: ExternalState {
                id: state_field("id"),
                name: state_field("name"),
                kind: state_field("type"),
            },
            priority: Some(map_linear_priority(
                raw.get("priority").filter(|p| p.is_number()).and_then(Value::as_i64).or(Some(0)),
            )),
            estimate: raw.get("estimate").and_then(Value::as_f64),
            labels,
            assignee: linear_user(raw.get("assignee")),
            creator: linear_user(raw.get("creator")),
            team_id: non_empty(raw.get("team").and_then(|t| t.get("id"))),
            project_id: non_empty(raw.get("project").and_then(|p| p.get("id"))),
            milestone: milestone.map(|m| ExternalMilestone {
                id: js_string(m.get("id")),
                name: js_string(m.get("name")),
                project_id: non_empty(m.get("project").and_then(|p| p.get("id"))),
                description: non_empty(m.get("description")),
                due_on: non_empty(m.get("targetDate")),
            }),
            updated_at: raw
                .get("updatedAt")
                .filter(|v| !v.is_null())
                .map_or_else(|| created_at.clone(), |v| js_string(Some(v))),
            created_at,
            started_at: non_empty(raw.get("startedAt")),
            closed_at: non_empty(raw.get("completedAt"))
                .or_else(|| non_empty(raw.get("canceledAt"))),
        }
    }
}

#[async_trait]
impl ImportSourceAdapter for LinearAdapter {
    fn provider(&self) -> ExternalProvider {
        ExternalProvider::Linear
    }

    #[allow(clippy::too_many_lines)]
    async fn discover(&self) -> Result<Discovery, SourceError> {
        let mut warnings: Vec<String> = Vec::new();
        let me = self
            .gql("{ viewer { id name email } organization { name urlKey } }", json!({}))
            .await?;
        let all_teams = self.list("teams", "id key name").await?;
        let mut teams: Vec<DiscoveredEntity> = all_teams
            .iter()
            .filter(|t| self.team_ids.is_empty() || self.team_ids.contains(&js_string(t.get("id"))))
            .map(|t| DiscoveredEntity {
                id: js_string(t.get("id")),
                key: non_empty(t.get("key")),
                name: js_string(t.get("name")),
                color: None,
                count: None,
            })
            .collect();
        let in_scope: BTreeSet<String> = teams.iter().map(|t| t.id.clone()).collect();

        // Counts and per-team numbers are a convenience: a schema or complexity problem must
        // not stop the preview.
        let mut sum = 0_i64;
        let mut known = true;
        for team in &mut teams {
            let count = match self
                .gql("query($id:String!){ team(id:$id){ issueCount } }", json!({ "id": team.id }))
                .await
            {
                Ok(data) => {
                    data.get("team").and_then(|t| t.get("issueCount")).and_then(Value::as_f64)
                }
                Err(SourceError::Provider(e)) if e.rate_limited() || e.status == 401 => {
                    return Err(SourceError::Provider(e));
                }
                Err(_) => None,
            };
            if let Some(count) = count {
                #[allow(clippy::cast_possible_truncation)]
                let count = count as i64;
                team.count = Some(count);
                sum += count;
            } else {
                known = false;
            }
        }
        let total = known.then_some(sum);
        if !known {
            warnings.push("Issue counts are unavailable for this workspace.".to_owned());
        }

        let states: Vec<Value> = self
            .list("workflowStates", "id name type team { id key }")
            .await?
            .into_iter()
            .filter(|s| in_scope.contains(&id_of(s.get("team"))))
            .collect();
        let team_key: BTreeMap<&str, &str> = teams
            .iter()
            .map(|t| (t.id.as_str(), t.key.as_deref().unwrap_or(t.name.as_str())))
            .collect();
        let labels: Vec<DiscoveredEntity> = self
            .list("issueLabels", "id name color team { id }")
            .await?
            .iter()
            .filter(|l| {
                let team = l.get("team").and_then(|t| t.get("id"));
                !team.is_some_and(trama_contracts::js::truthy)
                    || in_scope.contains(&js_string(team))
            })
            .map(|l| DiscoveredEntity {
                id: js_string(l.get("id")),
                name: js_string(l.get("name")),
                key: None,
                color: non_empty(l.get("color")),
                count: None,
            })
            .collect();
        let projects: Vec<DiscoveredEntity> = self
            .list("projects", "id name color teams { nodes { id } }")
            .await?
            .iter()
            .filter(|p| {
                p.get("teams")
                    .and_then(|t| t.get("nodes"))
                    .and_then(Value::as_array)
                    .is_some_and(|nodes| nodes.iter().any(|t| in_scope.contains(&id_of(Some(t)))))
            })
            .map(|p| DiscoveredEntity {
                id: js_string(p.get("id")),
                name: js_string(p.get("name")),
                key: None,
                color: non_empty(p.get("color")),
                count: None,
            })
            .collect();
        let project_ids: BTreeSet<&str> = projects.iter().map(|p| p.id.as_str()).collect();
        let milestones = match self
            .list("projectMilestones", "id name description targetDate project { id }")
            .await
        {
            Ok(list) => list
                .iter()
                .filter(|m| project_ids.contains(id_of(m.get("project")).as_str()))
                .map(|m| ExternalMilestone {
                    id: js_string(m.get("id")),
                    name: js_string(m.get("name")),
                    project_id: Some(id_of(m.get("project"))),
                    description: non_empty(m.get("description")),
                    due_on: non_empty(m.get("targetDate")),
                })
                .collect(),
            Err(SourceError::Provider(e)) if e.rate_limited() => {
                return Err(SourceError::Provider(e));
            }
            Err(_) => {
                warnings.push("Project milestones could not be read; they are skipped.".to_owned());
                Vec::new()
            }
        };
        let users: Vec<ExternalUser> = self
            .list("users", "id name email active")
            .await?
            .iter()
            .filter(|u| u.get("active") != Some(&Value::Bool(false)))
            .filter_map(|u| linear_user(Some(u)))
            .collect();

        let first = self.issues(None, &DEFAULT_IMPORT_OPTIONS).await?;
        let viewer = me.get("viewer");
        let organization = me.get("organization");
        let org_name = non_empty(organization.and_then(|o| o.get("name")));
        let url_key = non_empty(organization.and_then(|o| o.get("urlKey")));
        let team_names =
            teams.iter().map(|t| t.key.as_deref().unwrap_or(t.name.as_str())).collect::<Vec<_>>();
        let statuses = states
            .iter()
            .map(|s| {
                let name = js_string(s.get("name"));
                DiscoveredState {
                    state: ExternalState {
                        id: js_string(s.get("id")),
                        name: if teams.len() > 1 {
                            let key = team_key
                                .get(id_of(s.get("team")).as_str())
                                .copied()
                                .unwrap_or("undefined");
                            format!("{key} · {name}")
                        } else {
                            name
                        },
                        kind: js_string(s.get("type")),
                    },
                    count: None,
                }
            })
            .collect();
        Ok(Discovery {
            provider: ExternalProvider::Linear,
            account: non_empty(viewer.and_then(|v| v.get("name")))
                .or_else(|| non_empty(viewer.and_then(|v| v.get("email"))))
                .unwrap_or_else(|| "linear".to_owned()),
            source_label: format!(
                "{}: {}",
                org_name.unwrap_or_else(|| "Linear".to_owned()),
                if team_names.is_empty() { "no team".to_owned() } else { team_names.join(", ") }
            ),
            source_url: url_key.map(|key| format!("https://linear.app/{key}")),
            counts: DiscoveryCounts { issues: total, open: None, closed: None },
            teams,
            projects,
            labels,
            milestones,
            users,
            statuses,
            sample: first
                .items
                .into_iter()
                .take(5)
                .map(|i| SampleIssue { key: i.key, title: i.title, state: i.state.name })
                .collect(),
            warnings,
        })
    }

    async fn issues(
        &self,
        cursor: Option<&str>,
        options: &ImportOptions,
    ) -> Result<Page<ExternalIssue>, SourceError> {
        let mut filter = Map::new();
        if let Some(Value::Object(team)) = self.team_filter() {
            filter.extend(team);
        }
        if !options.include_closed {
            filter.insert(
                "state".to_owned(),
                json!({ "type": { "nin": ["completed", "canceled"] } }),
            );
        }
        let data = self
            .gql(
                &format!(
                    "query($first:Int!,$after:String,$filter:IssueFilter){{ issues(first:$first, after:$after, filter:$filter, orderBy:createdAt){{ nodes{{ {ISSUE_FIELDS} }} pageInfo{{ hasNextPage endCursor }} }} }}"
                ),
                json!({ "first": ISSUE_PAGE, "after": cursor, "filter": filter }),
            )
            .await?;
        let conn = Connection::of(&data, "issues")?;
        Ok(Page { next: conn.next(), items: conn.nodes.iter().map(Self::to_issue).collect() })
    }

    async fn comments(&self, cursor: Option<&str>) -> Result<Page<ExternalComment>, SourceError> {
        let filter = self.team_filter().map_or_else(|| json!({}), |team| json!({ "issue": team }));
        let data = self
            .gql(
                "query($first:Int!,$after:String,$filter:CommentFilter){ comments(first:$first, after:$after, filter:$filter){ nodes{ id body createdAt user { id name email } issue { id } } pageInfo{ hasNextPage endCursor } } }",
                json!({ "first": COMMENT_PAGE, "after": cursor, "filter": filter }),
            )
            .await?;
        let conn = Connection::of(&data, "comments")?;
        let mut items = Vec::new();
        for c in &conn.nodes {
            let Some(issue_id) = non_empty(c.get("issue").and_then(|i| i.get("id"))) else {
                continue;
            };
            let Some(body) = non_empty(c.get("body")) else { continue };
            items.push(ExternalComment {
                id: js_string(c.get("id")),
                issue_id,
                author: linear_user(c.get("user")),
                body,
                created_at: js_string(c.get("createdAt")),
            });
        }
        Ok(Page { next: conn.next(), items })
    }

    /// `id`: the issue uuid or its identifier (`ENG-123`).
    async fn get_issue(&self, id: &str) -> Result<ExternalIssue, SourceError> {
        let data = self
            .gql(
                &format!("query($id:String!){{ issue(id:$id){{ {ISSUE_FIELDS} }} }}"),
                json!({ "id": id }),
            )
            .await?;
        match data.get("issue").filter(|i| !i.is_null()) {
            Some(issue) => Ok(Self::to_issue(issue)),
            None => Err(failure(404, format!("Linear issue {id} not found"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use trama_contracts::common::Priority;
    use trama_contracts::issues::IssueKind;

    use super::*;
    use crate::adapter::testing::{FakeHttp, reply, reply_with};

    const KEY: &str = "lin_api_secretsecretsecretsecretsecret12";

    fn options(include_closed: bool) -> ImportOptions {
        ImportOptions { include_comments: false, include_closed, default_kind: IssueKind::Feature }
    }

    fn node(extra: &Value) -> Value {
        let mut node = json!({
            "id": "uuid-1",
            "identifier": "ENG-1",
            "title": "Crash",
            "description": "details",
            "priority": 2,
            "estimate": 5,
            "url": "https://linear.app/acme/issue/ENG-1/crash",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-02T00:00:00.000Z",
            "startedAt": "2026-01-03T00:00:00.000Z",
            "completedAt": null,
            "canceledAt": null,
            "state": { "id": "s1", "name": "In Progress", "type": "started" },
            "assignee": { "id": "u1", "name": "Ada", "email": "ADA@acme.dev" },
            "creator": { "id": "u2", "name": "Carl", "email": null },
            "team": { "id": "t1" },
            "project": { "id": "p1" },
            "projectMilestone": { "id": "m1", "name": "Beta", "project": { "id": "p1" } },
            "labels": { "nodes": [{ "id": "l1", "name": "Bug", "color": "#e11d48" }] },
        });
        if let (Some(base), Some(extra)) = (node.as_object_mut(), extra.as_object()) {
            base.extend(extra.clone());
        }
        node
    }

    #[allow(clippy::needless_pass_by_value)]
    fn connection(nodes: Vec<Value>, has_next: bool, cursor: Option<&str>) -> Value {
        json!({ "nodes": nodes, "pageInfo": { "hasNextPage": has_next, "endCursor": cursor } })
    }

    fn body_of(req: &HttpRequest) -> &Value {
        req.body.as_ref().expect("a JSON body")
    }

    fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
        req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    #[tokio::test]
    async fn sends_the_key_as_the_authorization_header_to_the_linear_endpoint_with_a_team_filter() {
        let (http, calls) = FakeHttp::new(|_| {
            Some(reply(
                json!({ "data": { "issues": connection(vec![node(&json!({}))], true, Some("c2")) } }),
            ))
        });
        let page = LinearAdapter::new(http, KEY.into(), vec!["t1".into()])
            .issues(Some("c1"), &options(false))
            .await
            .unwrap();
        let calls = calls.lock().unwrap();
        let req = &calls[0];
        assert_eq!(req.url, LINEAR_API);
        assert_eq!(req.method, axum::http::Method::POST);
        assert_eq!(header(req, "Authorization"), Some(KEY));
        assert_eq!(header(req, "User-Agent"), Some("trama-importer"));
        let body = body_of(req);
        let query = body["query"].as_str().unwrap();
        assert!(query.trim_start().starts_with("query"));
        assert!(!query.to_lowercase().contains("mutation"));
        assert_eq!(body["variables"]["first"], 50);
        assert_eq!(body["variables"]["after"], "c1");
        assert_eq!(
            body["variables"]["filter"],
            json!({ "team": { "id": { "in": ["t1"] } }, "state": { "type": { "nin": ["completed", "canceled"] } } })
        );
        assert_eq!(page.next.as_deref(), Some("c2"));
        let issue = &page.items[0];
        assert_eq!(issue.id, "uuid-1");
        assert_eq!(issue.key, "ENG-1");
        assert_eq!(issue.priority, Some(Priority::High));
        assert_eq!(issue.estimate, Some(5.0));
        assert_eq!(
            issue.assignee,
            Some(ExternalUser {
                id: "u1".into(),
                login: None,
                name: Some("Ada".into()),
                email: Some("ada@acme.dev".into())
            })
        );
        assert_eq!(issue.creator.as_ref().unwrap().email, None);
        assert_eq!(issue.team_id.as_deref(), Some("t1"));
        assert_eq!(issue.project_id.as_deref(), Some("p1"));
        let milestone = issue.milestone.as_ref().unwrap();
        assert_eq!(
            (milestone.id.as_str(), milestone.name.as_str(), milestone.project_id.as_deref()),
            ("m1", "Beta", Some("p1"))
        );
        assert_eq!(
            issue.labels,
            [ExternalLabel { id: "l1".into(), name: "Bug".into(), color: Some("#e11d48".into()) }]
        );
        assert_eq!(issue.state.id, "s1");
        assert_eq!(issue.state.kind, "started");
        assert_eq!(issue.started_at.as_deref(), Some("2026-01-03T00:00:00.000Z"));
    }

    #[tokio::test]
    async fn an_empty_cursor_and_no_team_filter_send_null_and_an_empty_filter() {
        let (http, calls) = FakeHttp::new(|_| {
            Some(reply(json!({ "data": { "issues": connection(vec![], false, None) } })))
        });
        LinearAdapter::new(http, KEY.into(), vec![]).issues(None, &options(true)).await.unwrap();
        let calls = calls.lock().unwrap();
        assert_eq!(body_of(&calls[0])["variables"]["after"], Value::Null);
        assert_eq!(body_of(&calls[0])["variables"]["filter"], json!({}));
    }

    #[tokio::test]
    async fn takes_the_close_date_from_completed_at_or_canceled_at() {
        let (http, _) = FakeHttp::new(|_| {
            Some(reply(json!({ "data": { "issues": connection(
                vec![node(&json!({ "canceledAt": "2026-04-01T00:00:00.000Z" }))], false, None) } })))
        });
        let page = LinearAdapter::new(http, KEY.into(), vec![])
            .issues(None, &options(true))
            .await
            .unwrap();
        assert_eq!(page.items[0].closed_at.as_deref(), Some("2026-04-01T00:00:00.000Z"));
        assert_eq!(page.next, None);
    }

    #[tokio::test]
    async fn maps_a_ratelimited_answer_to_a_wait_until_the_reset_time() {
        let reset = Utc::now().timestamp() + 300;
        let (http, _) = FakeHttp::new(move |_| {
            Some(reply_with(
                400,
                json!({ "errors": [{ "message": "Rate limit exceeded",
                    "extensions": { "code": "RATELIMITED" } }] }),
                &[("x-ratelimit-requests-reset", &reset.to_string())],
            ))
        });
        let err = LinearAdapter::new(http, KEY.into(), vec![])
            .issues(None, &options(true))
            .await
            .unwrap_err();
        let SourceError::Provider(err) = err else { panic!() };
        assert!(err.rate_limited());
        assert_eq!(err.status, 429);
        assert_eq!(err.rate_limited_until.unwrap().timestamp_millis(), reset * 1000);
    }

    #[tokio::test]
    async fn understands_reset_times_in_milliseconds_and_waits_a_minute_without_one() {
        let reset_ms = Utc::now().timestamp_millis() + 90_000;
        let (http, _) = FakeHttp::new(move |_| {
            Some(reply_with(
                429,
                Value::Null,
                &[("x-ratelimit-complexity-reset", &reset_ms.to_string())],
            ))
        });
        let err = LinearAdapter::new(http, KEY.into(), vec![]).whoami().await.unwrap_err();
        assert_eq!(err.rate_limited_until().unwrap().timestamp_millis(), reset_ms);

        let (http, _) = FakeHttp::new(|_| Some(reply_with(429, Value::Null, &[])));
        let before = Utc::now();
        let err = LinearAdapter::new(http, KEY.into(), vec![]).whoami().await.unwrap_err();
        let until = err.rate_limited_until().unwrap();
        assert!(
            until >= before + Duration::seconds(59) && until <= Utc::now() + Duration::seconds(61)
        );
    }

    #[tokio::test]
    async fn turns_a_rejected_key_into_a_401_that_does_not_echo_the_key() {
        let (http, _) = FakeHttp::new(|_| {
            Some(reply_with(
                401,
                json!({ "errors": [{ "message": format!("Authentication required, {KEY} is not valid") }] }),
                &[],
            ))
        });
        let err = LinearAdapter::new(http, KEY.into(), vec![]).whoami().await.unwrap_err();
        let SourceError::Provider(err) = err else { panic!() };
        assert_eq!(err.status, 401);
        assert!(!err.message.contains(KEY));
    }

    #[tokio::test]
    async fn graphql_errors_become_provider_errors_without_the_key() {
        let (http, _) = FakeHttp::new(|_| {
            Some(reply(json!({ "errors": [{ "message": format!("bad {KEY}"),
                "extensions": { "code": "AUTHENTICATION_ERROR" } }] })))
        });
        let err = LinearAdapter::new(http, KEY.into(), vec![]).whoami().await.unwrap_err();
        let SourceError::Provider(err) = err else { panic!() };
        assert_eq!((err.status, err.message.as_str()), (401, "Linear: bad [redacted]"));

        let (http, _) =
            FakeHttp::new(|_| Some(reply(json!({ "errors": [{ "message": "Boom" }] }))));
        let err = LinearAdapter::new(http, KEY.into(), vec![]).whoami().await.unwrap_err();
        let SourceError::Provider(err) = err else { panic!() };
        assert_eq!((err.status, err.message.as_str()), (502, "Linear: Boom"));

        let (http, _) = FakeHttp::new(|_| Some(reply_with(500, Value::Null, &[])));
        let err = LinearAdapter::new(http, KEY.into(), vec![]).whoami().await.unwrap_err();
        let SourceError::Provider(err) = err else { panic!() };
        assert_eq!((err.status, err.message.as_str()), (500, "Linear answered 500"));

        let (http, _) = FakeHttp::new(|_| Some(reply(json!({}))));
        let err = LinearAdapter::new(http, KEY.into(), vec![]).whoami().await.unwrap_err();
        let SourceError::Provider(err) = err else { panic!() };
        assert_eq!((err.status, err.message.as_str()), (502, "Linear answered 200"));
    }

    #[tokio::test]
    async fn whoami_names_the_account() {
        let (http, _) = FakeHttp::new(|_| {
            Some(reply(
                json!({ "data": { "viewer": { "id": "u1", "name": null, "email": "a@b.c" } } }),
            ))
        });
        assert_eq!(LinearAdapter::new(http, KEY.into(), vec![]).whoami().await.unwrap(), "a@b.c");
    }

    #[tokio::test]
    async fn reads_one_issue_by_identifier_and_reports_a_missing_one_as_404() {
        let issue = std::sync::Arc::new(std::sync::Mutex::new(node(&json!({}))));
        let shared = std::sync::Arc::clone(&issue);
        let (http, calls) = FakeHttp::new(move |_| {
            Some(reply(json!({ "data": { "issue": shared.lock().unwrap().clone() } })))
        });
        let adapter = LinearAdapter::new(http, KEY.into(), vec![]);
        assert_eq!(adapter.get_issue("ENG-1").await.unwrap().id, "uuid-1");
        assert_eq!(body_of(&calls.lock().unwrap()[0])["variables"]["id"], "ENG-1");
        *issue.lock().unwrap() = Value::Null;
        let err = adapter.get_issue("ENG-9").await.unwrap_err();
        let SourceError::Provider(err) = err else { panic!() };
        assert_eq!((err.status, err.message.as_str()), (404, "Linear issue ENG-9 not found"));
    }

    #[tokio::test]
    async fn drops_comments_without_a_body_or_an_issue() {
        let (http, calls) = FakeHttp::new(|_| {
            Some(reply(json!({ "data": { "comments": connection(vec![
                json!({ "id": "c1", "body": "hi", "createdAt": "2026-01-01T00:00:00.000Z",
                    "user": { "id": "u1", "name": "Ada" }, "issue": { "id": "uuid-1" } }),
                json!({ "id": "c2", "body": "", "createdAt": "2026-01-01T00:00:00.000Z",
                    "user": null, "issue": { "id": "uuid-1" } }),
                json!({ "id": "c3", "body": "orphan", "createdAt": "2026-01-01T00:00:00.000Z",
                    "user": null, "issue": null }),
            ], false, None) } })))
        });
        let page =
            LinearAdapter::new(http, KEY.into(), vec!["t1".into()]).comments(None).await.unwrap();
        let ids: Vec<_> = page.items.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["c1"]);
        assert_eq!(page.items[0].issue_id, "uuid-1");
        assert_eq!(page.items[0].author.as_ref().unwrap().name.as_deref(), Some("Ada"));
        let calls = calls.lock().unwrap();
        let vars = &body_of(&calls[0])["variables"];
        assert_eq!(vars["first"], 100);
        assert_eq!(vars["filter"], json!({ "issue": { "team": { "id": { "in": ["t1"] } } } }));
    }

    #[tokio::test]
    async fn describes_the_workspace_in_discover() {
        let (http, calls) = FakeHttp::new(|req| {
            let query = body_of(req)["query"].as_str().unwrap().to_owned();
            let data = if query.contains("viewer") {
                json!({ "viewer": { "id": "u0", "name": "Me", "email": "me@acme.dev" },
                    "organization": { "name": "Acme", "urlKey": "acme" } })
            } else if query.contains("teams(first") {
                json!({ "teams": connection(vec![
                    json!({ "id": "t1", "key": "ENG", "name": "Engineering" }),
                    json!({ "id": "t2", "key": "OPS", "name": "Operations" }),
                    json!({ "id": "t3", "key": "HR", "name": "People" }),
                ], false, None) })
            } else if query.contains("issueCount") {
                let id = body_of(req)["variables"]["id"].as_str().unwrap().to_owned();
                json!({ "team": { "issueCount": if id == "t1" { 10 } else { 4 } } })
            } else if query.contains("workflowStates") {
                json!({ "workflowStates": connection(vec![
                    json!({ "id": "s1", "name": "Todo", "type": "unstarted", "team": { "id": "t1", "key": "ENG" } }),
                    json!({ "id": "s2", "name": "Done", "type": "completed", "team": { "id": "t2", "key": "OPS" } }),
                    json!({ "id": "s3", "name": "Other", "type": "started", "team": { "id": "t3", "key": "HR" } }),
                ], false, None) })
            } else if query.contains("issueLabels") {
                json!({ "issueLabels": connection(vec![
                    json!({ "id": "l1", "name": "Bug", "color": "#ff0000", "team": { "id": "t1" } }),
                    json!({ "id": "l2", "name": "Shared", "color": null, "team": null }),
                    json!({ "id": "l3", "name": "Elsewhere", "color": "#00ff00", "team": { "id": "t3" } }),
                ], false, None) })
            } else if query.contains("projectMilestones") {
                json!({ "projectMilestones": connection(vec![
                    json!({ "id": "m1", "name": "Beta", "description": "d", "targetDate": "2026-05-01", "project": { "id": "p1" } }),
                    json!({ "id": "m2", "name": "Out", "description": null, "targetDate": null, "project": { "id": "p9" } }),
                ], false, None) })
            } else if query.contains("projects(first") {
                json!({ "projects": connection(vec![
                    json!({ "id": "p1", "name": "Launch", "color": "#123456", "teams": { "nodes": [{ "id": "t1" }] } }),
                    json!({ "id": "p9", "name": "Not ours", "color": null, "teams": { "nodes": [{ "id": "t3" }] } }),
                ], false, None) })
            } else if query.contains("users(first") {
                json!({ "users": connection(vec![
                    json!({ "id": "u1", "name": "Ada", "email": "ADA@acme.dev", "active": true }),
                    json!({ "id": "u2", "name": "Gone", "email": "gone@acme.dev", "active": false }),
                ], false, None) })
            } else if query.contains("issues(first") {
                json!({ "issues": connection(vec![node(&json!({}))], false, None) })
            } else {
                return None;
            };
            Some(reply(json!({ "data": data })))
        });
        let d = LinearAdapter::new(http, KEY.into(), vec!["t1".into(), "t2".into()])
            .discover()
            .await
            .unwrap();
        assert_eq!(d.account, "Me");
        assert_eq!(d.source_label, "Acme: ENG, OPS");
        assert_eq!(d.source_url.as_deref(), Some("https://linear.app/acme"));
        assert_eq!(d.counts, DiscoveryCounts { issues: Some(14), open: None, closed: None });
        let teams: Vec<_> = d.teams.iter().map(|t| (t.id.as_str(), t.count)).collect();
        assert_eq!(teams, [("t1", Some(10)), ("t2", Some(4))]);
        let labels: Vec<_> = d.labels.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(labels, ["l1", "l2"]);
        assert_eq!(d.projects.len(), 1);
        assert_eq!(d.projects[0].id, "p1");
        assert_eq!(d.milestones.len(), 1);
        assert_eq!(d.milestones[0].project_id.as_deref(), Some("p1"));
        assert_eq!(d.milestones[0].due_on.as_deref(), Some("2026-05-01"));
        assert_eq!(d.users.len(), 1);
        assert_eq!(d.users[0].email.as_deref(), Some("ada@acme.dev"));
        let names: Vec<_> = d.statuses.iter().map(|s| s.state.name.as_str()).collect();
        assert_eq!(names, ["ENG · Todo", "OPS · Done"]);
        assert_eq!(d.statuses[0].state.kind, "unstarted");
        assert_eq!(
            d.sample,
            [SampleIssue {
                key: "ENG-1".into(),
                title: "Crash".into(),
                state: "In Progress".into()
            }]
        );
        assert!(d.warnings.is_empty(), "{:?}", d.warnings);
        // every document sent is a query
        for call in calls.lock().unwrap().iter() {
            assert!(body_of(call)["query"].as_str().unwrap().trim_start().starts_with(['q', '{']));
        }
    }

    #[tokio::test]
    async fn discover_survives_unreadable_counts_and_milestones_but_not_a_rate_limit() {
        let route = |limit_counts: bool| {
            move |req: &HttpRequest| {
                let query = body_of(req)["query"].as_str().unwrap().to_owned();
                if query.contains("issueCount") {
                    return Some(if limit_counts {
                        reply_with(429, Value::Null, &[])
                    } else {
                        reply(json!({ "errors": [{ "message": "complexity" }] }))
                    });
                }
                if query.contains("projectMilestones") {
                    return Some(reply(json!({ "errors": [{ "message": "no schema" }] })));
                }
                let data = if query.contains("viewer") {
                    json!({ "viewer": { "email": "me@acme.dev" }, "organization": {} })
                } else if query.contains("teams(first") {
                    json!({ "teams": connection(vec![json!({ "id": "t1", "name": "Solo" })], false, None) })
                } else if query.contains("issues(first") {
                    json!({ "issues": connection(vec![], false, None) })
                } else {
                    let key = ["workflowStates", "issueLabels", "projects", "users"]
                        .into_iter()
                        .find(|k| query.contains(&format!("{k}(first")))
                        .expect("a field the test knows");
                    json!({ key: connection(vec![], false, None) })
                };
                Some(reply(json!({ "data": data })))
            }
        };
        let (http, _) = FakeHttp::new(route(false));
        let d = LinearAdapter::new(http, KEY.into(), vec![]).discover().await.unwrap();
        assert_eq!(d.account, "me@acme.dev");
        assert_eq!(d.source_label, "Linear: Solo");
        assert_eq!(d.source_url, None);
        assert_eq!(d.counts.issues, None);
        assert_eq!(
            d.warnings,
            [
                "Issue counts are unavailable for this workspace.",
                "Project milestones could not be read; they are skipped."
            ]
        );
        assert_eq!(d.statuses.len(), 0);

        let (http, _) = FakeHttp::new(route(true));
        let err = LinearAdapter::new(http, KEY.into(), vec![]).discover().await.unwrap_err();
        assert!(err.rate_limited_until().is_some());
    }
}
