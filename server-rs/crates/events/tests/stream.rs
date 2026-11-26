//! `GET /api/w/:slug/events/stream`: `events.controller.spec.ts` (hidden live subjects are
//! dropped before anything is written) and `events-stream-visibility.e2e-spec.ts` (visible events
//! only, closes when project access changes), plus per-user events, pings and credential checks.

mod common;

use std::time::Duration;

use axum::http::StatusCode;
use serde_json::Value;
use trama_contracts::activity::{LiveEventEntity, LiveEventType};
use trama_contracts::common::{ActorRef, SubjectRef, SubjectType};
use trama_events::{LiveChange, RecordEvent};

use common::{
    Frame, Req, Sse, World, issue, member, only_projects, project, session, sql, user, workspace,
};

const WAIT: Duration = Duration::from_secs(5);
const QUIET: Duration = Duration::from_millis(500);

fn subject(kind: SubjectType, id: &str) -> SubjectRef {
    SubjectRef { kind, id: id.to_owned() }
}

/// Owner `u_owner` and viewer `u_viewer`, who reaches only `pr_vis`, in `acme`. `pr_vis` and
/// `pr_hid` hold one issue each.
async fn scene(w: &World) -> (String, String) {
    workspace(w.db(), "acme").await;
    workspace(w.db(), "other").await;
    user(w.db(), "u_owner").await;
    user(w.db(), "u_viewer").await;
    member(w.db(), "ws_acme", "u_owner", "owner", None).await;
    member(w.db(), "ws_acme", "u_viewer", "viewer", Some(only_projects(&["pr_vis"], false))).await;
    project(w.db(), "ws_acme", "pr_vis").await;
    project(w.db(), "ws_acme", "pr_hid").await;
    issue(w.db(), "ws_acme", "in_vis", Some("pr_vis")).await;
    issue(w.db(), "ws_acme", "in_hid", Some("pr_hid")).await;
    (session(w.db(), "u_owner").await, session(w.db(), "u_viewer").await)
}

