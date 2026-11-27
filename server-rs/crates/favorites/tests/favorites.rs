//! The favorites routes against a real database and the real access guard
//! (`server/test/favorites.e2e-spec.ts`). The three `*.spec.ts` files next to the NestJS module
//! test frontend code (the optimistic toggle queue, list-state scoping, drafts) and have no
//! server behaviour to port.

mod common;

use axum::http::StatusCode;
use sea_orm::EntityTrait;
use serde_json::{Value, json};
use trama_contracts::activity::{LiveEventEntity, LiveEventType};
use trama_entities::favorites;

use common::{
    Req, Res, World, agent_token, issue, only_projects, person, person_with, project, session, sql,
    user, view, workspace,
};

const FAVORITES: &str = "/api/w/acme/favorites";

struct Fx {
    w: World,
    owner: String,
}

async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    workspace(w.db(), "acme").await;
    let owner = person(w.db(), "ws_acme", "owner", "owner").await;
    Some(Fx { w, owner })
}

impl Fx {
    async fn list(&self, cookie: &str) -> Vec<Value> {
        let res = self.w.send(Req::get(FAVORITES).session(cookie)).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.message());
        res.body.as_array().unwrap().clone()
    }

    async fn pin(&self, cookie: &str, kind: &str, subject: &str) -> Res {
        self.w
            .send(
                Req::post(FAVORITES)
                    .session(cookie)
                    .json(json!({ "type": kind, "subjectId": subject })),
            )
            .await
    }

    async fn unpin(&self, cookie: &str, kind: &str, subject: &str) -> Res {
        self.w.send(Req::delete(&format!("{FAVORITES}/{kind}/{subject}")).session(cookie)).await
    }

    async fn pairs(&self, cookie: &str) -> Vec<String> {
        self.list(cookie)
            .await
            .iter()
            .map(|f| {
                format!("{}:{}", f["type"].as_str().unwrap(), f["subjectId"].as_str().unwrap())
            })
            .collect()
    }
}

#[tokio::test]
async fn pins_and_unpins_every_kind_in_the_order_they_were_pinned() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    issue(db, "ws_acme", "in_1", "BUG-1", None).await;
    project(db, "ws_acme", "pj_1").await;
    view(db, "ws_acme", "vw_1", "owner", false).await;

    let pins = [("issue", "in_1"), ("project", "pj_1"), ("view", "vw_1")];
    for (kind, subject) in pins {
        let res = f.pin(&f.owner, kind, subject).await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
        assert_eq!(res.body["type"], kind);
        assert_eq!(res.body["subjectId"], subject);
        assert_eq!(res.body["workspaceId"], "ws_acme");
        assert!(res.body["id"].as_str().unwrap().starts_with("fav_"));
        assert!(res.body["createdAt"].as_str().unwrap().ends_with('Z'));
        // the owner is not part of the wire shape
        assert!(res.body.get("userId").is_none());
    }
    let expected: Vec<String> = pins.iter().map(|(k, s)| format!("{k}:{s}")).collect();
    assert_eq!(f.pairs(&f.owner).await, expected);

    // pinning again changes nothing and returns the existing favorite
    let first = f.list(&f.owner).await[0]["id"].clone();
    let again = f.pin(&f.owner, "issue", "in_1").await;
    assert_eq!(again.status, StatusCode::CREATED);
    assert_eq!(again.body["id"], first);
    assert_eq!(f.list(&f.owner).await.len(), pins.len());

    // unpinning is idempotent
    assert_eq!(f.unpin(&f.owner, "issue", "in_1").await.status, StatusCode::NO_CONTENT);
    assert_eq!(f.unpin(&f.owner, "issue", "in_1").await.status, StatusCode::NO_CONTENT);
    assert_eq!(f.pairs(&f.owner).await, ["project:pj_1", "view:vw_1"]);
    f.w.drop().await;
}

