//! Two-way sync from a recorded `issue.status_changed` event to the provider request and the
//! persisted result (`server/test/routing-rules.e2e-spec.ts`, "two-way sync"). The provider is a
//! fake behind `Http::new`; nothing leaves the process.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::http::Method;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
use sea_orm_migration::MigratorTrait;
use serde_json::{Value, json};
use trama_common::Secrets;
use trama_contracts::common::{ActorRef, GitProvider, SubjectRef, SubjectType};
use trama_contracts::issues::IssueKind;
use trama_contracts::roles::fresh_workspace_roles;
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::{
    integration_connections, memberships, projects, routing_rule_items, routing_rules, users,
    workspaces,
};
use trama_events::{Events, RecordEvent};
use trama_integrations::candidates::IssueCandidateState;
use trama_integrations::http::{Http, HttpClient, HttpFailure, HttpRequest, HttpResponse};
use trama_integrations::{IssueCandidate, RepoMeta};
use trama_issues::service::{IssueInput, NewIssue};
use trama_migration::Migrator;
use trama_routing::inbound::{self, RoutedIssueStatus};
use trama_routing::outbound::{self, Outbound, Outcome};

const WS: &str = "ws_out";
const USER: &str = "u_out";
const PROJECT: &str = "pj_out";
const CONNECTION: &str = "ic_out";
const RULE: &str = "rr_out";

