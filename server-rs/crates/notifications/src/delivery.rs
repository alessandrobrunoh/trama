//! Producing notifications: the half of `NotificationsService` that listens to recorded domain
//! events (`onModuleInit`, `handle`, `context`, `deliver`).
//!
//! [`spawn`] subscribes to [`Events::subscribe_recorded`] and handles every event on its own
//! task, so a slow SMTP server never delays the next event. An event becomes at most one message
//! per person and kind ([`crate::rules::plan_notifications`]); each message is then stored in
//! the person's inbox, pushed to their devices and emailed, as their settings ask.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use futures_util::future::join_all;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait,
    PaginatorTrait, QueryFilter, Set, Statement, TransactionTrait,
};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinHandle;
use trama_auth::member_access::project_hidden;
use trama_common::{Mail, Mailer, app_url};
use trama_contracts::access::{MemberAccess, effective_member_access};
use trama_contracts::activity::LiveEventEntity;
use trama_contracts::common::{ActorRef, ActorType, LegacySubjectRef, LegacySubjectType};
use trama_contracts::identity::{resolve_notification_settings, stored_member_access};
use trama_contracts::roles::find_workspace_role;
use trama_contracts::settings::resolve_workspace_settings;
use trama_core::AppState;
use trama_core::ids::uid;
use trama_entities::{
    agents, domain_events, issues, memberships, notifications, users, workspaces,
};
use trama_events::{Events, LiveChange};

use crate::push::{PushMessage, PushService};
use crate::rules::{
    NotificationDraft, RuleContext, RuleEvent, RuleIssue, js_truthy, plan_notifications,
};

/// An identical notification (same person, kind and title) inside this window is dropped.
const DEDUPE_WINDOW: Duration = Duration::from_secs(60);
/// Read notifications are kept this long.
const KEEP_READ_FOR: Duration = Duration::from_secs(90 * 24 * 60 * 60);
/// How many messages of one event are delivered at the same time.
pub const DELIVERY_CONCURRENCY: usize = 8;
/// The longest stored body (`slice(0, 500)`).
const MAX_BODY: usize = 500;
/// The longest push body (`slice(0, 200)`).
const MAX_PUSH_BODY: usize = 200;

/// Starts producing notifications from the domain events this instance records. The task ends
/// when the events service is dropped; abort the handle to stop it earlier.
///
/// Must be called inside a Tokio runtime. The subscription is made before this returns, so no
/// event recorded afterwards is missed.
#[must_use]
pub fn spawn(state: &AppState) -> JoinHandle<()> {
    let mut recorded = Events::of(state).subscribe_recorded();
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            match recorded.recv().await {
                Ok(event) => {
                    let state = state.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle(&state, &event).await {
                            tracing::warn!("Could not notify about {}: {e}", event.r#type);
                        }
                    });
                }
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!("Notifications fell behind and skipped {missed} events");
                }
                Err(RecvError::Closed) => break,
            }
        }
    })
}

/// Turns one recorded event into notifications (`handle`).
///
/// # Errors
///
/// Database errors.
pub async fn handle(state: &AppState, event: &domain_events::Model) -> Result<(), DbErr> {
    let db = &state.db;
    let Some(ctx) = context(db, event).await? else { return Ok(()) };
    let drafts = plan_notifications(&ctx);
    if drafts.is_empty() {
        return Ok(());
    }
    let env = Arc::new(Env {
        db: db.clone(),
        events: Events::of(state),
        mailer: Mailer::of(state),
        push: PushService::of(state),
        app_url: app_url(&state.config).to_owned(),
        actor: event.actor.clone(),
    });
    fan_out(db, &event.workspace_id, &ctx, drafts, move |workspace, recipient| {
        let env = Arc::clone(&env);
        async move { deliver(&env, &workspace, &recipient).await }
    })
    .await
}

/// A message with the person it is for, as loaded for delivery.
#[derive(Clone, Debug)]
pub struct Recipient {
    /// The message.
    pub draft: NotificationDraft,
    /// The person, when they still exist.
    pub user: Option<users::Model>,
    /// Whether they are still a member of the workspace.
    pub is_member: bool,
}

