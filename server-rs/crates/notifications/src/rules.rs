//! Who should hear about an event, and what to tell them: `notification-rules.ts`.
//!
//! Pure: no database, no delivery. The actor never hears about their own action. Callers still
//! apply membership and each person's settings.

use std::collections::HashSet;

use serde_json::{Map, Value};
use trama_contracts::common::{ActorRef, ActorType, LegacySubjectRef, LegacySubjectType};
use trama_contracts::identity::NotificationKind;

/// The slice of a recorded domain event the rules need (`RuleEvent`).
#[derive(Clone, Debug, PartialEq)]
pub struct RuleEvent {
    /// Event type, e.g. `comment.created`.
    pub kind: String,
    /// Who caused it.
    pub actor: ActorRef,
    /// What it is about.
    pub subject: LegacySubjectRef,
    /// The event payload.
    pub data: Map<String, Value>,
}

/// The task an event is about, with what the rules and the delivery need of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleIssue {
    /// Task id.
    pub id: String,
    /// Task key, e.g. `AUTH-142`.
    pub key: String,
    /// Task title.
    pub title: String,
    /// Assignee.
    pub assignee_id: Option<String>,
    /// Reporter.
    pub reporter_id: Option<String>,
    /// Lets delivery skip people who cannot open the task's project.
    pub project_id: Option<String>,
}

/// Records the rules may refer to (`RuleContext`). The service loads whichever the event is
/// about.
#[derive(Clone, Debug, PartialEq)]
pub struct RuleContext {
    /// The event.
    pub event: RuleEvent,
    /// Display name of whoever caused the event.
    pub actor_name: String,
    /// The task, when the event is about one.
    pub issue: Option<RuleIssue>,
}

/// One message for one person, before settings and delivery are applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotificationDraft {
    /// Recipient.
    pub user_id: String,
    /// Why it is sent.
    pub kind: NotificationKind,
    /// Headline.
    pub title: String,
    /// Excerpt.
    pub body: Option<String>,
    /// Relative to the workspace, e.g. `tasks/AUTH-142`.
    pub link: String,
    /// What it is about.
    pub subject: LegacySubjectRef,
}

