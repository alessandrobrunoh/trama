//! `live-relay.e2e-spec.ts`: live events reach the streams of another API instance through
//! Postgres, and this instance's own streams exactly once; plus the listener's lifecycle.

mod common;

use std::time::Duration;

use sea_orm::sqlx::postgres::PgListener;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use tokio::sync::broadcast::Receiver;
use trama_contracts::activity::{LiveEventEntity, LiveEventType};
use trama_core::testkit::TestDb;
use trama_events::relay::LIVE_CHANNEL;
use trama_events::{Events, LiveChange, PublishedEvent};

async fn setup() -> Option<TestDb> {
    TestDb::create().await
}

/// Polls `condition` until it holds.
async fn until(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..400 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn next(rx: &mut Receiver<PublishedEvent>) -> PublishedEvent {
    tokio::time::timeout(Duration::from_secs(8), rx.recv()).await.expect("an event").unwrap()
}

async fn quiet(rx: &mut Receiver<PublishedEvent>) {
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(rx.try_recv().is_err(), "no further event expected");
}

fn issue_created(id: &str) -> LiveChange {
    LiveChange::created(LiveEventEntity::Issue, id)
}

#[tokio::test]
async fn live_events_reach_the_streams_of_another_instance_through_postgres() {
    let Some(test) = setup().await else { return };
    let a = Events::start(test.db.clone(), test.url());
    let b = Events::start(test.db.clone(), test.url());
    until("both listeners", || a.is_listening() && b.is_listening()).await;
    let mut heard = b.subscribe();

    trama_common::request_context::scope(Some("tab-a".into()), async {
        a.publish("ws_1", issue_created("in_1"));
    })
    .await;

    let got = next(&mut heard).await;
    assert_eq!(got.workspace_id, "ws_1");
    assert_eq!(got.event.kind, LiveEventType::Created);
    assert_eq!(got.event.entity, LiveEventEntity::Issue);
    assert_eq!(got.event.id, "in_1");
    assert_eq!(got.event.client_id.as_deref(), Some("tab-a"));
    quiet(&mut heard).await;
    a.shutdown().await;
    b.shutdown().await;
    test.drop().await;
}

#[tokio::test]
async fn live_events_still_reach_this_instances_own_streams_exactly_once() {
    let Some(test) = setup().await else { return };
    let a = Events::start(test.db.clone(), test.url());
    until("the listener", || a.is_listening()).await;
    let mut own = a.subscribe();
    a.publish("ws_1", issue_created("in_1"));
    let got = next(&mut own).await;
    assert_eq!((got.event.kind, got.event.id.as_str()), (LiveEventType::Created, "in_1"));
    quiet(&mut own).await;
    a.shutdown().await;
    test.drop().await;
}

#[tokio::test]
async fn events_arrive_in_the_order_they_were_published() {
    let Some(test) = setup().await else { return };
    let a = Events::start(test.db.clone(), test.url());
    until("the listener", || a.is_listening()).await;
    let mut own = a.subscribe();
    for n in 0..30 {
        a.publish("ws_1", issue_created(&format!("in_{n}")));
    }
    for n in 0..30 {
        assert_eq!(next(&mut own).await.event.id, format!("in_{n}"));
    }
    a.shutdown().await;
    test.drop().await;
}

/// The wire format NestJS writes and reads: `JSON.stringify(PublishedEvent)`.
#[tokio::test]
async fn the_payload_is_the_one_nestjs_sends_and_other_payloads_are_ignored() {
    let Some(test) = setup().await else { return };
    let a = Events::start(test.db.clone(), test.url());
    until("the listener", || a.is_listening()).await;
    let mut raw = PgListener::connect(test.url()).await.unwrap();
    raw.listen(LIVE_CHANNEL).await.unwrap();
    let mut own = a.subscribe();

    trama_common::request_context::scope(Some("tab".into()), async {
        a.publish_to_user(
            "ws_1",
            LiveChange::updated(LiveEventEntity::Notification, "nt_1"),
            "u_1",
        );
    })
    .await;
    let note = tokio::time::timeout(Duration::from_secs(8), raw.recv()).await.unwrap().unwrap();
    assert_eq!(note.channel(), "trama_live");
    let wire: serde_json::Value = serde_json::from_str(note.payload()).unwrap();
    let at = wire["event"]["at"].as_str().unwrap().to_owned();
    assert_eq!(
        wire,
        serde_json::json!({
            "workspaceId": "ws_1",
            "userId": "u_1",
            "event": { "type": "updated", "entity": "notification", "id": "nt_1", "clientId": "tab", "at": at },
        })
    );
    // and without clientId, userId or subject the keys are omitted, as JSON.stringify does
    a.publish("ws_1", issue_created("in_9"));
    let note = tokio::time::timeout(Duration::from_secs(8), raw.recv()).await.unwrap().unwrap();
    let wire: serde_json::Value = serde_json::from_str(note.payload()).unwrap();
    let mut keys: Vec<_> = wire.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["event", "workspaceId"]);
    assert!(wire["event"].get("clientId").is_none());
    assert_eq!(next(&mut own).await.event.id, "nt_1");
    assert_eq!(next(&mut own).await.event.id, "in_9");

    // what NestJS writes is understood; payloads of other shapes are skipped, not fatal
    for payload in ["not json", "{}", r#"{"workspaceId":"ws_1"}"#, ""] {
        test.db
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT pg_notify($1, $2)",
                [LIVE_CHANNEL.into(), payload.into()],
            ))
            .await
            .unwrap();
    }
    test.db
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT pg_notify($1, $2)",
            [
                LIVE_CHANNEL.into(),
                r#"{"workspaceId":"ws_9","subject":{"type":"issue","id":"in_5"},"event":{"type":"created","entity":"comment","id":"cm_1","at":"2026-01-01T00:00:00.000Z"}}"#.into(),
            ],
        ))
        .await
        .unwrap();
    let got = next(&mut own).await;
    assert_eq!((got.workspace_id.as_str(), got.event.id.as_str()), ("ws_9", "cm_1"));
    assert_eq!(got.subject.unwrap().id, "in_5");
    // another channel is not ours
    test.db.execute_unprepared("SELECT pg_notify('other_channel', '{}')").await.unwrap();
    quiet(&mut own).await;
    a.shutdown().await;
    test.drop().await;
}

