//! `PgImportSink` against a real database: the unique external reference, the refreshed mirror,
//! comment idempotency, the label cap and the fatal error for a mapped record that is gone.

#![allow(clippy::too_many_lines)]

mod common;

use chrono::Utc;
use sea_orm::{EntityTrait, PaginatorTrait};
use trama_contracts::common::ActorRef;
use trama_contracts::imports::{
    DEFAULT_IMPORT_OPTIONS, ExternalProvider, ExternalRefOrigin, ImportMapping, ImportTarget,
};
use trama_entities::{comments, import_links, issues};
use trama_importers::engine::{CreateOutcome, ImportError, ImportSink, NewComment};
use trama_importers::mapping::{ResolvedPlan, external_ref_of, to_new_issue};
use trama_importers::sink::PgImportSink;

use common::{Fake, World, entity, gh_issue, person, workspace};

async fn world() -> Option<(World, PgImportSink)> {
    let w = World::new(Fake::new(vec![], vec![])).await?;
    workspace(w.db(), "acme").await;
    person(w.db(), "ws_acme", "owner", "owner").await;
    let sink = PgImportSink::new(
        &w.state,
        "ws_acme",
        ActorRef::user("owner"),
        "imp_1",
        ExternalProvider::Github,
        None,
    );
    Some((w, sink))
}

#[tokio::test]
async fn an_issue_is_created_once_and_its_mirror_refreshed() {
    let Some((w, sink)) = world().await else { return };
    let ext = gh_issue(7);
    let new = to_new_issue(
        ExternalProvider::Github,
        &ext,
        &ResolvedPlan::default(),
        &DEFAULT_IMPORT_OPTIONS,
        Utc::now(),
    );
    assert_eq!(sink.create_issue(&new).await.unwrap(), CreateOutcome::Created);
    assert_eq!(sink.create_issue(&new).await.unwrap(), CreateOutcome::Exists);
    assert_eq!(issues::Entity::find().count(w.db()).await.unwrap(), 1);
    assert_eq!(import_links::Entity::find().count(w.db()).await.unwrap(), 0, "no link for issues");
    let row = issues::Entity::find().one(w.db()).await.unwrap().unwrap();
    assert!(row.id.starts_with("in_"));
    assert_eq!(row.key.split('-').next_back(), Some("1"));

    let mut closed = ext.clone();
    closed.state = common::state_of("closed");
    let reference =
        external_ref_of(ExternalProvider::Github, &closed, ExternalRefOrigin::Import, Utc::now());
    sink.refresh_ref(ExternalProvider::Github, &ext.id, &reference).await.unwrap();
    let row = issues::Entity::find().one(w.db()).await.unwrap().unwrap();
    let mirrored = row.external_ref.unwrap();
    assert_eq!(mirrored["state"], "Closed");
    assert_eq!(mirrored["origin"], "import", "the rest of the reference is kept");

    let asked = [ext.id.clone(), "x#1".to_owned()];
    let found = sink.existing_issues(ExternalProvider::Github, &asked).await.unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[&ext.id], row.id);
    w.drop().await;
}

#[tokio::test]
async fn a_comment_is_written_once() {
    let Some((w, sink)) = world().await else { return };
    let new = to_new_issue(
        ExternalProvider::Github,
        &gh_issue(1),
        &ResolvedPlan::default(),
        &DEFAULT_IMPORT_OPTIONS,
        Utc::now(),
    );
    sink.create_issue(&new).await.unwrap();
    let issue = issues::Entity::find().one(w.db()).await.unwrap().unwrap();
    let comment = NewComment {
        external_id: "c1".into(),
        issue_id: issue.id.clone(),
        body: "hello".into(),
        created_at: Utc::now(),
    };
    assert!(sink.create_comment(ExternalProvider::Github, &comment).await.unwrap());
    assert!(!sink.create_comment(ExternalProvider::Github, &comment).await.unwrap());
    assert_eq!(comments::Entity::find().count(w.db()).await.unwrap(), 1);
    let seen = sink
        .existing_comments(ExternalProvider::Github, &["c1".into(), "c2".into()])
        .await
        .unwrap();
    assert_eq!(seen.into_iter().collect::<Vec<_>>(), ["c1"]);
    w.drop().await;
}

#[tokio::test]
async fn at_most_one_hundred_custom_labels_are_created() {
    let Some((w, sink)) = world().await else { return };
    let labels: Vec<_> =
        (0..101).map(|n| entity(&format!("l{n}"), &format!("label {n}"), None)).collect();
    let mut discovery = common::discovery(0);
    discovery.labels = labels;
    let mut mapping = ImportMapping::default();
    for n in 0..101 {
        mapping.labels.insert(format!("l{n}"), ImportTarget::Create);
    }
    let plan = sink.resolve_plan(&discovery, &mapping).await.unwrap();
    // the label past the cap is left off the issues instead of failing the job
    assert_eq!(plan.labels.values().filter(|id| id.is_some()).count(), 100);
    assert_eq!(plan.labels["l100"], None);
    let settings = trama_entities::workspaces::Entity::find_by_id("ws_acme")
        .one(w.db())
        .await
        .unwrap()
        .unwrap()
        .settings;
    assert_eq!(settings["labels"].as_array().map(Vec::len), Some(100));
    w.drop().await;
}

#[tokio::test]
async fn a_created_label_is_reused_by_the_next_run() {
    let Some((w, sink)) = world().await else { return };
    let mut discovery = common::discovery(0);
    discovery.labels = vec![entity("l1", "Bug", Some("#d73a4a"))];
    let mut mapping = ImportMapping::default();
    mapping.labels.insert("l1".into(), ImportTarget::Create);
    let first = sink.resolve_plan(&discovery, &mapping).await.unwrap();
    let again = sink.resolve_plan(&discovery, &mapping).await.unwrap();
    assert_eq!(first.labels["l1"], again.labels["l1"], "the link is reused");
    assert!(first.labels["l1"].as_deref().unwrap().starts_with("lb_"));
    w.drop().await;
}

#[tokio::test]
async fn a_mapped_project_that_is_gone_stops_the_job() {
    let Some((w, sink)) = world().await else { return };
    let mut discovery = common::discovery(0);
    discovery.projects = vec![entity("repo", "api", None)];
    let mut mapping = ImportMapping::default();
    mapping.projects.insert("repo".into(), ImportTarget::Map { id: "pj_gone".into() });
    let error = sink.resolve_plan(&discovery, &mapping).await.unwrap_err();
    assert!(matches!(error, ImportError::Fatal(_)), "{error:?}");
    w.drop().await;
}
