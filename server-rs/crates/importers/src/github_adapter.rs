//! GitHub Issues as an import source (`importers/github-adapter.ts`).
//!
//! Reads the issues of one repository through the GitHub REST API. Works without a token for
//! public repositories (60 requests an hour). Reads only; every call goes through [`Http`],
//! hence `safe_fetch`.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use trama_contracts::imports::{DEFAULT_IMPORT_OPTIONS, ExternalProvider, ImportOptions};
use trama_core::config::js_number;
use trama_integrations::providers::ensure_ok;
use trama_integrations::{Http, HttpRequest, HttpResponse, ProviderHttpError};

use crate::adapter::{encode_uri_component, js_number_string, js_string, non_empty};
use crate::mapping::{github_issue_id, map_github_state, priority_from_labels, redact_secrets};
use crate::types::{
    DiscoveredEntity, DiscoveredState, Discovery, DiscoveryCounts, ExternalComment, ExternalIssue,
    ExternalLabel, ExternalMilestone, ExternalState, ExternalUser, ImportSourceAdapter, Page,
    SampleIssue, SourceError,
};

const PER_PAGE: u32 = 100;
const MAX_LIST_PAGES: u32 = 5;

/// Where the REST API lives: `api.github.com` for github.com, `<base>/api/v3` for Enterprise.
#[must_use]
pub fn github_api_base(base_url: Option<&str>) -> String {
    let base = base_url.unwrap_or("https://github.com");
    let host = base.strip_prefix("https://").or_else(|| base.strip_prefix("http://"));
    if host.is_some_and(|h| h.strip_prefix("www.").unwrap_or(h) == "github.com") {
        "https://api.github.com".to_owned()
    } else if base.ends_with("/api/v3") {
        base.to_owned()
    } else {
        format!("{base}/api/v3")
    }
}

/// `githubUser`: a login is all GitHub gives; the id is its lower-case form.
fn github_user(raw: Option<&Value>) -> Option<ExternalUser> {
    let raw = raw?;
    let login = non_empty(raw.get("login"))?;
    Some(ExternalUser {
        id: login.to_lowercase(),
        name: non_empty(raw.get("name")),
        login: Some(login),
        email: None,
    })
}

fn label_of(raw: &Value) -> ExternalLabel {
    ExternalLabel {
        id: js_string(raw.get("id")),
        name: js_string(raw.get("name")),
        color: non_empty(raw.get("color")).map(|c| format!("#{}", c.to_lowercase())),
    }
}

fn has_next(res: &HttpResponse) -> bool {
    res.header("link").is_some_and(|link| link.contains("rel=\"next\""))
}

/// `Math.max(1, Number(cursor) || 1)`.
fn page_of(cursor: Option<&str>) -> f64 {
    let n = cursor.and_then(js_number).filter(|n| n.is_finite() && *n != 0.0).unwrap_or(1.0);
    n.max(1.0)
}

fn list_of(res: &HttpResponse) -> &[Value] {
    res.json.as_array().map_or(&[], Vec::as_slice)
}

