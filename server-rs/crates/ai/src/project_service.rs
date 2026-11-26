//! AI proposals for a project: summary, issues to add, risks
//! (`server/src/ai/project-ai.service.ts`). Read-only: it returns a proposal and changes nothing;
//! the person applies it from the UI.

use std::collections::HashMap;
use std::sync::Arc;

use axum::http::StatusCode;
use chrono::Utc;
use serde_json::{Map, json};
use trama_contracts::projects::{ProjectAiKind, ProjectAiResult, ProjectHealth};
use trama_core::AppError;

use crate::limits::Limits;
use crate::project_logic::{
    MAX_PROMPT_CHARS, ProjectFacts, ProjectSignal, compute_signals, derive_health, facts_json,
    merge_risk_texts, parse_issue_suggestions, parse_summary, risks_result, signals_to_risks,
    system_prompt,
};
use crate::project_store::ProjectAiStore;
use crate::provider::{AiMessage, AiProvider};
use crate::signal::Signal;

/// Who asks, and what they may do in the workspace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectAiScope {
    /// The workspace id.
    pub workspace_id: String,
    /// The person.
    pub user_id: Option<String>,
    /// Holds the `manageProjects` capability.
    pub can_manage_projects: bool,
}

/// Proposals for one project.
#[derive(Clone)]
pub struct ProjectAiService {
    store: Arc<dyn ProjectAiStore>,
    provider: Arc<dyn AiProvider>,
    limits: Limits,
    /// `AiConfig.status().configured`.
    configured: bool,
}

impl ProjectAiService {
    /// A service over its collaborators; `configured` is whether the AI provider is set up.
    #[must_use]
    pub fn new(
        store: Arc<dyn ProjectAiStore>,
        provider: Arc<dyn AiProvider>,
        limits: Limits,
        configured: bool,
    ) -> Self {
        Self { store, provider, limits, configured }
    }

    /// The configured provider or a connected SuperGrok account; nothing is called otherwise.
    async fn enabled(&self, user_id: &str) -> bool {
        self.configured || self.provider.has_own_account(user_id).await
    }

    /// A proposal of `kind` for the project.
    ///
    /// # Errors
    ///
    /// 404 for an unknown project, 403 unless the person manages projects or leads this one,
    /// 503 when AI is off (risks still work without it), 502 for an unusable model answer.
    pub async fn suggest(
        &self,
        user_id: &str,
        scope: &ProjectAiScope,
        project_id: &str,
        kind: ProjectAiKind,
        signal: &Signal,
    ) -> Result<ProjectAiResult, AppError> {
        let project = self
            .store
            .find_project(&scope.workspace_id, project_id)
            .await?
            .ok_or_else(|| AppError::not_found("Project not found"))?;
        let leads = scope.user_id.is_some() && project.lead_id == scope.user_id;
        if !scope.can_manage_projects && !leads {
            return Err(AppError::forbidden(
                "Only project managers and the project lead can use AI on a project.",
            ));
        }

        let enabled = self.enabled(user_id).await;
        if !enabled && kind != ProjectAiKind::Risks {
            return Err(AppError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "AI is not configured. Ask your administrator to enable it.",
            ));
        }

