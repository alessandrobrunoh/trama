//! The project update routes against a real database and the real access guard: the cases of
//! `project-updates.e2e-spec.ts` and `project-updates.service.spec.ts`. The transfer case of the
//! e2e spec (updates move with their project) is in `trama-sharing`'s `transfer` tests.

mod common;

use axum::http::StatusCode;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};
use trama_auth::tokens::{NewToken, create_token};
use trama_contracts::activity::{LiveEventEntity, LiveEventType};
use trama_contracts::common::ActorRef;
use trama_contracts::projects::PROJECT_UPDATE_BODY_MAX;
use trama_contracts::roles::TokenScope;
use trama_entities::{domain_events, project_updates};

use common::{Req, Res, World, agent_token, member, narrowed, person, sql, user, workspace};

const PJ: &str = "/api/w/acme/projects";

/// A workspace `acme` with an owner and two projects, `alpha` and `beta`.
struct Fx {
    w: World,
    owner: String,
    alpha: String,
    beta: String,
}

async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    workspace(w.db(), "acme").await;
    let owner = person(w.db(), "ws_acme", "owner", "owner").await;
    let mut fx = Fx { w, owner, alpha: String::new(), beta: String::new() };
    fx.alpha = fx.project("Alpha").await;
    fx.beta = fx.project("Beta").await;
    Some(fx)
}

impl Fx {
    async fn send(
        &self,
        cookie: &str,
        req: fn(&str) -> Req,
        path: &str,
        body: Option<Value>,
    ) -> Res {
        let req = req(path).session(cookie);
        self.w
            .send(match body {
                Some(body) => req.json(body),
                None => req,
            })
            .await
    }
    async fn get(&self, cookie: &str, path: &str) -> Res {
        self.send(cookie, Req::get, path, None).await
    }
    async fn post(&self, cookie: &str, path: &str, body: Value) -> Res {
        self.send(cookie, Req::post, path, Some(body)).await
    }
    async fn patch(&self, cookie: &str, path: &str, body: Value) -> Res {
        self.send(cookie, Req::patch, path, Some(body)).await
    }
    async fn delete(&self, cookie: &str, path: &str) -> Res {
        self.send(cookie, Req::delete, path, None).await
    }

    /// A project made by the owner; returns its id.
    async fn project(&self, name: &str) -> String {
        let res = self.post(&self.owner, PJ, json!({ "name": name })).await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
        res.body["id"].as_str().unwrap().to_owned()
    }

    /// A user with a session and the role.
    async fn person(&self, id: &str, role: &str) -> (String, String) {
        (person(self.w.db(), "ws_acme", id, role).await, id.to_owned())
    }

    /// A guest limited to `project`; returns their session cookie.
    async fn guest(&self, id: &str, project: &str, grants: &[&str]) -> String {
        user(self.w.db(), id).await;
        let access = json!({
            "projects": { "all": false, "projectIds": [project] },
            "includeUnassigned": false,
            "grants": grants,
        });
        member(self.w.db(), "ws_acme", id, "guest", Some(access)).await;
        common::session(self.w.db(), id).await
    }

    /// An update posted by `cookie`; panics unless it is created.
    async fn posted(&self, cookie: &str, project: &str, body: Value) -> Value {
        let res = self.post(cookie, &updates(project), body).await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
        res.body
    }

    async fn project_health(&self, project: &str) -> Value {
        self.get(&self.owner, &format!("{PJ}/{project}")).await.body["health"].clone()
    }

    async fn event_types(&self) -> Vec<String> {
        domain_events::Entity::find()
            .filter(domain_events::Column::WorkspaceId.eq("ws_acme"))
            .order_by_asc(domain_events::Column::At)
            .all(self.w.db())
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.r#type)
            .collect()
    }

    async fn stored(&self, project: &str) -> u64 {
        project_updates::Entity::find()
            .filter(project_updates::Column::ProjectId.eq(project))
            .count(self.w.db())
            .await
            .unwrap()
    }
}