/// Reads issues of one repository.
pub struct GithubAdapter {
    http: Http,
    token: Option<String>,
    repository: String,
    api: String,
    /// When the budget ran out: the next call waits for it (the runner sleeps, we only report).
    blocked_until: AtomicI64,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl GithubAdapter {
    /// An adapter for `repository` (`owner/name`), unauthenticated when `token` is `None`, on
    /// GitHub Enterprise when `base_url` is set.
    #[must_use]
    #[allow(
        clippy::needless_pass_by_value,
        reason = "the signature `create_adapter` and the importers call"
    )]
    pub fn new(
        http: Http,
        token: Option<String>,
        repository: String,
        base_url: Option<String>,
    ) -> Self {
        Self {
            http,
            token: token.filter(|t| !t.is_empty()),
            repository,
            api: github_api_base(base_url.as_deref()),
            blocked_until: AtomicI64::new(0),
            now: Arc::new(|| Utc::now().timestamp_millis()),
        }
    }

    /// Replaces the clock (milliseconds since the epoch).
    #[cfg(test)]
    #[must_use]
    fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        self.now = Arc::new(now);
        self
    }

    fn pseudo_id(&self) -> String {
        format!("repo:{}", self.repository.to_lowercase())
    }

    async fn get(&self, path: &str) -> Result<HttpResponse, SourceError> {
        let blocked = self.blocked_until.load(Ordering::Relaxed);
        if blocked > (self.now)() {
            return Err(SourceError::Provider(ProviderHttpError {
                status: 429,
                message: "Rate limit reached".to_owned(),
                rate_limited_until: DateTime::from_timestamp_millis(blocked),
            }));
        }
        let mut req = HttpRequest::get(format!("{}{path}", self.api));
        if let Some(token) = &self.token {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        let req = req
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "trama-importer");
        let res = self.http.request(req).await?;
        if res.header("x-ratelimit-remaining") == Some("0")
            && let Some(reset) =
                res.header("x-ratelimit-reset").and_then(js_number).filter(|n| n.is_finite())
        {
            #[allow(clippy::cast_possible_truncation)]
            self.blocked_until.store((reset * 1000.0) as i64, Ordering::Relaxed);
        }
        ensure_ok(&res).map_err(|mut e| {
            // A provider message should never carry the token, but whatever is stored or shown
            // must not either.
            e.message = redact_secrets(&e.message, &[self.token.as_deref()]);
            SourceError::Provider(e)
        })?;
        Ok(res)
    }

    async fn all(&self, path: &str, max_pages: u32) -> Result<Vec<Value>, SourceError> {
        let mut out = Vec::new();
        let sep = if path.contains('?') { '&' } else { '?' };
        for page in 1..=max_pages {
            let res = self.get(&format!("{path}{sep}per_page={PER_PAGE}&page={page}")).await?;
            out.extend_from_slice(list_of(&res));
            if !has_next(&res) {
                break;
            }
        }
        Ok(out)
    }

    async fn search_count(&self, state: &str) -> Result<Option<i64>, SourceError> {
        let q = encode_uri_component(&format!("repo:{} type:issue state:{state}", self.repository));
        match self.get(&format!("/search/issues?q={q}&per_page=1")).await {
            Ok(res) => Ok(res.json.get("total_count").and_then(Value::as_f64).map(count_of)),
            // The search API has its own, smaller budget; a count is nice to have, not required.
            Err(SourceError::Provider(e)) if matches!(e.status, 401 | 404) => {
                Err(SourceError::Provider(e))
            }
            Err(_) => Ok(None),
        }
    }

    fn milestone_of(&self, raw: &Value) -> ExternalMilestone {
        ExternalMilestone {
            id: js_string(raw.get("id")),
            name: js_string(raw.get("title")),
            project_id: Some(self.pseudo_id()),
            description: non_empty(raw.get("description")),
            due_on: non_empty(raw.get("due_on")),
        }
    }

    fn to_issue(&self, raw: &Value) -> ExternalIssue {
        let number = raw.get("number").and_then(Value::as_u64).unwrap_or_default();
        let labels: Vec<ExternalLabel> = raw
            .get("labels")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter(|l| l.is_object()).map(label_of).collect())
            .unwrap_or_default();
        let milestone = raw.get("milestone").filter(|m| m.is_object());
        let assignee = github_user(
            raw.get("assignee")
                .filter(|a| !a.is_null())
                .or_else(|| raw.get("assignees").and_then(|a| a.get(0))),
        );
        let priority = {
            let names: Vec<&str> = labels.iter().map(|l| l.name.as_str()).collect();
            priority_from_labels(&names)
        };
        let created_at = js_string(raw.get("created_at"));
        let updated_at = raw
            .get("updated_at")
            .filter(|v| !v.is_null())
            .map_or_else(|| created_at.clone(), |v| js_string(Some(v)));
        ExternalIssue {
            id: github_issue_id(&self.repository, number),
            key: format!("#{number}"),
            url: js_string(raw.get("html_url")),
            title: non_empty(raw.get("title")).unwrap_or_default(),
            body: non_empty(raw.get("body")),
            state: map_github_state(
                &js_string(raw.get("state")),
                non_empty(raw.get("state_reason")).as_deref(),
            ),
            priority,
            estimate: None,
            labels,
            assignee,
            creator: github_user(raw.get("user")),
            team_id: Some(self.pseudo_id()),
            project_id: Some(self.pseudo_id()),
            milestone: milestone.map(|m| self.milestone_of(m)),
            created_at,
            updated_at,
            started_at: None,
            closed_at: non_empty(raw.get("closed_at")),
        }
    }
}

