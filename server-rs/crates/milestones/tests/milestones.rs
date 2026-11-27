//! The milestones routes against a real database and the real access guard: the milestone
//! cases of `milestones.e2e-spec.ts` (CRUD, ordering, events), the project scoping of
//! `MilestonesService`, `pruneIssueMilestones`, and the DTO rules of the controller.
//! `milestones-migration.e2e-spec.ts` tests a TypeORM migration and is not ported.

mod common;

use axum::http::StatusCode;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};
use trama_contracts::activity::{LiveEventEntity, LiveEventType};
use trama_entities::{domain_events, issues, milestones};
use trama_milestones::prune_issue_milestones;

use common::{Req, Res, World, agent_token, issue, narrowed, person, project, sql, workspace};

const MS: &str = "/api/w/acme/milestones";

/// A workspace `acme` with an owner, a member, a viewer and two projects.
struct Fx {
    w: World,
    owner: String,
    member: String,
    viewer: String,
}

async fn fx() -> Option<Fx> {
    let w = World::new().await?;
    workspace(w.db(), "acme").await;
    let owner = person(w.db(), "ws_acme", "owner", "owner").await;
    let member = person(w.db(), "ws_acme", "m1", "member").await;
    let viewer = person(w.db(), "ws_acme", "vw", "viewer").await;
    project(w.db(), "ws_acme", "pj_a", "Alpha").await;
    project(w.db(), "ws_acme", "pj_b", "Beta").await;
    Some(Fx { w, owner, member, viewer })
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

    /// A milestone made by the owner; panics unless it is created.
    async fn make(&self, body: Value) -> Value {
        let res = self.post(&self.owner, MS, body).await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
        res.body
    }

    async fn ids(&self, query: &str) -> Vec<String> {
        let res = self.get(&self.owner, &format!("{MS}{query}")).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.message());
        ids_of(&res.body)
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
}

fn ids_of(body: &Value) -> Vec<String> {
    body.as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap().to_owned()).collect()
}

fn id(milestone: &Value) -> String {
    milestone["id"].as_str().unwrap().to_owned()
}

fn uri(milestone: &Value) -> String {
    format!("{MS}/{}", id(milestone))
}

// ── milestones.e2e-spec.ts: milestone CRUD, ordering, snapshot and events ──

#[tokio::test]
async fn crud_ordering_and_events() {
    let Some(f) = fx().await else { return };
    let m1 = f
        .make(
            json!({"projectId": "pj_a", "name": "Alpha", "targetDate": "2026-12-01T00:00:00.000Z"}),
        )
        .await;
    let m2 = f.make(json!({"projectId": "pj_a", "name": "Beta", "description": "second"})).await;
    let m3 = f.make(json!({"projectId": "pj_a", "name": "GA"})).await;
    assert!(id(&m1).starts_with("ms_"));
    assert_eq!(m1["projectId"], "pj_a");
    assert_eq!(m1["workspaceId"], "ws_acme");
    assert_eq!(m1["targetDate"], "2026-12-01T00:00:00.000Z");
    assert_eq!(
        [&m1["sortOrder"], &m2["sortOrder"], &m3["sortOrder"]],
        [&json!(0), &json!(1), &json!(2)]
    );
    assert!(m3.get("description").is_none() && m3.get("targetDate").is_none());
    assert_eq!(
        f.post(&f.owner, MS, json!({"projectId": "pj_missing", "name": "x"})).await.status,
        StatusCode::BAD_REQUEST
    );

    let renamed = f
        .patch(
            &f.owner,
            &uri(&m2),
            json!({"name": "Beta 2", "targetDate": "2026-12-15T00:00:00.000Z", "description": null}),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.message());
    assert_eq!(renamed.body["name"], "Beta 2");
    assert_eq!(renamed.body["targetDate"], "2026-12-15T00:00:00.000Z");
    assert!(renamed.body.get("description").is_none());

    let reorder = f
        .post(
            &f.owner,
            &format!("{MS}/reorder"),
            json!({"projectId": "pj_a", "ids": [id(&m3), id(&m1), id(&m2)]}),
        )
        .await;
    assert_eq!(reorder.status, StatusCode::OK, "{}", reorder.message());
    assert_eq!(ids_of(&reorder.body), [id(&m3), id(&m1), id(&m2)]);
    let sort: Vec<_> =
        reorder.body.as_array().unwrap().iter().map(|m| m["sortOrder"].clone()).collect();
    assert_eq!(sort, [json!(0), json!(1), json!(2)]);
    let bad = f
        .post(
            &f.owner,
            &format!("{MS}/reorder"),
            json!({"projectId": "pj_a", "ids": [id(&m3), "ms_nope"]}),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad.message(), "ids must be distinct milestones of the project");
    assert_eq!(f.ids("?projectId=pj_a").await, [id(&m3), id(&m1), id(&m2)]);

    assert_eq!(f.delete(&f.owner, &uri(&m3)).await.status, StatusCode::NO_CONTENT);
    let gone = f.get(&f.owner, &uri(&m3)).await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
    assert_eq!(gone.message(), format!("Milestone \"{}\" not found", id(&m3)));

    let types = f.event_types().await;
    for expected in ["milestone.created", "milestone.updated", "milestone.deleted"] {
        assert!(types.iter().any(|t| t == expected), "{expected} in {types:?}");
    }
    f.w.drop().await;
}