/// `asString`: a non-empty string.
fn as_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// JavaScript truthiness of a JSON value.
#[must_use]
pub fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// Who should hear about an event, and what to tell them (`planNotifications`).
///
/// The actor never hears about their own action; one message per person and kind.
#[must_use]
pub fn plan_notifications(ctx: &RuleContext) -> Vec<NotificationDraft> {
    let RuleContext { event, actor_name, issue } = ctx;
    let mut drafts: Vec<NotificationDraft> = Vec::new();
    let mut add = |user_id: Option<&str>, draft: &Draft| {
        if let Some(user_id) = user_id.filter(|id| !id.is_empty()) {
            drafts.push(draft.for_user(user_id));
        }
    };

    match event.kind.as_str() {
        "issue.created" => {
            add(as_string(event.data.get("assigneeId")), &assigned(issue.as_ref(), actor_name));
        }
        "issue.updated" => {
            let to = event.data.get("assignee").and_then(|change| change.get("to"));
            add(as_string(to), &assigned(issue.as_ref(), actor_name));
        }
        "review.requested" => {
            if let Some(issue) = issue {
                let draft = Draft {
                    kind: NotificationKind::ReviewRequested,
                    title: format!(
                        "Review requested: {}",
                        as_string(event.data.get("title")).unwrap_or("a pull request")
                    ),
                    body: Some(format!("{} · {}", issue.key, issue.title)),
                    link: format!("tasks/{}", issue.key),
                    subject: event.subject.clone(),
                };
                // The people the provider asked (mapped through their external identities) hear
                // about it; when none is known the task's assignee does.
                let reviewers: Vec<&str> = event
                    .data
                    .get("reviewerUserIds")
                    .and_then(Value::as_array)
                    .map(|ids| ids.iter().filter_map(Value::as_str).filter(|id| !id.is_empty()))
                    .into_iter()
                    .flatten()
                    .collect();
                if reviewers.is_empty() {
                    add(issue.assignee_id.as_deref(), &draft);
                } else {
                    for id in reviewers {
                        add(Some(id), &draft);
                    }
                }
            }
        }
        "artifact.updated" => {
            let ci_now = event
                .data
                .get("changes")
                .and_then(|changes| changes.get("ci"))
                .and_then(Value::as_array)
                .and_then(|ci| ci.get(1));
            if let (Some(issue), Some(Value::String(now))) = (issue, ci_now)
                && now == "failing"
            {
                add(
                    issue.assignee_id.as_deref(),
                    &Draft {
                        kind: NotificationKind::CiFailed,
                        title: format!(
                            "Checks are failing: {}",
                            as_string(event.data.get("title")).unwrap_or("a pull request")
                        ),
                        body: Some(format!("{} · {}", issue.key, issue.title)),
                        link: format!("tasks/{}", issue.key),
                        subject: event.subject.clone(),
                    },
                );
            }
        }
        "comment.created" => {
            let excerpt = as_string(event.data.get("excerpt"));
            if event.subject.kind == LegacySubjectType::Issue
                && let Some(issue) = issue
            {
                let draft = Draft {
                    kind: NotificationKind::Comment,
                    title: format!("{actor_name} commented on {}: {}", issue.key, issue.title),
                    body: excerpt.map(ToOwned::to_owned),
                    link: format!("tasks/{}", issue.key),
                    subject: event.subject.clone(),
                };
                add(issue.assignee_id.as_deref(), &draft);
                add(issue.reporter_id.as_deref(), &draft);
            }
        }
        _ => {}
    }

    // The actor never hears about their own action; one message per person and kind.
    let actor_id =
        (event.actor.kind == ActorType::User).then_some(event.actor.id.as_deref()).flatten();
    let mut seen: HashSet<(String, NotificationKind)> = HashSet::new();
    drafts
        .into_iter()
        .filter(|d| {
            Some(d.user_id.as_str()) != actor_id && seen.insert((d.user_id.clone(), d.kind))
        })
        .collect()
}

/// A [`NotificationDraft`] before it has a recipient (`Omit<NotificationDraft, 'userId'>`).
struct Draft {
    kind: NotificationKind,
    title: String,
    body: Option<String>,
    link: String,
    subject: LegacySubjectRef,
}

impl Draft {
    fn for_user(&self, user_id: &str) -> NotificationDraft {
        NotificationDraft {
            user_id: user_id.to_owned(),
            kind: self.kind,
            title: self.title.clone(),
            body: self.body.clone(),
            link: self.link.clone(),
            subject: self.subject.clone(),
        }
    }
}