#[allow(clippy::cast_possible_truncation)]
const fn count_of(n: f64) -> i64 {
    n as i64
}

#[async_trait]
impl ImportSourceAdapter for GithubAdapter {
    fn provider(&self) -> ExternalProvider {
        ExternalProvider::Github
    }

    async fn discover(&self) -> Result<Discovery, SourceError> {
        let mut warnings: Vec<String> = Vec::new();
        let repo = self.get(&format!("/repos/{}", self.repository)).await?.json;
        let full_name = non_empty(repo.get("full_name")).unwrap_or_else(|| self.repository.clone());
        if repo.get("has_issues") == Some(&Value::Bool(false)) {
            warnings.push("Issues are disabled on this repository.".to_owned());
        }
        let mut account = "anonymous".to_owned();
        if self.token.is_some() {
            match self.get("/user").await {
                Ok(res) => {
                    if let Some(login) = non_empty(res.json.get("login")) {
                        account = login;
                    }
                }
                Err(_) => warnings.push("The token could not read /user; continuing.".to_owned()),
            }
        } else {
            warnings.push(
                "No token: public data only and 60 requests an hour. Add a token for private \
                 repositories or large imports."
                    .to_owned(),
            );
        }

        let open = self.search_count("open").await?;
        let closed = self.search_count("closed").await?;
        if open.is_none() || closed.is_none() {
            warnings.push("Issue counts are unavailable right now (search rate limit).".to_owned());
        }

        let labels = self
            .all(&format!("/repos/{}/labels", self.repository), MAX_LIST_PAGES)
            .await?
            .iter()
            .map(|l| DiscoveredEntity {
                id: js_string(l.get("id")),
                name: js_string(l.get("name")),
                key: None,
                color: non_empty(l.get("color")).map(|c| format!("#{}", c.to_lowercase())),
                count: None,
            })
            .collect();
        let milestones = self
            .all(&format!("/repos/{}/milestones?state=all", self.repository), 3)
            .await?
            .iter()
            .map(|m| self.milestone_of(m))
            .collect();
        let users = match self.all(&format!("/repos/{}/assignees", self.repository), 3).await {
            Ok(list) => list.iter().filter_map(|u| github_user(Some(u))).collect(),
            Err(SourceError::Provider(e)) if e.rate_limited() => {
                return Err(SourceError::Provider(e));
            }
            Err(_) => {
                warnings.push(
                    "Assignable users could not be listed; assignees stay unmapped unless you \
                     add them."
                        .to_owned(),
                );
                Vec::new()
            }
        };
        let sample = self
            .issues(None, &DEFAULT_IMPORT_OPTIONS)
            .await?
            .items
            .into_iter()
            .take(5)
            .map(|i| SampleIssue { key: i.key, title: i.title, state: i.state.name })
            .collect();
        let entity = DiscoveredEntity {
            id: self.pseudo_id(),
            name: full_name.clone(),
            ..DiscoveredEntity::default()
        };
        let status = |id: &str, name: &str, count: Option<i64>| DiscoveredState {
            state: ExternalState { id: id.to_owned(), name: name.to_owned(), kind: id.to_owned() },
            count,
        };
        Ok(Discovery {
            provider: ExternalProvider::Github,
            account,
            source_label: full_name,
            source_url: non_empty(repo.get("html_url")),
            counts: DiscoveryCounts { issues: open.zip(closed).map(|(o, c)| o + c), open, closed },
            teams: vec![entity.clone()],
            projects: vec![entity],
            labels,
            milestones,
            users,
            statuses: vec![
                status("open", "Open", open),
                status("closed", "Closed (completed)", None),
                status("not_planned", "Closed (not planned)", None),
            ],
            sample,
            warnings,
        })
    }