/// Loads the workspace, the recipients and their memberships (once each), drops the people who
/// cannot open the task's project, and hands the rest to `deliver`, at most
/// [`DELIVERY_CONCURRENCY`] at a time.
///
/// # Errors
///
/// Database errors, and the first error `deliver` returned (the later batches are then not
/// delivered).
pub async fn fan_out<F, Fut>(
    db: &DatabaseConnection,
    workspace_id: &str,
    ctx: &RuleContext,
    drafts: Vec<NotificationDraft>,
    deliver: F,
) -> Result<(), DbErr>
where
    F: Fn(Arc<workspaces::Model>, Recipient) -> Fut,
    Fut: Future<Output = Result<(), DbErr>>,
{
    let Some(workspace) = workspaces::Entity::find_by_id(workspace_id).one(db).await? else {
        return Ok(());
    };
    let mut recipients: Vec<String> = Vec::new();
    for draft in &drafts {
        if !recipients.contains(&draft.user_id) {
            recipients.push(draft.user_id.clone());
        }
    }
    let found_users =
        users::Entity::find().filter(users::Column::Id.is_in(recipients.clone())).all(db).await?;
    let found_memberships = memberships::Entity::find()
        .filter(memberships::Column::WorkspaceId.eq(workspace.id.clone()))
        .filter(memberships::Column::UserId.is_in(recipients))
        .all(db)
        .await?;
    let users_by_id: HashMap<String, users::Model> =
        found_users.into_iter().map(|user| (user.id.clone(), user)).collect();
    let member_ids: HashSet<&str> = found_memberships.iter().map(|m| m.user_id.as_str()).collect();
    // Someone limited to some projects is not told about work in the others (the title would
    // leak in the email).
    let roles = resolve_workspace_settings(&workspace.settings).roles;
    let access_of: HashMap<&str, Option<MemberAccess>> = found_memberships
        .iter()
        .map(|m| {
            let stored = stored_member_access(m.access.as_ref());
            let role = find_workspace_role(&roles, Some(&m.role));
            (m.user_id.as_str(), effective_member_access(role, stored.as_ref()))
        })
        .collect();
    // `Some(None)`: the task has no project; `None`: the event is not about a project at all
    let project: Option<Option<&str>> = match &ctx.issue {
        Some(issue) => Some(issue.project_id.as_deref()),
        None if ctx.event.subject.kind == LegacySubjectType::Project => {
            Some(Some(ctx.event.subject.id.as_str()))
        }
        None => None,
    };
    let deliverable: Vec<Recipient> = drafts
        .into_iter()
        .filter(|draft| {
            project.is_none_or(|project| {
                let access = access_of.get(draft.user_id.as_str()).and_then(Option::as_ref);
                !project_hidden(access, project)
            })
        })
        .map(|draft| Recipient {
            user: users_by_id.get(&draft.user_id).cloned(),
            is_member: member_ids.contains(draft.user_id.as_str()),
            draft,
        })
        .collect();
    let workspace = Arc::new(workspace);
    for batch in deliverable.chunks(DELIVERY_CONCURRENCY) {
        let results = join_all(
            batch.iter().map(|recipient| deliver(Arc::clone(&workspace), recipient.clone())),
        )
        .await;
        results.into_iter().collect::<Result<Vec<()>, DbErr>>()?;
    }
    Ok(())
}

/// Loads the records an event is about; `None` when the event cannot produce a notification
/// (`context`).
///
/// # Errors
///
/// Database errors.
pub async fn context(
    db: &DatabaseConnection,
    event: &domain_events::Model,
) -> Result<Option<RuleContext>, DbErr> {
    let interesting = matches!(
        event.r#type.as_str(),
        "issue.created"
            | "issue.updated"
            | "review.requested"
            | "artifact.updated"
            | "comment.created"
    );
    if !interesting {
        return Ok(None);
    }
    let data = event.data.as_object().cloned().unwrap_or_default();
    if event.r#type == "issue.updated"
        && !js_truthy(data.get("assignee").and_then(|change| change.get("to")))
    {
        return Ok(None);
    }
    if event.r#type == "issue.created" && !js_truthy(data.get("assigneeId")) {
        return Ok(None);
    }
    let Ok(subject) = serde_json::from_value::<LegacySubjectRef>(event.subject.clone()) else {
        return Ok(None);
    };
    let actor = serde_json::from_value::<ActorRef>(event.actor.clone())
        .unwrap_or_else(|_| ActorRef::system());

    let actor_name = actor_name(db, &actor).await?;
    let mut issue = None;
    if subject.kind == LegacySubjectType::Issue {
        issue = find_issue(db, &event.workspace_id, &subject.id).await?;
        if issue.is_none() {
            return Ok(None);
        }
    }
    if issue.is_none()
        && let Some(issue_id) = data.get("issueId").and_then(Value::as_str)
    {
        issue = find_issue(db, &event.workspace_id, issue_id).await?;
    }
    Ok(Some(RuleContext {
        event: RuleEvent { kind: event.r#type.clone(), actor, subject, data },
        actor_name,
        issue,
    }))
}

