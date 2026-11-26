//! The artifact linker against a real database (`artifact-linker.service.spec.ts`, and the
//! review-request half of `server/test/external-identities.e2e-spec.ts` that goes through the
//! linker): issue keys, one artifact per issue, the people a provider names, CI by commit.

mod common;

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::json;
use trama_contracts::common::GitProvider;
use trama_contracts::identity::{ExternalIdentityInput, ExternalIdentityProvider};
use trama_contracts::issues::{ArtifactKind, ArtifactState, CiState, ReviewState};
use trama_entities::{artifact_sources, artifacts, domain_events};
use trama_external_identities::service as identities;
use trama_integrations::candidates::CiPatch;
use trama_integrations::linker::{apply_ci, key_map, upsert};
use trama_integrations::{ArtifactCandidate, LinkResult};

use common::{World, issue, member, only_projects, project, sql, user, workspace};

const WS: &str = "ws_acme";
const REPO: &str = "acme/app";

fn pr(number: u32, title: &str) -> ArtifactCandidate {
    let mut c = ArtifactCandidate::new(
        ArtifactKind::PullRequest,
        GitProvider::Github,
        format!("#{number}"),
        title,
    );
    c.texts = vec![title.to_owned()];
    c
}

/// `acme` with two projects and a task in each: `BUG-1` in `pj_a`, `WEB-2` in `pj_b`.
async fn world() -> Option<World> {
    let w = World::new().await?;
    let db = w.db();
    workspace(db, "acme").await;
    project(db, WS, "pj_a").await;
    project(db, WS, "pj_b").await;
    issue(db, WS, "in_1", "BUG-1", Some("pj_a")).await;
    issue(db, WS, "in_2", "WEB-2", Some("pj_b")).await;
    Some(w)
}

/// The people of the identity cases: Ada proved her GitHub login with a connection, Bob typed his
/// in, Cleo only reaches `pj_b`, and Eve is not a member.
async fn people(w: &World) {
    let db = w.db();
    for id in ["ada", "bob", "cleo", "eve"] {
        user(db, id, id).await;
    }
    member(db, WS, "ada", "member", None).await;
    member(db, WS, "bob", "member", None).await;
    member(db, WS, "cleo", "member", Some(only_projects(&["pj_b"], false))).await;
    identities::ensure_from_connection(db, "ada", "github", None, Some("Ada-GH")).await.unwrap();
    for (id, login) in [("bob", "Bob-GH"), ("cleo", "Cleo-GH"), ("eve", "Eve-GH")] {
        identities::add(
            db,
            id,
            &ExternalIdentityInput {
                provider: ExternalIdentityProvider::Github,
                host: None,
                login: login.to_owned(),
            },
        )
        .await
        .unwrap();
    }
}

async fn rows(w: &World) -> Vec<artifacts::Model> {
    artifacts::Entity::find().order_by_asc(artifacts::Column::CreatedAt).all(w.db()).await.unwrap()
}

async fn events(w: &World, kind: &str) -> Vec<domain_events::Model> {
    domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq(kind))
        .order_by_asc(domain_events::Column::At)
        .all(w.db())
        .await
        .unwrap()
}

fn result(created: u32, updated: u32, keys: &[&str]) -> LinkResult {
    LinkResult { created, updated, issue_keys: keys.iter().map(|k| (*k).to_owned()).collect() }
}