    async fn issues(
        &self,
        cursor: Option<&str>,
        options: &ImportOptions,
    ) -> Result<Page<ExternalIssue>, SourceError> {
        let page = page_of(cursor);
        let state = if options.include_closed { "all" } else { "open" };
        // Oldest first: the order does not move while new issues arrive, so a resumed page is
        // the same page.
        let res = self
            .get(&format!(
                "/repos/{}/issues?state={state}&sort=created&direction=asc&per_page={PER_PAGE}&page={}",
                self.repository,
                js_number_string(page)
            ))
            .await?;
        let items = list_of(&res)
            .iter()
            .filter(|i| !i.get("pull_request").is_some_and(trama_contracts::js::truthy))
            .map(|i| self.to_issue(i))
            .collect();
        Ok(Page { items, next: has_next(&res).then(|| js_number_string(page + 1.0)) })
    }

    async fn comments(&self, cursor: Option<&str>) -> Result<Page<ExternalComment>, SourceError> {
        let page = page_of(cursor);
        let res = self
            .get(&format!(
                "/repos/{}/issues/comments?sort=created&direction=asc&per_page={PER_PAGE}&page={}",
                self.repository,
                js_number_string(page)
            ))
            .await?;
        let mut items = Vec::new();
        for c in list_of(&res) {
            let Some(number) = non_empty(c.get("issue_url")).and_then(|url| issue_number(&url))
            else {
                continue;
            };
            let Some(body) = non_empty(c.get("body")) else { continue };
            items.push(ExternalComment {
                id: js_string(c.get("id")),
                issue_id: github_issue_id(&self.repository, number),
                author: github_user(c.get("user")),
                body,
                created_at: js_string(c.get("created_at")),
            });
        }
        Ok(Page { items, next: has_next(&res).then(|| js_number_string(page + 1.0)) })
    }

    async fn get_issue(&self, id: &str) -> Result<ExternalIssue, SourceError> {
        let number = id
            .rsplit_once('#')
            .map(|(_, n)| n)
            .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            .ok_or_else(|| {
                SourceError::Provider(ProviderHttpError::new(
                    400,
                    format!("Not a GitHub issue id: {id}"),
                ))
            })?;
        let res = self.get(&format!("/repos/{}/issues/{number}", self.repository)).await?;
        Ok(self.to_issue(&res.json))
    }
}