/// What the fake provider answers.
#[derive(Clone, Debug)]
enum Reply {
    Ok,
    Status(u16, Value),
    Offline(&'static str),
}

/// The fake GitHub / GitLab / Bitbucket: records every request and answers as told.
#[derive(Clone)]
struct Provider {
    seen: Arc<Mutex<Vec<HttpRequest>>>,
    reply: Arc<Mutex<Reply>>,
    /// Delays the answer to the first request, so a second change has to wait behind it.
    slow_first: Arc<Mutex<bool>>,
}

#[async_trait]
impl HttpClient for Provider {
    async fn request(&self, req: HttpRequest) -> Result<HttpResponse, HttpFailure> {
        self.seen.lock().unwrap().push(req);
        let slow = std::mem::take(&mut *self.slow_first.lock().unwrap());
        if slow {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let reply = self.reply.lock().unwrap().clone();
        match reply {
            Reply::Ok => {
                Ok(HttpResponse { status: 200, headers: BTreeMap::new(), json: json!({}) })
            }
            Reply::Status(status, json) => {
                Ok(HttpResponse { status, headers: BTreeMap::new(), json })
            }
            Reply::Offline(message) => Err(HttpFailure(message.to_owned())),
        }
    }
}

struct World {
    test: TestDb,
    state: AppState,
    provider: Provider,
    outbound: Outbound,
    listener: tokio::task::JoinHandle<()>,
    /// Key of the task the rule created.
    key: String,
    repo: RepoMeta,
    git: GitProvider,
    /// `lastSyncAt` of the rule once the task exists (routing it is a sync too).
    synced_at: Option<chrono::DateTime<chrono::FixedOffset>>,
}

fn candidate(git: GitProvider, state: IssueCandidateState) -> IssueCandidate {
    IssueCandidate {
        provider: git,
        external_id: "#7".to_owned(),
        number: 7,
        title: "Two-way issue".to_owned(),
        body: None,
        url: Some("https://example.test/acme/web/issues/7".to_owned()),
        state,
        state_reason: None,
        labels: Vec::new(),
        milestone: None,
        author: None,
    }
}

/// A workspace with one project, one connection of `git`, one rule (`direction`) and the task
/// the rule created from `acme/web#7`, with the listener running.
#[allow(clippy::too_many_lines)]
async fn world(git: GitProvider, direction: &str) -> Option<World> {
    let test = TestDb::create().await?;
    Migrator::up(&test.db, None).await.unwrap();
    let db = &test.db;
    let now = chrono::Utc::now().fixed_offset();
    users::ActiveModel {
        id: Set(USER.to_owned()),
        name: Set("Olivia".to_owned()),
        email: Set("olivia@test.invalid".to_owned()),
        password_hash: Set("unused".to_owned()),
        avatar_hue: Set(1),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    workspaces::ActiveModel {
        id: Set(WS.to_owned()),
        name: Set("Out".to_owned()),
        slug: Set("out".to_owned()),
        settings: Set(json!({ "roles": fresh_workspace_roles() })),
        primary_owner_id: Set(Some(USER.to_owned())),
        personal: Set(false),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    memberships::ActiveModel {
        id: Set("mb_out".to_owned()),
        workspace_id: Set(WS.to_owned()),
        user_id: Set(USER.to_owned()),
        role: Set("owner".to_owned()),
        access: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    projects::ActiveModel {
        id: Set(PROJECT.to_owned()),
        workspace_id: Set(WS.to_owned()),
        name: Set("Web".to_owned()),
        color: Set("#ffffff".to_owned()),
        status: Set("active".to_owned()),
        priority: Set("none".to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
        labels: Set(json!([])),
        key: Set("WEB".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();

    let provider = Provider {
        seen: Arc::default(),
        reply: Arc::new(Mutex::new(Reply::Ok)),
        slow_first: Arc::default(),
    };
    let state = AppState::new(db.clone(), Config::from_vars(&[]))
        .with_extension(Events::local())
        .with_extension(Http::new(provider.clone()));
    let secret = Secrets::of(&state).unwrap().encrypt("tok_acme", &format!("{CONNECTION}:secret"));
    integration_connections::ActiveModel {
        id: Set(CONNECTION.to_owned()),
        workspace_id: Set(Some(WS.to_owned())),
        owner_type: Set("workspace".to_owned()),
        provider: Set(git.as_str().to_owned()),
        account: Set("acme".to_owned()),
        host: Set(git.meta().host.to_owned()),
        label: Set(format!("{} · Acme", git.meta().label)),
        status: Set("connected".to_owned()),
        secret: Set(Some(secret)),
        config: Set(json!({})),
        created_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    routing_rules::ActiveModel {
        id: Set(RULE.to_owned()),
        workspace_id: Set(WS.to_owned()),
        project_id: Set(PROJECT.to_owned()),
        connection_id: Set(Some(CONNECTION.to_owned())),
        provider: Set(git.as_str().to_owned()),
        host: Set(git.meta().host.to_owned()),
        source_path: Set("acme/web".to_owned()),
        filters: Set(json!({})),
        filter_key: Set(String::new()),
        direction: Set(direction.to_owned()),
        created_by: Set(serde_json::to_value(ActorRef::user(USER)).unwrap()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();

    let repo = RepoMeta {
        full_name: "acme/web".to_owned(),
        url: None,
        default_branch: Some("main".to_owned()),
    };
    let key = if git == GitProvider::Bitbucket {
        // Bitbucket has no issue webhooks: the item is placed by hand
        let task = trama_issues::service::create(
            &state,
            WS,
            &ActorRef::system(),
            NewIssue::new(IssueKind::Feature, "Two-way issue"),
        )
        .await
        .unwrap();
        routing_rule_items::ActiveModel {
            id: Set("ri_out".to_owned()),
            workspace_id: Set(WS.to_owned()),
            rule_id: Set(Some(RULE.to_owned())),
            provider: Set("bitbucket".to_owned()),
            host: Set("bitbucket.org".to_owned()),
            repository: Set("acme/web".to_owned()),
            kind: Set("issue".to_owned()),
            external_id: Set("#7".to_owned()),
            issue_id: Set(Some(task.id)),
            external_state: Set(Some("open".to_owned())),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        task.key
    } else {
        let routed = inbound::route_issue(
            &state,
            CONNECTION,
            git,
            &repo,
            &candidate(git, IssueCandidateState::Open),
        )
        .await
        .unwrap();
        assert_eq!(routed.status, RoutedIssueStatus::Created);
        routed.key.unwrap()
    };

    let outbound = Outbound::new();
    let listener = outbound.spawn(&state);
    let synced_at =
        routing_rules::Entity::find_by_id(RULE).one(&test.db).await.unwrap().unwrap().last_sync_at;
    Some(World { test, state, provider, outbound, listener, key, repo, git, synced_at })
}

impl World {
    fn db(&self) -> &sea_orm::DatabaseConnection {
        &self.test.db
    }

    fn requests(&self) -> Vec<HttpRequest> {
        self.provider.seen.lock().unwrap().clone()
    }

    fn reply(&self, reply: Reply) {
        *self.provider.reply.lock().unwrap() = reply;
    }

    /// Waits until the listener took everything recorded so far and sent what it queued.
    async fn settle(&self) {
        let sentinel = Events::of(&self.state)
            .record(
                self.db(),
                RecordEvent::new(
                    WS,
                    ActorRef::system(),
                    "project.updated",
                    SubjectRef { kind: SubjectType::Project, id: PROJECT.to_owned() },
                )
                .without_live(),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            self.outbound.caught_up(&sentinel.id).await;
            self.outbound.idle().await;
        })
        .await
        .expect("the listener settles");
    }

    /// A person moves the task to `status`; returns once the listener is done with the change.
    async fn move_to(&self, status: &str) {
        self.update(&ActorRef::user(USER), status).await;
        self.settle().await;
    }

    async fn update(&self, actor: &ActorRef, status: &str) {
        trama_issues::service::update(
            &self.state,
            WS,
            actor,
            &self.key,
            IssueInput { status: Some(status.to_owned()), ..Default::default() },
        )
        .await
        .unwrap();
    }

    async fn item(&self) -> routing_rule_items::Model {
        routing_rule_items::Entity::find()
            .filter(routing_rule_items::Column::WorkspaceId.eq(WS))
            .one(self.db())
            .await
            .unwrap()
            .unwrap()
    }

    async fn rule(&self) -> routing_rules::Model {
        routing_rules::Entity::find_by_id(RULE).one(self.db()).await.unwrap().unwrap()
    }

    /// The latest recorded `issue.status_changed` that moved a task to `to`.
    async fn status_event(&self, to: &str) -> trama_entities::domain_events::Model {
        let mut events = trama_entities::domain_events::Entity::find()
            .filter(trama_entities::domain_events::Column::Type.eq("issue.status_changed"))
            .all(self.db())
            .await
            .unwrap();
        events.retain(|event| event.data["to"] == to);
        events.sort_by_key(|event| event.at);
        events.pop().expect("a status change to that status was recorded")
    }

    async fn drop(self) {
        self.listener.abort();
        self.test.drop().await;
    }
}

fn header(req: &HttpRequest, name: &str) -> Option<String> {
    req.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
}

#[tokio::test]
async fn closes_and_reopens_the_external_issue_and_records_a_healthy_rule() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };

    w.move_to("done").await;
    let sent = w.requests();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].method, Method::PATCH);
    assert_eq!(sent[0].url, "https://api.github.com/repos/acme/web/issues/7");
    assert_eq!(sent[0].body, Some(json!({ "state": "closed", "state_reason": "completed" })));
    assert_eq!(header(&sent[0], "Authorization").as_deref(), Some("Bearer tok_acme"));
    assert_eq!(w.item().await.external_state.as_deref(), Some("closed"));
    let rule = w.rule().await;
    assert!(rule.last_sync_at > w.synced_at);
    assert_eq!(rule.last_error, None);

    // moving between two closed statuses writes nothing
    w.move_to("canceled").await;
    assert_eq!(w.requests().len(), 1);
    assert_eq!(w.item().await.external_state.as_deref(), Some("closed"));

    w.move_to("todo").await;
    let sent = w.requests();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1].body, Some(json!({ "state": "open", "state_reason": "reopened" })));
    assert_eq!(w.item().await.external_state.as_deref(), Some("open"));
    w.drop().await;
}

#[tokio::test]
async fn closes_as_not_planned_when_the_task_is_canceled() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    w.move_to("canceled").await;
    assert_eq!(
        w.requests()[0].body,
        Some(json!({ "state": "closed", "state_reason": "not_planned" }))
    );
    w.drop().await;
}

#[tokio::test]
async fn a_transition_that_does_not_change_open_or_closed_is_not_sent() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    w.move_to("todo").await;
    w.move_to("in_progress").await;
    w.move_to("in_review").await;
    assert!(w.requests().is_empty());
    let event = w.status_event("in_review").await;
    let outcome = outbound::apply(&w.state, &event).await.unwrap();
    assert_eq!(outcome, Outcome::Skipped("open or closed did not change"));
    let rule = w.rule().await;
    assert_eq!(rule.last_sync_at, w.synced_at);
    assert_eq!(rule.last_error, None);
    w.drop().await;
}

#[tokio::test]
async fn the_host_already_being_there_is_not_written_again() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    // the host says it is closed: a person reopens and closes again on our side
    routing_rule_items::Entity::update_many()
        .col_expr(
            routing_rule_items::Column::ExternalState,
            sea_orm::sea_query::Expr::value("closed"),
        )
        .exec(w.db())
        .await
        .unwrap();
    w.move_to("done").await;
    assert!(w.requests().is_empty());
    let event = w.status_event("done").await;
    assert_eq!(
        outbound::apply(&w.state, &event).await.unwrap(),
        Outcome::Skipped("the issue is already there")
    );
    w.drop().await;
}

#[tokio::test]
async fn an_inbound_only_rule_is_never_written_back() {
    let Some(w) = world(GitProvider::Github, "inbound").await else { return };
    w.move_to("done").await;
    assert!(w.requests().is_empty());
    let event = w.status_event("done").await;
    assert_eq!(
        outbound::apply(&w.state, &event).await.unwrap(),
        Outcome::Skipped("the rule is inbound only")
    );
    assert_eq!(w.item().await.external_state.as_deref(), Some("open"));
    assert_eq!(w.rule().await.last_sync_at, w.synced_at);
    w.drop().await;
}

#[tokio::test]
async fn a_task_no_rule_created_is_ignored() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    let loose = trama_issues::service::create(
        &w.state,
        WS,
        &ActorRef::user(USER),
        NewIssue::new(IssueKind::Feature, "Made by hand"),
    )
    .await
    .unwrap();
    trama_issues::service::update(
        &w.state,
        WS,
        &ActorRef::user(USER),
        &loose.key,
        IssueInput { status: Some("done".to_owned()), ..Default::default() },
    )
    .await
    .unwrap();
    w.settle().await;
    assert!(w.requests().is_empty());
    let event = w.status_event("done").await;
    assert_eq!(
        outbound::apply(&w.state, &event).await.unwrap(),
        Outcome::Skipped("not routed by a rule")
    );
    w.drop().await;
}

#[tokio::test]
async fn what_the_host_itself_closed_never_echoes_back() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    // the webhook says the issue was closed: the task follows, recorded as the system
    let followed = inbound::route_issue(
        &w.state,
        CONNECTION,
        w.git,
        &w.repo,
        &candidate(w.git, IssueCandidateState::Closed),
    )
    .await
    .unwrap();
    assert_eq!(followed.status, RoutedIssueStatus::Updated);
    w.settle().await;
    assert!(w.requests().is_empty(), "no echo of a change that came from the provider");
    let event = w.status_event("done").await;
    assert_eq!(event.actor["type"], "system");
    assert_eq!(w.item().await.external_state.as_deref(), Some("closed"));

