//! Agents, API tokens, labels and statuses over HTTP: `token-permissions.e2e-spec.ts`,
//! `tokens-controller.spec.ts`, `labels.service.spec.ts` and `statuses.service.spec.ts` as far
//! as they run through these routes.

mod common;

use axum::http::StatusCode;
use sea_orm::{ActiveModelTrait, EntityTrait, Set};
use serde_json::{Value, json};
use trama_contracts::labels::LabelScope;
use trama_contracts::roles::TokenScope;
use trama_entities::{api_tokens, issues};

use common::{Req, World, agent, custom_token, people, token};

fn labels_of(body: &Value) -> Vec<Value> {
    body["settings"]["labels"].as_array().cloned().unwrap_or_default()
}

async fn issue_with_labels(w: &World, id: &str, labels: Value) {
    issues::ActiveModel {
        id: Set(id.to_owned()),
        workspace_id: Set("ws_acme".to_owned()),
        number: Set(1),
        key: Set(format!("ACM-{id}")),
        kind: Set("bug".to_owned()),
        title: Set("Labelled".to_owned()),
        status: Set("todo".to_owned()),
        labels: Set(labels),
        ..Default::default()
    }
    .insert(w.db())
    .await
    .unwrap();
}

// ───────────────────────────── agents ─────────────────────────────