/// `/\/issues\/(\d+)$/.exec(issue_url)`.
fn issue_number(url: &str) -> Option<u64> {
    let (head, number) = url.rsplit_once('/')?;
    if !head.ends_with("/issues")
        || number.is_empty()
        || !number.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    number.parse().ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use trama_contracts::issues::IssueKind;

    use super::*;
    use crate::adapter::testing::{FakeHttp, reply, reply_with};
    use trama_contracts::common::Priority;

    const TOKEN: &str = "ghp_secretsecretsecretsecretsecretsecret1";

    fn options(include_closed: bool) -> ImportOptions {
        ImportOptions { include_comments: false, include_closed, default_kind: IssueKind::Feature }
    }

    fn gh_issue(n: u64, extra: &Value) -> Value {
        let mut issue = json!({
            "number": n,
            "id": 1000 + n,
            "html_url": format!("https://github.com/acme/api/issues/{n}"),
            "title": format!("Issue {n}"),
            "body": "body",
            "state": "open",
            "labels": [{ "id": 1, "name": "bug", "color": "E11D48" }],
            "assignee": { "login": "Ada" },
            "user": { "login": "carl" },
            "milestone": { "id": 77, "title": "v1", "due_on": "2026-12-01T00:00:00Z" },
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T00:00:00Z",
        });
        if let (Some(base), Some(extra)) = (issue.as_object_mut(), extra.as_object()) {
            base.extend(extra.clone());
        }
        issue
    }

    fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
        req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    #[tokio::test]
    async fn lists_issues_oldest_first_drops_pull_requests_and_follows_the_link_header() {
        let (http, calls) = FakeHttp::new(|req| {
            req.url.contains("/issues?").then(|| {
                reply_with(
                    200,
                    json!([
                        gh_issue(1, &json!({})),
                        gh_issue(2, &json!({ "pull_request": { "url": "x" } })),
                        gh_issue(
                            3,
                            &json!({ "state": "closed", "state_reason": "not_planned",
                                "closed_at": "2026-02-01T00:00:00Z" })
                        ),
                    ]),
                    &[("link", "<https://api.github.com/x?page=2>; rel=\"next\"")],
                )
            })
        });
        let page = GithubAdapter::new(http, Some(TOKEN.into()), "Acme/api".into(), None)
            .issues(None, &options(true))
            .await
            .unwrap();
        let keys: Vec<_> = page.items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, ["#1", "#3"]);
        assert_eq!(page.next.as_deref(), Some("2"));
        let calls = calls.lock().unwrap();
        assert!(
            calls[0].url.contains("/repos/Acme/api/issues?state=all&sort=created&direction=asc"),
            "{}",
            calls[0].url
        );
        assert!(calls[0].url.starts_with("https://api.github.com/"));
        assert_eq!(header(&calls[0], "Authorization"), Some(format!("Bearer {TOKEN}").as_str()));
        assert_eq!(header(&calls[0], "Accept"), Some("application/vnd.github+json"));
        assert_eq!(header(&calls[0], "X-GitHub-Api-Version"), Some("2022-11-28"));
        assert_eq!(header(&calls[0], "User-Agent"), Some("trama-importer"));

        let first = &page.items[0];
        assert_eq!(first.id, "acme/api#1");
        assert_eq!(first.state.id, "open");
        assert_eq!(
            first.assignee,
            Some(ExternalUser {
                id: "ada".into(),
                login: Some("Ada".into()),
                name: None,
                email: None
            })
        );
        let milestone = first.milestone.as_ref().unwrap();
        assert_eq!((milestone.id.as_str(), milestone.name.as_str()), ("77", "v1"));
        assert_eq!(milestone.project_id.as_deref(), Some("repo:acme/api"));
        assert_eq!(milestone.due_on.as_deref(), Some("2026-12-01T00:00:00Z"));
        assert_eq!(
            first.labels,
            [ExternalLabel { id: "1".into(), name: "bug".into(), color: Some("#e11d48".into()) }]
        );
        assert_eq!(first.creator.as_ref().unwrap().id, "carl");
        assert_eq!(first.team_id.as_deref(), Some("repo:acme/api"));
        assert_eq!(page.items[1].state.id, "not_planned");
        assert_eq!(page.items[1].state.kind, "not_planned");
        assert_eq!(page.items[1].closed_at.as_deref(), Some("2026-02-01T00:00:00Z"));
    }

    #[tokio::test]
    async fn only_asks_for_open_issues_when_closed_ones_are_excluded_and_ends_without_a_next_link()
    {
        let (http, calls) = FakeHttp::new(|_| Some(reply(json!([]))));
        let page = GithubAdapter::new(http, None, "acme/api".into(), None)
            .issues(Some("4"), &options(false))
            .await
            .unwrap();
        assert_eq!(page.next, None);
        let calls = calls.lock().unwrap();
        assert!(calls[0].url.contains("state=open"));
        assert!(calls[0].url.contains("per_page=100&page=4"));
        // public repositories are read without a token
        assert_eq!(header(&calls[0], "Authorization"), None);
    }

    #[tokio::test]
    async fn an_unreadable_cursor_starts_at_the_first_page() {
        for cursor in ["abc", "0", "-3", ""] {
            let (http, calls) = FakeHttp::new(|_| Some(reply(json!([]))));
            GithubAdapter::new(http, None, "acme/api".into(), None)
                .issues(Some(cursor), &options(true))
                .await
                .unwrap();
            assert!(calls.lock().unwrap()[0].url.ends_with("&page=1"), "{cursor}");
        }
    }

    #[tokio::test]
    async fn reads_priority_from_labels_and_the_first_assignee_when_assignee_is_null() {
        let issue = gh_issue(
            5,
            &json!({
                "labels": [{ "id": 2, "name": "priority: high", "color": null }, "oops"],
                "assignee": null,
                "assignees": [{ "login": "Bo" }],
                "milestone": null,
                "body": "",
            }),
        );
        let (http, _) = FakeHttp::new(move |_| Some(reply(json!([issue.clone()]))));
        let page = GithubAdapter::new(http, None, "acme/api".into(), None)
            .issues(None, &options(true))
            .await
            .unwrap();
        let item = &page.items[0];
        assert_eq!(item.priority, Some(Priority::High));
        assert_eq!(item.assignee.as_ref().unwrap().id, "bo");
        assert_eq!(item.labels.len(), 1);
        assert_eq!(item.labels[0].color, None);
        assert_eq!(item.milestone, None);
        assert_eq!(item.body, None);
    }

    #[tokio::test]
    async fn turns_repo_wide_comments_into_per_issue_comments() {
        let (http, calls) = FakeHttp::new(|_| {
            Some(reply(json!([
                { "id": 5, "issue_url": "https://api.github.com/repos/acme/api/issues/12",
                  "body": "hello", "user": { "login": "Dee" }, "created_at": "2026-01-03T00:00:00Z" },
                { "id": 6, "issue_url": "https://api.github.com/repos/acme/api/issues/12",
                  "body": "", "user": { "login": "Dee" }, "created_at": "2026-01-04T00:00:00Z" },
                { "id": 7, "issue_url": "https://api.github.com/repos/acme/api/pulls/12",
                  "body": "not an issue", "created_at": "2026-01-05T00:00:00Z" },
            ])))
        });
        let page =
            GithubAdapter::new(http, None, "acme/api".into(), None).comments(None).await.unwrap();
        assert_eq!(
            page.items,
            [ExternalComment {
                id: "5".into(),
                issue_id: "acme/api#12".into(),
                author: Some(ExternalUser {
                    id: "dee".into(),
                    login: Some("Dee".into()),
                    name: None,
                    email: None
                }),
                body: "hello".into(),
                created_at: "2026-01-03T00:00:00Z".into(),
            }]
        );
        assert_eq!(
            calls.lock().unwrap()[0].url,
            "https://api.github.com/repos/acme/api/issues/comments?sort=created&direction=asc&per_page=100&page=1"
        );
    }

    #[tokio::test]
    async fn reports_a_rate_limit_with_the_time_it_ends_and_stops_calling_until_then() {
        let reset = Utc::now().timestamp() + 120;
        let (http, calls) = FakeHttp::new(move |_| {
            Some(reply_with(
                403,
                json!({ "message": "API rate limit exceeded" }),
                &[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", &reset.to_string())],
            ))
        });
        let adapter = GithubAdapter::new(http, Some(TOKEN.into()), "acme/api".into(), None);
        let err = adapter.issues(None, &options(true)).await.unwrap_err();
        let SourceError::Provider(err) = &err else { panic!("{err:?}") };
        assert!(err.rate_limited());
        assert_eq!(err.rate_limited_until.unwrap().timestamp_millis(), reset * 1000);
        // the budget is known to be spent: no second request is sent
        let again = adapter.issues(None, &options(true)).await.unwrap_err();
        assert_eq!(again.rate_limited_until().unwrap().timestamp_millis(), reset * 1000);
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn calls_again_once_the_reset_time_has_passed() {
        let (http, calls) = FakeHttp::new(|_| {
            Some(reply_with(
                403,
                json!({ "message": "API rate limit exceeded" }),
                &[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "100")],
            ))
        });
        let clock = Arc::new(AtomicI64::new(50_000));
        let tick = Arc::clone(&clock);
        let adapter = GithubAdapter::new(http, None, "acme/api".into(), None)
            .with_clock(move || tick.load(Ordering::Relaxed));
        adapter.issues(None, &options(true)).await.unwrap_err();
        adapter.issues(None, &options(true)).await.unwrap_err();
        assert_eq!(calls.lock().unwrap().len(), 1);
        clock.store(100_000, Ordering::Relaxed);
        adapter.issues(None, &options(true)).await.unwrap_err();
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn never_puts_the_token_in_an_error_message() {
        let (http, _) = FakeHttp::new(|_| {
            Some(reply_with(401, json!({ "message": format!("Bad credentials {TOKEN}") }), &[]))
        });
        let err = GithubAdapter::new(http, Some(TOKEN.into()), "acme/api".into(), None)
            .issues(None, &options(true))
            .await
            .unwrap_err();
        assert!(!err.to_string().contains(TOKEN));
        let SourceError::Provider(err) = err else { panic!() };
        assert_eq!(err.status, 401);
    }

    #[tokio::test]
    async fn reads_one_issue_by_id_and_describes_the_source_in_discover() {
        let (http, calls) = FakeHttp::new(|req| {
            let url = &req.url;
            if url.ends_with("/repos/acme/api") {
                return Some(reply(json!({
                    "full_name": "acme/api", "html_url": "https://github.com/acme/api",
                    "has_issues": true
                })));
            }
            if url.ends_with("/user") {
                return Some(reply(json!({ "login": "ada" })));
            }
            if url.contains("/search/issues") {
                let total = if url.contains("state%3Aopen") { 7 } else { 3 };
                return Some(reply(json!({ "total_count": total })));
            }
            if url.contains("/labels") {
                return Some(reply(json!([{ "id": 9, "name": "bug", "color": "ff0000" }])));
            }
            if url.contains("/milestones") {
                return Some(reply(json!([{ "id": 77, "title": "v1", "due_on": null }])));
            }
            if url.contains("/assignees") {
                return Some(reply(json!([{ "login": "Ada" }])));
            }
            if url.contains("/issues?") {
                return Some(reply(json!([gh_issue(1, &json!({}))])));
            }
            if url.ends_with("/issues/12") {
                return Some(reply(gh_issue(12, &json!({}))));
            }
            None
        });
        let adapter = GithubAdapter::new(http, Some(TOKEN.into()), "acme/api".into(), None);
        let d = adapter.discover().await.unwrap();
        assert_eq!(d.account, "ada");
        assert_eq!(d.source_label, "acme/api");
        assert_eq!(d.source_url.as_deref(), Some("https://github.com/acme/api"));
        assert_eq!(d.counts, DiscoveryCounts { issues: Some(10), open: Some(7), closed: Some(3) });
        assert_eq!(
            d.labels,
            [DiscoveredEntity {
                id: "9".into(),
                name: "bug".into(),
                key: None,
                color: Some("#ff0000".into()),
                count: None
            }]
        );
        assert_eq!(
            d.users,
            [ExternalUser { id: "ada".into(), login: Some("Ada".into()), name: None, email: None }]
        );
        assert_eq!(d.milestones[0].id, "77");
        assert_eq!(d.milestones[0].project_id.as_deref(), Some("repo:acme/api"));
        assert_eq!(d.milestones[0].due_on, None);
        let ids: Vec<_> = d.statuses.iter().map(|s| s.state.id.as_str()).collect();
        assert_eq!(ids, ["open", "closed", "not_planned"]);
        assert_eq!(d.statuses[0].count, Some(7));
        assert_eq!(d.statuses[1].state.name, "Closed (completed)");
        assert_eq!(d.teams, d.projects);
        assert_eq!(d.teams[0].id, "repo:acme/api");
        assert_eq!(
            d.sample,
            [SampleIssue { key: "#1".into(), title: "Issue 1".into(), state: "Open".into() }]
        );
        assert!(d.warnings.is_empty(), "{:?}", d.warnings);
        assert_eq!(adapter.get_issue("acme/api#12").await.unwrap().key, "#12");

        let urls: Vec<String> = calls.lock().unwrap().iter().map(|c| c.url.clone()).collect();
        assert!(urls.contains(
            &"https://api.github.com/repos/acme/api/labels?per_page=100&page=1".to_owned()
        ));
        assert!(
            urls.contains(
                &"https://api.github.com/repos/acme/api/milestones?state=all&per_page=100&page=1"
                    .to_owned()
            )
        );
        assert!(urls.contains(&"https://api.github.com/search/issues?q=repo%3Aacme%2Fapi%20type%3Aissue%20state%3Aclosed&per_page=1".to_owned()));
    }

    #[tokio::test]
    async fn discover_without_a_token_warns_and_survives_a_spent_search_budget() {
        let (http, _) = FakeHttp::new(|req| {
            let url = &req.url;
            if url.contains("/search/issues") {
                return Some(reply_with(
                    403,
                    json!({ "message": "rate limit" }),
                    &[("x-ratelimit-remaining", "0"), ("retry-after", "30")],
                ));
            }
            if url.ends_with("/repos/acme/api") {
                return Some(reply(json!({ "has_issues": false })));
            }
            if url.contains("/assignees") {
                return Some(reply_with(404, json!({ "message": "Not Found" }), &[]));
            }
            if url.contains("/issues?") || url.contains("/labels") || url.contains("/milestones") {
                return Some(reply(json!([])));
            }
            None
        });
        let d = GithubAdapter::new(http, None, "acme/api".into(), None).discover().await;
        // the search 403 sets no reset header, so only the next call would wait; reading goes on
        let d = d.unwrap();
        assert_eq!(d.account, "anonymous");
        assert_eq!(d.source_label, "acme/api");
        assert_eq!(d.counts, DiscoveryCounts { issues: None, open: None, closed: None });
        assert_eq!(d.warnings.len(), 4, "{:?}", d.warnings);
        assert_eq!(d.warnings[0], "Issues are disabled on this repository.");
        assert!(d.warnings[1].starts_with("No token: public data only"));
        assert_eq!(d.warnings[2], "Issue counts are unavailable right now (search rate limit).");
        assert!(d.warnings[3].starts_with("Assignable users could not be listed"));
    }

    #[tokio::test]
    async fn discover_fails_when_the_repository_is_not_readable() {
        let (http, _) =
            FakeHttp::new(|_| Some(reply_with(404, json!({ "message": "Not Found" }), &[])));
        let err =
            GithubAdapter::new(http, None, "acme/nope".into(), None).discover().await.unwrap_err();
        let SourceError::Provider(err) = err else { panic!() };
        assert_eq!((err.status, err.message.as_str()), (404, "404: Not Found"));
    }

    #[tokio::test]
    async fn rejects_an_id_that_is_not_a_github_issue() {
        let (http, calls) = FakeHttp::new(|_| None);
        let err = GithubAdapter::new(http, None, "acme/api".into(), None)
            .get_issue("ENG-1")
            .await
            .unwrap_err();
        let SourceError::Provider(err) = err else { panic!() };
        assert_eq!((err.status, err.message.as_str()), (400, "Not a GitHub issue id: ENG-1"));
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn uses_the_enterprise_api_root_for_self_hosted_hosts() {
        assert_eq!(github_api_base(None), "https://api.github.com");
        assert_eq!(github_api_base(Some("https://github.com")), "https://api.github.com");
        assert_eq!(github_api_base(Some("http://www.github.com")), "https://api.github.com");
        assert_eq!(
            github_api_base(Some("https://ghe.example.com")),
            "https://ghe.example.com/api/v3"
        );
        assert_eq!(
            github_api_base(Some("https://ghe.example.com/api/v3")),
            "https://ghe.example.com/api/v3"
        );
        assert_eq!(
            github_api_base(Some("https://example.com/github")),
            "https://example.com/github/api/v3"
        );
    }

    #[tokio::test]
    async fn requests_go_to_the_enterprise_root() {
        let (http, calls) = FakeHttp::new(|_| Some(reply(json!([]))));
        GithubAdapter::new(
            http,
            Some(TOKEN.into()),
            "acme/api".into(),
            Some("https://ghe.example.com".into()),
        )
        .issues(None, &options(true))
        .await
        .unwrap();
        assert!(calls.lock().unwrap()[0].url.starts_with("https://ghe.example.com/api/v3/repos/"));
    }
}
