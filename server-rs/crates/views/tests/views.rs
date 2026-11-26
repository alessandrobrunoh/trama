//! The views routes against a real database and the real access guard: `views.service.spec.ts`,
//! `view-sharing.spec.ts` (service and DTO cases) and the views part of
//! `project-views-icon.e2e-spec.ts`.

mod common;

use axum::http::StatusCode;
use sea_orm::EntityTrait;
use serde_json::{Value, json};
use trama_contracts::activity::{LiveEventEntity, LiveEventType};
use trama_entities::saved_views;
use trama_views::rules::hash_public_token;

use common::{Req, Res, World, agent_token, person, sql, workspace, workspace_without_sharing};

const VIEWS: &str = "/api/w/acme/views";

/// A workspace `acme` with an owner, an admin, two members and a viewer.
struct Fx {
    w: World,
    owner: String,
    admin: String,
    u2: String,
    u3: String,
    viewer: String,
}

async fn fx() -> Option<Fx> {
    fx_in(false).await
}

async fn fx_in(without_sharing: bool) -> Option<Fx> {
    let w = World::new().await?;
    if without_sharing {
        workspace_without_sharing(w.db(), "acme").await;
    } else {
        workspace(w.db(), "acme").await;
    }
    let owner = person(w.db(), "ws_acme", "owner", "owner").await;
    let admin = person(w.db(), "ws_acme", "a1", "admin").await;
    let u2 = person(w.db(), "ws_acme", "u2", "member").await;
    let u3 = person(w.db(), "ws_acme", "u3", "member").await;
    let viewer = person(w.db(), "ws_acme", "vw", "viewer").await;
    Some(Fx { w, owner, admin, u2, u3, viewer })
}

impl Fx {
    async fn get(&self, cookie: &str, path: &str) -> Res {
        self.w.send(Req::get(path).session(cookie)).await
    }
    async fn post(&self, cookie: &str, path: &str, body: Value) -> Res {
        self.w.send(Req::post(path).session(cookie).json(body)).await
    }
    async fn patch(&self, cookie: &str, path: &str, body: Value) -> Res {
        self.w.send(Req::patch(path).session(cookie).json(body)).await
    }
    async fn delete(&self, cookie: &str, path: &str) -> Res {
        self.w.send(Req::delete(path).session(cookie)).await
    }

    /// A view of `cookie`'s person; panics unless it is created.
    async fn make(&self, cookie: &str, body: Value) -> Value {
        let res = self.post(cookie, VIEWS, body).await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
        res.body
    }

    /// An issue view of the owner with the given sharing.
    async fn owned(&self, sharing: Value) -> String {
        let view = self
            .make(&self.owner, json!({"name": "V", "entity": "issue", "sharing": sharing}))
            .await;
        view["id"].as_str().unwrap().to_owned()
    }

    async fn stored(&self, id: &str) -> saved_views::Model {
        saved_views::Entity::find_by_id(id).one(self.w.db()).await.unwrap().unwrap()
    }

    async fn ids(&self, cookie: &str) -> Vec<String> {
        let res = self.get(cookie, VIEWS).await;
        assert_eq!(res.status, StatusCode::OK);
        res.body.as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap().to_owned()).collect()
    }
}

fn uri(id: &str) -> String {
    format!("{VIEWS}/{id}")
}

// ── project-views-icon.e2e-spec.ts: views: project entity and timeline layout ──

#[tokio::test]
async fn accepts_the_project_entity_and_timeline_layout() {
    let Some(f) = fx().await else { return };
    let v = f
        .make(&f.owner, json!({"name": "Roadmap", "entity": "project", "layout": "timeline"}))
        .await;
    assert_eq!(v["entity"], "project");
    assert_eq!(v["layout"], "timeline");
    f.make(&f.owner, json!({"name": "Projects list", "entity": "project"})).await;
    f.make(
        &f.owner,
        json!({"name": "Projects board", "entity": "project", "layout": "board",
               "filters": [{"field": "status", "op": "is", "value": "started"}]}),
    )
    .await;
    let res = f.get(&f.owner, &uri(v["id"].as_str().unwrap())).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["layout"], "timeline");
    f.w.drop().await;
}