#[tokio::test]
async fn attaches_webhook_artifacts_to_matching_issues() {
    let Some(w) = world().await else { return };
    let out = upsert(&w.state, WS, REPO, &pr(12, "Fix BUG-1"), None).await.unwrap();
    assert_eq!(out, result(1, 0, &["BUG-1"]));
    let all = rows(&w).await;
    assert_eq!(all.len(), 1);
    let a = &all[0];
    assert_eq!(a.issue_id.as_deref(), Some("in_1"));
    assert_eq!(
        (a.kind.as_str(), a.provider.as_str(), a.state.as_str()),
        ("pull_request", "github", "open")
    );
    assert_eq!(
        (a.repository.as_deref(), a.external_id.as_deref(), a.title.as_str()),
        (Some(REPO), Some("#12"), "Fix BUG-1")
    );
    let attached = events(&w, "artifact.attached").await;
    assert_eq!(attached.len(), 1);
    assert_eq!(attached[0].actor["type"], "system");
    assert_eq!(attached[0].subject, json!({ "type": "artifact", "id": a.id }));
    w.drop().await;
}

#[tokio::test]
async fn updates_the_artifact_it_already_made_instead_of_adding_another() {
    let Some(w) = world().await else { return };
    upsert(&w.state, WS, REPO, &pr(12, "Fix BUG-1"), None).await.unwrap();
    // nothing changed: nothing counts as updated
    let same = upsert(&w.state, WS, REPO, &pr(12, "Fix BUG-1"), None).await.unwrap();
    assert_eq!(same, result(0, 0, &["BUG-1"]));
    let mut merged = pr(12, "Fix BUG-1");
    merged.state = Some(ArtifactState::Merged);
    merged.url = Some("https://github.com/acme/app/pull/12".to_owned());
    assert_eq!(upsert(&w.state, WS, REPO, &merged, None).await.unwrap(), result(0, 1, &["BUG-1"]));
    let all = rows(&w).await;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].state, "merged");
    assert_eq!(all[0].url.as_deref(), Some("https://github.com/acme/app/pull/12"));
    // another repository, another kind or another number is another artifact
    upsert(&w.state, WS, "acme/other", &pr(12, "Fix BUG-1"), None).await.unwrap();
    upsert(&w.state, WS, REPO, &pr(13, "Fix BUG-1"), None).await.unwrap();
    let mut mr = pr(12, "Fix BUG-1");
    mr.kind = ArtifactKind::MergeRequest;
    upsert(&w.state, WS, REPO, &mr, None).await.unwrap();
    assert_eq!(rows(&w).await.len(), 4);
    w.drop().await;
}

#[tokio::test]
async fn keeps_one_artifact_per_issue_and_ignores_keys_it_does_not_know() {
    let Some(w) = world().await else { return };
    let out = upsert(&w.state, WS, REPO, &pr(1, "BUG-1 and WEB-2 and NOPE-9"), None).await.unwrap();
    assert_eq!(out, result(2, 0, &["BUG-1", "WEB-2"]));
    let mut ids: Vec<_> = rows(&w).await.into_iter().filter_map(|a| a.issue_id).collect();
    ids.sort();
    assert_eq!(ids, ["in_1", "in_2"]);
    let none = upsert(&w.state, WS, REPO, &pr(2, "Nothing to link NOPE-9"), None).await.unwrap();
    assert_eq!(none, result(0, 0, &[]));
    assert_eq!(rows(&w).await.len(), 2);
    // keys of another workspace are unknown here
    let map = key_map(w.db(), WS).await.unwrap();
    assert_eq!(map.get("BUG-1").map(String::as_str), Some("in_1"));
    assert_eq!(key_map(w.db(), "ws_nope").await.unwrap().len(), 0);
    w.drop().await;
}

#[tokio::test]
async fn reads_keys_from_branch_names_ignoring_case() {
    let Some(w) = world().await else { return };
    let mut c = pr(5, "Refactor");
    c.branch_texts = vec!["feature/bug-1-refresh".to_owned()];
    assert_eq!(upsert(&w.state, WS, REPO, &c, None).await.unwrap(), result(1, 0, &["BUG-1"]));
    // free text is case-sensitive
    let mut lower = pr(6, "refactor bug-1");
    lower.branch_texts = Vec::new();
    assert_eq!(upsert(&w.state, WS, REPO, &lower, None).await.unwrap(), result(0, 0, &[]));
    w.drop().await;
}

