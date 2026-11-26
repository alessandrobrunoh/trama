//! Time-tracking facts that follow an issue's status, and who claims an issue that starts
//! (`applyStatusFacts` and `claimAssignee` of `issues.service.ts`).

use chrono::{DateTime, Utc};
use trama_contracts::common::{ActorRef, ActorType};

/// `startedAt` and `completedAt` of an issue.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StatusFacts {
    /// First time the issue entered `in_progress` / `in_review`; kept afterwards.
    pub started_at: Option<DateTime<Utc>>,
    /// Set when the issue becomes done or canceled; cleared when it is reopened.
    pub completed_at: Option<DateTime<Utc>>,
}

/// Applies a move to the status of semantic type `to`: `startedAt` is set the first time the
/// issue enters `in_progress` / `in_review` (and kept afterwards); `completedAt` is set when it
/// becomes `done` or `canceled` and cleared when it is reopened.
pub fn apply_status_facts(facts: &mut StatusFacts, to: &str, now: DateTime<Utc>) {
    if matches!(to, "in_progress" | "in_review") && facts.started_at.is_none() {
        facts.started_at = Some(now);
    }
    if matches!(to, "done" | "canceled") {
        facts.completed_at.get_or_insert(now);
    } else {
        facts.completed_at = None;
    }
}

/// The user who moves an unassigned issue to `in_progress` becomes the assignee. An explicit
/// assignee (including `null`, `assignee_was_set`) wins. Agents and other actors do not claim,
/// and an issue that is already `in_progress` is left as it is.
#[must_use]
pub fn claim_assignee(
    actor: &ActorRef,
    from: Option<&str>,
    to: &str,
    assignee_id: Option<String>,
    assignee_was_set: bool,
) -> Option<String> {
    if assignee_was_set {
        return assignee_id;
    }
    if to == "in_progress"
        && from != Some("in_progress")
        && assignee_id.is_none()
        && actor.kind == ActorType::User
        && let Some(id) = actor.id.as_deref().filter(|id| !id.is_empty())
    {
        return Some(id.to_owned());
    }
    assignee_id
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn at(day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, day, 0, 0, 0).unwrap()
    }

    // issues/issue-facts.spec.ts
    #[test]
    fn sets_started_at_once_on_the_first_in_progress_or_in_review() {
        let mut row = StatusFacts::default();
        apply_status_facts(&mut row, "todo", at(1));
        assert_eq!(row.started_at, None);
        apply_status_facts(&mut row, "in_review", at(1));
        assert_eq!(row.started_at, Some(at(1)));
        apply_status_facts(&mut row, "in_progress", at(2));
        apply_status_facts(&mut row, "backlog", at(3));
        assert_eq!(row.started_at, Some(at(1)));
    }

    #[test]
    fn assigns_the_user_who_starts_an_unassigned_issue_and_nobody_else() {
        let user = ActorRef::user("usr_me");
        let agent = ActorRef::agent("ag_1");
        let me = Some("usr_me".to_owned());
        assert_eq!(claim_assignee(&user, Some("backlog"), "in_progress", None, false), me);
        assert_eq!(claim_assignee(&user, None, "in_progress", None, false), me);
        assert_eq!(
            claim_assignee(&user, Some("todo"), "in_progress", Some("usr_other".into()), false),
            Some("usr_other".to_owned())
        );
        assert_eq!(claim_assignee(&user, Some("backlog"), "in_progress", None, true), None);
        assert_eq!(claim_assignee(&user, Some("in_progress"), "in_progress", None, false), None);
        assert_eq!(claim_assignee(&user, Some("backlog"), "in_review", None, false), None);
        assert_eq!(claim_assignee(&agent, Some("backlog"), "in_progress", None, false), None);
        let anonymous = ActorRef { kind: ActorType::User, id: None };
        assert_eq!(claim_assignee(&anonymous, Some("backlog"), "in_progress", None, false), None);
    }

    #[test]
    fn sets_completed_at_on_done_or_canceled_and_clears_it_on_reopen() {
        let mut row = StatusFacts::default();
        apply_status_facts(&mut row, "done", at(2));
        assert_eq!(row.completed_at, Some(at(2)));
        apply_status_facts(&mut row, "canceled", at(3));
        assert_eq!(row.completed_at, Some(at(2)));
        apply_status_facts(&mut row, "in_progress", at(3));
        assert_eq!(row.completed_at, None);
    }

    // issues/issues.controller.spec.ts, issues.service.spec.ts: claimAssignee
    #[test]
    fn claims_for_a_person_but_not_for_an_agent() {
        let me = ActorRef::user("usr_me");
        assert_eq!(
            claim_assignee(&me, Some("todo"), "in_progress", None, false),
            Some("usr_me".to_owned())
        );
        assert_eq!(
            claim_assignee(&ActorRef::agent("ag_me"), Some("todo"), "in_progress", None, false),
            None
        );
    }
}