    // a person reopening it afterwards does reach the host
    w.move_to("todo").await;
    let sent = w.requests();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].body, Some(json!({ "state": "open", "state_reason": "reopened" })));
    w.drop().await;
}

#[tokio::test]
async fn an_agent_closing_a_task_is_synced_like_a_person() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    w.update(&ActorRef::agent("ag_out"), "done").await;
    w.settle().await;
    assert_eq!(w.requests().len(), 1);
    w.drop().await;
}

#[tokio::test]
async fn a_provider_error_is_recorded_on_the_rule_and_cleared_by_the_next_good_write() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    w.reply(Reply::Status(500, json!({ "message": "provider unavailable" })));
    w.move_to("done").await;
    assert_eq!(w.requests().len(), 1);
    let rule = w.rule().await;
    assert_eq!(
        rule.last_error.as_deref(),
        Some(
            "Could not close acme/web#7: GitHub · Acme refused the change (500: provider unavailable)"
        )
    );
    assert_eq!(rule.last_sync_at, w.synced_at);
    // the host still has it open
    assert_eq!(w.item().await.external_state.as_deref(), Some("open"));

    w.reply(Reply::Ok);
    w.move_to("todo").await; // the host is open already: nothing to write
    assert_eq!(w.requests().len(), 1);
    assert!(w.rule().await.last_error.is_some());
    w.move_to("done").await;
    assert_eq!(w.requests().len(), 2);
    let rule = w.rule().await;
    assert_eq!(rule.last_error, None);
    assert!(rule.last_sync_at > w.synced_at);
    assert_eq!(w.item().await.external_state.as_deref(), Some("closed"));
    w.drop().await;
}