async fn open(w: &World, cookie: &str) -> Sse {
    let (status, _, sse) = w
        .open_stream(
            Req::get("/api/w/acme/events/stream")
                .session(cookie)
                .header("accept", "text/event-stream"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    sse
}

async fn record(w: &World, kind: &str, about: SubjectRef, live: Option<LiveChange>) {
    let mut input = RecordEvent::new("ws_acme", ActorRef::user("u_owner"), kind, about);
    if let Some(change) = live {
        input = input.live(change);
    }
    w.events.record(w.db(), input).await.unwrap();
}

/// The `(entity, id)` of every data message until the stream has been quiet for [`QUIET`].
async fn drain(sse: &mut Sse) -> Vec<(String, String)> {
    let mut seen = Vec::new();
    loop {
        match sse.next(QUIET).await {
            Frame::Message { event: None, data, .. } => {
                let v: Value = serde_json::from_str(&data).unwrap();
                seen.push((
                    v["entity"].as_str().unwrap().to_owned(),
                    v["id"].as_str().unwrap().to_owned(),
                ));
            }
            Frame::Message { .. } => {}
            Frame::Timeout | Frame::Closed => return seen,
        }
    }
}

#[tokio::test]
async fn opens_an_event_stream_with_the_sse_headers() {
    let Some(w) = World::new().await else { return };
    let (owner, _) = scene(&w).await;
    let (status, headers, sse) =
        w.open_stream(Req::get("/api/w/acme/events/stream").session(&owner)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/event-stream"));
    assert_eq!(
        headers["cache-control"],
        "private, no-cache, no-store, must-revalidate, max-age=0, no-transform"
    );
    assert_eq!(headers["x-accel-buffering"], "no");
    assert_eq!(headers["connection"], "keep-alive");
    drop(sse);
    w.drop().await;
}

#[tokio::test]
async fn needs_a_session_and_membership() {
    let Some(w) = World::new().await else { return };
    scene(&w).await;
    user(w.db(), "u_out").await;
    member(w.db(), "ws_other", "u_out", "owner", None).await;
    let outsider = session(w.db(), "u_out").await;
    let (status, ..) = w.open_stream(Req::get("/api/w/acme/events/stream")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, ..) =
        w.open_stream(Req::get("/api/w/acme/events/stream").session(&outsider)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    w.drop().await;
}

/// `delivers visible events only and closes when project access changes`.
#[tokio::test]
async fn delivers_visible_events_only_and_closes_when_project_access_changes() {
    let Some(w) = World::fast_recheck().await else { return };
    let (_, viewer) = scene(&w).await;
    let mut sse = open(&w, &viewer).await;

    record(&w, "project.updated", subject(SubjectType::Project, "pr_vis"), None).await;
    record(&w, "project.updated", subject(SubjectType::Project, "pr_hid"), None).await;
    record(&w, "issue.created", subject(SubjectType::Issue, "in_hid"), None).await;
    record(&w, "issue.created", subject(SubjectType::Issue, "in_vis"), None).await;
    let comment = |id: &str| Some(LiveChange::created(LiveEventEntity::Comment, id));
    record(&w, "comment.created", subject(SubjectType::Issue, "in_hid"), comment("cm_hid")).await;
    record(&w, "comment.created", subject(SubjectType::Issue, "in_vis"), comment("cm_vis")).await;

    // the first message is the first visible event, as LiveEvent JSON
    let first = sse.next(WAIT).await;
    assert!(matches!(&first, Frame::Message { event: None, id: Some(1), .. }), "{first:?}");
    let live = first.json();
    assert_eq!(live["type"], "updated");
    assert_eq!((live["entity"].as_str(), live["id"].as_str()), (Some("project"), Some("pr_vis")));
    assert_eq!(live["at"].as_str().unwrap().len(), 24);
    assert_eq!(live.as_object().unwrap().len(), 4, "type, entity, id, at: {live}");

    let rest = drain(&mut sse).await;
    assert_eq!(
        rest,
        [("issue".into(), "in_vis".into()), ("comment".into(), "cm_vis".into())],
        "hidden project, issue and comment events are never written"
    );

    // the member's project list is emptied: the stream ends
    sql(
        w.db(),
        &format!(
            r#"UPDATE memberships SET access = '{}' WHERE "userId" = 'u_viewer'"#,
            only_projects(&[], false)
        ),
    )
    .await;
    assert_eq!(sse.next(Duration::from_secs(3)).await, Frame::Closed);
    w.drop().await;
}

/// `drops hidden live subjects before writing SSE messages`.
#[tokio::test]
async fn drops_hidden_live_subjects_before_writing_messages() {
    let Some(w) = World::new().await else { return };
    let (_, viewer) = scene(&w).await;
    let mut sse = open(&w, &viewer).await;
    let on = |id: &str| Some(subject(SubjectType::Issue, id).into());
    let created = |id: &str| LiveChange::created(LiveEventEntity::Issue, id);
    w.events.publish_with("ws_acme", created("iss_hidden"), None, on("in_hid"));
    w.events.publish_with("ws_acme", created("iss_visible"), None, on("in_vis"));
    let got = sse.next(WAIT).await;
    assert_eq!(got.json()["id"], "iss_visible");
    assert!(matches!(sse.next(QUIET).await, Frame::Timeout));
    w.drop().await;
}

#[tokio::test]
async fn an_event_that_cannot_be_resolved_is_not_shown_to_a_narrowed_member() {
    let Some(w) = World::new().await else { return };
    let (owner, viewer) = scene(&w).await;
    let (mut narrowed, mut full) = (open(&w, &viewer).await, open(&w, &owner).await);
    // an issue nobody has heard of, and a comment that does not exist
    w.events.publish("ws_acme", LiveChange::updated(LiveEventEntity::Issue, "in_unknown"));
    w.events.publish("ws_acme", LiveChange::updated(LiveEventEntity::Comment, "cm_unknown"));
    assert!(drain(&mut narrowed).await.is_empty());
    assert_eq!(drain(&mut full).await.len(), 2, "the owner is not narrowed");
    w.drop().await;
}

#[tokio::test]
async fn events_of_other_workspaces_and_other_people_are_not_delivered() {
    let Some(w) = World::new().await else { return };
    let (owner, viewer) = scene(&w).await;
    let (mut owner_sse, mut viewer_sse) = (open(&w, &owner).await, open(&w, &viewer).await);

    w.events.publish("ws_other", LiveChange::updated(LiveEventEntity::Workspace, "ws_other"));
    // addressed to the owner: the narrowed viewer must not see it
    w.events.publish_to_user(
        "ws_acme",
        LiveChange::created(LiveEventEntity::Notification, "nt_owner"),
        "u_owner",
    );
    // addressed to the viewer: delivered although the viewer is narrowed (it is their own)
    w.events.publish_to_user(
        "ws_acme",
        LiveChange::created(LiveEventEntity::Notification, "nt_viewer"),
        "u_viewer",
    );
    w.events.publish("ws_acme", LiveChange::updated(LiveEventEntity::Workspace, "ws_acme"));

    assert_eq!(
        drain(&mut owner_sse).await,
        [("notification".into(), "nt_owner".into()), ("workspace".into(), "ws_acme".into())]
    );
    // the workspace event is workspace-level: hidden from a member without `includeUnassigned`
    assert_eq!(drain(&mut viewer_sse).await, [("notification".into(), "nt_viewer".into())]);
    w.drop().await;
}

#[tokio::test]
async fn messages_are_numbered_and_carry_the_client_id_of_the_request() {
    let Some(w) = World::new().await else { return };
    let (owner, _) = scene(&w).await;
    let mut sse = open(&w, &owner).await;
    trama_common::request_context::scope(Some("tab-3".into()), async {
        record(&w, "issue.created", subject(SubjectType::Issue, "in_vis"), None).await;
    })
    .await;
    record(&w, "issue.deleted", subject(SubjectType::Issue, "in_vis"), None).await;
    let (a, b) = (sse.next(WAIT).await, sse.next(WAIT).await);
    assert!(matches!(&a, Frame::Message { id: Some(1), .. }), "{a:?}");
    assert!(matches!(&b, Frame::Message { id: Some(2), .. }), "{b:?}");
    assert_eq!(a.json()["clientId"], "tab-3");
    assert_eq!(a.json()["type"], "created");
    assert!(b.json().get("clientId").is_none());
    assert_eq!(b.json()["type"], "deleted");
    w.drop().await;
}

#[tokio::test]
async fn closes_when_the_session_ends_or_the_membership_changes() {
    let Some(w) = World::fast_recheck().await else { return };
    let (owner, viewer) = scene(&w).await;
    // logged out
    let mut sse = open(&w, &owner).await;
    sql(w.db(), r#"DELETE FROM sessions WHERE "userId" = 'u_owner'"#).await;
    assert_eq!(sse.next(Duration::from_secs(3)).await, Frame::Closed);
    // role changed
    let mut sse = open(&w, &viewer).await;
    assert!(matches!(sse.next(Duration::from_millis(400)).await, Frame::Timeout), "still open");
    sql(w.db(), r#"UPDATE memberships SET role = 'member' WHERE "userId" = 'u_viewer'"#).await;
    assert_eq!(sse.next(Duration::from_secs(3)).await, Frame::Closed);
    // removed
    let viewer = session(w.db(), "u_viewer").await;
    let mut sse = open(&w, &viewer).await;
    sql(w.db(), r#"DELETE FROM memberships WHERE "userId" = 'u_viewer'"#).await;
    assert_eq!(sse.next(Duration::from_secs(3)).await, Frame::Closed);
    w.drop().await;
}

#[tokio::test]
async fn closes_when_an_api_token_is_revoked() {
    let Some(w) = World::fast_recheck().await else { return };
    scene(&w).await;
    let (row, secret) = common::token(
        w.db(),
        "ws_acme",
        ActorRef::user("u_owner"),
        trama_contracts::roles::TokenScope::Read,
        None,
        None,
    )
    .await;
    let (status, _, mut sse) =
        w.open_stream(Req::get("/api/w/acme/events/stream").bearer(&secret)).await;
    assert_eq!(status, StatusCode::OK);
    record(&w, "issue.created", subject(SubjectType::Issue, "in_vis"), None).await;
    assert_eq!(sse.next(WAIT).await.json()["id"], "in_vis");
    sql(w.db(), &format!("DELETE FROM api_tokens WHERE id = '{}'", row.id)).await;
    assert_eq!(sse.next(Duration::from_secs(3)).await, Frame::Closed);
    w.drop().await;
}

#[tokio::test]
async fn sends_a_ping_every_25_seconds() {
    // no credential re-check while the clock is paused
    let Some(w) =
        World::with_config(trama_core::Config::from_vars(&[("TRAMA_SSE_RECHECK_MS", "3600000")]))
            .await
    else {
        return;
    };
    let (owner, _) = scene(&w).await;
    let mut sse = open(&w, &owner).await;
    // let the stream task reach its first wait on the real clock, then jump the clock
    tokio::time::sleep(Duration::from_millis(200)).await;
    tokio::time::pause();
    let first = sse.next(Duration::from_secs(26)).await;
    let Frame::Message { event, id, data } = first else { panic!("{first:?}") };
    assert_eq!((event.as_deref(), id), (Some("ping"), Some(1)));
    let at = serde_json::from_str::<Value>(&data).unwrap()["at"].as_str().unwrap().to_owned();
    assert_eq!(at.len(), 24);
    assert!(at.ends_with('Z'));
    let second = sse.next(Duration::from_secs(26)).await;
    assert!(
        matches!(second, Frame::Message { event: Some(ref e), id: Some(2), .. } if e == "ping"),
        "{second:?}"
    );
    tokio::time::resume();
    w.drop().await;
}

#[tokio::test]
async fn reports_an_error_and_closes_when_an_event_cannot_be_checked() {
    let Some(w) = World::new().await else { return };
    let (_, viewer) = scene(&w).await;
    let mut sse = open(&w, &viewer).await;
    // a narrowed member's comment events are resolved through the comments table
    sql(w.db(), "DROP TABLE comments").await;
    w.events.publish(
        "ws_acme",
        LiveChange::new(LiveEventType::Updated, LiveEventEntity::Comment, "cm_1"),
    );
    let frame = sse.next(WAIT).await;
    assert!(
        matches!(&frame, Frame::Message { event: Some(e), data, .. } if e == "error" && data == "Internal server error"),
        "{frame:?}"
    );
    assert_eq!(sse.next(WAIT).await, Frame::Closed);
    w.drop().await;
}