#[tokio::test]
async fn refuses_the_timeline_on_issue_views_and_the_removed_decision_entity() {
    let Some(f) = fx().await else { return };
    let res = f
        .post(
            &f.owner,
            VIEWS,
            json!({"name": "issue gantt", "entity": "issue", "layout": "timeline"}),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(res.message().contains("timeline"), "{}", res.message());
    assert_eq!(
        f.post(&f.owner, VIEWS, json!({"name": "decisions", "entity": "decision"})).await.status,
        StatusCode::BAD_REQUEST
    );
    let list = f.make(&f.owner, json!({"name": "Issues", "entity": "issue"})).await;
    let list_id = list["id"].as_str().unwrap();
    assert_eq!(
        f.patch(&f.owner, &uri(list_id), json!({"layout": "timeline"})).await.status,
        StatusCode::BAD_REQUEST
    );
    let gantt =
        f.make(&f.owner, json!({"name": "Gantt", "entity": "project", "layout": "timeline"})).await;
    let gantt = uri(gantt["id"].as_str().unwrap());
    // switching the entity under an existing timeline layout is refused too
    assert_eq!(
        f.patch(&f.owner, &gantt, json!({"entity": "issue"})).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.patch(&f.owner, &gantt, json!({"entity": "decision", "layout": "list"})).await.status,
        StatusCode::BAD_REQUEST
    );
    let res = f.patch(&f.owner, &gantt, json!({"entity": "issue", "layout": "list"})).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["entity"], "issue");
    assert_eq!(f.get(&f.owner, &uri(list_id)).await.body["layout"], "list");
    // a project view keeps its timeline when the entity is set to what it already is
    let keep =
        f.make(&f.owner, json!({"name": "K", "entity": "project", "layout": "timeline"})).await;
    let res =
        f.patch(&f.owner, &uri(keep["id"].as_str().unwrap()), json!({"entity": "project"})).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        (res.body["entity"].as_str(), res.body["layout"].as_str()),
        (Some("project"), Some("timeline"))
    );
    f.w.drop().await;
}