fn assigned(issue: Option<&RuleIssue>, actor_name: &str) -> Draft {
    Draft {
        kind: NotificationKind::Assigned,
        title: issue.map_or_else(
            || format!("{actor_name} assigned you an issue"),
            |i| format!("{actor_name} assigned you {}: {}", i.key, i.title),
        ),
        body: None,
        link: issue.map_or_else(|| "tasks".to_owned(), |i| format!("tasks/{}", i.key)),
        subject: LegacySubjectRef {
            kind: LegacySubjectType::Issue,
            id: issue.map(|i| i.id.clone()).unwrap_or_default(),
        },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn issue() -> RuleIssue {
        RuleIssue {
            id: "iss_1".into(),
            key: "BUG-142".into(),
            title: "Session expires".into(),
            assignee_id: Some("usr_dev".into()),
            reporter_id: Some("usr_rep".into()),
            project_id: None,
        }
    }

    fn subject(kind: LegacySubjectType, id: &str) -> LegacySubjectRef {
        LegacySubjectRef { kind, id: id.into() }
    }

    #[allow(clippy::needless_pass_by_value)] // call sites pass `json!(...)`
    fn ctx(kind: &str, issue: Option<RuleIssue>, data: Value) -> RuleContext {
        RuleContext {
            event: RuleEvent {
                kind: kind.into(),
                actor: ActorRef::user("usr_actor"),
                subject: subject(LegacySubjectType::Issue, "iss_1"),
                data: data.as_object().cloned().unwrap_or_default(),
            },
            actor_name: "Maya".into(),
            issue,
        }
    }

    fn by(actor: ActorRef, mut ctx: RuleContext) -> RuleContext {
        ctx.event.actor = actor;
        ctx
    }

    fn users(drafts: &[NotificationDraft]) -> Vec<&str> {
        drafts.iter().map(|d| d.user_id.as_str()).collect()
    }

    #[test]
    fn tells_a_new_assignee_unless_they_assigned_it_to_themselves() {
        let drafts = plan_notifications(&ctx(
            "issue.updated",
            Some(issue()),
            json!({ "assignee": { "from": null, "to": "usr_dev" } }),
        ));
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].user_id, "usr_dev");
        assert_eq!(drafts[0].kind, NotificationKind::Assigned);
        assert_eq!(drafts[0].link, "tasks/BUG-142");
        assert_eq!(drafts[0].title, "Maya assigned you BUG-142: Session expires");
        assert_eq!(drafts[0].subject, subject(LegacySubjectType::Issue, "iss_1"));

        let own = by(
            ActorRef::user("usr_dev"),
            ctx("issue.updated", Some(issue()), json!({ "assignee": { "to": "usr_dev" } })),
        );
        assert_eq!(plan_notifications(&own), []);
        let other_fields = ctx("issue.updated", Some(issue()), json!({ "fields": ["title"] }));
        assert_eq!(plan_notifications(&other_fields), []);
    }

    #[test]
    fn assigns_on_creation_too() {
        let drafts = plan_notifications(&ctx(
            "issue.created",
            Some(issue()),
            json!({ "assigneeId": "usr_dev" }),
        ));
        assert_eq!(users(&drafts), ["usr_dev"]);
        assert_eq!(drafts[0].kind, NotificationKind::Assigned);
    }

    #[test]
    fn assignment_without_a_loaded_task_still_reads() {
        let drafts =
            plan_notifications(&ctx("issue.created", None, json!({ "assigneeId": "usr_dev" })));
        assert_eq!(drafts[0].title, "Maya assigned you an issue");
        assert_eq!(drafts[0].link, "tasks");
        assert_eq!(drafts[0].subject.id, "");
    }

    #[test]
    fn comments_notify_the_assignee_and_the_reporter_once_each_never_the_author() {
        let base = ctx("comment.created", Some(issue()), json!({ "excerpt": "Looks like a race" }));
        let mut all =
            users(&plan_notifications(&base)).into_iter().map(str::to_owned).collect::<Vec<_>>();
        all.sort();
        assert_eq!(all, ["usr_dev", "usr_rep"]);
        let drafts = plan_notifications(&base);
        assert_eq!(drafts[0].body.as_deref(), Some("Looks like a race"));
        assert_eq!(drafts[0].title, "Maya commented on BUG-142: Session expires");

        let by_assignee = by(ActorRef::user("usr_dev"), base.clone());
        assert_eq!(users(&plan_notifications(&by_assignee)), ["usr_rep"]);

        let mut same = base;
        same.issue.as_mut().unwrap().reporter_id = Some("usr_dev".into());
        // one message even if assignee and reporter coincide
        assert_eq!(users(&plan_notifications(&same)), ["usr_dev"]);
    }

    #[test]
    fn a_comment_on_something_else_says_nothing() {
        let mut c = ctx("comment.created", Some(issue()), json!({}));
        c.event.subject = subject(LegacySubjectType::Project, "pr_1");
        assert_eq!(plan_notifications(&c), []);
    }

    #[test]
    fn flags_review_requests_and_failing_ci_for_the_issue_assignee() {
        let artifact = subject(LegacySubjectType::Artifact, "ar_1");
        let review = RuleContext {
            event: RuleEvent {
                kind: "review.requested".into(),
                actor: ActorRef::agent("ag_1"),
                subject: artifact.clone(),
                data: json!({ "title": "PR #318" }).as_object().cloned().unwrap(),
            },
            actor_name: "x".into(),
            issue: Some(issue()),
        };
        let drafts = plan_notifications(&review);
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].user_id, "usr_dev");
        assert_eq!(drafts[0].kind, NotificationKind::ReviewRequested);
        assert_eq!(drafts[0].title, "Review requested: PR #318");
        assert_eq!(drafts[0].link, "tasks/BUG-142");
        assert_eq!(drafts[0].body.as_deref(), Some("BUG-142 · Session expires"));
        assert_eq!(drafts[0].subject, artifact);

        let artifact_event = |ci: Value| RuleContext {
            event: RuleEvent {
                kind: "artifact.updated".into(),
                actor: ActorRef::system(),
                subject: artifact.clone(),
                data: json!({ "title": "PR #318", "changes": { "ci": ci } })
                    .as_object()
                    .cloned()
                    .unwrap(),
            },
            actor_name: "Trama".into(),
            issue: Some(issue()),
        };
        let failing = plan_notifications(&artifact_event(json!(["pending", "failing"])));
        assert_eq!(
            failing.iter().map(|d| d.kind).collect::<Vec<_>>(),
            [NotificationKind::CiFailed]
        );
        assert_eq!(failing[0].title, "Checks are failing: PR #318");
        assert_eq!(plan_notifications(&artifact_event(json!(["failing", "passing"]))), []);
    }

    #[test]
    fn says_nothing_when_an_issue_has_no_assignee() {
        let mut unassigned = issue();
        unassigned.assignee_id = None;
        let c = ctx("review.requested", Some(unassigned), json!({ "title": "PR #318" }));
        assert_eq!(plan_notifications(&c), []);
    }

    #[test]
    fn sends_a_review_request_to_the_people_it_was_asked_from_not_the_assignee() {
        let drafts = plan_notifications(&by(
            ActorRef::system(),
            ctx(
                "review.requested",
                Some(issue()),
                json!({ "title": "PR #318", "reviewerUserIds": ["usr_a", "usr_b", "usr_a", 7, ""] }),
            ),
        ));
        assert_eq!(
            drafts.iter().map(|d| (d.user_id.as_str(), d.kind)).collect::<Vec<_>>(),
            [
                ("usr_a", NotificationKind::ReviewRequested),
                ("usr_b", NotificationKind::ReviewRequested)
            ]
        );
    }

    #[test]
    fn keeps_the_actor_out_of_their_own_review_request_and_falls_back_to_the_assignee() {
        let own = by(
            ActorRef::user("usr_a"),
            ctx("review.requested", Some(issue()), json!({ "reviewerUserIds": ["usr_a"] })),
        );
        assert_eq!(plan_notifications(&own), []);
        let unknown = ctx("review.requested", Some(issue()), json!({ "reviewerUserIds": [] }));
        assert_eq!(users(&plan_notifications(&unknown)), ["usr_dev"]);
    }

    #[test]
    fn ignores_retired_customer_decision_and_input_events() {
        for kind in [
            "input.requested",
            "decision.proposed",
            "customer_request.linked",
            "customer_request.updated",
            "issue.status_changed",
            "project.status_changed",
        ] {
            let c = ctx(
                kind,
                Some(issue()),
                json!({ "to": "done", "important": true, "assigneeUserId": "usr_ask" }),
            );
            assert_eq!(plan_notifications(&c), [], "{kind}");
        }
    }

    #[test]
    fn js_truthiness() {
        assert!(!js_truthy(None));
        assert!(!js_truthy(Some(&json!(null))));
        assert!(!js_truthy(Some(&json!(""))));
        assert!(!js_truthy(Some(&json!(0))));
        assert!(js_truthy(Some(&json!("x"))));
        assert!(js_truthy(Some(&json!({}))));
    }
}