#[tokio::test]
async fn events_carry_the_subject_and_payload() {
    let Some(f) = fx().await else { return };
    let mut live = f.w.events.subscribe();
    let m = f.make(json!({"projectId": "pj_a", "name": "Alpha"})).await;
    f.patch(&f.owner, &uri(&m), json!({"name": "Alpha 2", "sortOrder": 4})).await;
    f.delete(&f.owner, &uri(&m)).await;

    let rows = domain_events::Entity::find()
        .order_by_asc(domain_events::Column::At)
        .all(f.w.db())
        .await
        .unwrap();
    let kinds: Vec<_> = rows.iter().map(|e| e.r#type.as_str()).collect();
    assert_eq!(kinds, ["milestone.created", "milestone.updated", "milestone.deleted"]);
    assert_eq!(rows[0].subject, json!({"type": "milestone", "id": id(&m)}));
    assert_eq!(rows[0].actor, json!({"type": "user", "id": "owner"}));
    assert_eq!(rows[0].data, json!({"name": "Alpha", "projectId": "pj_a"}));
    assert_eq!(
        rows[1].data,
        json!({"name": "Alpha 2", "projectId": "pj_a", "fields": ["name", "sortOrder"]})
    );
    assert_eq!(rows[2].data, json!({"name": "Alpha 2", "projectId": "pj_a"}));

    // the live stream got created, updated, deleted for the milestone
    let mut seen = Vec::new();
    while let Ok(published) = live.try_recv() {
        if published.event.entity == LiveEventEntity::Milestone {
            seen.push(published.event.kind);
        }
    }
    assert_eq!(seen, [LiveEventType::Created, LiveEventType::Updated, LiveEventType::Deleted]);
    f.w.drop().await;
}

#[tokio::test]
async fn an_update_that_changes_nothing_records_nothing() {
    let Some(f) = fx().await else { return };
    let m = f.make(json!({"projectId": "pj_a", "name": "Alpha", "description": "d"})).await;
    let res = f
        .patch(&f.owner, &uri(&m), json!({"name": " Alpha ", "description": "d ", "sortOrder": 0}))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, m);
    let res = f.patch(&f.owner, &uri(&m), json!({})).await;
    assert_eq!(res.body, m);
    assert_eq!(f.event_types().await, ["milestone.created"]);
    f.w.drop().await;
}

#[tokio::test]
async fn text_is_trimmed_and_blank_descriptions_are_cleared() {
    let Some(f) = fx().await else { return };
    let m = f
        .make(json!({"projectId": "pj_a", "name": "  Alpha  ", "description": "   ", "sortOrder": 7.5}))
        .await;
    assert_eq!(m["name"], "Alpha");
    assert!(m.get("description").is_none());
    assert_eq!(m["sortOrder"], 7.5);
    // the next milestone goes after the highest sortOrder
    let next = f.make(json!({"projectId": "pj_a", "name": "Next"})).await;
    assert_eq!(next["sortOrder"], 8.5);
    // other projects count on their own
    let other = f.make(json!({"projectId": "pj_b", "name": "Other"})).await;
    assert_eq!(other["sortOrder"], 0);
    let set = f.patch(&f.owner, &uri(&m), json!({"description": "  hello  "})).await;
    assert_eq!(set.body["description"], "hello");
    let cleared = f.patch(&f.owner, &uri(&m), json!({"description": ""})).await;
    assert!(cleared.body.get("description").is_none());
    let renamed = f.patch(&f.owner, &uri(&m), json!({"name": "  Beta "})).await;
    assert_eq!(renamed.body["name"], "Beta");
    f.w.drop().await;
}