#[tokio::test]
async fn keeps_an_existing_link_when_the_title_stops_naming_the_issue() {
    let Some(w) = world().await else { return };
    upsert(&w.state, WS, REPO, &pr(7, "Fix BUG-1"), None).await.unwrap();
    let out = upsert(&w.state, WS, REPO, &pr(7, "Reworded"), None).await.unwrap();
    assert_eq!(out, result(0, 1, &[]));
    let all = rows(&w).await;
    assert_eq!((all.len(), all[0].title.as_str()), (1, "Reworded"));
    w.drop().await;
}

#[tokio::test]
async fn serializes_webhooks_of_one_pull_request() {
    let Some(w) = world().await else { return };
    let c = pr(8, "Fix BUG-1");
    let (a, b) =
        tokio::join!(upsert(&w.state, WS, REPO, &c, None), upsert(&w.state, WS, REPO, &c, None));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.created + b.created, 1, "{a:?} {b:?}");
    assert_eq!(rows(&w).await.len(), 1);
    w.drop().await;
}

#[tokio::test]
async fn applies_a_review_only_from_the_states_it_names() {
    let Some(w) = world().await else { return };
    let mut c = pr(9, "Fix BUG-1");
    c.review = Some(ReviewState::None);
    upsert(&w.state, WS, REPO, &c, None).await.unwrap();
    let review = |w: &World| {
        let db = w.db().clone();
        async move { rows_of(&db).await[0].review.clone() }
    };
    let mut approved = pr(9, "Fix BUG-1");
    approved.review = Some(ReviewState::Approved);
    approved.review_only_from = Some(vec![ReviewState::Requested]);
    upsert(&w.state, WS, REPO, &approved, None).await.unwrap();
    assert_eq!(review(&w).await.as_deref(), Some("none"), "not asked for yet");
    let mut asked = pr(9, "Fix BUG-1");
    asked.review = Some(ReviewState::Requested);
    upsert(&w.state, WS, REPO, &asked, None).await.unwrap();
    assert_eq!(review(&w).await.as_deref(), Some("requested"));
    upsert(&w.state, WS, REPO, &approved, None).await.unwrap();
    assert_eq!(review(&w).await.as_deref(), Some("approved"));
    w.drop().await;
}

async fn rows_of(db: &sea_orm::DatabaseConnection) -> Vec<artifacts::Model> {
    artifacts::Entity::find().all(db).await.unwrap()
}

// ───────────────────────────── external identities ─────────────────────────────

fn review_request(logins: &[&str], sender: Option<&str>) -> ArtifactCandidate {
    let mut c = pr(12, "Fix BUG-1");
    c.review = Some(ReviewState::Requested);
    c.reviewer_logins = logins.iter().map(|l| (*l).to_owned()).collect();
    c.actor_login = sender.map(ToOwned::to_owned);
    c
}

#[tokio::test]
async fn asks_the_people_the_provider_named_and_credits_a_verified_sender() {
    let Some(w) = world().await else { return };
    people(&w).await;
    upsert(&w.state, WS, REPO, &review_request(&["bob-gh"], Some("Ada-GH")), None).await.unwrap();
    let requested = events(&w, "review.requested").await;
    assert_eq!(requested.len(), 1);
    assert_eq!(requested[0].data["reviewerUserIds"], json!(["bob"]));
    assert_eq!(requested[0].actor, json!({ "type": "user", "id": "ada" }));
    let attached = events(&w, "artifact.attached").await;
    assert_eq!(attached[0].actor, json!({ "type": "user", "id": "ada" }));
    w.drop().await;
}

#[tokio::test]
async fn does_not_credit_a_sender_whose_login_was_only_typed_in() {
    let Some(w) = world().await else { return };
    people(&w).await;
    upsert(&w.state, WS, REPO, &review_request(&["Ada-GH"], Some("Bob-GH")), None).await.unwrap();
    let requested = events(&w, "review.requested").await;
    assert_eq!(requested[0].actor["type"], "system");
    // the reviewer is found however the login was proven
    assert_eq!(requested[0].data["reviewerUserIds"], json!(["ada"]));
    w.drop().await;
}