async fn find_issue(
    db: &DatabaseConnection,
    workspace_id: &str,
    id: &str,
) -> Result<Option<RuleIssue>, DbErr> {
    Ok(issues::Entity::find_by_id(id)
        .filter(issues::Column::WorkspaceId.eq(workspace_id))
        .one(db)
        .await?
        .map(|issue| RuleIssue {
            id: issue.id,
            key: issue.key,
            title: issue.title,
            assignee_id: issue.assignee_id,
            reporter_id: issue.reporter_id,
            project_id: issue.project_id,
        }))
}

async fn actor_name(db: &DatabaseConnection, actor: &ActorRef) -> Result<String, DbErr> {
    let id = actor.id.as_deref().filter(|id| !id.is_empty());
    Ok(match (actor.kind, id) {
        (ActorType::User, Some(id)) => users::Entity::find_by_id(id)
            .one(db)
            .await?
            .map_or_else(|| "Someone".to_owned(), |user| user.name),
        (ActorType::Agent, Some(id)) => agents::Entity::find_by_id(id)
            .one(db)
            .await?
            .map_or_else(|| "An agent".to_owned(), |agent| agent.name),
        _ => "Trama".to_owned(),
    })
}

/// What [`deliver`] needs besides the message.
pub struct Env {
    /// Database.
    pub db: DatabaseConnection,
    /// Live events.
    pub events: Events,
    /// Email.
    pub mailer: Mailer,
    /// Web Push.
    pub push: PushService,
    /// Base URL of the web app, for links in emails.
    pub app_url: String,
    /// The stored actor of the event, kept on the notification.
    pub actor: Value,
}

/// `JSON.stringify([workspaceId, userId, kind, title])`: the text whose hash is the advisory
/// lock that serializes competing deliveries of the same message.
#[must_use]
pub fn dedupe_lock_key(workspace_id: &str, user_id: &str, kind: &str, title: &str) -> String {
    serde_json::to_string(&[workspace_id, user_id, kind, title]).unwrap_or_default()
}

/// `String.prototype.slice(0, max)`: counts UTF-16 units, so a character that does not fit whole
/// becomes the replacement character, as it does when Node encodes a lone surrogate.
#[must_use]
pub fn js_slice(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        let width = c.len_utf16();
        if units + width > max {
            if units < max {
                out.push('\u{fffd}');
            }
            break;
        }
        out.push(c);
        units += width;
    }
    out
}

/// Applies the person's settings and membership, stores the notification and pushes and emails
/// it if asked (`deliver`).
///
/// # Errors
///
/// Database errors from the in-app delivery. Push and email problems are logged only.
pub async fn deliver(
    env: &Env,
    workspace: &workspaces::Model,
    recipient: &Recipient,
) -> Result<(), DbErr> {
    let Some(user) = recipient.user.as_ref().filter(|_| recipient.is_member) else {
        return Ok(());
    };
    let draft = &recipient.draft;
    let channels = resolve_notification_settings(Some(&user.notification_settings)).get(draft.kind);

    if channels.in_app
        && let Some(row) = store(env, workspace, user, draft).await?
    {
        env.events.publish_to_user(
            &workspace.id,
            LiveChange::created(LiveEventEntity::Notification, row.id),
            &user.id,
        );
        // read notifications are kept for a while, then forgotten
        let cutoff = Utc::now() - KEEP_READ_FOR;
        let forgotten = notifications::Entity::delete_many()
            .filter(notifications::Column::UserId.eq(user.id.clone()))
            .filter(notifications::Column::ReadAt.lt(cutoff.fixed_offset()))
            .exec(&env.db)
            .await;
        if let Err(e) = forgotten {
            tracing::warn!("Could not remove old notifications: {e}");
        }
    }

    if channels.push && env.push.enabled() {
        let message = PushMessage {
            title: draft.title.clone(),
            body: draft.body.as_deref().map(|b| js_slice(b, MAX_PUSH_BODY)),
            path: format!("/{}/{}", workspace.slug, draft.link),
            tag: Some(format!("{}:{}", draft.kind, draft.subject.id)),
        };
        if let Err(e) = env.push.send(&env.db, &user.id, &message).await {
            tracing::warn!("Could not push \"{}\": {e}", draft.title);
        }
    }

    if channels.email && env.mailer.enabled() {
        let url = format!("{}/{}/{}", env.app_url, workspace.slug, draft.link);
        let mut lines = vec![draft.title.clone()];
        lines.extend(draft.body.clone());
        lines.extend([
            String::new(),
            url,
            String::new(),
            "You can change what Trama emails you in Settings → Notifications.".to_owned(),
        ]);
        env.mailer
            .send(Mail {
                to: user.email.clone(),
                subject: draft.title.clone(),
                text: lines.join("\n"),
                html: None,
            })
            .await;
    }
    Ok(())
}