#[tokio::test]
async fn are_private_to_their_owner() {
    let Some(f) = fx().await else { return };
    let other = person(f.w.db(), "ws_acme", "other", "member").await;
    issue(f.w.db(), "ws_acme", "in_1", "BUG-1", None).await;
    assert_eq!(f.pin(&f.owner, "issue", "in_1").await.status, StatusCode::CREATED);

    assert!(f.list(&other).await.is_empty());
    assert_eq!(f.pin(&other, "issue", "in_1").await.status, StatusCode::CREATED);
    assert_eq!(f.unpin(&other, "issue", "in_1").await.status, StatusCode::NO_CONTENT);
    // the owner's one is untouched
    assert_eq!(f.pairs(&f.owner).await, ["issue:in_1"]);
    f.w.drop().await;
}

#[tokio::test]
async fn refuses_unknown_subjects_foreign_private_views_and_bad_input() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    let res = f.pin(&f.owner, "issue", "iss_nope").await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), "issue \"iss_nope\" not found");
    assert_eq!(
        f.pin(&f.owner, "project", "pj_nope").await.message(),
        "project \"pj_nope\" not found"
    );

    let res = f.pin(&f.owner, "banana", "x").await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "type must be one of the following values: issue, project, view");
    // removed kinds are no longer valid favorite types
    for kind in ["decision", "team", "repository", "customer"] {
        assert_eq!(f.pin(&f.owner, kind, "x").await.status, StatusCode::BAD_REQUEST, "{kind}");
    }

    // a missing subject, a wrong type, a missing type and an over-long id
    let post = |body: Value| f.w.send(Req::post(FAVORITES).session(&f.owner).json(body));
    let res = post(json!({ "type": "issue" })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        res.message(),
        "subjectId must be shorter than or equal to 100 characters; subjectId must be a string"
    );
    assert_eq!(
        post(json!({ "type": "issue", "subjectId": 5 })).await.message(),
        "subjectId must be shorter than or equal to 100 characters; subjectId must be a string"
    );
    assert_eq!(
        post(json!({ "type": "issue", "subjectId": "x".repeat(101) })).await.message(),
        "subjectId must be shorter than or equal to 100 characters"
    );
    assert_eq!(
        post(json!({ "subjectId": "x" })).await.message(),
        "type must be one of the following values: issue, project, view"
    );
    assert_eq!(
        post(json!({})).await.message(),
        "type must be one of the following values: issue, project, view; subjectId must be shorter than or equal to 100 characters; subjectId must be a string"
    );
    // an array body is refused before validation
    let res = f.w.send(Req::post(FAVORITES).session(&f.owner).json(json!([]))).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);

    let res = f.unpin(&f.owner, "banana", "x").await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "Validation failed (enum string is expected)");

    // views: a private one of someone else is not found, a shared one can be pinned
    let nosy = person(db, "ws_acme", "nosy", "member").await;
    view(db, "ws_acme", "vw_secret", "owner", false).await;
    view(db, "ws_acme", "vw_open", "owner", true).await;
    assert_eq!(f.pin(&nosy, "view", "vw_secret").await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.pin(&nosy, "view", "vw_open").await.status, StatusCode::CREATED);
    // the owner can pin their own private view
    assert_eq!(f.pin(&f.owner, "view", "vw_secret").await.status, StatusCode::CREATED);
    f.w.drop().await;
}

#[tokio::test]
async fn subjects_of_another_workspace_do_not_exist() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    workspace(db, "globex").await;
    issue(db, "ws_globex", "in_g", "G-1", None).await;
    project(db, "ws_globex", "pj_g").await;
    assert_eq!(f.pin(&f.owner, "issue", "in_g").await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.pin(&f.owner, "project", "pj_g").await.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn forgets_favorites_whose_subject_was_deleted() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    issue(db, "ws_acme", "in_1", "IDEA-1", None).await;
    view(db, "ws_acme", "vw_1", "owner", false).await;
    assert_eq!(f.pin(&f.owner, "issue", "in_1").await.status, StatusCode::CREATED);
    assert_eq!(f.pin(&f.owner, "view", "vw_1").await.status, StatusCode::CREATED);
    assert_eq!(f.pairs(&f.owner).await, ["issue:in_1", "view:vw_1"]);

    sql(db, "DELETE FROM issues WHERE id = 'in_1'").await;
    assert_eq!(f.pairs(&f.owner).await, ["view:vw_1"]);
    // the dangling row is gone for good, not only hidden
    assert_eq!(favorites::Entity::find().all(db).await.unwrap().len(), 1);

    // a view that stops being visible to the person (made private by its owner) is dropped too
    let member = person(db, "ws_acme", "m1", "member").await;
    view(db, "ws_acme", "vw_2", "owner", true).await;
    assert_eq!(f.pin(&member, "view", "vw_2").await.status, StatusCode::CREATED);
    assert_eq!(f.pairs(&member).await, ["view:vw_2"]);
    sql(db, "UPDATE saved_views SET shared = false WHERE id = 'vw_2'").await;
    assert!(f.list(&member).await.is_empty());
    f.w.drop().await;
}