#[tokio::test]
async fn does_not_tell_a_reviewer_who_is_limited_to_other_projects() {
    let Some(w) = world().await else { return };
    people(&w).await;
    // BUG-1 is in pj_a: Cleo only reaches pj_b
    let both = review_request(&["Bob-GH", "Cleo-GH"], None);
    upsert(&w.state, WS, REPO, &both, None).await.unwrap();
    let alone = review_request(&["Cleo-GH"], None);
    let mut other = alone.clone();
    other.external_id = "#13".to_owned();
    upsert(&w.state, WS, REPO, &other, None).await.unwrap();
    // WEB-2 is in pj_b: Cleo may hear about it
    let mut web = review_request(&["Cleo-GH"], None);
    web.external_id = "#14".to_owned();
    web.texts = vec!["Fix WEB-2".to_owned()];
    upsert(&w.state, WS, REPO, &web, None).await.unwrap();

    let requested = events(&w, "review.requested").await;
    let by_external: Vec<_> = requested
        .iter()
        .map(|e| (e.data["externalId"].clone(), e.data.get("reviewerUserIds").cloned()))
        .collect();
    assert_eq!(
        by_external,
        [
            (json!("#12"), Some(json!(["bob"]))),
            (json!("#13"), None),
            (json!("#14"), Some(json!(["cleo"]))),
        ]
    );
    w.drop().await;
}

#[tokio::test]
async fn only_workspace_members_hear_about_a_review() {
    let Some(w) = world().await else { return };
    people(&w).await;
    // Eve has the login but is not a member of the workspace
    upsert(&w.state, WS, REPO, &review_request(&["Eve-GH"], Some("Eve-GH")), None).await.unwrap();
    let requested = events(&w, "review.requested").await;
    assert!(requested[0].data.get("reviewerUserIds").is_none());
    assert_eq!(requested[0].actor["type"], "system");
    w.drop().await;
}

#[tokio::test]
async fn keeps_the_system_actor_when_nobody_is_linked() {
    let Some(w) = world().await else { return };
    people(&w).await;
    upsert(&w.state, WS, REPO, &review_request(&["stranger"], Some("stranger")), None)
        .await
        .unwrap();
    assert_eq!(events(&w, "artifact.attached").await[0].actor["type"], "system");
    assert!(events(&w, "review.requested").await[0].data.get("reviewerUserIds").is_none());
    w.drop().await;
}

#[tokio::test]
async fn looks_logins_up_on_the_host_the_event_came_from() {
    let Some(w) = world().await else { return };
    people(&w).await;
    identities::add(
        w.db(),
        "bob",
        &ExternalIdentityInput {
            provider: ExternalIdentityProvider::Github,
            host: Some("ghe.acme.dev".to_owned()),
            login: "bob-ent".to_owned(),
        },
    )
    .await
    .unwrap();
    let c = review_request(&["bob-ent"], None);
    upsert(&w.state, WS, REPO, &c, None).await.unwrap();
    let mut on_host = c.clone();
    on_host.external_id = "#2".to_owned();
    upsert(&w.state, WS, REPO, &on_host, Some("ghe.acme.dev")).await.unwrap();
    let requested = events(&w, "review.requested").await;
    assert!(requested[0].data.get("reviewerUserIds").is_none(), "github.com has no bob-ent");
    assert_eq!(requested[1].data["reviewerUserIds"], json!(["bob"]));
    w.drop().await;
}

// ───────────────────────────── CI ─────────────────────────────