fn updates(project: &str) -> String {
    format!("{PJ}/{project}/updates")
}

fn update(project: &str, id: &Value) -> String {
    format!("{PJ}/{project}/updates/{}", id.as_str().unwrap())
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array().unwrap().iter().map(|u| u["id"].as_str().unwrap().to_owned()).collect()
}

/// A token of `actor` with `scope`; returns the secret.
async fn token(f: &Fx, actor: ActorRef, scope: TokenScope) -> String {
    let (_, secret) = create_token(
        f.w.db(),
        NewToken {
            workspace_id: "ws_acme".into(),
            name: "t".into(),
            actor,
            scope: Some(scope),
            permissions: None,
            limits: None,
            created_by_user_id: None,
            expires_at: None,
        },
    )
    .await
    .unwrap();
    secret
}

// ── project-updates.e2e-spec.ts ──

#[tokio::test]
async fn a_member_posts_and_lists_updates_newest_first() {
    let Some(f) = fx().await else { return };
    let (maya, _) = f.person("maya", "member").await;
    let url = updates(&f.alpha);
    let mut live = f.w.events.subscribe();

    let empty = f.get(&maya, &url).await;
    assert_eq!((empty.status, empty.body), (StatusCode::OK, json!([])));
    let res = f.post(&maya, &url, json!({ "body": "  Kicked off the work \n" })).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    let first = res.body;
    assert_eq!(first["workspaceId"], "ws_acme");
    assert_eq!(first["projectId"], f.alpha);
    assert_eq!(first["author"], json!({ "type": "user", "id": "maya" }));
    assert_eq!(first["body"], "Kicked off the work");
    assert!(first["id"].as_str().unwrap().starts_with("pu_"));
    assert!(first.get("health").is_none() && first.get("editedAt").is_none(), "{first}");
    assert!(first["createdAt"].as_str().unwrap().ends_with('Z'));
    let second = f.posted(&f.owner, &f.alpha, json!({ "body": "Second update" })).await;

    let listed = f.get(&maya, &url).await;
    assert_eq!(ids(&listed.body), [second["id"].as_str().unwrap(), first["id"].as_str().unwrap()]);
    // another project has its own list
    assert_eq!(f.get(&f.owner, &updates(&f.beta)).await.body, json!([]));

    // the post is a domain event about the project, and a live `created project_update`
    let rows = domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq("project.update_posted"))
        .order_by_asc(domain_events::Column::At)
        .all(f.w.db())
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].subject, json!({ "type": "project", "id": f.alpha }));
    assert_eq!(
        rows[0].data,
        json!({ "updateId": first["id"], "excerpt": "Kicked off the work", "health": null })
    );
    assert_eq!(rows[0].actor, json!({ "type": "user", "id": "maya" }));
    let mut seen = Vec::new();
    while let Ok(published) = live.try_recv() {
        seen.push((published.event.kind, published.event.entity, published.event.id.clone()));
    }
    for posted in [&first, &second] {
        let id = posted["id"].as_str().unwrap().to_owned();
        assert!(
            seen.contains(&(LiveEventType::Created, LiveEventEntity::ProjectUpdate, id.clone())),
            "{seen:?}"
        );
    }
    f.w.drop().await;
}