#[tokio::test]
async fn rejects_unknown_entities_and_layouts_and_viewers_cannot_share() {
    let Some(f) = fx().await else { return };
    for body in [
        json!({"name": "x", "entity": "milestone"}),
        json!({"name": "x", "entity": "project", "layout": "calendar"}),
        json!({"name": "x", "entity": "workstream"}),
        json!({"name": "x", "entity": "execution"}),
        json!({"name": "x", "entity": "issue", "layout": "gantt"}),
    ] {
        assert_eq!(
            f.post(&f.owner, VIEWS, body.clone()).await.status,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
    let res =
        f.post(&f.viewer, VIEWS, json!({"name": "x", "entity": "project", "shared": true})).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    f.w.drop().await;
}

#[tokio::test]
async fn hides_legacy_entities_behind_a_404() {
    let Some(f) = fx().await else { return };
    sql(
        f.w.db(),
        r#"INSERT INTO saved_views (id, "workspaceId", "ownerId", name, entity, layout)
           VALUES ('vw_legacy', 'ws_acme', 'owner', 'Legacy', 'workstream', 'list')"#,
    )
    .await;
    assert_eq!(f.get(&f.owner, &uri("vw_legacy")).await.status, StatusCode::NOT_FOUND);
    assert!(f.ids(&f.owner).await.is_empty());
    assert_eq!(
        f.patch(&f.owner, &uri("vw_legacy"), json!({"name": "x"})).await.status,
        StatusCode::NOT_FOUND
    );
    f.w.drop().await;
}

// ── views.service.spec.ts: layout/entity validation ──

#[tokio::test]
async fn creates_a_project_timeline_view_and_trims_the_name() {
    let Some(f) = fx().await else { return };
    let v = f
        .make(&f.owner, json!({"name": " Roadmap ", "entity": "project", "layout": "timeline"}))
        .await;
    assert_eq!(v["name"], "Roadmap");
    assert_eq!(v["ownerId"], "owner");
    assert_eq!(v["workspaceId"], "ws_acme");
    assert_eq!(v["shared"], false);
    assert_eq!(v["sharing"], json!({"visibility": "private", "grants": []}));
    assert_eq!(v["filters"], json!([]));
    assert!(v["id"].as_str().unwrap().starts_with("vw_"));
    // optional fields are omitted, never null
    for absent in ["sort", "groupBy", "publicToken"] {
        assert!(v.get(absent).is_none(), "{absent}");
    }
    assert!(v["createdAt"].as_str().unwrap().ends_with('Z'));
    let stored = f.stored(v["id"].as_str().unwrap()).await;
    assert_eq!(stored.name, "Roadmap");
    f.w.drop().await;
}

#[tokio::test]
async fn stores_filters_sort_and_grouping_and_clears_them_with_null() {
    let Some(f) = fx().await else { return };
    let v = f
        .make(
            &f.owner,
            json!({"name": "Open", "entity": "issue", "groupBy": "status",
                   "sort": {"field": "title", "direction": "desc"},
                   "filters": [{"field": "status", "op": "in", "value": ["todo", "done"], "extra": 1}]}),
        )
        .await;
    assert_eq!(v["groupBy"], "status");
    assert_eq!(v["sort"], json!({"field": "title", "direction": "desc"}));
    assert_eq!(v["filters"], json!([{"field": "status", "op": "in", "value": ["todo", "done"]}]));
    let id = v["id"].as_str().unwrap();
    let res = f
        .patch(&f.owner, &uri(id), json!({"sort": null, "groupBy": null, "name": "  Renamed "}))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.body.get("sort").is_none() && res.body.get("groupBy").is_none());
    assert_eq!(res.body["name"], "Renamed");
    assert_eq!(res.body["filters"].as_array().unwrap().len(), 1);
    assert_eq!(
        f.patch(&f.owner, &uri(id), json!({"filters": []})).await.body["filters"],
        json!([])
    );
    f.w.drop().await;
}

#[tokio::test]
async fn validates_bodies_like_the_dtos() {
    let Some(f) = fx().await else { return };
    let id = f.owned(json!({})).await;
    let bad_create = [
        json!({"name": "", "entity": "issue"}),
        json!({"name": "x".repeat(101), "entity": "issue"}),
        json!({"entity": "issue"}),
        json!({"name": "x", "entity": "issue", "filters": [{"field": "title", "op": "contains", "value": 5}]}),
        json!({"name": "x", "entity": "issue", "filters": [{"field": "title", "op": "all", "value": "a"}]}),
        json!({"name": "x", "entity": "issue", "sort": {"field": "title", "direction": "up"}}),
        json!({"name": "x", "entity": "issue", "shared": "yes"}),
        json!({"name": "x", "entity": "issue", "sharing": {"visibility": "public"}}),
        json!({"name": "x", "entity": "issue", "sharing": {"grants": [{"userId": "u2", "level": "owner"}]}}),
    ];
    for body in bad_create {
        assert_eq!(
            f.post(&f.owner, VIEWS, body.clone()).await.status,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
    let res = f
        .post(
            &f.owner,
            VIEWS,
            json!({"name": "x", "entity": "issue", "filters": [{"field": "title", "op": "contains", "value": null}]}),
        )
        .await;
    assert!(
        res.message().contains("filters.0.value must be a string or an array of strings"),
        "{}",
        res.message()
    );
    for body in [
        json!({"name": null}),
        json!({"layout": null}),
        json!({"entity": null}),
        json!({"shared": null}),
    ] {
        assert_eq!(
            f.patch(&f.owner, &uri(&id), body.clone()).await.status,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
    // a body that is not an object
    let res = f.w.send(Req::post(VIEWS).session(&f.owner).json(json!([1]))).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    f.w.drop().await;
}

#[tokio::test]
async fn agents_cannot_own_saved_views() {
    let Some(f) = fx().await else { return };
    let secret = agent_token(f.w.db(), "ws_acme", "ag_1").await;
    let res =
        f.w.send(Req::post(VIEWS).bearer(&secret).json(json!({"name": "x", "entity": "issue"})))
            .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Agents cannot own saved views");
    // they can read what is shared
    let shared = f.owned(json!({"visibility": "workspace"})).await;
    let private = f.owned(json!({})).await;
    let res = f.w.send(Req::get(VIEWS).bearer(&secret)).await;
    assert_eq!(res.status, StatusCode::OK);
    let ids: Vec<&str> =
        res.body.as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [shared.as_str()]);
    assert_eq!(
        f.w.send(Req::get(&uri(&private)).bearer(&secret)).await.status,
        StatusCode::NOT_FOUND
    );
    // and never see the secret link
    let link = f.owned(json!({"visibility": "link"})).await;
    let res = f.w.send(Req::get(&uri(&link)).bearer(&secret)).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.body.get("publicToken").is_none());
    f.w.drop().await;
}

// ── view-sharing.spec.ts: ViewsService sharing ──

#[tokio::test]
async fn lists_only_views_the_caller_may_see() {
    let Some(f) = fx().await else { return };
    // created oldest first: the list is in creation order
    let own = f.make(&f.u2, json!({"name": "own", "entity": "issue"})).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let other_private = f.owned(json!({})).await;
    let invited = f.owned(json!({"grants": [{"userId": "u2", "level": "view"}]})).await;
    let workspace_wide = f.owned(json!({"visibility": "workspace"})).await;
    let link = f.owned(json!({"visibility": "link"})).await;
    assert_eq!(
        f.ids(&f.u2).await,
        [own.clone(), invited.clone(), workspace_wide.clone(), link.clone()]
    );
    // a viewer sees what is shared with everybody, an admin does not see private views
    assert_eq!(f.ids(&f.viewer).await, [workspace_wide.clone(), link.clone()]);
    assert!(!f.ids(&f.admin).await.contains(&other_private));
    assert!(!f.ids(&f.admin).await.contains(&own));
    assert_eq!(f.ids(&f.owner).await, [other_private, invited, workspace_wide, link]);
    f.w.drop().await;
}

#[tokio::test]
async fn hides_views_the_caller_may_not_read_behind_a_404() {
    let Some(f) = fx().await else { return };
    let id = f.owned(json!({})).await;
    assert_eq!(f.get(&f.u2, &uri(&id)).await.status, StatusCode::NOT_FOUND);
    let res = f.patch(&f.u2, &uri(&id), json!({"name": "x"})).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.message(), format!("View \"{id}\" not found"));
    assert_eq!(f.delete(&f.u2, &uri(&id)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        f.post(&f.u2, &format!("{}/invite", uri(&id)), json!({"emails": ["u3@test.dev"]}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.post(&f.u2, &format!("{}/rotate-link", uri(&id)), json!({})).await.status,
        StatusCode::NOT_FOUND
    );
    // an admin does not reach into a private view either
    assert_eq!(f.get(&f.admin, &uri(&id)).await.status, StatusCode::NOT_FOUND);
    // and one that does not exist answers the same
    assert_eq!(f.get(&f.owner, &uri("vw_missing")).await.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn views_are_scoped_to_their_workspace() {
    let Some(f) = fx().await else { return };
    let id = f.owned(json!({"visibility": "workspace"})).await;
    workspace(f.w.db(), "other").await;
    let stranger = person(f.w.db(), "ws_other", "s1", "owner").await;
    assert_eq!(f.get(&stranger, "/api/w/other/views").await.body, json!([]));
    assert_eq!(
        f.get(&stranger, &format!("/api/w/other/views/{id}")).await.status,
        StatusCode::NOT_FOUND
    );
    // not a member of acme at all
    assert_eq!(f.get(&stranger, VIEWS).await.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn read_only_invitees_cannot_edit_editors_edit_content_but_not_sharing() {
    let Some(f) = fx().await else { return };
    let id = f
        .owned(json!({"grants": [{"userId": "u2", "level": "view"}, {"userId": "u3", "level": "edit"}]}))
        .await;
    let res = f.patch(&f.u2, &uri(&id), json!({"name": "x"})).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "You can only view this view; ask the owner for edit access");
    let res = f.patch(&f.u3, &uri(&id), json!({"name": "renamed"})).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["name"], "renamed");
    for body in [json!({"sharing": {"visibility": "link"}}), json!({"shared": true})] {
        let res = f.patch(&f.u3, &uri(&id), body).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
        assert_eq!(
            res.message(),
            "Only the owner (or an admin, for shared views) can change who has access"
        );
    }
    let res = f.delete(&f.u3, &uri(&id)).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Only the owner (or an admin, for shared views) can delete a view");
    // the editor cannot invite or rotate either
    assert_eq!(
        f.post(&f.u3, &format!("{}/invite", uri(&id)), json!({"emails": ["a1@test.dev"]}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.post(&f.u3, &format!("{}/rotate-link", uri(&id)), json!({})).await.status,
        StatusCode::FORBIDDEN
    );
    // an edit grant needs the power to write: a viewer invited to edit still cannot
    let res = f
        .patch(
            &f.owner,
            &uri(&id),
            json!({"sharing": {"grants": [{"userId": "vw", "level": "edit"}]}}),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        f.patch(&f.viewer, &uri(&id), json!({"name": "x"})).await.status,
        StatusCode::FORBIDDEN
    );
    f.w.drop().await;
}

#[tokio::test]
async fn admins_manage_shared_views_but_not_private_ones() {
    let Some(f) = fx().await else { return };
    let shared = f.owned(json!({"visibility": "workspace"})).await;
    let res = f
        .patch(
            &f.admin,
            &uri(&shared),
            json!({"name": "by admin", "sharing": {"visibility": "link"}}),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["name"], "by admin");
    // the admin manages the link, so sees the secret
    assert!(res.body["publicToken"].as_str().unwrap().starts_with("vt_"));
    // a plain member edits nothing of a workspace view
    assert_eq!(
        f.patch(&f.u2, &uri(&shared), json!({"name": "x"})).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(f.delete(&f.admin, &uri(&shared)).await.status, StatusCode::NO_CONTENT);
    let private = f.owned(json!({})).await;
    assert_eq!(f.delete(&f.admin, &uri(&private)).await.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

#[tokio::test]
async fn mints_a_token_when_a_view_goes_public_and_shows_it_to_managers_only() {
    let Some(f) = fx().await else { return };
    let id = f.owned(json!({"visibility": "workspace"})).await;
    let owner = f.patch(&f.owner, &uri(&id), json!({"sharing": {"visibility": "link"}})).await;
    assert_eq!(owner.status, StatusCode::OK);
    assert_eq!(owner.body["sharing"]["visibility"], "link");
    let token = owner.body["publicToken"].as_str().unwrap().to_owned();
    assert!(token.starts_with("vt_"));
    let stored = f.stored(&id).await;
    assert_eq!(stored.public_token_hash.as_deref(), Some(hash_public_token(&token).as_str()));
    let json = owner.body.to_string();
    assert!(!json.contains("publicTokenHash") && !json.contains("publicTokenEnc"));
    // an ordinary member sees the view but not the secret
    let member = f.get(&f.u2, &uri(&id)).await;
    assert_eq!(member.body["sharing"]["visibility"], "link");
    assert!(member.body.get("publicToken").is_none());
    // an admin can manage a shared view and sees the link
    assert_eq!(f.get(&f.admin, &uri(&id)).await.body["publicToken"], token);
    // the stored copy is encrypted, and the list shows the same token to the owner
    assert!(!stored.public_token_enc.unwrap().contains(&token));
    let list = f.get(&f.owner, VIEWS).await;
    assert_eq!(list.body[0]["publicToken"], token);
    let list = f.get(&f.u2, VIEWS).await;
    assert!(list.body[0].get("publicToken").is_none());
    f.w.drop().await;
}

#[tokio::test]
async fn revokes_the_link_when_access_changes_and_issues_a_new_one_when_it_returns() {
    let Some(f) = fx().await else { return };
    let id = f.owned(json!({})).await;
    let first = f.patch(&f.owner, &uri(&id), json!({"sharing": {"visibility": "link"}})).await.body
        ["publicToken"]
        .as_str()
        .unwrap()
        .to_owned();
    let old_hash = f.stored(&id).await.public_token_hash;
    f.patch(&f.owner, &uri(&id), json!({"sharing": {"visibility": "workspace"}})).await;
    let row = f.stored(&id).await;
    assert_eq!((row.public_token_hash, row.public_token_enc), (None, None));
    assert!(row.shared);
    let res = f.patch(&f.owner, &uri(&id), json!({"shared": false})).await;
    assert_eq!(res.body["sharing"]["visibility"], "private");
    assert_eq!(res.body["shared"], false);
    let second = f
        .patch(&f.owner, &uri(&id), json!({"sharing": {"visibility": "link"}}))
        .await
        .body["publicToken"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(second, first);
    assert_ne!(f.stored(&id).await.public_token_hash, old_hash);
    // changing something else keeps the link
    let res = f.patch(&f.owner, &uri(&id), json!({"name": "again"})).await;
    assert_eq!(res.body["publicToken"], second);
    f.w.drop().await;
}

#[tokio::test]
async fn rotating_the_link_invalidates_the_previous_token() {
    let Some(f) = fx().await else { return };
    let id = f.owned(json!({"visibility": "workspace"})).await;
    let rotate = format!("{}/rotate-link", uri(&id));
    let res = f.post(&f.owner, &rotate, json!({})).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "This view is not shared by link");
    let first = f.patch(&f.owner, &uri(&id), json!({"sharing": {"visibility": "link"}})).await.body
        ["publicToken"]
        .as_str()
        .unwrap()
        .to_owned();
    let res = f.post(&f.owner, &rotate, json!({})).await;
    assert_eq!(res.status, StatusCode::OK, "POST answers 200, not 201");
    let next = res.body["publicToken"].as_str().unwrap().to_owned();
    assert_ne!(next, first);
    assert_eq!(f.stored(&id).await.public_token_hash, Some(hash_public_token(&next)));
    let res = f.post(&f.u2, &rotate, json!({})).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(
        res.message(),
        "Only the owner (or an admin, for shared views) can change the public link"
    );
    f.w.drop().await;
}

#[tokio::test]
async fn needs_the_manage_shared_views_capability_to_share_beyond_invited_people() {
    let Some(f) = fx_in(true).await else { return };
    let id = f.make(&f.u2, json!({"name": "mine", "entity": "issue"})).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for sharing in [json!({"visibility": "workspace"}), json!({"visibility": "link"})] {
        let res = f.patch(&f.u2, &uri(&id), json!({"sharing": sharing})).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
        assert_eq!(res.message(), "You are not allowed to share views with the workspace");
    }
    let res = f.patch(&f.u2, &uri(&id), json!({"shared": true})).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    for body in [
        json!({"name": "x", "entity": "issue", "sharing": {"visibility": "link"}}),
        json!({"name": "x", "entity": "issue", "shared": true}),
    ] {
        assert_eq!(f.post(&f.u2, VIEWS, body).await.status, StatusCode::FORBIDDEN);
    }
    assert_eq!(
        f.post(&f.u2, VIEWS, json!({"name": "x", "entity": "issue"})).await.status,
        StatusCode::CREATED
    );
    // inviting people is not sharing beyond them
    let res = f
        .patch(
            &f.u2,
            &uri(&id),
            json!({"sharing": {"grants": [{"userId": "u3", "level": "view"}]}}),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    // the owner may share: the role says so
    let res =
        f.post(&f.owner, VIEWS, json!({"name": "x", "entity": "issue", "shared": true})).await;
    assert_eq!(res.status, StatusCode::CREATED);
    f.w.drop().await;
}

#[tokio::test]
async fn keeps_the_legacy_shared_flag_working() {
    let Some(f) = fx().await else { return };
    let id = f.owned(json!({})).await;
    f.patch(&f.owner, &uri(&id), json!({"shared": true})).await;
    assert_eq!(f.stored(&id).await.sharing["visibility"], "workspace");
    f.patch(&f.owner, &uri(&id), json!({"sharing": {"visibility": "link"}})).await;
    f.patch(&f.owner, &uri(&id), json!({"shared": true})).await;
    assert_eq!(f.stored(&id).await.sharing["visibility"], "link");
    // `sharing.visibility` wins over the flag
    f.patch(&f.owner, &uri(&id), json!({"shared": false, "sharing": {"visibility": "workspace"}}))
        .await;
    assert_eq!(f.stored(&id).await.sharing["visibility"], "workspace");
    // the flag on create
    let created = f.make(&f.owner, json!({"name": "S", "entity": "issue", "shared": true})).await;
    assert_eq!(
        (created["shared"].as_bool(), created["sharing"]["visibility"].as_str()),
        (Some(true), Some("workspace"))
    );
    f.w.drop().await;
}

#[tokio::test]
async fn invites_workspace_members_by_email_case_insensitively_and_never_the_owner() {
    let Some(f) = fx().await else { return };
    let id = f.owned(json!({})).await;
    let invite = format!("{}/invite", uri(&id));
    let res = f
        .post(&f.owner, &invite, json!({"emails": ["U2@Test.dev", "u3@test.dev", "OWNER@test.dev", "u2@test.dev"], "level": "edit"}))
        .await;
    assert_eq!(res.status, StatusCode::OK, "POST answers 200, not 201: {}", res.message());
    assert_eq!(
        res.body["sharing"]["grants"],
        json!([{"userId": "u2", "level": "edit"}, {"userId": "u3", "level": "edit"}])
    );
    // inviting again changes the level, and the default level is view
    let res = f.post(&f.owner, &invite, json!({"emails": ["u2@test.dev"]})).await;
    assert_eq!(res.body["sharing"]["grants"][0], json!({"userId": "u2", "level": "view"}));
    assert_eq!(res.body["sharing"]["visibility"], "private");
    // the invited person now sees it
    assert!(f.ids(&f.u2).await.contains(&id));
    f.w.drop().await;
}

#[tokio::test]
async fn refuses_to_invite_people_outside_the_workspace_or_without_management_rights() {
    let Some(f) = fx().await else { return };
    common::user(f.w.db(), "outsider").await;
    let id = f.owned(json!({})).await;
    let invite = format!("{}/invite", uri(&id));
    let res = f
        .post(
            &f.owner,
            &invite,
            json!({"emails": ["u2@test.dev", "stranger@example.com", "outsider@test.dev"]}),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        res.message(),
        "Not members of this workspace: stranger@example.com, outsider@test.dev. Invite them to the workspace first."
    );
    assert_eq!(f.stored(&id).await.sharing["grants"], json!([]), "nothing is stored on failure");
    for body in [
        json!({"emails": []}),
        json!({}),
        json!({"emails": ["not-an-email"]}),
        json!({"emails": ["u2@test.dev"], "level": "owner"}),
    ] {
        assert_eq!(
            f.post(&f.owner, &invite, body.clone()).await.status,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
    // an editor may not invite
    let editable = f.owned(json!({"grants": [{"userId": "u2", "level": "edit"}]})).await;
    let res = f
        .post(&f.u2, &format!("{}/invite", uri(&editable)), json!({"emails": ["u3@test.dev"]}))
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Only the owner (or an admin, for shared views) can invite people");
    f.w.drop().await;
}

#[tokio::test]
async fn removes_invitees_by_replacing_the_grant_list_which_must_name_workspace_members() {
    let Some(f) = fx().await else { return };
    let id = f
        .owned(json!({"grants": [{"userId": "u2", "level": "view"}, {"userId": "u3", "level": "view"}]}))
        .await;
    let res = f
        .patch(
            &f.owner,
            &uri(&id),
            json!({"sharing": {"grants": [{"userId": "u3", "level": "view"}]}}),
        )
        .await;
    assert_eq!(res.body["sharing"]["grants"], json!([{"userId": "u3", "level": "view"}]));
    assert!(!f.ids(&f.u2).await.contains(&id));
    let res = f
        .patch(
            &f.owner,
            &uri(&id),
            json!({"sharing": {"grants": [{"userId": "ghost", "level": "view"}]}}),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "You can only share a view with members of this workspace");
    // the owner is dropped from the list, a person named twice keeps the last level
    let res = f
        .patch(
            &f.owner,
            &uri(&id),
            json!({"sharing": {"grants": [{"userId": "owner", "level": "edit"}, {"userId": "u2", "level": "view"}, {"userId": "u2", "level": "edit"}]}}),
        )
        .await;
    assert_eq!(res.body["sharing"]["grants"], json!([{"userId": "u2", "level": "edit"}]));
    let res = f.patch(&f.owner, &uri(&id), json!({"sharing": {"grants": []}})).await;
    assert_eq!(res.body["sharing"]["grants"], json!([]));
    // people from another workspace are not members here
    f.w.drop().await;
}

// ── side effects ──

#[tokio::test]
async fn publishes_a_live_event_for_each_change() {
    let Some(f) = fx().await else { return };
    let mut live = f.w.events.subscribe();
    let id = f.owned(json!({"visibility": "workspace"})).await;
    assert_eq!(f.patch(&f.owner, &uri(&id), json!({"name": "n"})).await.status, StatusCode::OK);
    assert_eq!(
        f.post(&f.owner, &format!("{}/invite", uri(&id)), json!({"emails": ["u2@test.dev"]}))
            .await
            .status,
        StatusCode::OK
    );
    f.patch(&f.owner, &uri(&id), json!({"sharing": {"visibility": "link"}})).await;
    f.post(&f.owner, &format!("{}/rotate-link", uri(&id)), json!({})).await;
    assert_eq!(f.delete(&f.owner, &uri(&id)).await.status, StatusCode::NO_CONTENT);
    // a refused change publishes nothing
    assert_eq!(
        f.patch(&f.u3, &uri("vw_missing"), json!({"name": "x"})).await.status,
        StatusCode::NOT_FOUND
    );
    f.w.drop().await;

    let mut seen = Vec::new();
    while let Ok(published) = live.try_recv() {
        seen.push((
            published.event.kind,
            published.event.entity,
            published.event.id,
            published.workspace_id,
        ));
    }
    let view = LiveEventEntity::View;
    let expected: Vec<(LiveEventType, LiveEventEntity, String, String)> = [
        LiveEventType::Created,
        LiveEventType::Updated,
        LiveEventType::Updated,
        LiveEventType::Updated,
        LiveEventType::Updated,
        LiveEventType::Deleted,
    ]
    .into_iter()
    .map(|kind| (kind, view, id.clone(), "ws_acme".to_owned()))
    .collect();
    assert_eq!(seen, expected);
}

#[tokio::test]
async fn the_list_function_is_what_the_snapshot_embeds() {
    let Some(f) = fx().await else { return };
    let shared = f.owned(json!({"visibility": "workspace"})).await;
    let private = f.owned(json!({})).await;
    // the same context the guard builds for the owner
    let ctx = workspace_context(&f, "owner").await;
    let views = trama_views::list(&f.w.state, &ctx).await.unwrap();
    let ids: Vec<&str> = views.iter().map(|v| v.id.as_str()).collect();
    assert_eq!(ids, [shared.as_str(), private.as_str()]);
    let ctx = workspace_context(&f, "u2").await;
    let views = trama_views::list(&f.w.state, &ctx).await.unwrap();
    let ids: Vec<&str> = views.iter().map(|v| v.id.as_str()).collect();
    assert_eq!(ids, [shared.as_str()]);
    f.w.drop().await;
}

/// The workspace context of `user_id`, as the guard builds it.
async fn workspace_context(f: &Fx, user_id: &str) -> trama_auth::WorkspaceContext {
    use sea_orm::{ColumnTrait, QueryFilter};
    use trama_contracts::common::ActorRef;
    use trama_contracts::roles::{apply_token_scope, find_workspace_role};
    use trama_contracts::settings::resolve_workspace_settings;
    use trama_entities::{memberships, workspaces};

    let ws = workspaces::Entity::find_by_id("ws_acme").one(f.w.db()).await.unwrap().unwrap();
    let membership = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq("ws_acme"))
        .filter(memberships::Column::UserId.eq(user_id))
        .one(f.w.db())
        .await
        .unwrap()
        .unwrap();
    let settings = resolve_workspace_settings(&ws.settings);
    let role =
        find_workspace_role(&settings.roles, Some(membership.role.as_str())).unwrap().clone();
    let effective = apply_token_scope(&role, None);
    trama_auth::WorkspaceContext {
        workspace: ws,
        settings,
        actor: ActorRef::user(user_id),
        user_id: Some(user_id.to_owned()),
        role: membership.role.clone(),
        member_role: membership.role,
        token_scope: None,
        access: None,
        owner: effective.owner,
        capabilities: effective.capabilities.clone(),
        effective_role: effective,
    }
}