#[tokio::test]
async fn agents_are_managed_by_those_who_can_manage_agents() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;

    let body = json!({ "name": "Bot", "provider": "codex", "description": "Triage" });
    let bad = w
        .send(Req::post("/api/w/acme/agents").session(&p.admin).json(json!({ "provider": "x" })))
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    let made = w.send(Req::post("/api/w/acme/agents").session(&p.admin).json(body)).await;
    assert_eq!(made.status, StatusCode::CREATED, "{:?}", made.body);
    let id = made.body["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("ag_"));
    assert_eq!(made.body["provider"], "codex");

    // an owner who is not a member of the workspace is refused
    let outsider = w
        .send(
            Req::post("/api/w/acme/agents")
                .session(&p.admin)
                .json(json!({ "name": "B", "provider": "other", "ownerUserId": "u_out" })),
        )
        .await;
    assert_eq!(outsider.status, StatusCode::BAD_REQUEST);

    let url = format!("/api/w/acme/agents/{id}");
    let one = w.send(Req::get(&url).session(&p.viewer)).await;
    assert_eq!(one.status, StatusCode::OK);
    assert_eq!(one.body["name"], "Bot");
    assert_eq!(
        w.send(Req::get("/api/w/acme/agents").session(&p.viewer))
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        w.send(Req::get("/api/w/acme/agents/ag_missing").session(&p.viewer)).await.status,
        StatusCode::NOT_FOUND
    );

    // null clears the description and the owner
    let patched = w
        .send(
            Req::patch(&url)
                .session(&p.admin)
                .json(json!({ "name": "Bot 2", "description": null, "ownerUserId": "u_member" })),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{:?}", patched.body);
    assert_eq!(patched.body["name"], "Bot 2");
    assert_eq!(patched.body["ownerUserId"], "u_member");
    assert!(patched.body["description"].is_null());
    assert_eq!(
        w.send(Req::patch(&url).session(&p.member).json(json!({ "name": "X" }))).await.status,
        StatusCode::FORBIDDEN
    );

    // removing an agent removes the tokens that act as it
    let secret = common::agent_token(w.db(), "ws_acme", &id, TokenScope::Write).await;
    assert_eq!(w.send(Req::get("/api/auth/token").bearer(&secret)).await.status, StatusCode::OK);
    assert_eq!(w.send(Req::delete(&url).session(&p.member)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(w.send(Req::delete(&url).session(&p.admin)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(w.send(Req::get(&url).session(&p.admin)).await.status, StatusCode::NOT_FOUND);
    assert!(api_tokens::Entity::find().all(w.db()).await.unwrap().is_empty());
    w.drop().await;
}

// ───────────────────────────── tokens ─────────────────────────────

#[tokio::test]
async fn tokens_are_listed_per_person_and_never_show_a_secret_again() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    let post =
        |cookie: &str, body: Value| Req::post("/api/w/acme/tokens").session(cookie).json(body);

    let made = w.send(post(&p.member, json!({ "name": "ci" }))).await;
    assert_eq!(made.status, StatusCode::CREATED, "{:?}", made.body);
    let secret = made.body["secret"].as_str().unwrap().to_owned();
    assert!(secret.starts_with("trm_"));
    assert_eq!(made.body["token"]["scope"], "write");
    assert!(made.body["token"].get("secret").is_none() && made.body["token"].get("hash").is_none());
    let id = made.body["token"]["id"].as_str().unwrap().to_owned();
    // the secret works as a bearer
    assert_eq!(w.send(Req::get("/api/w/acme").bearer(&secret)).await.status, StatusCode::OK);

    w.send(post(&p.admin, json!({ "name": "admins" }))).await;
    // a member lists their own, an admin everyone's
    let mine = w.send(Req::get("/api/w/acme/tokens").session(&p.member)).await;
    assert_eq!(mine.body.as_array().unwrap().len(), 1);
    let all = w.send(Req::get("/api/w/acme/tokens").session(&p.admin)).await;
    assert_eq!(all.body.as_array().unwrap().len(), 2);
    assert!(all.body[0].get("secret").is_none());

    // others cannot revoke someone else's token (viewers cannot write at all); admins can
    let url = format!("/api/w/acme/tokens/{id}");
    let other = w.send(post(&p.owner, json!({ "name": "owner's" }))).await;
    let other_url = format!("/api/w/acme/tokens/{}", other.body["token"]["id"].as_str().unwrap());
    assert_eq!(
        w.send(Req::delete(&other_url).session(&p.member)).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(w.send(Req::delete(&url).session(&p.viewer)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(w.send(Req::delete(&url).session(&p.admin)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(
        w.send(Req::get("/api/w/acme").bearer(&secret)).await.status,
        StatusCode::UNAUTHORIZED
    );

    // viewers cannot manage tokens at all
    assert_eq!(
        w.send(post(&p.viewer, json!({ "name": "no" }))).await.status,
        StatusCode::FORBIDDEN
    );
    w.drop().await;
}

#[tokio::test]
async fn token_definitions_are_validated() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    let post = |body: Value| Req::post("/api/w/acme/tokens").session(&p.admin).json(body);
    let status = |res: &common::Res| res.status;

    assert_eq!(status(&w.send(post(json!({}))).await), StatusCode::BAD_REQUEST);
    assert_eq!(
        status(&w.send(post(json!({ "name": "t", "scope": "root" }))).await),
        StatusCode::BAD_REQUEST
    );
    // permissions imply custom scope; an empty or unknown-only list is refused
    let custom =
        w.send(post(json!({ "name": "t", "permissions": ["tasks:write", "projects:read"] }))).await;
    assert_eq!(custom.status, StatusCode::CREATED, "{:?}", custom.body);
    assert_eq!(custom.body["token"]["scope"], "custom");
    // write implies read
    assert_eq!(
        custom.body["token"]["permissions"],
        json!(["projects:read", "tasks:read", "tasks:write"])
    );
    assert_eq!(
        status(&w.send(post(json!({ "name": "t", "scope": "custom", "permissions": [] }))).await),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        status(&w.send(post(json!({ "name": "t", "permissions": ["nope:all"] }))).await),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        status(
            &w.send(post(json!({ "name": "t", "scope": "read", "permissions": ["tasks:read"] })))
                .await
        ),
        StatusCode::BAD_REQUEST
    );
    // limits are bounded, and an expiry must be a date
    assert_eq!(
        status(&w.send(post(json!({ "name": "t", "limits": { "requestsPerMinute": 0 } }))).await),
        StatusCode::BAD_REQUEST
    );
    let limited = w
        .send(post(json!({ "name": "t", "limits": { "writesPerDay": 5 }, "expiresAt": "2099-01-01T00:00:00Z" })))
        .await;
    assert_eq!(limited.status, StatusCode::CREATED, "{:?}", limited.body);
    assert_eq!(limited.body["token"]["limits"]["writesPerDay"], 5);
    assert_eq!(
        status(&w.send(post(json!({ "name": "t", "expiresAt": "tomorrow" }))).await),
        StatusCode::BAD_REQUEST
    );
    // `admin` scope needs an admin caller
    let as_member = w
        .send(
            Req::post("/api/w/acme/tokens")
                .session(&p.member)
                .json(json!({ "name": "t", "scope": "admin" })),
        )
        .await;
    assert_eq!(as_member.status, StatusCode::FORBIDDEN);
    w.drop().await;
}

#[tokio::test]
async fn a_token_cannot_escalate_by_minting_tokens() {
    let Some(w) = World::new().await else { return };
    let _ = people(&w).await;
    // a custom token with only issue permissions cannot mint tokens
    let secret = custom_token(w.db(), "ws_acme", "u_owner", &["tasks:read"]).await;
    let res = w
        .send(Req::post("/api/w/acme/tokens").bearer(&secret).json(json!({ "name": "child" })))
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN, "{:?}", res.body);
    // a read token cannot mint one wider than itself
    let read = token(w.db(), "ws_acme", "u_owner", TokenScope::Read).await;
    let res = w
        .send(
            Req::post("/api/w/acme/tokens")
                .bearer(&read)
                .json(json!({ "name": "child", "scope": "write" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN, "{:?}", res.body);
    w.drop().await;
}

#[tokio::test]
async fn agent_tokens_are_minted_by_admins_for_known_agents() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    agent(w.db(), "ws_acme", "ag_1").await;
    let post =
        |cookie: &str, body: Value| Req::post("/api/w/acme/tokens").session(cookie).json(body);

    let ok =
        w.send(post(&p.admin, json!({ "name": "bot", "agentId": "ag_1", "scope": "write" }))).await;
    assert_eq!(ok.status, StatusCode::CREATED, "{:?}", ok.body);
    assert_eq!(ok.body["token"]["actor"]["type"], "agent");
    assert_eq!(
        w.send(post(&p.member, json!({ "name": "bot", "agentId": "ag_1" }))).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.send(post(&p.admin, json!({ "name": "bot", "agentId": "ag_nope" }))).await.status,
        StatusCode::NOT_FOUND
    );
    w.drop().await;
}

// ───────────────────────────── labels ─────────────────────────────

#[tokio::test]
async fn labels_are_created_renamed_merged_and_removed() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    let post =
        |cookie: &str, body: Value| Req::post("/api/w/acme/labels").session(cookie).json(body);

    // a member may create while tagging; a viewer may not
    assert_eq!(
        w.send(post(&p.viewer, json!({ "name": "bug", "scope": "issue" }))).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.send(post(&p.member, json!({ "name": "", "scope": "issue" }))).await.status,
        StatusCode::BAD_REQUEST
    );
    let bug = w.send(post(&p.member, json!({ "name": "Bug", "scope": "issue" }))).await;
    assert_eq!(bug.status, StatusCode::CREATED, "{:?}", bug.body);
    let created = labels_of(&bug.body);
    assert_eq!(created.len(), 1);
    assert!(created[0]["color"].as_str().unwrap().starts_with('#'));
    let bug_id = created[0]["id"].as_str().unwrap().to_owned();
    // names are unique across the catalog, case-insensitively
    for scope in ["issue", "project"] {
        assert_eq!(
            w.send(post(&p.member, json!({ "name": "bug", "scope": scope }))).await.status,
            StatusCode::CONFLICT
        );
    }
    let feature = w
        .send(post(&p.admin, json!({ "name": "Feature", "scope": "issue", "color": "#112233" })))
        .await;
    let feature_id =
        labels_of(&feature.body).iter().find(|l| l["name"] == "Feature").unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();

    // renaming and archiving are admin work
    let url = |id: &str| format!("/api/w/acme/labels/{id}");
    assert_eq!(
        w.send(Req::patch(&url(&bug_id)).session(&p.member).json(json!({ "name": "Defect" })))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let renamed = w
        .send(
            Req::patch(&url(&bug_id))
                .session(&p.admin)
                .json(json!({ "name": "Defect", "color": "#ABCDEF" })),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{:?}", renamed.body);
    let defect = labels_of(&renamed.body).into_iter().find(|l| l["id"] == bug_id.as_str()).unwrap();
    assert_eq!(defect["name"], "Defect");
    assert_eq!(defect["color"], "#abcdef");
    assert_eq!(
        w.send(
            Req::patch("/api/w/acme/labels/lb_none").session(&p.admin).json(json!({ "name": "Z" }))
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );

    // merging moves the records and drops the source
    issue_with_labels(&w, "i1", json!([bug_id, feature_id])).await;
    let merged = w
        .send(
            Req::post(&format!("/api/w/acme/labels/{bug_id}/merge"))
                .session(&p.admin)
                .json(json!({ "into": feature_id })),
        )
        .await;
    assert_eq!(merged.status, StatusCode::CREATED, "{:?}", merged.body);
    assert!(labels_of(&merged.body).iter().all(|l| l["id"] != bug_id.as_str()));
    let issue = issues::Entity::find_by_id("i1").one(w.db()).await.unwrap().unwrap();
    assert_eq!(issue.labels, json!([feature_id]));

    // removing strips the label from records
    let removed = w.send(Req::delete(&url(&feature_id)).session(&p.admin)).await;
    assert_eq!(removed.status, StatusCode::OK, "{:?}", removed.body);
    let issue = issues::Entity::find_by_id("i1").one(w.db()).await.unwrap().unwrap();
    assert_eq!(issue.labels, json!([]));
    assert_eq!(
        w.send(Req::delete(&url(&feature_id)).session(&p.admin)).await.status,
        StatusCode::BAD_REQUEST
    );
    w.drop().await;
}

#[tokio::test]
async fn assign_validates_record_labels_against_the_catalog() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    let made = w
        .send(
            Req::post("/api/w/acme/labels")
                .session(&p.admin)
                .json(json!({ "name": "Bug", "scope": "issue" })),
        )
        .await;
    let id = labels_of(&made.body)[0]["id"].as_str().unwrap().to_owned();
    let assign = |ids: Option<Vec<String>>, scope| {
        let db = w.db();
        async move { trama_workspaces::labels::assign(db, "ws_acme", ids.as_deref(), scope, None).await }
    };

    assert_eq!(assign(None, Some(LabelScope::Issue)).await.unwrap(), None);
    assert_eq!(
        assign(Some(vec![id.clone(), id.clone()]), Some(LabelScope::Issue)).await.unwrap(),
        Some(vec![id.clone()])
    );
    assert!(assign(Some(vec!["lb_nope".into()]), Some(LabelScope::Issue)).await.is_err());
    // an issue label does not apply to projects
    let wrong = assign(Some(vec![id]), Some(LabelScope::Project)).await.unwrap_err();
    assert_eq!(wrong.status_code(), 400);
    w.drop().await;
}

// ───────────────────────────── statuses ─────────────────────────────

#[tokio::test]
async fn statuses_are_added_edited_and_removed_while_unused() {
    let Some(w) = World::new().await else { return };
    let p = people(&w).await;
    let base = "/api/w/acme/statuses/issue";
    let new =
        json!({ "name": "QA", "icon": "flask-conical", "color": "#AA00FF", "type": "in_review" });

    assert_eq!(
        w.send(Req::post(base).session(&p.member).json(new.clone())).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.send(Req::post("/api/w/acme/statuses/nope").session(&p.admin).json(new.clone()))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        w.send(
            Req::post(base)
                .session(&p.admin)
                .json(json!({ "icon": "x", "color": "#fff", "type": "in_review" }))
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    let made = w.send(Req::post(base).session(&p.admin).json(new.clone())).await;
    assert_eq!(made.status, StatusCode::CREATED, "{:?}", made.body);
    let qa = made.body["settings"]["statuses"]["issue"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "QA")
        .unwrap()
        .clone();
    assert_eq!(qa["color"], "#aa00ff");
    assert_eq!(qa["type"], "in_review");
    let qa_id = qa["id"].as_str().unwrap().to_owned();
    assert!(qa_id.starts_with("st_"));
    assert_eq!(
        w.send(Req::post(base).session(&p.admin).json(new)).await.status,
        StatusCode::CONFLICT
    );

    let url = format!("{base}/{qa_id}");
    let edited = w
        .send(
            Req::patch(&url)
                .session(&p.admin)
                .json(json!({ "name": "Quality", "color": "#000000" })),
        )
        .await;
    assert_eq!(edited.status, StatusCode::OK, "{:?}", edited.body);

    // a record on the status keeps it in the catalog
    issues::ActiveModel {
        id: Set("i1".to_owned()),
        workspace_id: Set("ws_acme".to_owned()),
        number: Set(1),
        key: Set("ACM-1".to_owned()),
        kind: Set("bug".to_owned()),
        title: Set("t".to_owned()),
        status: Set(qa_id.clone()),
        ..Default::default()
    }
    .insert(w.db())
    .await
    .unwrap();
    let busy = w.send(Req::delete(&url).session(&p.admin)).await;
    assert_eq!(busy.status, StatusCode::CONFLICT, "{:?}", busy.body);
    assert!(busy.message().contains("Quality"));
    issues::Entity::delete_by_id("i1").exec(w.db()).await.unwrap();
    assert_eq!(w.send(Req::delete(&url).session(&p.admin)).await.status, StatusCode::OK);
    // the last of a type stays
    assert_eq!(
        w.send(Req::delete(&format!("{base}/backlog")).session(&p.admin)).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        w.send(Req::delete(&format!("{base}/st_missing")).session(&p.admin)).await.status,
        StatusCode::BAD_REQUEST
    );
    w.drop().await;
}
