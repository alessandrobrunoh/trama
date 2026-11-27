//! Project transfer (`sharing.e2e-spec.ts`, "project transfer").

mod common;

use axum::http::StatusCode;
use serde_json::{Value, json};
use trama_contracts::activity::{LiveEventEntity, LiveEventType};
use trama_contracts::status::default_status_catalog;

use common::{
    Req, Res, World, member, only_projects, project, scalar, session, sql, token, user,
    workspace_with,
};

const SRC: &str = "/api/w/src";

struct Scene {
    w: World,
    owner: String,
}

/// The e2e `scene()`: `Transfer Source` and `Transfer Target`, both owned by `u_owner`, a project
/// `Checkout` with a milestone, two issues (a parent and a child assigned to somebody who is not
/// in the target), a time entry, a guest limited to the project and somebody who is not.
async fn scene() -> Option<Scene> {
    let w = World::new().await?;
    let db = w.db();
    let label = |id: &str, name: &str, color: &str| json!({ "id": id, "name": name, "color": color, "template": false, "scope": "issue" });
    let mut statuses = default_status_catalog();
    for entry in &mut statuses.issue {
        if entry.kind == "in_progress" {
            entry.id = "st_doing".to_owned();
            entry.name = "Doing".to_owned();
        }
    }
    workspace_with(
        db,
        "src",
        "Transfer Source",
        json!({ "labels": [
            label("lb_bug", "Bug", "#e11d48"),
            label("lb_design", "Needs design", "#7c3aed"),
        ] }),
    )
    .await;
    workspace_with(
        db,
        "tgt",
        "Transfer Target",
        json!({ "labels": [label("lb_tbug", "bug", "#2563eb")], "statuses": statuses }),
    )
    .await;
    user(db, "u_owner").await;
    member(db, "ws_src", "u_owner", "owner", None).await;
    member(db, "ws_tgt", "u_owner", "owner", None).await;

    project(db, "ws_src", "pj_main", "Checkout", "CHKO").await;
    sql(
        db,
        r#"INSERT INTO milestones (id, "workspaceId", name, "projectId") VALUES ('ms_beta', 'ws_src', 'Beta', 'pj_main')"#,
    )
    .await;
    user(db, "u_lost").await;
    member(db, "ws_src", "u_lost", "member", None).await;
    sql(
        db,
        r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "projectId", labels, "assigneeId")
           VALUES ('is_1', 'ws_src', 'CHKO-1', 1, 'feature', 'Parent task', 'manual', 'none', 'in_progress', 'pj_main', '["lb_bug"]', 'u_owner')"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "projectId", labels, "assigneeId", "parentId", "milestoneIds")
           VALUES ('is_2', 'ws_src', 'CHKO-2', 2, 'bug', 'Child task', 'manual', 'none', 'backlog', 'pj_main', '["lb_bug","lb_design"]', 'u_lost', 'is_1', '["ms_beta"]')"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO workspace_counters ("workspaceId", name, value) VALUES ('ws_src', 'issue-key:CHKO', 2)"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO time_entries (id, "workspaceId", "userId", "issueId", "startedAt", "endedAt")
           VALUES ('te_1', 'ws_src', 'u_owner', 'is_1', now() - interval '1 hour', now())"#,
    )
    .await;
    user(db, "u_guest").await;
    member(db, "ws_src", "u_guest", "viewer", Some(only_projects(&["pj_main"]))).await;
    let owner = session(db, "u_owner").await;
    Some(Scene { w, owner })
}

async fn preview(w: &World, cookie: &str, target: &str) -> Res {
    w.send(
        Req::get(&format!("{SRC}/projects/pj_main/transfer-preview?target={target}"))
            .session(cookie),
    )
    .await
}

async fn go(w: &World, cookie: &str, target: &str) -> Res {
    w.send(
        Req::post(&format!("{SRC}/projects/pj_main/transfer"))
            .session(cookie)
            .json(&json!({ "target": target })),
    )
    .await
}

async fn one(w: &World, select: &str) -> String {
    scalar(w.db(), select).await.unwrap_or_default()
}