#[tokio::test]
async fn a_project_the_caller_cannot_see_is_a_404_for_every_route() {
    let Some(f) = fx().await else { return };
    let insider = narrowed(f.w.db(), "ws_acme", "ivan", &[&f.beta], false).await;
    let posted = f.posted(&f.owner, &f.alpha, json!({ "body": "Alpha only" })).await;
    let url = updates(&f.alpha);

    assert_eq!(f.get(&insider, &format!("{PJ}/{}", f.alpha)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.get(&insider, &url).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        f.post(&insider, &url, json!({ "body": "Sneaking in" })).await.status,
        StatusCode::NOT_FOUND
    );
    let edit =
        f.patch(&insider, &update(&f.alpha, &posted["id"]), json!({ "body": "Edited" })).await;
    assert_eq!(edit.status, StatusCode::NOT_FOUND);
    let del = f.delete(&insider, &update(&f.alpha, &posted["id"])).await;
    assert_eq!(del.status, StatusCode::NOT_FOUND);
    // their own project works
    let own = f.post(&insider, &updates(&f.beta), json!({ "body": "Beta news" })).await;
    assert_eq!(own.status, StatusCode::CREATED, "{}", own.message());
    // and nothing happened to the hidden one
    let left = f.get(&f.owner, &url).await;
    assert_eq!(left.body.as_array().unwrap().len(), 1);
    assert_eq!(left.body[0]["body"], "Alpha only");
    f.w.drop().await;
}

#[tokio::test]
async fn a_guest_on_the_project_can_read_but_not_post_edit_or_delete() {
    let Some(f) = fx().await else { return };
    let guest = f.guest("gina", &f.alpha, &[]).await;
    let url = updates(&f.alpha);
    let posted = f.posted(&f.owner, &f.alpha, json!({ "body": "Visible to the guest" })).await;

    let seen = f.get(&guest, &url).await;
    assert_eq!(seen.status, StatusCode::OK);
    assert_eq!(ids(&seen.body), [posted["id"].as_str().unwrap()]);
    assert_eq!(
        f.post(&guest, &url, json!({ "body": "Guest post" })).await.status,
        StatusCode::FORBIDDEN
    );
    let edit =
        f.patch(&guest, &update(&f.alpha, &posted["id"]), json!({ "body": "Guest edit" })).await;
    assert_eq!(edit.status, StatusCode::FORBIDDEN);
    let del = f.delete(&guest, &update(&f.alpha, &posted["id"])).await;
    assert_eq!(del.status, StatusCode::FORBIDDEN);
    // another project of the workspace is not theirs
    assert_eq!(f.get(&guest, &updates(&f.beta)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.stored(&f.alpha).await, 1);
    f.w.drop().await;
}

#[tokio::test]
async fn a_viewer_reads_but_cannot_post() {
    let Some(f) = fx().await else { return };
    let (viewer, _) = f.person("vic", "viewer").await;
    let url = updates(&f.alpha);
    f.posted(&f.owner, &f.alpha, json!({ "body": "News" })).await;

    assert_eq!(f.get(&viewer, &url).await.body.as_array().unwrap().len(), 1);
    assert_eq!(
        f.post(&viewer, &url, json!({ "body": "Nope" })).await.status,
        StatusCode::FORBIDDEN
    );
    f.w.drop().await;
}

#[tokio::test]
async fn only_the_author_edits_and_editing_leaves_the_project_health_alone() {
    let Some(f) = fx().await else { return };
    let (author, _) = f.person("ada", "member").await;
    let (other, _) = f.person("otto", "member").await;
    let url = updates(&f.alpha);
    let posted =
        f.posted(&author, &f.alpha, json!({ "body": "First draft", "health": "on_track" })).await;
    assert_eq!(posted["health"], "on_track");
    let one = update(&f.alpha, &posted["id"]);

    let hijack = f.patch(&other, &one, json!({ "body": "Hijacked" })).await;
    assert_eq!(
        (hijack.status, hijack.message()),
        (StatusCode::FORBIDDEN, "Only the author can edit an update".into())
    );
    // not even the owner
    let owner = f.patch(&f.owner, &one, json!({ "body": "Even the owner cannot" })).await;
    assert_eq!(owner.status, StatusCode::FORBIDDEN);

    let res =
        f.patch(&author, &one, json!({ "body": "  Final text ", "health": "off_track" })).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.message());
    let edited = res.body;
    assert_eq!(edited["id"], posted["id"]);
    assert_eq!(edited["body"], "Final text");
    assert_eq!(edited["health"], "off_track");
    assert_eq!(edited["author"]["id"], "ada");
    assert!(edited["editedAt"].as_str().is_some());
    assert_eq!(edited["createdAt"], posted["createdAt"]);

    // editing the health of the update does not move the project's health: only posting does
    assert_eq!(f.project_health(&f.alpha).await, "on_track");

    let cleared = f.patch(&author, &one, json!({ "health": null })).await;
    assert_eq!(cleared.status, StatusCode::OK);
    assert!(cleared.body.get("health").is_none(), "{}", cleared.body);
    for (body, status) in [
        (json!({ "health": "great" }), StatusCode::BAD_REQUEST),
        (json!({ "body": "" }), StatusCode::BAD_REQUEST),
        (json!({ "body": "   " }), StatusCode::BAD_REQUEST),
        (json!({ "body": null }), StatusCode::BAD_REQUEST),
        (json!({ "body": "x".repeat(PROJECT_UPDATE_BODY_MAX + 1) }), StatusCode::BAD_REQUEST),
    ] {
        assert_eq!(f.patch(&author, &one, body.clone()).await.status, status, "{body}");
    }
    let missing = f.patch(&author, &format!("{url}/upd_missing"), json!({ "body": "x" })).await;
    assert_eq!(
        (missing.status, missing.message()),
        (StatusCode::NOT_FOUND, "Project update \"upd_missing\" not found".into())
    );
    // an update of another project is a 404
    let elsewhere =
        f.patch(&f.owner, &update(&f.beta, &posted["id"]), json!({ "body": "x" })).await;
    assert_eq!(elsewhere.status, StatusCode::NOT_FOUND);

    let listed = f.get(&author, &url).await;
    assert_eq!(listed.body[0]["body"], "Final text");
    f.w.drop().await;
}

#[tokio::test]
async fn the_author_or_a_project_manager_deletes_an_update() {
    let Some(f) = fx().await else { return };
    let (author, _) = f.person("ada", "member").await;
    // granted `projects:delete`, so the guard passes and the service decides
    let guest = f.guest("gina", &f.alpha, &["projects:delete"]).await;
    let (manager, _) = f.person("mia", "member").await;
    let url = updates(&f.alpha);

    let own = f.posted(&author, &f.alpha, json!({ "body": "Mine" })).await;
    assert_eq!(
        f.delete(&author, &update(&f.alpha, &own["id"])).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        f.delete(&author, &update(&f.alpha, &own["id"])).await.status,
        StatusCode::NOT_FOUND
    );

    let theirs = f.posted(&author, &f.alpha, json!({ "body": "Moderated" })).await;
    let refused = f.delete(&guest, &update(&f.alpha, &theirs["id"])).await;
    assert_eq!(
        (refused.status, refused.message()),
        (
            StatusCode::FORBIDDEN,
            "Only the author or someone who manages projects can delete an update".into()
        )
    );
    assert_eq!(
        f.delete(&manager, &update(&f.alpha, &theirs["id"])).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(f.get(&f.owner, &url).await.body, json!([]));
    f.w.drop().await;
}

#[tokio::test]
async fn an_author_without_manage_projects_still_deletes_their_own_update() {
    // service spec: "lets the author delete their own update, even without manageProjects".
    // A guest cannot post, but can be the stored author (a role changed after the post).
    let Some(f) = fx().await else { return };
    let guest = f.guest("gina", &f.alpha, &["projects:delete"]).await;
    sql(
        f.w.db(),
        &format!(
            r#"INSERT INTO project_updates (id, "workspaceId", "projectId", author, body)
               VALUES ('pu_mine', 'ws_acme', '{}', '{{"type":"user","id":"gina"}}'::jsonb, 'Mine')"#,
            f.alpha
        ),
    )
    .await;
    let res = f.delete(&guest, &update(&f.alpha, &json!("pu_mine"))).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.message());
    assert_eq!(f.stored(&f.alpha).await, 0);
    f.w.drop().await;
}

#[tokio::test]
async fn posting_with_a_health_sets_the_project_health_with_the_usual_events() {
    let Some(f) = fx().await else { return };
    let url = updates(&f.alpha);
    assert_eq!(f.project_health(&f.alpha).await, Value::Null);

    let posted =
        f.posted(&f.owner, &f.alpha, json!({ "body": "Risky", "health": "at_risk" })).await;
    assert_eq!(posted["health"], "at_risk");
    assert_eq!(f.project_health(&f.alpha).await, "at_risk");
    let changed = domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq("project.health_changed"))
        .all(f.w.db())
        .await
        .unwrap();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].subject["id"], f.alpha);
    assert_eq!(changed[0].data, json!({ "from": null, "to": "at_risk" }));
    let types = f.event_types().await;
    assert!(types.contains(&"project.update_posted".to_owned()), "{types:?}");

    // an update without a health leaves the project's health as it is
    f.posted(&f.owner, &f.alpha, json!({ "body": "Just words" })).await;
    assert_eq!(f.project_health(&f.alpha).await, "at_risk");
    // the same health again does not touch the project
    f.posted(&f.owner, &f.alpha, json!({ "body": "Still risky", "health": "at_risk" })).await;
    let changes = f.event_types().await.iter().filter(|t| *t == "project.health_changed").count();
    assert_eq!(changes, 1);
    // a legacy enum resolves to the catalog id; a different health moves the project
    let moved =
        f.posted(&f.owner, &f.alpha, json!({ "body": "Slipping", "health": "off_track" })).await;
    assert_eq!(moved["health"], "off_track");
    assert_eq!(f.project_health(&f.alpha).await, "off_track");

    // an unknown health is refused and writes nothing
    let before = f.stored(&f.alpha).await;
    let bad = f.post(&f.owner, &url, json!({ "body": "Bad health", "health": "great" })).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        f.post(&f.owner, &url, json!({ "body": "Bad health", "health": 42 })).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(f.stored(&f.alpha).await, before);
    assert_eq!(f.project_health(&f.alpha).await, "off_track");
    f.w.drop().await;
}