        let facts = self.store.gather(&project, kind == ProjectAiKind::Issues).await?;
        let now = Utc::now();
        let signals = compute_signals(&facts, now);
        let health = derive_health(&signals);
        let none = Map::new();
        match kind {
            ProjectAiKind::Risks => {
                Ok(self.risks(user_id, &facts, &signals, health, enabled, signal).await)
            }
            ProjectAiKind::Summary => {
                let reply = self
                    .ask(user_id, kind, &facts_json(&facts, &none, MAX_PROMPT_CHARS, now), signal)
                    .await?;
                parse_summary(&reply)
            }
            ProjectAiKind::Issues => {
                let mut allowed: HashMap<String, String> = HashMap::new();
                for issue in &facts.candidates {
                    allowed.insert(issue.id.to_lowercase(), issue.id.clone());
                    allowed.insert(issue.key.to_lowercase(), issue.id.clone());
                }
                if allowed.is_empty() {
                    return Ok(ProjectAiResult::Issues(
                        trama_contracts::projects::ProjectAiIssues { suggestions: Vec::new() },
                    ));
                }
                let reply = self
                    .ask(user_id, kind, &facts_json(&facts, &none, MAX_PROMPT_CHARS, now), signal)
                    .await?;
                parse_issue_suggestions(&reply, &allowed)
            }
        }
    }

    /// Deterministic risks, worded by the model when it is available; any model failure keeps the
    /// plain result.
    async fn risks(
        &self,
        user_id: &str,
        facts: &ProjectFacts,
        signals: &[ProjectSignal],
        health: ProjectHealth,
        enabled: bool,
        signal: &Signal,
    ) -> ProjectAiResult {
        let plain = risks_result(health, signals_to_risks(signals));
        if !enabled || signals.is_empty() {
            return plain;
        }
        let mut extra = Map::new();
        extra.insert(
            "signals".to_owned(),
            signals
                .iter()
                .map(|s| {
                    let mut item = json!({
                        "ref": s.reference,
                        "title": s.title,
                        "detail": s.detail,
                        "severity": s.severity,
                    });
                    if let (Some(id), Some(map)) = (&s.issue_id, item.as_object_mut()) {
                        map.insert("issueId".to_owned(), json!(id));
                    }
                    item
                })
                .collect::<Vec<_>>()
                .into(),
        );
        let reply = self
            .ask(
                user_id,
                ProjectAiKind::Risks,
                &facts_json(facts, &extra, MAX_PROMPT_CHARS, Utc::now()),
                signal,
            )
            .await;
        match reply.and_then(|text| merge_risk_texts(&text, signals)) {
            Ok(risks) => risks_result(health, risks),
            Err(_) => plain,
        }
    }

    async fn ask(
        &self,
        user_id: &str,
        kind: ProjectAiKind,
        facts: &str,
        signal: &Signal,
    ) -> Result<String, AppError> {
        self.limits
            .run(user_id, async {
                self.provider
                    .complete(
                        &[
                            AiMessage::system(system_prompt(kind)),
                            AiMessage::user(format!("Project data (reference only):\n{facts}")),
                        ],
                        signal,
                        Some(user_id),
                    )
                    .await
            })
            .await?
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use chrono::{DateTime, TimeDelta, Utc};
    use trama_contracts::projects::{ProjectAiIssues, ProjectAiRisks, ProjectAiSummary};
    use trama_entities::projects;

    use super::*;
    use crate::project_logic::{FactsEvent, FactsIssue, FactsProject};
    use crate::provider::{AiToolDef, AiToolTurn, AiTurnMessage, OnText};

    fn iso(at: DateTime<Utc>) -> String {
        at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn ago(days: i64) -> String {
        iso(Utc::now() - TimeDelta::days(days))
    }

    fn ahead(days: i64) -> String {
        iso(Utc::now() + TimeDelta::days(days))
    }

    fn issue(n: u32, tweak: impl FnOnce(&mut FactsIssue)) -> FactsIssue {
        let mut issue = FactsIssue {
            id: format!("iss_{n}"),
            key: format!("ENG-{n}"),
            title: format!("Issue {n}"),
            status: "todo".into(),
            priority: "medium".into(),
            assignee_id: Some("usr_1".into()),
            assignee: Some("Ada".into()),
            milestone_ids: Vec::new(),
            updated_at: ago(1),
        };
        tweak(&mut issue);
        issue
    }

    fn make_facts() -> ProjectFacts {
        ProjectFacts {
            project: FactsProject {
                id: "pj_1".into(),
                name: "Billing revamp".into(),
                summary: None,
                description: None,
                status: "in_progress".into(),
                priority: "high".into(),
                lead: Some("Ada".into()),
                start_date: Some(ago(40)),
                target_date: Some(ahead(60)),
                created_at: ago(40),
            },
            milestones: Vec::new(),
            issues: vec![issue(1, |_| {}), issue(2, |i| i.status = "done".into())],
            events: Vec::new(),
            candidates: Vec::new(),
        }
    }

    fn late_facts() -> ProjectFacts {
        let mut facts = make_facts();
        facts.project.target_date = Some(ago(3));
        facts
    }

    fn project_row(lead: Option<&str>) -> projects::Model {
        let now = Utc::now().fixed_offset();
        projects::Model {
            id: "pj_1".into(),
            workspace_id: "ws_1".into(),
            name: "Billing revamp".into(),
            summary: None,
            description: None,
            color: "blue".into(),
            status: "in_progress".into(),
            priority: "high".into(),
            lead_id: lead.map(str::to_owned),
            start_date: None,
            target_date: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
            icon: None,
            health: None,
            labels: json!([]),
            key: "BILL".into(),
            repository: None,
        }
    }

    struct Store {
        facts: ProjectFacts,
        lead: Option<String>,
        gathered: Mutex<u32>,
    }

    #[async_trait]
    impl ProjectAiStore for Store {
        async fn find_project(
            &self,
            _workspace_id: &str,
            id: &str,
        ) -> Result<Option<projects::Model>, AppError> {
            Ok((id == "pj_1").then(|| project_row(self.lead.as_deref())))
        }

        async fn gather(
            &self,
            _project: &projects::Model,
            _with_candidates: bool,
        ) -> Result<ProjectFacts, AppError> {
            *self.gathered.lock().unwrap() += 1;
            Ok(self.facts.clone())
        }
    }

    struct Model {
        reply: Result<String, String>,
        calls: Mutex<u32>,
        own_account: bool,
    }

    #[async_trait]
    impl AiProvider for Model {
        async fn complete(
            &self,
            _messages: &[AiMessage],
            _signal: &Signal,
            _user_id: Option<&str>,
        ) -> Result<String, AppError> {
            *self.calls.lock().unwrap() += 1;
            self.reply.clone().map_err(|e| AppError::new(StatusCode::BAD_GATEWAY, e))
        }

        async fn has_own_account(&self, _user_id: &str) -> bool {
            self.own_account
        }

        async fn complete_with_tools(
            &self,
            _messages: &[AiTurnMessage],
            _tools: &[AiToolDef],
            _signal: &Signal,
            _user_id: Option<&str>,
            _on_text: Option<OnText<'_>>,
        ) -> Result<AiToolTurn, AppError> {
            unreachable!("project AI never uses tools")
        }
    }

    #[derive(Default)]
    struct Setup {
        facts: Option<ProjectFacts>,
        reply: Option<Result<String, String>>,
        unconfigured: bool,
        cannot_manage: bool,
        lead: Option<&'static str>,
        own_account: bool,
    }

    struct Harness {
        service: ProjectAiService,
        model: Arc<Model>,
        store: Arc<Store>,
        scope: ProjectAiScope,
    }

    fn setup(opts: Setup) -> Harness {
        let store = Arc::new(Store {
            facts: opts.facts.unwrap_or_else(make_facts),
            lead: opts.lead.map(str::to_owned),
            gathered: Mutex::default(),
        });
        let model = Arc::new(Model {
            reply: opts.reply.unwrap_or_else(|| Ok("{}".to_owned())),
            calls: Mutex::default(),
            own_account: opts.own_account,
        });
        let service = ProjectAiService::new(
            store.clone(),
            model.clone(),
            Limits::default(),
            !opts.unconfigured,
        );
        let scope = ProjectAiScope {
            workspace_id: "ws_1".into(),
            user_id: Some("usr_1".into()),
            can_manage_projects: !opts.cannot_manage,
        };
        Harness { service, model, store, scope }
    }

    impl Harness {
        async fn run(&self, kind: ProjectAiKind) -> Result<ProjectAiResult, AppError> {
            self.service.suggest("usr_1", &self.scope, "pj_1", kind, &Signal::new()).await
        }

        fn calls(&self) -> u32 {
            *self.model.calls.lock().unwrap()
        }
    }

    fn ok(reply: &str) -> Option<Result<String, String>> {
        Some(Ok(reply.to_owned()))
    }

    fn summary_of(result: ProjectAiResult) -> ProjectAiSummary {
        match result {
            ProjectAiResult::Summary(s) => s,
            other => panic!("not a summary: {other:?}"),
        }
    }

    fn issues_of(result: ProjectAiResult) -> ProjectAiIssues {
        match result {
            ProjectAiResult::Issues(i) => i,
            other => panic!("not issues: {other:?}"),
        }
    }

    fn risks_of(result: ProjectAiResult) -> ProjectAiRisks {
        match result {
            ProjectAiResult::Risks(r) => r,
            other => panic!("not risks: {other:?}"),
        }
    }

    #[tokio::test]
    async fn summary_returns_a_single_line_summary_and_the_description() {
        let h = setup(Setup {
            reply: ok(
                "{\"summary\":\"Rebuild\\nbilling   flow\",\"description\":\"## Goal\\nInvoices.\"}",
            ),
            ..Setup::default()
        });
        let summary = summary_of(h.run(ProjectAiKind::Summary).await.unwrap());
        assert_eq!(summary.summary, "Rebuild billing flow");
        assert_eq!(summary.description, "## Goal\nInvoices.");
        // on the wire the result is tagged with its kind
        assert_eq!(
            serde_json::to_value(ProjectAiResult::Summary(summary)).unwrap()["kind"],
            "summary"
        );
    }

    #[tokio::test]
    async fn summary_rejects_an_output_without_a_summary() {
        let h = setup(Setup {
            reply: ok("{\"summary\":\"\",\"description\":\"x\"}"),
            ..Setup::default()
        });
        let err = h.run(ProjectAiKind::Summary).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_GATEWAY);
        assert!(err.to_string().contains("The AI did not return a valid suggestion. Try again."));
    }

    fn candidates() -> Vec<FactsIssue> {
        vec![
            issue(10, |i| {
                i.status = "backlog".into();
                i.assignee_id = None;
                i.assignee = None;
            }),
            issue(11, |_| {}),
        ]
    }

    #[tokio::test]
    async fn issues_keeps_only_candidate_ids_and_keys_once_with_a_reason() {
        let mut facts = make_facts();
        facts.candidates = candidates();
        let h = setup(Setup {
            facts: Some(facts),
            reply: ok(&json!({ "suggestions": [
                { "issueId": "iss_10", "reason": "Mentions invoices." },
                { "issueId": "iss_made_up", "reason": "Invented by the model." },
                { "issueId": "iss_10", "reason": "Duplicate." },
                { "issueId": "ENG-11", "reason": "Same area, by key." },
                { "issueId": "iss_1", "reason": "Already in the project." },
                { "issueId": "iss_11", "reason": "   " },
            ] })
            .to_string()),
            ..Setup::default()
        });
        let result = issues_of(h.run(ProjectAiKind::Issues).await.unwrap());
        let got: Vec<_> =
            result.suggestions.iter().map(|s| (s.issue_id.as_str(), s.reason.as_str())).collect();
        assert_eq!(got, [("iss_10", "Mentions invoices."), ("iss_11", "Same area, by key.")]);
    }

    #[tokio::test]
    async fn issues_caps_the_list_at_10_and_skips_the_model_without_candidates() {
        let many: Vec<FactsIssue> = (0..15).map(|i| issue(100 + i, |_| {})).collect();
        let mut facts = make_facts();
        facts.candidates = many.clone();
        let h = setup(Setup {
            facts: Some(facts),
            reply: ok(&json!({ "suggestions": many.iter()
                .map(|i| json!({ "issueId": i.id, "reason": "fits" }))
                .collect::<Vec<_>>() })
            .to_string()),
            ..Setup::default()
        });
        assert_eq!(issues_of(h.run(ProjectAiKind::Issues).await.unwrap()).suggestions.len(), 10);

        let none = setup(Setup::default());
        let result = none.run(ProjectAiKind::Issues).await.unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "kind": "issues", "suggestions": [] })
        );
        assert_eq!(none.calls(), 0);
    }

    #[tokio::test]
    async fn issues_rejects_malformed_output() {
        let mut facts = make_facts();
        facts.candidates = candidates();
        let h = setup(Setup {
            facts: Some(facts),
            reply: ok("{\"suggestions\":\"all of them\"}"),
            ..Setup::default()
        });
        let err = h.run(ProjectAiKind::Issues).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn risks_work_without_any_model_call_when_there_is_nothing_to_report() {
        let h = setup(Setup::default());
        let result = h.run(ProjectAiKind::Risks).await.unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "kind": "risks", "health": "on_track", "risks": [] })
        );
        assert_eq!(h.calls(), 0);
    }

    #[tokio::test]
    async fn risks_compute_signals_first_and_let_the_model_only_reword_them() {
        let h = setup(Setup {
            facts: Some(late_facts()),
            reply: ok(&json!({ "risks": [
                { "ref": "S1", "title": "Delivery is late", "detail": "The project target date has passed." },
                { "ref": "S99", "title": "Invented risk", "detail": "No such signal." },
            ] })
            .to_string()),
            ..Setup::default()
        });
        let result = risks_of(h.run(ProjectAiKind::Risks).await.unwrap());
        assert_eq!(h.calls(), 1);
        assert_eq!(result.health, ProjectHealth::AtRisk);
        assert_eq!(result.risks.len(), 1);
        assert_eq!(result.risks[0].title, "Delivery is late");
        assert_eq!(result.risks[0].detail, "The project target date has passed.");
        assert_eq!(result.risks[0].severity, trama_contracts::activity::AttentionSeverity::High);
        assert!(result.risks.iter().all(|r| r.title != "Invented risk"));
    }

    #[tokio::test]
    async fn risks_fall_back_to_the_deterministic_result_when_ai_is_off() {
        let h = setup(Setup { facts: Some(late_facts()), unconfigured: true, ..Setup::default() });
        let result = risks_of(h.run(ProjectAiKind::Risks).await.unwrap());
        assert_eq!(h.calls(), 0);
        assert_eq!(
            result.risks.iter().map(|r| r.severity).collect::<Vec<_>>(),
            [trama_contracts::activity::AttentionSeverity::High]
        );
        assert!(result.risks.iter().all(|r| !r.title.is_empty() && !r.detail.is_empty()));
    }

    #[tokio::test]
    async fn risks_use_a_connected_supergrok_account_when_the_provider_is_not_configured() {
        let h = setup(Setup {
            facts: Some(late_facts()),
            unconfigured: true,
            own_account: true,
            reply: ok(
                &json!({ "risks": [{ "ref": "S1", "title": "Reworded", "detail": "By Grok." }] })
                    .to_string(),
            ),
            ..Setup::default()
        });
        let result = risks_of(h.run(ProjectAiKind::Risks).await.unwrap());
        assert_eq!(h.calls(), 1);
        assert_eq!(result.risks[0].title, "Reworded");
    }

    #[tokio::test]
    async fn risks_fall_back_when_the_model_fails_or_answers_garbage() {
        let failing = setup(Setup {
            facts: Some(late_facts()),
            reply: Some(Err("provider down".into())),
            ..Setup::default()
        });
        let garbage =
            setup(Setup { facts: Some(late_facts()), reply: ok("not json"), ..Setup::default() });
        let a = risks_of(failing.run(ProjectAiKind::Risks).await.unwrap());
        let b = risks_of(garbage.run(ProjectAiKind::Risks).await.unwrap());
        assert_eq!(a.risks.len(), 1);
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn risks_flag_late_milestones_stale_issues_and_unowned_urgent_issues() {
        let mut facts = make_facts();
        facts.milestones = vec![crate::project_logic::FactsMilestone {
            id: "ms_1".into(),
            name: "Beta".into(),
            target_date: Some(ago(20)),
        }];
        facts.issues = vec![
            issue(1, |i| i.milestone_ids = vec!["ms_1".into()]),
            issue(2, |i| {
                i.status = "in_progress".into();
                i.updated_at = ago(40);
            }),
            issue(3, |i| {
                i.priority = "urgent".into();
                i.assignee_id = None;
                i.assignee = None;
            }),
        ];
        let h = setup(Setup { facts: Some(facts), unconfigured: true, ..Setup::default() });
        let risks = risks_of(h.run(ProjectAiKind::Risks).await.unwrap()).risks;
        let titles: Vec<&str> = risks.iter().map(|r| r.title.as_str()).collect();
        assert!(titles.contains(&"Milestone \"Beta\" is late"), "{titles:?}");
        assert!(titles.contains(&"ENG-2 looks stalled"), "{titles:?}");
        assert!(titles.contains(&"ENG-3 has no assignee"), "{titles:?}");
        let stalled = risks.iter().find(|r| r.title == "ENG-2 looks stalled").unwrap();
        assert_eq!(stalled.issue_id.as_deref(), Some("iss_2"));
        assert_eq!(
            serde_json::to_value(stalled).unwrap()["issueId"],
            "iss_2",
            "the wire name is camelCase"
        );
    }

    #[tokio::test]
    async fn does_not_call_the_model_for_non_risk_kinds_when_ai_is_not_configured() {
        let h = setup(Setup { unconfigured: true, ..Setup::default() });
        let err = h.run(ProjectAiKind::Summary).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            err.to_string().contains("AI is not configured. Ask your administrator to enable it.")
        );
        assert_eq!(h.calls(), 0);
        assert_eq!(*h.store.gathered.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn requires_manage_projects_or_being_the_project_lead() {
        let h = setup(Setup { cannot_manage: true, ..Setup::default() });
        let err = h.run(ProjectAiKind::Summary).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::FORBIDDEN);
        assert!(
            err.to_string()
                .contains("Only project managers and the project lead can use AI on a project.")
        );

        let lead = setup(Setup {
            cannot_manage: true,
            lead: Some("usr_1"),
            reply: ok("{\"summary\":\"s\",\"description\":\"d\"}"),
            ..Setup::default()
        });
        assert_eq!(summary_of(lead.run(ProjectAiKind::Summary).await.unwrap()).summary, "s");
    }

    #[tokio::test]
    async fn an_unknown_project_is_a_404_before_any_permission_check() {
        let h = setup(Setup { cannot_manage: true, ..Setup::default() });
        let err = h
            .service
            .suggest("usr_1", &h.scope, "pj_missing", ProjectAiKind::Summary, &Signal::new())
            .await
            .unwrap_err();
        assert_eq!(err.status_code(), StatusCode::NOT_FOUND);
        assert!(err.to_string().contains("Project not found"));
    }

    #[tokio::test]
    async fn the_facts_json_stays_within_the_prompt_cap() {
        let issues: Vec<FactsIssue> =
            (0..400).map(|i| issue(i, |f| f.title = "x".repeat(200))).collect();
        let mut facts = make_facts();
        facts.events = (0..25)
            .map(|i| FactsEvent {
                at: ago(i),
                kind: "issue.updated".into(),
                summary: "y".repeat(200),
            })
            .collect();
        facts.candidates = issues.clone();
        facts.issues = issues;
        facts.project.description = Some("d".repeat(50_000));
        let text = facts_json(&facts, &Map::new(), 24_000, Utc::now());
        assert!(trama_contracts::js::len(&text) <= 24_000);
        assert!(serde_json::from_str::<serde_json::Value>(&text).is_ok());
    }
}