/// Stores the in-app notification unless an identical one was stored in the last minute. The
/// advisory lock makes two instances (or two events) delivering the same message take turns, so
/// the second one sees the first one's row.
async fn store(
    env: &Env,
    workspace: &workspaces::Model,
    user: &users::Model,
    draft: &NotificationDraft,
) -> Result<Option<notifications::Model>, DbErr> {
    let txn = env.db.begin().await?;
    let key = dedupe_lock_key(&workspace.id, &user.id, draft.kind.as_str(), &draft.title);
    txn.execute_raw(Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [key.into()],
    ))
    .await?;
    let window_start = Utc::now() - DEDUPE_WINDOW;
    let duplicate = notifications::Entity::find()
        .filter(notifications::Column::WorkspaceId.eq(workspace.id.clone()))
        .filter(notifications::Column::UserId.eq(user.id.clone()))
        .filter(notifications::Column::Kind.eq(draft.kind.as_str()))
        .filter(notifications::Column::Title.eq(draft.title.clone()))
        .filter(notifications::Column::CreatedAt.gt(window_start.fixed_offset()))
        .count(&txn)
        .await?
        > 0;
    if duplicate {
        txn.commit().await?;
        return Ok(None);
    }
    let row = notifications::ActiveModel {
        id: Set(uid("ntf")),
        workspace_id: Set(workspace.id.clone()),
        user_id: Set(user.id.clone()),
        kind: Set(draft.kind.as_str().to_owned()),
        title: Set(draft.title.clone()),
        body: Set(draft.body.as_deref().map(|b| js_slice(b, MAX_BODY))),
        actor: Set(env.actor.clone()),
        subject: Set(serde_json::to_value(&draft.subject).unwrap_or(Value::Null)),
        link: Set(draft.link.clone()),
        read_at: Set(None),
        ..Default::default()
    }
    .insert(&txn)
    .await?;
    txn.commit().await?;
    Ok(Some(row))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use sea_orm::{DatabaseBackend, MockDatabase};
    use serde_json::json;
    use trama_contracts::identity::NotificationKind;
    use trama_contracts::roles::fresh_workspace_roles;

    use super::*;

    fn workspace() -> workspaces::Model {
        workspaces::Model {
            id: "w1".into(),
            name: "Acme".into(),
            slug: "acme".into(),
            created_at: Utc::now().fixed_offset(),
            settings: json!({ "roles": fresh_workspace_roles() }),
            primary_owner_id: None,
            personal: false,
        }
    }

    fn user(id: &str) -> users::Model {
        users::Model {
            id: id.into(),
            name: id.into(),
            email: format!("{id}@test.dev"),
            password_hash: String::new(),
            avatar_hue: 1,
            created_at: Utc::now().fixed_offset(),
            notification_settings: json!({}),
        }
    }

    fn membership(user_id: &str, role: &str, access: Option<Value>) -> memberships::Model {
        memberships::Model {
            id: format!("mb_{user_id}"),
            workspace_id: "w1".into(),
            user_id: user_id.into(),
            role: role.into(),
            created_at: Utc::now().fixed_offset(),
            access,
        }
    }

    fn draft(user_id: &str) -> NotificationDraft {
        NotificationDraft {
            user_id: user_id.into(),
            kind: NotificationKind::Comment,
            title: "New comment".into(),
            body: None,
            link: "tasks/ABC-1".into(),
            subject: LegacySubjectRef { kind: LegacySubjectType::Issue, id: "i1".into() },
        }
    }

    fn rule_context(project_id: Option<&str>) -> RuleContext {
        RuleContext {
            event: RuleEvent {
                kind: "comment.created".into(),
                actor: ActorRef::user("actor"),
                subject: LegacySubjectRef { kind: LegacySubjectType::Issue, id: "i1".into() },
                data: serde_json::Map::new(),
            },
            actor_name: "Actor".into(),
            issue: Some(RuleIssue {
                id: "i1".into(),
                key: "ABC-1".into(),
                title: "Issue".into(),
                assignee_id: None,
                reporter_id: None,
                project_id: project_id.map(ToOwned::to_owned),
            }),
        }
    }

    #[tokio::test]
    async fn batch_loads_users_and_memberships_once_for_unique_recipients() {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![workspace()]])
            .append_query_results([vec![user("u1"), user("u2")]])
            .append_query_results([vec![
                membership("u1", "member", None),
                membership("u2", "member", None),
            ]])
            .into_connection();
        let delivered = Mutex::new(Vec::new());
        let drafts = vec![draft("u1"), draft("u2"), draft("u1")];
        fan_out(&db, "w1", &rule_context(None), drafts, |_, recipient| {
            delivered.lock().unwrap().push((recipient.draft.user_id.clone(), recipient.is_member));
            async { Ok(()) }
        })
        .await
        .unwrap();
        assert_eq!(delivered.lock().unwrap().len(), 3);
        let log = db.into_transaction_log();
        let sql: Vec<String> =
            log.iter().flat_map(|t| t.statements().iter().map(ToString::to_string)).collect();
        assert_eq!(sql.len(), 3, "{sql:#?}");
        assert!(sql[0].contains("FROM \"workspaces\""));
        assert_eq!(sql.iter().filter(|s| s.contains("FROM \"users\"")).count(), 1);
        assert_eq!(sql.iter().filter(|s| s.contains("FROM \"memberships\"")).count(), 1);
    }

    #[tokio::test]
    async fn never_runs_more_than_eight_deliveries_concurrently() {
        let ids: Vec<String> = (0..10).map(|i| format!("u{i}")).collect();
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![workspace()]])
            .append_query_results([ids.iter().map(|id| user(id)).collect::<Vec<_>>()])
            .append_query_results([ids
                .iter()
                .map(|id| membership(id, "member", None))
                .collect::<Vec<_>>()])
            .into_connection();
        let active = AtomicUsize::new(0);
        let maximum = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        let drafts: Vec<_> = ids.iter().map(|id| draft(id)).collect();
        fan_out(&db, "w1", &rule_context(None), drafts, |_, _| {
            let (active, maximum, done) = (&active, &maximum, &done);
            async move {
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(1)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                done.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        })
        .await
        .unwrap();
        assert_eq!(maximum.load(Ordering::SeqCst), 8);
        assert_eq!(done.load(Ordering::SeqCst), 10);
    }

    #[tokio::test]
    async fn does_not_notify_a_guest_about_work_in_a_project_outside_their_list() {
        let guest = |projects: &[&str]| json!({ "projects": { "all": false, "projectIds": projects }, "includeUnassigned": false, "grants": [] });
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![workspace()]])
            .append_query_results([vec![user("guest-in"), user("guest-out"), user("member")]])
            .append_query_results([vec![
                membership("guest-in", "guest", Some(guest(&["p1"]))),
                membership("guest-out", "guest", Some(guest(&["p2"]))),
                membership("member", "member", None),
            ]])
            .into_connection();
        let notified = Mutex::new(Vec::new());
        let drafts = vec![draft("guest-in"), draft("guest-out"), draft("member")];
        fan_out(&db, "w1", &rule_context(Some("p1")), drafts, |_, recipient| {
            notified.lock().unwrap().push(recipient.draft.user_id);
            async { Ok(()) }
        })
        .await
        .unwrap();
        let mut notified = notified.into_inner().unwrap();
        notified.sort();
        assert_eq!(notified, ["guest-in", "member"]);
    }

    #[tokio::test]
    async fn a_failing_delivery_stops_the_later_batches() {
        let ids: Vec<String> = (0..10).map(|i| format!("u{i}")).collect();
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![workspace()]])
            .append_query_results([ids.iter().map(|id| user(id)).collect::<Vec<_>>()])
            .append_query_results([ids
                .iter()
                .map(|id| membership(id, "member", None))
                .collect::<Vec<_>>()])
            .into_connection();
        let calls = AtomicUsize::new(0);
        let drafts: Vec<_> = ids.iter().map(|id| draft(id)).collect();
        let result = fan_out(&db, "w1", &rule_context(None), drafts, |_, _| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(DbErr::Custom("boom".into())) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn the_lock_key_is_the_json_of_workspace_user_kind_and_title() {
        assert_eq!(
            dedupe_lock_key("w1", "u1", "assigned", "Assigned"),
            r#"["w1","u1","assigned","Assigned"]"#
        );
        assert_eq!(dedupe_lock_key("w", "u", "k", "a \"b\""), r#"["w","u","k","a \"b\""]"#);
    }

    #[test]
    fn slices_by_utf16_units_like_javascript() {
        assert_eq!(js_slice("hello", 3), "hel");
        assert_eq!(js_slice("hello", 10), "hello");
        assert_eq!(js_slice("é😀x", 3), "é😀");
        assert_eq!(js_slice("é😀x", 2), "é\u{fffd}");
        assert_eq!(js_slice("", 5), "");
    }
}