#[tokio::test]
async fn validates_the_body() {
    let Some(f) = fx().await else { return };
    let url = updates(&f.alpha);

    let long =
        f.post(&f.owner, &url, json!({ "body": "x".repeat(PROJECT_UPDATE_BODY_MAX + 1) })).await;
    assert_eq!(long.status, StatusCode::BAD_REQUEST);
    assert_eq!(long.message(), "body must be shorter than or equal to 20000 characters");
    let blank = f.post(&f.owner, &url, json!({ "body": "   " })).await;
    assert_eq!(
        (blank.status, blank.message()),
        (StatusCode::BAD_REQUEST, "An update needs some text".into())
    );
    for body in [json!({ "body": "" }), json!({}), json!({ "body": 12 })] {
        assert_eq!(
            f.post(&f.owner, &url, body.clone()).await.status,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
    // 20000 characters pass; the limit counts the trimmed text, and characters are UTF-16 units
    let full = f.post(&f.owner, &url, json!({ "body": "x".repeat(PROJECT_UPDATE_BODY_MAX) })).await;
    assert_eq!(full.status, StatusCode::CREATED, "{}", full.message());
    let padded = format!("  {}  ", "y".repeat(PROJECT_UPDATE_BODY_MAX - 4));
    assert_eq!(f.post(&f.owner, &url, json!({ "body": padded })).await.status, StatusCode::CREATED);
    assert_eq!(f.get(&f.owner, &url).await.body.as_array().unwrap().len(), 2);
    f.w.drop().await;
}

#[tokio::test]
async fn follows_the_token_scopes() {
    let Some(f) = fx().await else { return };
    let url = updates(&f.alpha);
    let posted = f.posted(&f.owner, &f.alpha, json!({ "body": "News" })).await;
    let one = update(&f.alpha, &posted["id"]);
    let send = |secret: &str, req: Req| f.w.send(req.bearer(secret));

    let read = token(&f, ActorRef::user("owner"), TokenScope::Read).await;
    let listed = send(&read, Req::get(&url)).await;
    assert_eq!(listed.body.as_array().unwrap().len(), 1);
    assert_eq!(
        send(&read, Req::post(&url).json(json!({ "body": "Read token post" }))).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send(&read, Req::patch(&one).json(json!({ "body": "Read token edit" }))).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(send(&read, Req::delete(&one)).await.status, StatusCode::FORBIDDEN);

    let write = token(&f, ActorRef::user("owner"), TokenScope::Write).await;
    let bot = send(&write, Req::post(&url).json(json!({ "body": "From a token" }))).await;
    assert_eq!(bot.status, StatusCode::CREATED, "{}", bot.message());
    assert_eq!(bot.body["author"]["type"], "user");
    let bot_one = update(&f.alpha, &bot.body["id"]);
    let edited =
        send(&write, Req::patch(&bot_one).json(json!({ "body": "Edited by its author" }))).await;
    assert_eq!(edited.status, StatusCode::OK);
    assert_eq!(send(&write, Req::delete(&bot_one)).await.status, StatusCode::NO_CONTENT);

    // an agent token reads and writes under its own identity
    let agent = agent_token(f.w.db(), "ws_acme", "ag_status").await;
    let by_agent = send(&agent, Req::post(&url).json(json!({ "body": "Automated status" }))).await;
    assert_eq!(by_agent.status, StatusCode::CREATED, "{}", by_agent.message());
    assert_eq!(by_agent.body["author"], json!({ "type": "agent", "id": "ag_status" }));
    let agent_one = update(&f.alpha, &by_agent.body["id"]);
    let owner_edit = f.patch(&f.owner, &agent_one, json!({ "body": "Not mine" })).await;
    assert_eq!(owner_edit.status, StatusCode::FORBIDDEN);
    assert_eq!(f.delete(&f.owner, &agent_one).await.status, StatusCode::NO_CONTENT);
    f.w.drop().await;
}

#[tokio::test]
async fn updates_go_with_their_project_when_it_is_deleted() {
    let Some(f) = fx().await else { return };
    f.posted(&f.owner, &f.beta, json!({ "body": "Doomed" })).await;
    assert_eq!(f.stored(&f.beta).await, 1);

    assert_eq!(
        f.delete(&f.owner, &format!("{PJ}/{}", f.beta)).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(f.get(&f.owner, &updates(&f.beta)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.stored(&f.beta).await, 0);
    f.w.drop().await;
}

// ── project-updates.service.spec.ts ──

#[tokio::test]
async fn the_excerpt_keeps_the_first_200_characters() {
    let Some(f) = fx().await else { return };
    f.posted(&f.owner, &f.alpha, json!({ "body": "z".repeat(450) })).await;
    let row = domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq("project.update_posted"))
        .one(f.w.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.data["excerpt"], "z".repeat(200));
    f.w.drop().await;
}

#[tokio::test]
async fn lists_the_newest_200_of_the_project_only() {
    let Some(f) = fx().await else { return };
    sql(
        f.w.db(),
        &format!(
            r#"INSERT INTO project_updates (id, "workspaceId", "projectId", author, body, "createdAt")
               SELECT 'pu_' || lpad(n::text, 4, '0'), 'ws_acme', '{}', '{{"type":"user","id":"owner"}}'::jsonb,
                      'Update ' || n, now() - make_interval(secs => 1000 - n)
               FROM generate_series(1, 205) AS n"#,
            f.alpha
        ),
    )
    .await;
    let other = f.posted(&f.owner, &f.beta, json!({ "body": "Elsewhere" })).await;

    let listed = f.get(&f.owner, &updates(&f.alpha)).await;
    let list = ids(&listed.body);
    assert_eq!(list.len(), 200);
    assert_eq!((list[0].as_str(), list[199].as_str()), ("pu_0205", "pu_0006"));
    assert!(!list.contains(&other["id"].as_str().unwrap().to_owned()));
    f.w.drop().await;
}

#[tokio::test]
async fn editing_publishes_a_live_event_and_an_unchanged_edit_does_nothing() {
    let Some(f) = fx().await else { return };
    let posted = f.posted(&f.owner, &f.alpha, json!({ "body": "Shipped the beta" })).await;
    let one = update(&f.alpha, &posted["id"]);
    let id = posted["id"].as_str().unwrap().to_owned();
    let mut live = f.w.events.subscribe();

    // the same text (and the same absent health) is not an edit
    let same = f.patch(&f.owner, &one, json!({ "body": " Shipped the beta " })).await;
    assert_eq!(same.status, StatusCode::OK);
    assert!(same.body.get("editedAt").is_none(), "{}", same.body);
    assert!(live.try_recv().is_err());
    let empty = f.patch(&f.owner, &one, json!({})).await;
    assert_eq!(empty.status, StatusCode::OK);
    assert!(empty.body.get("editedAt").is_none());
    assert!(live.try_recv().is_err());

    let edited = f.patch(&f.owner, &one, json!({ "body": "Shipped the beta, really" })).await;
    assert_eq!(edited.body["body"], "Shipped the beta, really");
    assert!(edited.body["editedAt"].as_str().is_some());
    let event = live.try_recv().unwrap();
    assert_eq!(
        (event.event.kind, event.event.entity, event.event.id.as_str()),
        (LiveEventType::Updated, LiveEventEntity::ProjectUpdate, id.as_str())
    );
    let subject = event.subject.unwrap();
    assert_eq!((subject.kind.as_str(), subject.id.as_str()), ("project", f.alpha.as_str()));
    // the post is the only domain event; editing records none, and never touches the project
    let types = f.event_types().await;
    assert_eq!(types.iter().filter(|t| t.starts_with("project.update")).count(), 1, "{types:?}");
    assert!(!types.contains(&"project.updated".to_owned()), "{types:?}");

    // deleting publishes `deleted`
    assert_eq!(f.delete(&f.owner, &one).await.status, StatusCode::NO_CONTENT);
    let event = live.try_recv().unwrap();
    assert_eq!(
        (event.event.kind, event.event.entity, event.event.id.as_str()),
        (LiveEventType::Deleted, LiveEventEntity::ProjectUpdate, id.as_str())
    );
    f.w.drop().await;
}

#[tokio::test]
async fn a_refused_delete_publishes_nothing() {
    let Some(f) = fx().await else { return };
    let guest = f.guest("gina", &f.alpha, &["projects:delete"]).await;
    let posted = f.posted(&f.owner, &f.alpha, json!({ "body": "Kept" })).await;
    let mut live = f.w.events.subscribe();

    let res = f.delete(&guest, &update(&f.alpha, &posted["id"])).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert!(live.try_recv().is_err());
    assert_eq!(f.stored(&f.alpha).await, 1);
    f.w.drop().await;
}

#[tokio::test]
async fn an_update_of_another_workspace_is_a_404() {
    let Some(f) = fx().await else { return };
    workspace(f.w.db(), "other").await;
    let stranger = person(f.w.db(), "ws_other", "sam", "owner").await;
    let posted = f.posted(&f.owner, &f.alpha, json!({ "body": "Private" })).await;

    // the project id belongs to `acme`: from `other` it does not exist
    let res = f.get(&stranger, &format!("/api/w/other/projects/{}/updates", f.alpha)).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    let res = f
        .delete(
            &stranger,
            &format!(
                "/api/w/other/projects/{}/updates/{}",
                f.alpha,
                posted["id"].as_str().unwrap()
            ),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    // a non-member of `acme` is turned away from its workspace
    assert_eq!(f.get(&stranger, &updates(&f.alpha)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.stored(&f.alpha).await, 1);
    f.w.drop().await;
}