#[tokio::test]
async fn previews_and_then_moves_the_project_with_its_issues_guests_and_history() {
    let Some(s) = scene().await else { return };
    let w = &s.w;

    let before = preview(w, &s.owner, "tgt").await;
    assert_eq!(before.status, StatusCode::OK, "{:?}", before.body);
    let body = &before.body;
    assert_eq!(body["project"], json!({ "id": "pj_main", "name": "Checkout", "key": "CHKO" }));
    assert_eq!(body["source"], json!({ "id": "ws_src", "slug": "src", "name": "Transfer Source" }));
    assert_eq!(body["target"], json!({ "id": "ws_tgt", "slug": "tgt", "name": "Transfer Target" }));
    assert_eq!(body["counts"], json!({ "issues": 2, "milestones": 1, "timeEntries": 1 }));
    assert_eq!(body["unassigned"], 1);
    assert_eq!(body["blockers"], json!([]));
    let mappings = body["mappings"].as_array().unwrap();
    for expected in [
        json!({ "kind": "label", "from": "Bug", "to": "bug", "action": "map", "count": 2 }),
        json!({ "kind": "label", "from": "Needs design", "to": "Needs design", "action": "create", "count": 1 }),
        json!({ "kind": "issue", "from": "In Progress", "to": "Doing", "action": "map", "count": 1 }),
    ] {
        assert!(mappings.contains(&expected), "{expected} not in {mappings:?}");
    }
    assert_eq!(
        body["guests"],
        json!([{
            "userId": "u_guest",
            "name": "User u_guest",
            "email": "u_guest@test.dev",
            "action": "add",
            "role": "viewer",
        }])
    );
    // a preview changes nothing
    assert_eq!(
        one(w, "SELECT \"workspaceId\" AS v FROM projects WHERE id = 'pj_main'").await,
        "ws_src"
    );

    // somebody who put the project in the target workspace now simply sees it there; a
    // placement elsewhere stays
    user(w.db(), "u_home").await;
    sql(
        w.db(),
        r#"INSERT INTO project_placements (id, "userId", "projectId", "workspaceId", position) VALUES
             ('pp_a', 'u_home', 'pj_main', 'ws_tgt', 0),
             ('pp_b', 'u_guest', 'pj_main', NULL, 0)"#,
    )
    .await;

    let mut live = w.events.subscribe();
    let done = go(w, &s.owner, "tgt").await;
    assert_eq!(done.status, StatusCode::OK, "{:?}", done.body);
    assert_eq!(done.body["project"]["id"], "pj_main");
    assert_eq!(done.body["project"]["key"], "CHKO");
    assert_eq!(done.body["project"]["workspaceId"], "ws_tgt");
    assert_eq!(done.body["project"]["status"], "in_progress");
    assert!(done.body["project"].get("health").is_none());
    assert_eq!(
        done.body["target"],
        json!({ "id": "ws_tgt", "slug": "tgt", "name": "Transfer Target" })
    );
    assert_eq!(done.body["counts"], json!({ "issues": 2, "milestones": 1, "timeEntries": 1 }));
    assert_eq!(done.body["unassigned"], 1);

    // gone from the source, whole in the target
    let rows = |table: &str, ws: &str| {
        format!(r#"SELECT count(*)::text AS v FROM {table} WHERE "workspaceId" = '{ws}'"#)
    };
    assert_eq!(one(w, &rows("issues", "ws_src")).await, "0");
    assert_eq!(one(w, &rows("issues", "ws_tgt")).await, "2");
    assert_eq!(one(w, &rows("milestones", "ws_tgt")).await, "1");
    assert_eq!(one(w, &rows("time_entries", "ws_tgt")).await, "1");
    assert_eq!(one(w, &rows("time_entries", "ws_src")).await, "0");

    // issue keys, parent links and the milestone survive; labels and statuses are the target's
    let parent = one(w, "SELECT concat_ws('|', key, status, labels::text, \"assigneeId\") AS v FROM issues WHERE id = 'is_1'").await;
    assert_eq!(parent, r#"CHKO-1|st_doing|["lb_tbug"]|u_owner"#);
    let child = one(
        w,
        "SELECT concat_ws('|', key, status, labels::text, \"parentId\", \"milestoneIds\"::text) AS v FROM issues WHERE id = 'is_2'",
    )
    .await;
    // the target did not use the label's id, so the new label keeps it
    assert_eq!(child, r#"CHKO-2|backlog|["lb_tbug", "lb_design"]|is_1|["ms_beta"]"#);
    // someone who is not in the target no longer holds the task
    assert_eq!(one(w, "SELECT \"assigneeId\" AS v FROM issues WHERE id = 'is_2'").await, "");
    // the missing label is now in the target's catalog
    let labels =
        one(w, "SELECT (settings->'labels')::text AS v FROM workspaces WHERE id = 'ws_tgt'").await;
    let labels: Value = serde_json::from_str(&labels).unwrap();
    assert_eq!(labels.as_array().unwrap().len(), 2);
    assert_eq!(
        labels[1],
        json!({ "id": "lb_design", "name": "Needs design", "color": "#7c3aed", "template": false, "scope": "issue" })
    );
    // the project moved, with its time entry still pointing at the issue
    assert_eq!(
        one(w, "SELECT \"projectId\" AS v FROM time_entries WHERE id = 'te_1'").await,
        "pj_main"
    );

    // the project.transferred event is recorded in the target, about the project
    let events = one(
        w,
        r#"SELECT jsonb_agg(jsonb_build_object('ws', "workspaceId", 'type', type, 'subject', subject, 'data', data, 'actor', actor))::text AS v
           FROM domain_events WHERE type = 'project.transferred'"#,
    )
    .await;
    let events: Value = serde_json::from_str(&events).unwrap();
    assert_eq!(events.as_array().unwrap().len(), 1);
    assert_eq!(events[0]["ws"], "ws_tgt");
    assert_eq!(events[0]["subject"], json!({ "type": "project", "id": "pj_main" }));
    assert_eq!(
        events[0]["data"],
        json!({
            "name": "Checkout",
            "key": "CHKO",
            "from": { "id": "ws_src", "slug": "src", "name": "Transfer Source" },
            "issues": 2,
        })
    );

    // the next issue continues the project's numbering
    assert_eq!(one(w, "SELECT value::text AS v FROM workspace_counters WHERE \"workspaceId\" = 'ws_tgt' AND name = 'issue-key:CHKO'").await, "2");

    // guests come along as limited members of the target, and Shared with me follows
    let carried = one(
        w,
        r#"SELECT concat_ws('|', role, access::text) AS v FROM memberships WHERE "workspaceId" = 'ws_tgt' AND "userId" = 'u_guest'"#,
    )
    .await;
    assert_eq!(
        carried,
        r#"viewer|{"grants": [], "projects": {"all": false, "projectIds": ["pj_main"]}, "includeUnassigned": false}"#
    );
    // their way into the source project is gone with it
    let left = one(
        w,
        r#"SELECT access->'projects'->>'projectIds' AS v FROM memberships WHERE "workspaceId" = 'ws_src' AND "userId" = 'u_guest'"#,
    )
    .await;
    assert_eq!(left, "[]");
    let guest = session(w.db(), "u_guest").await;
    let list = w.send(Req::get("/api/shared/projects").session(&guest)).await;
    assert_eq!(list.body[0]["id"], "pj_main");
    assert_eq!(list.body[0]["workspace"]["slug"], "tgt");
    // and the placement made in the target is gone, the other one stays
    assert_eq!(
        one(w, "SELECT string_agg(id, ',' ORDER BY id) AS v FROM project_placements").await,
        "pp_b"
    );
    assert_eq!(
        list.body[0]["placement"],
        json!({ "projectId": "pj_main", "workspaceId": null, "position": 0 })
    );

    // live events: the project leaves one workspace and arrives in the other
    let mut seen = Vec::new();
    while let Ok(published) = live.try_recv() {
        let e = published.event;
        seen.push((published.workspace_id, e.kind, e.entity, e.id));
    }
    let expected = [
        ("ws_src", LiveEventType::Deleted, LiveEventEntity::Project, "pj_main"),
        ("ws_src", LiveEventType::Updated, LiveEventEntity::Workspace, "ws_src"),
        ("ws_tgt", LiveEventType::Created, LiveEventEntity::Project, "pj_main"),
        ("ws_tgt", LiveEventType::Updated, LiveEventEntity::Workspace, "ws_tgt"),
        // the id of the membership event is the person's, as NestJS sends it
        ("ws_tgt", LiveEventType::Created, LiveEventEntity::Membership, "u_guest"),
    ];
    for want in expected {
        let want = (want.0.to_owned(), want.1, want.2, want.3.to_owned());
        assert!(seen.contains(&want), "{want:?} not in {seen:?}");
    }
    s.w.drop().await;
}

/// `updates go with their project when it is deleted or transferred` (`project-updates.e2e-spec`)
/// and the thread records and decisions of the moved tasks.
#[tokio::test]
async fn moves_project_updates_thread_records_and_decisions_with_the_project() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    let db = w.db();
    // the target's "on track" health has another id; a health it has no entry for is dropped
    let mut catalog = default_status_catalog();
    for entry in &mut catalog.project_health {
        if entry.kind == "on_track" {
            entry.id = "st_on".to_owned();
            entry.name = "On track".to_owned();
        }
    }
    sql(
        db,
        &format!(
            r#"UPDATE workspaces SET settings = jsonb_set(settings, '{{statuses}}', '{}'::jsonb) WHERE id = 'ws_tgt'"#,
            serde_json::to_string(&catalog).unwrap()
        ),
    )
    .await;
    sql(db, r#"UPDATE projects SET health = 'on_track' WHERE id = 'pj_main'"#).await;
    sql(
        db,
        r#"INSERT INTO project_updates (id, "workspaceId", "projectId", author, body, health) VALUES
             ('pu_a', 'ws_src', 'pj_main', '{"type":"user","id":"u_owner"}', 'Mapped', 'on_track'),
             ('pu_b', 'ws_src', 'pj_main', '{"type":"user","id":"u_owner"}', 'Kept as is', 'off_track'),
             ('pu_c', 'ws_src', 'pj_main', '{"type":"user","id":"u_owner"}', 'Unknown there', 'retired'),
             ('pu_d', 'ws_src', 'pj_main', '{"type":"user","id":"u_owner"}', 'No health', NULL)"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status)
           VALUES ('is_out', 'ws_src', 'UNPR-1', 1, 'bug', 'Stays behind', 'manual', 'none', 'backlog')"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO task_thread_records ("issueId", "workspaceId", summary, "lastSyncBy") VALUES
             ('is_1', 'ws_src', 'Moves', '{"type":"agent","id":"ag_1"}'),
             ('is_out', 'ws_src', 'Stays', '{"type":"agent","id":"ag_1"}');
           INSERT INTO task_decisions (id, "workspaceId", "issueId", text, "createdBy") VALUES
             ('dc_1', 'ws_src', 'is_1', 'Moves', '{"type":"agent","id":"ag_1"}'),
             ('dc_2', 'ws_src', 'is_2', 'Moves too', '{"type":"agent","id":"ag_1"}'),
             ('dc_out', 'ws_src', 'is_out', 'Stays', '{"type":"agent","id":"ag_1"}')"#,
    )
    .await;

    let res = go(w, &s.owner, "tgt").await;
    assert_eq!(res.status, StatusCode::OK, "{:?}", res.body);

    assert_eq!(
        one(
            w,
            r#"SELECT string_agg(concat_ws('|', id, "workspaceId", coalesce(health, '-')), ',' ORDER BY id) AS v FROM project_updates"#
        )
        .await,
        "pu_a|ws_tgt|st_on,pu_b|ws_tgt|off_track,pu_c|ws_tgt|-,pu_d|ws_tgt|-"
    );
    assert_eq!(
        one(
            w,
            r#"SELECT string_agg(concat_ws('|', "issueId", "workspaceId"), ',' ORDER BY "issueId") AS v FROM task_thread_records"#
        )
        .await,
        "is_1|ws_tgt,is_out|ws_src"
    );
    assert_eq!(
        one(
            w,
            r#"SELECT string_agg(concat_ws('|', id, "workspaceId"), ',' ORDER BY id) AS v FROM task_decisions"#
        )
        .await,
        "dc_1|ws_tgt,dc_2|ws_tgt,dc_out|ws_src"
    );
    s.w.drop().await;
}

#[tokio::test]
async fn carries_comments_artifacts_files_and_edges_and_clears_what_points_back() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    let db = w.db();
    sql(
        db,
        r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "parentId", "duplicateOfId")
           VALUES ('is_out', 'ws_src', 'UNPR-1', 1, 'bug', 'Stays behind', 'manual', 'none', 'backlog', NULL, NULL)"#,
    )
    .await;
    // a moved issue that points at one staying behind, and one staying behind that points at it
    sql(db, r#"UPDATE issues SET "duplicateOfId" = 'is_out' WHERE id = 'is_2'"#).await;
    sql(db, r#"UPDATE issues SET "duplicateOfId" = 'is_1' WHERE id = 'is_out'"#).await;
    sql(
        db,
        r#"INSERT INTO comments (id, "workspaceId", subject, author, body) VALUES
             ('cm_issue', 'ws_src', '{"type":"issue","id":"is_1"}', '{"type":"system"}', 'on the issue'),
             ('cm_out', 'ws_src', '{"type":"issue","id":"is_out"}', '{"type":"system"}', 'stays')"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO domain_events (id, "workspaceId", at, actor, type, subject, data) VALUES
             ('ev_proj', 'ws_src', now(), '{"type":"system"}', 'project.created', '{"type":"project","id":"pj_main"}', '{}'),
             ('ev_out', 'ws_src', now(), '{"type":"system"}', 'issue.created', '{"type":"issue","id":"is_out"}', '{}')"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO artifacts (id, "workspaceId", kind, provider, title, state, "issueId") VALUES
             ('ar_1', 'ws_src', 'pull_request', 'github', 'PR', 'open', 'is_1')"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO artifact_sources ("artifactId", "workspaceId") VALUES ('ar_1', 'ws_src')"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO dependencies (id, "workspaceId", "fromType", "fromId", "toType", "toId") VALUES
             ('dp_in', 'ws_src', 'issue', 'is_1', 'issue', 'is_2'),
             ('dp_cross', 'ws_src', 'issue', 'is_1', 'issue', 'is_out'),
             ('dp_out', 'ws_src', 'issue', 'is_out', 'issue', 'is_out2')"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO uploads (id, "workspaceId", filename, "contentType", "byteSize", bytes, referenced, "createdBy") VALUES
             ('up_own', 'ws_src', 'a.png', 'image/png', 1, '\x00', true, '{"type":"system"}'),
             ('up_shared', 'ws_src', 'b.png', 'image/png', 1, '\x00', true, '{"type":"system"}')"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO upload_references ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId") VALUES
             ('ws_src', 'up_own', 'comment', 'cm_issue', 'pj_main'),
             ('ws_src', 'up_shared', 'issue', 'is_1', 'pj_main'),
             ('ws_src', 'up_shared', 'issue', 'is_out', NULL)"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO favorites (id, "workspaceId", "userId", type, "subjectId") VALUES
             ('fv_1', 'ws_src', 'u_owner', 'issue', 'is_1'),
             ('fv_out', 'ws_src', 'u_owner', 'issue', 'is_out')"#,
    )
    .await;
    sql(
        db,
        r#"INSERT INTO notifications (id, "workspaceId", "userId", kind, title, actor, subject, link) VALUES
             ('nt_1', 'ws_src', 'u_owner', 'mention', 'x', '{"type":"system"}', '{"type":"issue","id":"is_1"}', '/x'),
             ('nt_out', 'ws_src', 'u_owner', 'mention', 'x', '{"type":"system"}', '{"type":"issue","id":"is_out"}', '/x')"#,
    )
    .await;
    // the dependency's far end has to exist as an issue; make it a plain one
    sql(
        db,
        r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status)
           VALUES ('is_out2', 'ws_src', 'UNPR-2', 2, 'bug', 'Also behind', 'manual', 'none', 'backlog')"#,
    )
    .await;

    let done = go(w, &s.owner, "tgt").await;
    assert_eq!(done.status, StatusCode::OK, "{:?}", done.body);

    let ws_of = |table: &str, id: &str| {
        format!(r#"SELECT "workspaceId" AS v FROM {table} WHERE id = '{id}'"#)
    };
    assert_eq!(one(w, &ws_of("comments", "cm_issue")).await, "ws_tgt");
    assert_eq!(one(w, &ws_of("comments", "cm_out")).await, "ws_src");
    assert_eq!(one(w, &ws_of("domain_events", "ev_proj")).await, "ws_tgt");
    assert_eq!(one(w, &ws_of("domain_events", "ev_out")).await, "ws_src");
    assert_eq!(one(w, &ws_of("artifacts", "ar_1")).await, "ws_tgt");
    assert_eq!(
        one(w, r#"SELECT "workspaceId" AS v FROM artifact_sources WHERE "artifactId" = 'ar_1'"#)
            .await,
        "ws_tgt"
    );
    // the edge inside the project moved; edges with an end left behind are gone
    assert_eq!(one(w, &ws_of("dependencies", "dp_in")).await, "ws_tgt");
    assert_eq!(
        one(w, "SELECT count(*)::text AS v FROM dependencies WHERE id = 'dp_cross'").await,
        "0"
    );
    assert_eq!(one(w, &ws_of("dependencies", "dp_out")).await, "ws_src");
    // a file only the moved records use follows them; one something behind still uses stays
    assert_eq!(one(w, &ws_of("uploads", "up_own")).await, "ws_tgt");
    assert_eq!(one(w, &ws_of("uploads", "up_shared")).await, "ws_src");
    assert_eq!(
        one(w, r#"SELECT string_agg("workspaceId" || ':' || "subjectId", ',' ORDER BY "subjectId") AS v FROM upload_references"#).await,
        "ws_tgt:cm_issue,ws_src:is_out"
    );
    // pins and inbox items about moved records are dropped, others stay
    assert_eq!(one(w, "SELECT string_agg(id, ',') AS v FROM favorites").await, "fv_out");
    assert_eq!(one(w, "SELECT string_agg(id, ',') AS v FROM notifications").await, "nt_out");
    // links across the two workspaces are cleared on both sides
    assert_eq!(one(w, "SELECT \"duplicateOfId\" AS v FROM issues WHERE id = 'is_2'").await, "");
    assert_eq!(one(w, "SELECT \"duplicateOfId\" AS v FROM issues WHERE id = 'is_out'").await, "");
    s.w.drop().await;
}

#[tokio::test]
async fn needs_owner_or_admin_rights_on_both_workspaces() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    let db = w.db();

    // an admin of the source who does not belong to the target cannot even see that it exists
    user(db, "u_admin").await;
    member(db, "ws_src", "u_admin", "admin", None).await;
    let admin = session(db, "u_admin").await;
    let hidden = go(w, &admin, "tgt").await;
    assert_eq!(hidden.status, StatusCode::NOT_FOUND);
    assert_eq!(hidden.message(), r#"Workspace "tgt" not found"#);
    assert_eq!(preview(w, &admin, "tgt").await.status, StatusCode::NOT_FOUND);

    // a plain member of the source cannot move projects at all
    let member_cookie = session(db, "u_lost").await;
    assert_eq!(go(w, &member_cookie, "tgt").await.status, StatusCode::FORBIDDEN);
    assert_eq!(preview(w, &member_cookie, "tgt").await.status, StatusCode::FORBIDDEN);

    // an admin of the source who is only a member of the target is refused
    workspace_with(db, "else", "Elsewhere", json!({})).await;
    user(db, "u_boss").await;
    member(db, "ws_else", "u_boss", "owner", None).await;
    member(db, "ws_else", "u_admin", "member", None).await;
    let denied = go(w, &admin, "else").await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(
        denied.message(),
        "You need to be an owner or admin of the target workspace to transfer a project into it"
    );
    assert_eq!(preview(w, &admin, "else").await.status, StatusCode::FORBIDDEN);

    // being admin on both is enough
    sql(db, r#"UPDATE memberships SET role = 'admin' WHERE "workspaceId" = 'ws_else' AND "userId" = 'u_admin'"#).await;
    let ok = preview(w, &admin, "else").await;
    assert_eq!(ok.status, StatusCode::OK, "{:?}", ok.body);
    assert_eq!(ok.body["target"]["slug"], "else");
    // an admin limited to some projects cannot take a project in
    sql(
        db,
        r#"UPDATE memberships SET access = '{"projects":{"all":false,"projectIds":["pj_other"]},"includeUnassigned":true,"grants":[]}'
           WHERE "workspaceId" = 'ws_else' AND "userId" = 'u_admin'"#,
    )
    .await;
    assert_eq!(preview(w, &admin, "else").await.status, StatusCode::FORBIDDEN);

    // unknown or identical targets; the slug is trimmed and lower-cased as NestJS does
    assert_eq!(go(w, &s.owner, "no-such-workspace").await.status, StatusCode::NOT_FOUND);
    let same = go(w, &s.owner, "src").await;
    assert_eq!(same.status, StatusCode::BAD_REQUEST);
    assert_eq!(same.message(), "The project already lives in that workspace");
    assert_eq!(preview(w, &s.owner, "%20TGT%20").await.status, StatusCode::OK);
    // an unknown project looks the same however it is asked
    let missing = w
        .send(
            Req::get(&format!("{SRC}/projects/pj_nope/transfer-preview?target=tgt"))
                .session(&s.owner),
        )
        .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.message(), r#"Project "pj_nope" not found"#);

    // an API token never moves a project
    let secret = token(db, "ws_src", "u_owner").await;
    let by_token = w
        .send(
            Req::post(&format!("{SRC}/projects/pj_main/transfer"))
                .bearer(&secret)
                .json(&json!({ "target": "tgt" })),
        )
        .await;
    assert_eq!(by_token.status, StatusCode::FORBIDDEN);
    let peek = w
        .send(
            Req::get(&format!("{SRC}/projects/pj_main/transfer-preview?target=tgt"))
                .bearer(&secret),
        )
        .await;
    assert_eq!(peek.status, StatusCode::FORBIDDEN);
    assert_eq!(
        one(w, "SELECT \"workspaceId\" AS v FROM projects WHERE id = 'pj_main'").await,
        "ws_src"
    );
    s.w.drop().await;
}

#[tokio::test]
async fn a_project_outside_the_callers_access_is_not_found() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    let db = w.db();
    // an admin limited to a different project of the source
    project(db, "ws_src", "pj_other", "Other", "OTHR").await;
    user(db, "u_narrow").await;
    member(db, "ws_src", "u_narrow", "admin", Some(only_projects(&["pj_other"]))).await;
    member(db, "ws_tgt", "u_narrow", "admin", None).await;
    let narrow = session(db, "u_narrow").await;
    let res = go(w, &narrow, "tgt").await;
    assert_eq!(res.status, StatusCode::NOT_FOUND, "{:?}", res.body);
    assert_eq!(res.message(), r#"Project "pj_main" not found"#);
    s.w.drop().await;
}

#[tokio::test]
async fn validates_the_target() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    let post = |body: Value| {
        Req::post(&format!("{SRC}/projects/pj_main/transfer")).session(&s.owner).json(&body)
    };
    let all = "target must be shorter than or equal to 80 characters; target must be longer than or equal to 1 characters; target must be a string";
    for body in [json!({}), json!({ "target": 5 })] {
        let res = w.send(post(body)).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST);
        assert_eq!(res.message(), all);
    }
    let long = w.send(post(json!({ "target": "a".repeat(81) }))).await;
    assert_eq!(long.message(), "target must be shorter than or equal to 80 characters");
    let no_query = w
        .send(Req::get(&format!("{SRC}/projects/pj_main/transfer-preview")).session(&s.owner))
        .await;
    assert_eq!(no_query.status, StatusCode::BAD_REQUEST);
    assert_eq!(no_query.message(), all);
    s.w.drop().await;
}

#[tokio::test]
async fn refuses_to_move_a_project_whose_tag_the_target_already_uses_and_moves_nothing() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    project(w.db(), "ws_src", "pj_clash", "Clash", "CLSH").await;
    sql(
        w.db(),
        r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "projectId")
           VALUES ('is_stay', 'ws_src', 'CLSH-1', 1, 'bug', 'Stays put', 'manual', 'none', 'backlog', 'pj_clash')"#,
    )
    .await;
    project(w.db(), "ws_tgt", "pj_here", "Already here", "CLSH").await;

    let peek = w
        .send(
            Req::get(&format!("{SRC}/projects/pj_clash/transfer-preview?target=tgt"))
                .session(&s.owner),
        )
        .await;
    assert_eq!(peek.status, StatusCode::OK);
    assert_eq!(
        peek.body["blockers"],
        json!(["The project tag CLSH is already used in Transfer Target. Change the tag first."])
    );
    let res = w
        .send(
            Req::post(&format!("{SRC}/projects/pj_clash/transfer"))
                .session(&s.owner)
                .json(&json!({ "target": "tgt" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(
        res.message(),
        "The project tag CLSH is already used in Transfer Target. Change the tag first."
    );
    assert_eq!(
        one(w, "SELECT \"workspaceId\" AS v FROM projects WHERE id = 'pj_clash'").await,
        "ws_src"
    );
    assert_eq!(
        one(w, "SELECT \"projectId\" AS v FROM issues WHERE id = 'is_stay'").await,
        "pj_clash"
    );
    assert_eq!(
        one(w, "SELECT count(*)::text AS v FROM domain_events WHERE type = 'project.transferred'")
            .await,
        "0"
    );
    s.w.drop().await;
}

#[tokio::test]
async fn blocks_when_issue_keys_would_collide_even_without_the_tag() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    // an issue of the target that has the key as an alias (a renamed project's old key)
    sql(
        w.db(),
        r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, aliases)
           VALUES ('is_alias', 'ws_tgt', 'OLD-1', 1, 'bug', 'Renamed', 'manual', 'none', 'backlog', '["CHKO-7"]')"#,
    )
    .await;
    let peek = preview(w, &s.owner, "tgt").await;
    assert_eq!(
        peek.body["blockers"],
        json!(["Transfer Target already has issues keyed CHKO-…, so the keys would collide."])
    );
    assert_eq!(go(w, &s.owner, "tgt").await.status, StatusCode::CONFLICT);
    s.w.drop().await;
}

#[tokio::test]
async fn blocks_when_the_target_has_no_role_a_guest_can_hold() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    // only the owner and an admin role are left in the target
    let roles = trama_contracts::roles::fresh_workspace_roles();
    let only: Vec<_> = roles.into_iter().filter(|r| r.owner || r.id == "admin").collect();
    sql(
        w.db(),
        &format!(
            r#"UPDATE workspaces SET settings = jsonb_set(settings, '{{roles}}', '{}'::jsonb) WHERE id = 'ws_tgt'"#,
            serde_json::to_string(&only).unwrap()
        ),
    )
    .await;
    let peek = preview(w, &s.owner, "tgt").await;
    assert_eq!(
        peek.body["blockers"],
        json!([
            "Transfer Target has no role a guest can hold (everything there is an owner or admin role), so User u_guest could not be carried over."
        ])
    );
    assert_eq!(peek.body["guests"], json!([]));
    s.w.drop().await;
}

#[tokio::test]
async fn something_that_already_exists_in_the_target_is_a_conflict_and_rolls_everything_back() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    // the same imported issue on both sides: the unique index of external references refuses it
    sql(
        w.db(),
        r#"UPDATE issues SET "externalRef" = '{"provider":"github","id":"42"}' WHERE id = 'is_1'"#,
    )
    .await;
    sql(
        w.db(),
        r#"INSERT INTO issues (id, "workspaceId", key, number, kind, title, source, priority, status, "externalRef")
           VALUES ('is_twin', 'ws_tgt', 'TWIN-1', 1, 'bug', 'Twin', 'manual', 'none', 'backlog', '{"provider":"github","id":"42"}')"#,
    )
    .await;
    let res = go(w, &s.owner, "tgt").await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(
        res.message(),
        "Something in this project already exists in the target workspace (an issue key or an imported issue)"
    );
    assert_eq!(
        one(w, "SELECT \"workspaceId\" AS v FROM projects WHERE id = 'pj_main'").await,
        "ws_src"
    );
    assert_eq!(one(w, "SELECT count(*)::text AS v FROM issues WHERE \"workspaceId\" = 'ws_src' AND \"projectId\" = 'pj_main'").await, "2");
    // the labels the plan wanted to add are not in the target either
    assert_eq!(
        one(w, "SELECT jsonb_array_length(settings->'labels')::text AS v FROM workspaces WHERE id = 'ws_tgt'").await,
        "1"
    );
    s.w.drop().await;
}

#[tokio::test]
async fn extends_a_guest_who_is_already_limited_in_the_target_and_keeps_full_members() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    let db = w.db();
    // the guest is already limited to another project in the target; Sam is a full member there
    project(db, "ws_tgt", "pj_tgt", "Target project", "TGTP").await;
    member(db, "ws_tgt", "u_guest", "viewer", Some(only_projects(&["pj_tgt"]))).await;
    user(db, "u_sam").await;
    member(db, "ws_src", "u_sam", "viewer", Some(only_projects(&["pj_main"]))).await;
    member(db, "ws_tgt", "u_sam", "member", None).await;
    let peek = preview(w, &s.owner, "tgt").await;
    let guests = peek.body["guests"].as_array().unwrap();
    let action_of = |id: &str| {
        guests.iter().find(|g| g["userId"] == id).map(|g| (g["action"].clone(), g["role"].clone()))
    };
    assert_eq!(action_of("u_guest"), Some((json!("extend"), json!("viewer"))));
    assert_eq!(action_of("u_sam"), Some((json!("keep"), json!("member"))));

    assert_eq!(go(w, &s.owner, "tgt").await.status, StatusCode::OK);
    let ids = |user: &str| {
        format!(
            r#"SELECT access->'projects'->>'projectIds' AS v FROM memberships WHERE "workspaceId" = 'ws_tgt' AND "userId" = '{user}'"#
        )
    };
    assert_eq!(one(w, &ids("u_guest")).await, r#"["pj_tgt", "pj_main"]"#);
    // a full member is untouched
    assert_eq!(one(w, &ids("u_sam")).await, "");
    // nobody got a second membership
    assert_eq!(
        one(w, r#"SELECT count(*)::text AS v FROM memberships WHERE "userId" = 'u_guest'"#).await,
        "2"
    );
    s.w.drop().await;
}

#[tokio::test]
async fn a_guest_role_member_loses_the_source_membership_when_nothing_is_left() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    user(w.db(), "u_visitor").await;
    member(w.db(), "ws_src", "u_visitor", "guest", Some(only_projects(&["pj_main"]))).await;
    let peek = preview(w, &s.owner, "tgt").await;
    let visitor = peek.body["guests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["userId"] == "u_visitor")
        .unwrap()
        .clone();
    assert_eq!(
        (visitor["action"].clone(), visitor["role"].clone()),
        (json!("add"), json!("guest"))
    );
    assert_eq!(go(w, &s.owner, "tgt").await.status, StatusCode::OK);
    assert_eq!(
        one(w, r#"SELECT count(*)::text AS v FROM memberships WHERE "workspaceId" = 'ws_src' AND "userId" = 'u_visitor'"#).await,
        "0"
    );
    assert_eq!(
        one(w, r#"SELECT role AS v FROM memberships WHERE "workspaceId" = 'ws_tgt' AND "userId" = 'u_visitor'"#).await,
        "guest"
    );
    s.w.drop().await;
}

#[tokio::test]
async fn a_placement_made_before_the_move_keeps_working_without_granting_anything() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    let db = w.db();
    workspace_with(db, "home", "Guest Home", json!({})).await;
    member(db, "ws_home", "u_guest", "owner", None).await;
    let guest = session(db, "u_guest").await;
    let placed = w
        .send(
            Req::put("/api/shared/projects/pj_main/placement")
                .session(&guest)
                .json(&json!({ "workspaceId": "ws_home" })),
        )
        .await;
    assert_eq!(placed.status, StatusCode::OK);
    assert_eq!(go(w, &s.owner, "tgt").await.status, StatusCode::OK);
    let list = w.send(Req::get("/api/shared/projects").session(&guest)).await;
    assert_eq!(list.body[0]["workspace"]["slug"], "tgt");
    assert_eq!(list.body[0]["placement"]["workspaceId"], "ws_home");
    s.w.drop().await;
}

#[tokio::test]
async fn the_transfer_event_is_visible_in_the_target_history_only() {
    let Some(s) = scene().await else { return };
    let w = &s.w;
    assert_eq!(go(w, &s.owner, "tgt").await.status, StatusCode::OK);
    let count = |ws: &str| {
        format!(
            r#"SELECT count(*)::text AS v FROM domain_events WHERE "workspaceId" = '{ws}' AND type = 'project.transferred'"#
        )
    };
    assert_eq!(one(w, &count("ws_tgt")).await, "1");
    assert_eq!(one(w, &count("ws_src")).await, "0");
    let actor =
        one(w, "SELECT actor::text AS v FROM domain_events WHERE type = 'project.transferred'")
            .await;
    let actor: Value = serde_json::from_str(&actor).unwrap();
    assert_eq!(actor, json!({ "type": "user", "id": "u_owner" }));
    s.w.drop().await;
}
