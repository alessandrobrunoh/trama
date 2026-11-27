//! Where a time entry came from (`time-entries.service.spec.ts`): tagging, the list filter,
//! suggestions that never count as a running timer, accepting and dismissing them.

use axum::http::StatusCode;
use sea_orm::{ConnectionTrait, DatabaseConnection, EntityTrait, PaginatorTrait};
use sea_orm_migration::MigratorTrait;
use trama_core::testkit::TestDb;
use trama_core::{AppState, Config};
use trama_entities::time_entries;
use trama_time_entries::service::{self, ManualTimeEntry, Target};

const WS: &str = "ws_1";

async fn setup() -> Option<(TestDb, AppState)> {
    let test = TestDb::create().await?;
    trama_migration::Migrator::up(&test.db, None).await.unwrap();
    let db = &test.db;
    sql(
        db,
        "INSERT INTO workspaces (id, name, slug, settings, personal) VALUES ('ws_1', 'W', 'w', '{}', false)",
    )
    .await;
    for user in ["usr_a", "usr_b"] {
        sql(
            db,
            &format!(
                r#"INSERT INTO users (id, name, email, "passwordHash", "avatarHue") VALUES ('{user}', '{user}', '{user}@test.dev', 'x', 1)"#
            ),
        )
        .await;
    }
    let state = AppState::new(test.db.clone(), Config::from_vars(&[]));
    Some((test, state))
}

async fn sql(db: &DatabaseConnection, statement: &str) {
    db.execute_unprepared(statement).await.unwrap();
}

/// A suggestion of `user`, finished 47 minutes after it started, or still open when `open`.
async fn suggestion(db: &DatabaseConnection, user: &str, id: &str, open: bool) {
    let ended = if open { "NULL" } else { "TIMESTAMPTZ '2026-10-28T10:47:00Z'" };
    sql(
        db,
        &format!(
            r#"INSERT INTO time_entries (id, "workspaceId", "userId", description, source, "startedAt", "endedAt")
               VALUES ('{id}', 'ws_1', '{user}', '', 'suggested', TIMESTAMPTZ '2026-10-28T10:00:00Z', {ended})"#
        ),
    )
    .await;
}

fn manual() -> ManualTimeEntry {
    ManualTimeEntry {
        target: Target::default(),
        started_at: trama_milestones::dates::parse("2026-10-28T10:00:00.000Z").unwrap(),
        ended_at: trama_milestones::dates::parse("2026-10-28T11:00:00.000Z").unwrap(),
    }
}

fn status(error: &trama_core::AppError) -> StatusCode {
    error.status_code()
}

#[tokio::test]
async fn tags_entries_by_how_they_were_made() {
    let Some((test, state)) = setup().await else { return };
    let started = service::start(&state, WS, "usr_a", Target::default()).await.unwrap();
    assert_eq!(started.source.as_str(), "timer");
    let added = service::add(&state, WS, "usr_a", manual()).await.unwrap();
    assert_eq!(added.source.as_str(), "manual");
    test.drop().await;
}

#[tokio::test]
async fn leaves_suggestions_out_of_the_list_until_they_are_asked_for() {
    let Some((test, state)) = setup().await else { return };
    service::add(&state, WS, "usr_a", manual()).await.unwrap();
    suggestion(&test.db, "usr_a", "te_s", false).await;
    let sources = |rows: Vec<trama_time_entries::schemas::TimeEntry>| -> Vec<String> {
        rows.iter().map(|row| row.source.as_str().to_owned()).collect()
    };
    assert_eq!(sources(service::list(&state, WS, "usr_a", None).await.unwrap()), ["manual"]);
    let suggested = service::list(
        &state,
        WS,
        "usr_a",
        Some(trama_contracts::threads::TimeEntrySource::Suggested),
    )
    .await
    .unwrap();
    assert_eq!(suggested.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["te_s"]);
    let manual_only =
        service::list(&state, WS, "usr_a", Some(trama_contracts::threads::TimeEntrySource::Manual))
            .await
            .unwrap();
    assert_eq!(manual_only.len(), 1);
    test.drop().await;
}

#[tokio::test]
async fn a_suggestion_is_never_a_running_timer() {
    let Some((test, state)) = setup().await else { return };
    // starting a timer leaves a finished suggestion alone, and stopping finds only the timer
    suggestion(&test.db, "usr_a", "te_s", false).await;
    let started = service::start(&state, WS, "usr_a", Target::default()).await.unwrap();
    assert!(started.ended_at.is_none());
    let row = time_entries::Entity::find_by_id("te_s").one(&test.db).await.unwrap().unwrap();
    assert_eq!(row.source, "suggested");
    let stopped = service::stop(&state, WS, "usr_a").await.unwrap();
    assert_eq!(stopped.id, started.id);
    // a person with nothing but a (never finished) suggestion has no timer to stop
    suggestion(&test.db, "usr_b", "te_t", true).await;
    let error = service::stop(&state, WS, "usr_b").await.unwrap_err();
    assert_eq!(status(&error), StatusCode::BAD_REQUEST);
    assert_eq!(error.to_string(), "400 Bad Request: No timer is running");
    let row = time_entries::Entity::find_by_id("te_t").one(&test.db).await.unwrap().unwrap();
    assert!(row.ended_at.is_none());
    test.drop().await;
}

#[tokio::test]
async fn only_the_owner_accepts_a_suggestion_and_only_a_suggestion_can_be_accepted() {
    let Some((test, state)) = setup().await else { return };
    suggestion(&test.db, "usr_a", "te_s", false).await;
    let stranger = service::accept(&state, WS, "usr_b", "te_s").await.unwrap_err();
    assert_eq!(stranger.to_string(), "404 Not Found: Time entry \"te_s\" not found");
    let missing = service::accept(&state, WS, "usr_a", "te_missing").await.unwrap_err();
    assert_eq!(status(&missing), StatusCode::NOT_FOUND);

    let before = time_entries::Entity::find_by_id("te_s").one(&test.db).await.unwrap().unwrap();
    let accepted = service::accept(&state, WS, "usr_a", "te_s").await.unwrap();
    assert_eq!(accepted.source.as_str(), "manual");
    assert!(accepted.updated_at >= trama_core::time::to_iso(&before.updated_at));
    let listed = service::list(&state, WS, "usr_a", None).await.unwrap();
    assert_eq!(listed.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["te_s"]);

    let again = service::accept(&state, WS, "usr_a", "te_s").await.unwrap_err();
    assert_eq!(again.to_string(), "400 Bad Request: Only a suggested entry can be accepted");
    let timer = service::start(&state, WS, "usr_a", Target::default()).await.unwrap();
    let on_a_timer = service::accept(&state, WS, "usr_a", &timer.id).await.unwrap_err();
    assert_eq!(status(&on_a_timer), StatusCode::BAD_REQUEST);
    test.drop().await;
}

#[tokio::test]
async fn dismissing_a_suggestion_deletes_it() {
    let Some((test, state)) = setup().await else { return };
    suggestion(&test.db, "usr_a", "te_s", false).await;
    service::remove(&state, WS, "usr_a", "te_s").await.unwrap();
    assert_eq!(time_entries::Entity::find().count(&test.db).await.unwrap(), 0);
    test.drop().await;
}