#[tokio::test]
async fn the_list_is_ordered_by_project_then_position_then_age() {
    let Some(f) = fx().await else { return };
    let b1 = f.make(json!({"projectId": "pj_b", "name": "B1"})).await;
    let a2 = f.make(json!({"projectId": "pj_a", "name": "A2", "sortOrder": 5})).await;
    let a1 = f.make(json!({"projectId": "pj_a", "name": "A1", "sortOrder": 1})).await;
    let a1b = f.make(json!({"projectId": "pj_a", "name": "A1b", "sortOrder": 1})).await;
    assert_eq!(f.ids("").await, [id(&a1), id(&a1b), id(&a2), id(&b1)]);
    assert_eq!(f.ids("?projectId=pj_b").await, [id(&b1)]);
    assert_eq!(f.ids("?projectId=pj_none").await, Vec::<String>::new());
    // an empty projectId filters nothing
    assert_eq!(f.ids("?projectId=").await.len(), 4);
    assert_eq!(
        f.get(&f.owner, &format!("{MS}?projectId=a&projectId=b")).await.status,
        StatusCode::BAD_REQUEST
    );
    f.w.drop().await;
}

#[tokio::test]
#[allow(clippy::many_single_char_names)] // milestones named after their letters
async fn reorder_keeps_unlisted_milestones_after_the_listed_ones() {
    let Some(f) = fx().await else { return };
    let a = f.make(json!({"projectId": "pj_a", "name": "A"})).await;
    let b = f.make(json!({"projectId": "pj_a", "name": "B"})).await;
    let c = f.make(json!({"projectId": "pj_a", "name": "C"})).await;
    let d = f.make(json!({"projectId": "pj_a", "name": "D"})).await;
    let other = f.make(json!({"projectId": "pj_b", "name": "Other"})).await;
    let before = f.event_types().await.len();
    let res = f
        .post(
            &f.owner,
            &format!("{MS}/reorder"),
            json!({"projectId": "pj_a", "ids": [id(&d), id(&b)]}),
        )
        .await;
    assert_eq!(ids_of(&res.body), [id(&d), id(&b), id(&a), id(&c)]);
    // d (3 to 0), a (0 to 2) and c (2 to 3) moved, b stayed at 1: one event per move
    let after = f.event_types().await;
    assert_eq!(after.len() - before, 3);
    assert!(after[before..].iter().all(|t| t == "milestone.updated"));
    // reordering again to the same order records nothing
    f.post(
        &f.owner,
        &format!("{MS}/reorder"),
        json!({"projectId": "pj_a", "ids": [id(&d), id(&b)]}),
    )
    .await;
    assert_eq!(f.event_types().await.len(), after.len());
    // the other project is untouched
    assert_eq!(f.get(&f.owner, &uri(&other)).await.body["sortOrder"], 0);
    // duplicates and milestones of another project are refused
    for ids in [json!([id(&a), id(&a)]), json!([id(&other)])] {
        let res = f
            .post(&f.owner, &format!("{MS}/reorder"), json!({"projectId": "pj_a", "ids": ids}))
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
    }
    // an empty list is allowed and renumbers by the current order
    let res =
        f.post(&f.owner, &format!("{MS}/reorder"), json!({"projectId": "pj_a", "ids": []})).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(ids_of(&res.body), [id(&d), id(&b), id(&a), id(&c)]);
    f.w.drop().await;
}

// ── MilestonesController DTOs ──