#[tokio::test]
async fn an_unreachable_provider_is_recorded_with_its_own_message() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    w.reply(Reply::Offline("connect ECONNREFUSED"));
    w.move_to("done").await;
    assert_eq!(
        w.rule().await.last_error.as_deref(),
        Some("Could not close acme/web#7: connect ECONNREFUSED")
    );
    w.reply(Reply::Status(403, json!({ "message": "Resource not accessible" })));
    w.move_to("todo").await;
    w.move_to("done").await;
    let event = w.status_event("done").await;
    let outcome = outbound::apply(&w.state, &event).await.unwrap();
    assert!(matches!(&outcome, Outcome::Failed(reason)
        if reason == "GitHub · Acme refused the change (403: Resource not accessible)"));
    w.drop().await;
}

#[tokio::test]
async fn a_connection_that_is_not_working_fails_the_rule_without_a_request() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    integration_connections::Entity::update_many()
        .col_expr(
            integration_connections::Column::Status,
            sea_orm::sea_query::Expr::value("revoked"),
        )
        .exec(w.db())
        .await
        .unwrap();
    w.move_to("done").await;
    assert!(w.requests().is_empty());
    assert_eq!(
        w.rule().await.last_error.as_deref(),
        Some("The connection is not working, so acme/web#7 was not closed.")
    );
    // reopening names the other verb
    routing_rule_items::Entity::update_many()
        .col_expr(
            routing_rule_items::Column::ExternalState,
            sea_orm::sea_query::Expr::value("closed"),
        )
        .exec(w.db())
        .await
        .unwrap();
    w.move_to("todo").await;
    assert_eq!(
        w.rule().await.last_error.as_deref(),
        Some("The connection is not working, so acme/web#7 was not reopened.")
    );
    w.drop().await;
}