#[tokio::test]
async fn applies_ci_to_the_pull_requests_of_a_commit() {
    let Some(w) = world().await else { return };
    let mut c = pr(12, "Fix BUG-1");
    c.head_sha = Some("abc123".to_owned());
    c.head_branch = Some("bug-1-fix".to_owned());
    c.ci = Some(CiState::Pending);
    upsert(&w.state, WS, REPO, &c, None).await.unwrap();
    let id = rows(&w).await[0].id.clone();
    let source = artifact_sources::Entity::find_by_id(&id).one(w.db()).await.unwrap().unwrap();
    assert_eq!(
        (
            source.workspace_id.as_str(),
            source.repository.as_deref(),
            source.head_sha.as_deref(),
            source.head_branch.as_deref()
        ),
        (WS, Some(REPO), Some("abc123"), Some("bug-1-fix"))
    );

    let patch = |sha: Option<&str>, ids: &[&str], ci| CiPatch {
        sha: sha.map(ToOwned::to_owned),
        pr_external_ids: ids.iter().map(|i| (*i).to_owned()).collect(),
        ci,
    };
    assert_eq!(
        apply_ci(&w.state, WS, REPO, &patch(Some("abc123"), &[], CiState::Passing)).await.unwrap(),
        1
    );
    assert_eq!(rows(&w).await[0].ci.as_deref(), Some("passing"));
    // unchanged, unknown or from another repository: nothing to do
    assert_eq!(
        apply_ci(&w.state, WS, REPO, &patch(Some("abc123"), &[], CiState::Passing)).await.unwrap(),
        0
    );
    assert_eq!(
        apply_ci(&w.state, WS, REPO, &patch(Some("zzz"), &[], CiState::Failing)).await.unwrap(),
        0
    );
    assert_eq!(
        apply_ci(&w.state, WS, "acme/other", &patch(Some("abc123"), &[], CiState::Failing))
            .await
            .unwrap(),
        0
    );
    // listed explicitly, by the number the provider gave
    assert_eq!(
        apply_ci(&w.state, WS, REPO, &patch(None, &["#12"], CiState::Failing)).await.unwrap(),
        1
    );
    assert_eq!(rows(&w).await[0].ci.as_deref(), Some("failing"));
    // both ways at once count the artifact once
    assert_eq!(
        apply_ci(&w.state, WS, REPO, &patch(Some("abc123"), &["#12"], CiState::Passing))
            .await
            .unwrap(),
        1
    );
    let updates = events(&w, "artifact.updated").await;
    assert_eq!(updates.len(), 3);
    assert!(updates.iter().all(|e| e.actor["type"] == "system"));

    // a new commit moves the coordinates
    c.head_sha = Some("def456".to_owned());
    c.head_branch = None;
    upsert(&w.state, WS, REPO, &c, None).await.unwrap();
    let source = artifact_sources::Entity::find_by_id(&id).one(w.db()).await.unwrap().unwrap();
    assert_eq!(
        (source.head_sha.as_deref(), source.head_branch.as_deref()),
        (Some("def456"), Some("bug-1-fix"))
    );
    w.drop().await;
}

#[tokio::test]
async fn ci_only_reaches_pull_and_merge_requests() {
    let Some(w) = world().await else { return };
    upsert(&w.state, WS, REPO, &pr(12, "Fix BUG-1"), None).await.unwrap();
    sql(
        w.db(),
        &format!(
            r#"INSERT INTO artifacts (id, "workspaceId", repository, kind, provider, title, "externalId", state, "issueId")
               VALUES ('ar_build', '{WS}', '{REPO}', 'build', 'ci', 'Build', '#12', 'pending', 'in_1')"#
        ),
    )
    .await;
    let patch =
        CiPatch { sha: None, pr_external_ids: vec!["#12".to_owned()], ci: CiState::Passing };
    assert_eq!(apply_ci(&w.state, WS, REPO, &patch).await.unwrap(), 1);
    let build = artifacts::Entity::find_by_id("ar_build").one(w.db()).await.unwrap().unwrap();
    assert_eq!(build.ci, None);
    w.drop().await;
}