#[tokio::test]
async fn bodies_are_validated_with_class_validators_messages() {
    let Some(f) = fx().await else { return };
    let m = f.make(json!({"projectId": "pj_a", "name": "Alpha"})).await;
    let cases = [
        (json!({}), "projectId must be a string"),
        (json!({"projectId": "pj_a"}), "name must be a string"),
        (
            json!({"projectId": "pj_a", "name": ""}),
            "name must be longer than or equal to 1 characters",
        ),
        (
            json!({"projectId": "pj_a", "name": "x".repeat(201)}),
            "name must be shorter than or equal to 200 characters",
        ),
        (
            json!({"projectId": "pj_a", "name": "x", "description": "d".repeat(20_001)}),
            "description must be shorter than or equal to 20000 characters",
        ),
        (
            json!({"projectId": "pj_a", "name": "x", "targetDate": "next week"}),
            "targetDate must be a valid ISO 8601 date string",
        ),
        (
            json!({"projectId": "pj_a", "name": "x", "sortOrder": -1}),
            "sortOrder must not be less than 0",
        ),
        (
            json!({"projectId": "pj_a", "name": "x", "sortOrder": "1"}),
            "sortOrder must be a number conforming to the specified constraints",
        ),
    ];
    for (body, message) in cases {
        let res = f.post(&f.owner, MS, body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
        assert!(res.message().contains(message), "{body}: {}", res.message());
    }
    // `@IsOptional()` lets null through on create
    f.make(json!({"projectId": "pj_a", "name": "ok", "description": null, "targetDate": null, "sortOrder": null}))
        .await;
    // PATCH: name and sortOrder refuse null, description and targetDate accept it
    for body in [
        json!({"name": null}),
        json!({"name": ""}),
        json!({"sortOrder": null}),
        json!({"sortOrder": -1}),
        json!({"targetDate": "soon"}),
        json!({"description": "d".repeat(20_001)}),
    ] {
        assert_eq!(
            f.patch(&f.owner, &uri(&m), body.clone()).await.status,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
    let ok = f.patch(&f.owner, &uri(&m), json!({"targetDate": null, "description": null})).await;
    assert_eq!(ok.status, StatusCode::OK);
    // reorder
    for body in [
        json!({"ids": []}),
        json!({"projectId": "pj_a"}),
        json!({"projectId": "pj_a", "ids": "x"}),
        json!({"projectId": "pj_a", "ids": [1]}),
        json!({"projectId": "pj_a", "ids": vec!["x"; 501]}),
    ] {
        let res = f.post(&f.owner, &format!("{MS}/reorder"), body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
    }
    f.w.drop().await;
}

#[tokio::test]
async fn unknown_and_foreign_milestones_are_404() {
    let Some(f) = fx().await else { return };
    workspace(f.w.db(), "other").await;
    project(f.w.db(), "ws_other", "pj_o", "Other").await;
    let theirs = person(f.w.db(), "ws_other", "stranger", "owner").await;
    let res =
        f.w.send(
            Req::post("/api/w/other/milestones")
                .session(&theirs)
                .json(json!({"projectId": "pj_o", "name": "Theirs"})),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    let foreign = format!("{MS}/{}", res.body["id"].as_str().unwrap());

    assert_eq!(f.get(&f.owner, &foreign).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        f.patch(&f.owner, &foreign, json!({"name": "x"})).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(f.delete(&f.owner, &foreign).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.delete(&f.owner, &format!("{MS}/ms_nope")).await.status, StatusCode::NOT_FOUND);
    // a project of another workspace is unknown
    let res = f.post(&f.owner, MS, json!({"projectId": "pj_o", "name": "x"})).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.message(), "Unknown project \"pj_o\"");
    // the foreign workspace's milestone is untouched
    assert_eq!(milestones::Entity::find().all(f.w.db()).await.unwrap().len(), 1);
    // a non-member cannot even see the workspace
    assert_eq!(f.get(&theirs, MS).await.status, StatusCode::NOT_FOUND);
    f.w.drop().await;
}

// ── permissions ──

#[tokio::test]
async fn writes_need_manage_projects_and_reads_need_membership() {
    let Some(f) = fx().await else { return };
    let m = f.make(json!({"projectId": "pj_a", "name": "Alpha"})).await;
    let body = json!({"projectId": "pj_a", "name": "x"});
    // a viewer reads but cannot write
    assert_eq!(f.get(&f.viewer, MS).await.status, StatusCode::OK);
    assert_eq!(f.get(&f.viewer, &uri(&m)).await.status, StatusCode::OK);
    assert_eq!(f.post(&f.viewer, MS, body.clone()).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        f.post(&f.viewer, &format!("{MS}/reorder"), json!({"projectId": "pj_a", "ids": []}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.patch(&f.viewer, &uri(&m), json!({"name": "y"})).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(f.delete(&f.viewer, &uri(&m)).await.status, StatusCode::FORBIDDEN);
    // a member manages projects by default
    assert_eq!(f.post(&f.member, MS, body).await.status, StatusCode::CREATED);
    // anonymous requests are refused
    assert_eq!(f.w.send(Req::get(MS)).await.status, StatusCode::UNAUTHORIZED);
    // an agent token acts as itself
    let secret = agent_token(f.w.db(), "ws_acme", "ag_1").await;
    let res = f
        .w
        .send(Req::post(MS).bearer(&secret).json(json!({"projectId": "pj_a", "name": "By bot"})))
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.message());
    let event = domain_events::Entity::find()
        .filter(domain_events::Column::Type.eq("milestone.created"))
        .order_by_desc(domain_events::Column::At)
        .one(f.w.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.actor, json!({"type": "agent", "id": "ag_1"}));
    f.w.drop().await;
}

// ── project scope (assertCanUseProject / projectHidden / applyProjectScope) ──

#[tokio::test]
async fn a_narrowed_member_only_reaches_milestones_of_their_projects() {
    let Some(f) = fx().await else { return };
    let a = f.make(json!({"projectId": "pj_a", "name": "A"})).await;
    let b = f.make(json!({"projectId": "pj_b", "name": "B"})).await;
    let scoped = narrowed(f.w.db(), "ws_acme", "scoped", &["pj_a"], false).await;

    let list = f.get(&scoped, MS).await;
    assert_eq!(ids_of(&list.body), [id(&a)]);
    assert_eq!(
        ids_of(&f.get(&scoped, &format!("{MS}?projectId=pj_b")).await.body),
        Vec::<String>::new()
    );
    assert_eq!(f.get(&scoped, &uri(&a)).await.status, StatusCode::OK);
    assert_eq!(f.get(&scoped, &uri(&b)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        f.patch(&scoped, &uri(&b), json!({"name": "x"})).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(f.delete(&scoped, &uri(&b)).await.status, StatusCode::NOT_FOUND);
    // creating in a project outside the access is a 403, in their own project it works
    let res = f.post(&scoped, MS, json!({"projectId": "pj_b", "name": "x"})).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.message(), "Outside the projects you can access");
    assert_eq!(
        f.post(&scoped, MS, json!({"projectId": "pj_a", "name": "x"})).await.status,
        StatusCode::CREATED
    );
    assert_eq!(f.patch(&scoped, &uri(&a), json!({"name": "A2"})).await.status, StatusCode::OK);
    // reordering returns only what they can see
    let res =
        f.post(&scoped, &format!("{MS}/reorder"), json!({"projectId": "pj_b", "ids": []})).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, json!([]));
    // a member with no project at all and no unassigned work sees nothing
    let nobody = narrowed(f.w.db(), "ws_acme", "nobody", &[], false).await;
    assert_eq!(f.get(&nobody, MS).await.body, json!([]));
    f.w.drop().await;
}

// ── MilestonesService.remove ──

#[tokio::test]
async fn deleting_detaches_issues_removes_comments_and_announces_the_issues() {
    let Some(f) = fx().await else { return };
    let m1 = f.make(json!({"projectId": "pj_a", "name": "M1"})).await;
    let m2 = f.make(json!({"projectId": "pj_a", "name": "M2"})).await;
    let (m1id, m2id) = (id(&m1), id(&m2));
    issue(f.w.db(), "ws_acme", 1, Some("pj_a"), &[&m1id, &m2id]).await;
    issue(f.w.db(), "ws_acme", 2, Some("pj_a"), &[&m2id]).await;
    issue(f.w.db(), "ws_acme", 3, Some("pj_a"), &[&m1id]).await;
    for (cid, subject) in [("cm_1", &m1id), ("cm_2", &m2id)] {
        sql(
            f.w.db(),
            &format!(
                r#"INSERT INTO comments (id, "workspaceId", subject, author, body)
                   VALUES ('{cid}', 'ws_acme', '{{"type":"milestone","id":"{subject}"}}', '{{"type":"user","id":"owner"}}', 'hi')"#
            ),
        )
        .await;
    }
    let mut live = f.w.events.subscribe();

    assert_eq!(f.delete(&f.owner, &uri(&m1)).await.status, StatusCode::NO_CONTENT);

    let rows =
        issues::Entity::find().order_by_asc(issues::Column::Number).all(f.w.db()).await.unwrap();
    let held: Vec<Value> = rows.iter().map(|i| i.milestone_ids.clone()).collect();
    assert_eq!(held, [json!([m2id]), json!([m2id]), json!([])]);
    let comments = sql_count(&f, "SELECT count(*) FROM comments").await;
    assert_eq!(comments, 1);
    assert_eq!(f.get(&f.owner, &uri(&m1)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(f.get(&f.owner, &uri(&m2)).await.status, StatusCode::OK);

    let mut announced = Vec::new();
    while let Ok(published) = live.try_recv() {
        if published.event.entity == LiveEventEntity::Issue {
            announced.push(published.event.id.clone());
        }
    }
    announced.sort();
    assert_eq!(announced, ["in_1", "in_3"]);
    f.w.drop().await;
}

async fn sql_count(f: &Fx, query: &str) -> i64 {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    let row =
        f.w.db()
            .query_one_raw(Statement::from_string(DbBackend::Postgres, query))
            .await
            .unwrap()
            .unwrap();
    row.try_get_by_index::<i64>(0).unwrap()
}

// ── milestone-scope.ts ──

#[tokio::test]
async fn pruning_keeps_only_milestones_of_the_issues_own_project() {
    let Some(f) = fx().await else { return };
    let a = id(&f.make(json!({"projectId": "pj_a", "name": "A"})).await);
    let b = id(&f.make(json!({"projectId": "pj_b", "name": "B"})).await);
    issue(f.w.db(), "ws_acme", 1, Some("pj_a"), &[&a, &b]).await; // loses b
    issue(f.w.db(), "ws_acme", 2, None, &[&a]).await; // no project: loses everything
    issue(f.w.db(), "ws_acme", 3, Some("pj_a"), &[&a]).await; // already consistent
    issue(f.w.db(), "ws_acme", 4, Some("pj_a"), &["ms_ghost"]).await; // unknown milestone
    issue(f.w.db(), "ws_acme", 5, Some("pj_b"), &[&a]).await; // not asked for
    let before = issues::Entity::find_by_id("in_3").one(f.w.db()).await.unwrap().unwrap();

    let all: Vec<String> = (1..=4).map(|n| format!("in_{n}")).collect();
    let mut changed = prune_issue_milestones(f.w.db(), "ws_acme", &all).await.unwrap();
    changed.sort();
    assert_eq!(changed, ["in_1", "in_2", "in_4"]);

    let held = |n: i32| {
        let db = f.w.db().clone();
        async move { issues::Entity::find_by_id(format!("in_{n}")).one(&db).await.unwrap().unwrap() }
    };
    assert_eq!(held(1).await.milestone_ids, json!([a]));
    assert_eq!(held(2).await.milestone_ids, json!([]));
    assert_eq!(held(4).await.milestone_ids, json!([]));
    assert_eq!(held(5).await.milestone_ids, json!([a]));
    let after = held(3).await;
    assert_eq!(after.milestone_ids, json!([a]));
    assert_eq!(after.updated_at, before.updated_at);
    assert!(held(1).await.updated_at > before.updated_at);

    assert!(prune_issue_milestones(f.w.db(), "ws_acme", &[]).await.unwrap().is_empty());
    // another workspace's id is never touched
    assert!(prune_issue_milestones(f.w.db(), "ws_other", &all).await.unwrap().is_empty());
    f.w.drop().await;
}

// ── service functions for the snapshot and the importers ──

#[tokio::test]
async fn the_service_lists_and_creates_for_other_crates() {
    use trama_contracts::common::ActorRef;
    use trama_milestones::{NewMilestone, service};

    let Some(f) = fx().await else { return };
    let target = trama_milestones::dates::parse("2026-12-01").unwrap();
    let m = service::create(
        &f.w.state,
        "ws_acme",
        &ActorRef::system(),
        NewMilestone {
            project_id: "pj_a".into(),
            name: "Imported".into(),
            description: None,
            target_date: Some(target),
            sort_order: None,
        },
    )
    .await
    .unwrap();
    assert!(m.sort_order.abs() < f64::EPSILON);
    assert_eq!(m.target_date.as_deref(), Some("2026-12-01T00:00:00.000Z"));
    let listed = service::list(f.w.db(), "ws_acme", None).await.unwrap();
    assert_eq!(listed, std::slice::from_ref(&m));
    assert_eq!(service::get(f.w.db(), "ws_acme", &m.id).await.unwrap(), m);
    let err = service::create(
        &f.w.state,
        "ws_acme",
        &ActorRef::system(),
        NewMilestone {
            project_id: "pj_zz".into(),
            name: "x".into(),
            description: None,
            target_date: None,
            sort_order: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
    f.w.drop().await;
}