#[tokio::test]
async fn a_rule_whose_connection_was_removed_fails_the_same_way() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    integration_connections::Entity::delete_by_id(CONNECTION).exec(w.db()).await.unwrap();
    w.move_to("done").await;
    assert!(w.requests().is_empty());
    assert!(
        w.rule().await.last_error.is_some_and(|e| e.starts_with("The connection is not working"))
    );
    w.drop().await;
}

#[tokio::test]
async fn gitlab_closes_with_a_state_event_on_the_encoded_project_path() {
    let Some(w) = world(GitProvider::Gitlab, "two_way").await else { return };
    w.move_to("done").await;
    let sent = w.requests();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].method, Method::PUT);
    assert_eq!(sent[0].url, "https://gitlab.com/api/v4/projects/acme%2Fweb/issues/7");
    assert_eq!(sent[0].body, Some(json!({ "state_event": "close" })));
    assert_eq!(header(&sent[0], "PRIVATE-TOKEN").as_deref(), Some("tok_acme"));
    w.move_to("todo").await;
    assert_eq!(w.requests()[1].body, Some(json!({ "state_event": "reopen" })));
    w.drop().await;
}

#[tokio::test]
async fn bitbucket_cannot_close_issues_and_says_so_on_the_rule() {
    let Some(w) = world(GitProvider::Bitbucket, "two_way").await else { return };
    w.move_to("done").await;
    assert!(w.requests().is_empty());
    assert_eq!(
        w.rule().await.last_error.as_deref(),
        Some("Could not close acme/web#7: Bitbucket · Acme cannot close issues")
    );
    w.drop().await;
}

#[tokio::test]
async fn an_external_id_that_is_not_a_number_is_reported() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    routing_rule_items::Entity::update_many()
        .col_expr(routing_rule_items::Column::ExternalId, sea_orm::sea_query::Expr::value("#seven"))
        .exec(w.db())
        .await
        .unwrap();
    w.move_to("done").await;
    assert!(w.requests().is_empty());
    assert_eq!(
        w.rule().await.last_error.as_deref(),
        Some("Could not close acme/web#seven: Not an issue number: #seven")
    );
    w.drop().await;
}

#[tokio::test]
async fn changes_of_one_task_are_sent_in_the_order_they_were_made() {
    let Some(w) = world(GitProvider::Github, "two_way").await else { return };
    *w.provider.slow_first.lock().unwrap() = true;
    // the close is still being sent when the reopen is recorded
    w.update(&ActorRef::user(USER), "done").await;
    w.update(&ActorRef::user(USER), "todo").await;
    w.settle().await;
    let bodies: Vec<Value> = w.requests().into_iter().filter_map(|r| r.body).collect();
    assert_eq!(
        bodies,
        vec![
            json!({ "state": "closed", "state_reason": "completed" }),
            json!({ "state": "open", "state_reason": "reopened" }),
        ]
    );
    assert_eq!(w.item().await.external_state.as_deref(), Some("open"));
    w.drop().await;
}
