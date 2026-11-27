//! `EventsService.record` and `publish` against a real database.

mod common;

use chrono::{TimeZone, Utc};
use sea_orm::{EntityTrait, PaginatorTrait, TransactionTrait};
use serde_json::json;
use tokio::sync::broadcast::error::TryRecvError;
use trama_contracts::activity::{LiveEventEntity, LiveEventType};
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_core::AppState;
use trama_entities::domain_events;
use trama_events::{Events, LiveChange, RecordEvent};

use common::{World, workspace};

fn issue(id: &str) -> SubjectRef {
    SubjectRef { kind: SubjectType::Issue, id: id.to_owned() }
}

fn input(kind: &str) -> RecordEvent {
    RecordEvent::new("ws_acme", ActorRef::user("u_1"), kind, issue("in_1"))
}

async fn rows(w: &World) -> u64 {
    domain_events::Entity::find().count(w.db()).await.unwrap()
}

#[tokio::test]
async fn record_stores_the_domain_event_and_broadcasts_the_default_live_event() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    let mut live = w.events.subscribe();
    let mut recorded = w.events.subscribe_recorded();

    let row = trama_common::request_context::scope(Some("tab-7".into()), async {
        w.events.record(w.db(), input("issue.created").data(json!({ "title": "Crash" }))).await
    })
    .await
    .unwrap();

    assert!(row.id.starts_with("ev_"));
    assert_eq!(row.workspace_id, "ws_acme");
    assert_eq!(row.r#type, "issue.created");
    assert_eq!(row.actor, json!({ "type": "user", "id": "u_1" }));
    assert_eq!(row.subject, json!({ "type": "issue", "id": "in_1" }));
    assert_eq!(row.data, json!({ "title": "Crash" }));
    assert_eq!(row.legacy_workstream_key, None);
    // stored with the precision of `new Date()`
    assert_eq!(row.at.timestamp_subsec_nanos() % 1_000_000, 0);
    assert_eq!(
        domain_events::Entity::find_by_id(row.id.clone()).one(w.db()).await.unwrap(),
        Some(row.clone())
    );

    let published = live.try_recv().unwrap();
    assert_eq!(published.workspace_id, "ws_acme");
    assert_eq!(published.user_id, None);
    assert_eq!(published.subject, Some(issue("in_1").into()));
    assert_eq!(published.event.kind, LiveEventType::Created);
    assert_eq!(published.event.entity, LiveEventEntity::Issue);
    assert_eq!(published.event.id, "in_1");
    assert_eq!(published.event.client_id.as_deref(), Some("tab-7"));
    assert_eq!(published.event.at.len(), 24);
    assert_eq!(recorded.try_recv().unwrap(), row);
    assert!(matches!(live.try_recv(), Err(TryRecvError::Empty)));
    w.drop().await;
}

#[tokio::test]
async fn record_maps_event_types_to_live_types() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    let mut live = w.events.subscribe();
    for (kind, expected) in [
        ("issue.created", LiveEventType::Created),
        ("issue.deleted", LiveEventType::Deleted),
        ("issue.status_changed", LiveEventType::Updated),
        ("issue.created.again", LiveEventType::Updated),
        ("created", LiveEventType::Updated),
    ] {
        w.events.record(w.db(), input(kind)).await.unwrap();
        assert_eq!(live.try_recv().unwrap().event.kind, expected, "{kind}");
    }
    // no data stores an empty object; `client_id` is absent outside a request
    let row = w.events.record(w.db(), input("issue.updated")).await.unwrap();
    assert_eq!(row.data, json!({}));
    assert_eq!(live.try_recv().unwrap().event.client_id, None);
    w.drop().await;
}