#[tokio::test]
async fn keeps_rows_of_removed_kinds_but_never_lists_them() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    sql(
        db,
        r#"INSERT INTO favorites (id, "workspaceId", "userId", type, "subjectId")
           VALUES ('fav_old', 'ws_acme', 'owner', 'decision', 'dc_1')"#,
    )
    .await;
    assert!(f.list(&f.owner).await.is_empty());
    assert_eq!(favorites::Entity::find().all(db).await.unwrap().len(), 1);
    f.w.drop().await;
}

#[tokio::test]
async fn viewers_can_keep_favorites_and_agents_cannot() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    let viewer = person(db, "ws_acme", "vw", "viewer").await;
    project(db, "ws_acme", "pj_1").await;
    assert_eq!(f.pin(&viewer, "project", "pj_1").await.status, StatusCode::CREATED);
    assert_eq!(f.pairs(&viewer).await, ["project:pj_1"]);
    assert_eq!(f.unpin(&viewer, "project", "pj_1").await.status, StatusCode::NO_CONTENT);

    let secret = agent_token(db, "ws_acme", "ag_1").await;
    let as_agent = |req: Req| f.w.send(req.bearer(&secret));
    let res = as_agent(Req::get(FAVORITES)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "This endpoint requires a user, not an agent token");
    let res =
        as_agent(Req::post(FAVORITES).json(json!({ "type": "project", "subjectId": "pj_1" })))
            .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(
        as_agent(Req::delete(&format!("{FAVORITES}/project/pj_1"))).await.status,
        StatusCode::FORBIDDEN
    );

    // signed out
    assert_eq!(f.w.send(Req::get(FAVORITES)).await.status, StatusCode::UNAUTHORIZED);
    // signed in but not a member of the workspace: the workspace does not exist for them
    user(db, "stranger").await;
    let stranger = session(db, "stranger").await;
    let res = f.w.send(Req::get(FAVORITES).session(&stranger)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn people_limited_to_projects_cannot_pin_or_keep_work_outside_them() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    project(db, "ws_acme", "pj_a").await;
    project(db, "ws_acme", "pj_b").await;
    issue(db, "ws_acme", "in_a", "A-1", Some("pj_a")).await;
    issue(db, "ws_acme", "in_b", "B-1", Some("pj_b")).await;
    issue(db, "ws_acme", "in_none", "N-1", None).await;
    let limited =
        person_with(db, "ws_acme", "lim", "member", Some(only_projects(&["pj_a"], false))).await;

    assert_eq!(f.pin(&limited, "project", "pj_a").await.status, StatusCode::CREATED);
    assert_eq!(f.pin(&limited, "project", "pj_b").await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.pin(&limited, "issue", "in_a").await.status, StatusCode::CREATED);
    assert_eq!(f.pin(&limited, "issue", "in_b").await.status, StatusCode::NOT_FOUND);
    // work without a project is hidden unless the person may see unassigned work
    assert_eq!(f.pin(&limited, "issue", "in_none").await.status, StatusCode::NOT_FOUND);

    // a favorite stops being listed (and is removed) once access ends
    sql(
        db,
        r#"UPDATE memberships SET access = '{"projects":{"all":false,"projectIds":[]},"includeUnassigned":false,"grants":[]}'
           WHERE "userId" = 'lim'"#,
    )
    .await;
    assert!(f.list(&limited).await.is_empty());
    assert!(
        favorites::Entity::find().all(db).await.unwrap().iter().all(|f| f.user_id != "lim"),
        "the dangling rows are removed"
    );

    // a person who may see unassigned work can pin it
    let loose =
        person_with(db, "ws_acme", "loose", "member", Some(only_projects(&["pj_a"], true))).await;
    assert_eq!(f.pin(&loose, "issue", "in_none").await.status, StatusCode::CREATED);
    f.w.drop().await;
}