#[tokio::test]
async fn without_a_listener_events_go_to_this_instances_streams_only() {
    let Some(test) = setup().await else { return };
    // nothing listens at this address: the listener keeps retrying
    let a = Events::start(test.db.clone(), "postgres://delta:delta@127.0.0.1:1/none");
    let mut own = a.subscribe();
    assert!(!a.is_listening());
    a.publish("ws_1", issue_created("in_1"));
    assert_eq!(next(&mut own).await.event.id, "in_1");
    quiet(&mut own).await;
    a.shutdown().await;
    test.drop().await;
}

#[tokio::test]
async fn the_listener_reconnects_after_it_is_lost() {
    let Some(test) = setup().await else { return };
    let a = Events::start(test.db.clone(), test.url());
    until("the listener", || a.is_listening()).await;
    let mut own = a.subscribe();

    let killed = test
        .db
        .execute_unprepared(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
             WHERE datname = current_database() AND query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()",
        )
        .await
        .unwrap();
    assert!(killed.rows_affected() > 0);
    until("the loss to be noticed", || !a.is_listening()).await;
    // meanwhile events still reach this instance
    a.publish("ws_1", issue_created("in_lost"));
    assert_eq!(next(&mut own).await.event.id, "in_lost");

    // first retry after 1 s
    until("the reconnect", || a.is_listening()).await;
    a.publish("ws_1", issue_created("in_back"));
    assert_eq!(next(&mut own).await.event.id, "in_back");
    quiet(&mut own).await;
    a.shutdown().await;
    test.drop().await;
}

#[tokio::test]
async fn shutdown_stops_the_listener_and_later_events_stay_local() {
    let Some(test) = setup().await else { return };
    let a = Events::start(test.db.clone(), test.url());
    until("the listener", || a.is_listening()).await;
    a.shutdown().await;
    assert!(!a.is_listening());
    let mut own = a.subscribe();
    a.publish("ws_1", issue_created("in_1"));
    assert_eq!(next(&mut own).await.event.id, "in_1");
    quiet(&mut own).await;
    // shutting down twice is harmless
    a.shutdown().await;
    test.drop().await;
}