#[tokio::test]
async fn record_can_skip_or_customise_the_live_event() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    let mut live = w.events.subscribe();
    let mut recorded = w.events.subscribe_recorded();

    w.events.record(w.db(), input("issue.viewed").without_live()).await.unwrap();
    assert!(matches!(live.try_recv(), Err(TryRecvError::Empty)));
    assert_eq!(recorded.try_recv().unwrap().r#type, "issue.viewed");

    // a comment event: its own entity, still scoped by the issue it belongs to
    w.events
        .record(
            w.db(),
            input("comment.created").live(LiveChange::created(LiveEventEntity::Comment, "cm_1")),
        )
        .await
        .unwrap();
    let published = live.try_recv().unwrap();
    assert_eq!(published.event.entity, LiveEventEntity::Comment);
    assert_eq!(published.event.id, "cm_1");
    assert_eq!(published.subject, Some(issue("in_1").into()));
    w.drop().await;
}

#[tokio::test]
async fn backdated_events_are_stored_but_not_sent_to_recorded() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;
    let mut recorded = w.events.subscribe_recorded();
    let at = Utc.with_ymd_and_hms(2020, 1, 2, 3, 4, 5).unwrap();
    let row = w.events.record(w.db(), input("issue.created").at(at)).await.unwrap();
    assert_eq!(row.at.to_utc(), at);
    assert!(matches!(recorded.try_recv(), Err(TryRecvError::Empty)));
    w.drop().await;
}

#[tokio::test]
async fn record_writes_inside_the_callers_transaction() {
    let Some(w) = World::new().await else { return };
    workspace(w.db(), "acme").await;

    let txn = w.db().begin().await.unwrap();
    w.events.record(&txn, input("issue.created")).await.unwrap();
    assert_eq!(rows(&w).await, 0, "not visible before the commit");
    txn.rollback().await.unwrap();
    assert_eq!(rows(&w).await, 0);

    let txn = w.db().begin().await.unwrap();
    w.events.record(&txn, input("issue.created")).await.unwrap();
    txn.commit().await.unwrap();
    assert_eq!(rows(&w).await, 1);
    w.drop().await;
}

#[tokio::test]
async fn a_failed_insert_broadcasts_nothing() {
    let Some(w) = World::new().await else { return };
    // no such workspace: the foreign key refuses the row
    let mut live = w.events.subscribe();
    let mut recorded = w.events.subscribe_recorded();
    assert!(w.events.record(w.db(), input("issue.created")).await.is_err());
    assert!(matches!(live.try_recv(), Err(TryRecvError::Empty)));
    assert!(matches!(recorded.try_recv(), Err(TryRecvError::Empty)));
    w.drop().await;
}

#[tokio::test]
async fn publish_addresses_a_workspace_or_one_person() {
    let w = Events::local();
    let mut live = w.subscribe();
    w.publish("ws_1", LiveChange::updated(LiveEventEntity::Workspace, "ws_1"));
    w.publish_to_user("ws_1", LiveChange::created(LiveEventEntity::Notification, "nt_1"), "u_1");
    w.publish_with(
        "ws_1",
        LiveChange::deleted(LiveEventEntity::Comment, "cm_1"),
        None,
        Some(issue("in_1").into()),
    );
    let (a, b, c) = (live.try_recv().unwrap(), live.try_recv().unwrap(), live.try_recv().unwrap());
    assert_eq!((a.user_id, a.subject), (None, None));
    assert_eq!(b.user_id.as_deref(), Some("u_1"));
    assert_eq!(b.event.kind, LiveEventType::Created);
    assert_eq!(c.subject, Some(issue("in_1").into()));
    assert_eq!(c.event.kind, LiveEventType::Deleted);
}

#[tokio::test]
async fn of_returns_the_registered_instance_or_a_shared_local_one() {
    let Some(w) = World::new().await else { return };
    let registered = Events::of(&w.state);
    let mut live = registered.subscribe();
    w.events.publish("ws_1", LiveChange::updated(LiveEventEntity::Workspace, "ws_1"));
    assert!(live.try_recv().is_ok(), "the registered instance is the one on the state");

    // a bare state falls back to one process-local instance, the same on every call
    let bare = AppState::new(w.db().clone(), trama_core::Config::from_vars(&[]));
    let mut first = Events::of(&bare).subscribe();
    Events::of(&bare).publish("ws_1", LiveChange::updated(LiveEventEntity::Workspace, "ws_1"));
    assert!(first.try_recv().is_ok());
    assert!(matches!(live.try_recv(), Err(TryRecvError::Empty)));
    w.drop().await;
}