#[tokio::test]
async fn caps_the_list_per_workspace() {
    let Some(f) = fx().await else { return };
    let db = f.w.db();
    sql(
        db,
        r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status)
           SELECT 'in_' || n, 'ws_acme', 'X-' || n, n, 'bug', 'T', 'manual', 'none', 'backlog'
             FROM generate_series(1, 101) AS n"#,
    )
    .await;
    for n in 1..=100 {
        let res = f.pin(&f.owner, "issue", &format!("in_{n}")).await;
        assert_eq!(res.status, StatusCode::CREATED, "{n}: {}", res.message());
    }
    let res = f.pin(&f.owner, "issue", "in_101").await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.message(), "You can keep up to 100 favorites per workspace");
    // pinning something already pinned still works at the cap
    assert_eq!(f.pin(&f.owner, "issue", "in_1").await.status, StatusCode::CREATED);
    // another workspace has its own list
    workspace(db, "globex").await;
    assert_eq!(f.list(&f.owner).await.len(), 100);
    f.w.drop().await;
}

#[tokio::test]
async fn concurrent_pins_keep_one_favorite_and_publish_once() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", "in_1", "BUG-1", None).await;
    let mut live = f.w.events.subscribe();

    let (a, b, c) = tokio::join!(
        f.pin(&f.owner, "issue", "in_1"),
        f.pin(&f.owner, "issue", "in_1"),
        f.pin(&f.owner, "issue", "in_1"),
    );
    let ids: Vec<&Value> = [&a, &b, &c].iter().map(|r| &r.body["id"]).collect();
    for res in [&a, &b, &c] {
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    }
    assert_eq!(ids[0], ids[1]);
    assert_eq!(ids[1], ids[2]);
    assert_eq!(f.list(&f.owner).await.len(), 1);

    let mut created = 0;
    while let Ok(published) = live.try_recv() {
        assert_eq!(published.event.kind, LiveEventType::Created);
        assert_eq!(published.event.entity, LiveEventEntity::Favorite);
        created += 1;
    }
    assert_eq!(created, 1, "only the request that inserted the row announces it");
    f.w.drop().await;
}

#[tokio::test]
async fn publishes_a_live_event_for_each_pin_and_unpin() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", "in_1", "BUG-1", None).await;
    let mut live = f.w.events.subscribe();

    let id = f.pin(&f.owner, "issue", "in_1").await.body["id"].as_str().unwrap().to_owned();
    // a repeated pin, an unknown subject and an unpin of nothing publish nothing
    f.pin(&f.owner, "issue", "in_1").await;
    f.pin(&f.owner, "issue", "nope").await;
    f.unpin(&f.owner, "project", "pj_nope").await;
    f.unpin(&f.owner, "issue", "in_1").await;
    f.unpin(&f.owner, "issue", "in_1").await;

    let mut seen = Vec::new();
    while let Ok(published) = live.try_recv() {
        assert_eq!(published.workspace_id, "ws_acme");
        assert_eq!(published.user_id, None);
        seen.push((published.event.kind, published.event.entity, published.event.id));
    }
    assert_eq!(
        seen,
        [
            (LiveEventType::Created, LiveEventEntity::Favorite, id.clone()),
            (LiveEventType::Deleted, LiveEventEntity::Favorite, id),
        ]
    );
    f.w.drop().await;
}

#[tokio::test]
async fn the_service_is_callable_without_the_router() {
    let Some(f) = fx().await else { return };
    issue(f.w.db(), "ws_acme", "in_1", "BUG-1", None).await;
    let row = trama_favorites::service::add(
        &f.w.state,
        "ws_acme",
        "owner",
        trama_contracts::identity::FavoriteType::Issue,
        "in_1",
    )
    .await
    .unwrap();
    let rows = trama_favorites::service::list(&f.w.state, "ws_acme", "owner").await.unwrap();
    assert_eq!(rows, [row]);
    f.w.drop().await;
}
