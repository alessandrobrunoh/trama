//! `InsightsController`, mounted under `/api`.

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use trama_auth::{Ctx, Gate, Routes};
use trama_contracts::insights::{
    ActorShare, AgentFailureRow, AgingItem, CumulativeFlow, CumulativeFlowSeries, DurationStats,
    FlowDuration, HistogramBucket, InsightActor, InsightActorType, InsightActors, InsightAging,
    InsightBottleneck, InsightContributor, InsightFlow, InsightItem, InsightItemType, InsightRange,
    InsightScope, InsightSeverity, InsightSignal, InsightSignalId, InsightWip, InsightWipRow,
    InsightsReport, PreviousThroughput, ThroughputBucket, WipLimits,
};
use trama_core::{AppError, AppState};
use utoipa::OpenApi;

use crate::schemas::InsightsQuery;
use crate::service::{self, Params};

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(report, signal),
    components(schemas(
        ActorShare,
        AgentFailureRow,
        AgingItem,
        CumulativeFlow,
        CumulativeFlowSeries,
        DurationStats,
        FlowDuration,
        HistogramBucket,
        InsightActor,
        InsightActorType,
        InsightActors,
        InsightAging,
        InsightBottleneck,
        InsightContributor,
        InsightFlow,
        InsightItem,
        InsightItemType,
        InsightRange,
        InsightScope,
        InsightSeverity,
        InsightSignal,
        InsightSignalId,
        InsightWip,
        InsightWipRow,
        InsightsReport,
        PreviousThroughput,
        ThroughputBucket,
        WipLimits,
    ))
)]
pub struct ApiDoc;

/// Routes of this module (the controller has no decorators: every member may read; a custom
/// token needs `insights:read`).
pub fn router() -> Routes {
    Routes::new().get("/w/{slug}/insights", Gate::authenticated(), report).get(
        "/w/{slug}/insights/signals/{id}",
        Gate::authenticated(),
        signal,
    )
}

impl From<InsightsQuery> for Params {
    fn from(query: InsightsQuery) -> Self {
        Self {
            days: query.days,
            project_id: query.project_id,
            stale_days: query.stale_days,
            limit: query.limit,
        }
    }
}

/// Health signals, flow metrics, bottlenecks and contributors of the issues the caller can see,
/// for the last 7, 30 or 90 days.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/insights",
    tag = "insights",
    params(("slug" = String, Path, description = "Workspace slug"), InsightsQuery),
    responses(
        (status = 200, description = "The report", body = InsightsReport),
        (status = 400, description = "Invalid query"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace or project, or not a member"),
    )
)]
async fn report(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<InsightsReport>, AppError> {
    let query = InsightsQuery::parse(raw.as_deref())?;
    service::report(&state.db, &ctx, &query.into()).await.map(Json)
}

/// One signal of the report with up to 100 items (500 at most).
#[utoipa::path(
    get,
    path = "/api/w/{slug}/insights/signals/{id}",
    tag = "insights",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "stale_issues, overdue_milestones, prs_stuck_in_review or ci_failing"),
        InsightsQuery,
    ),
    responses(
        (status = 200, description = "The signal", body = InsightSignal),
        (status = 400, description = "Invalid query"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace, project or signal, or not a member"),
    )
)]
async fn signal(
    ctx: Ctx,
    State(state): State<AppState>,
    Path((_slug, id)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Result<Json<InsightSignal>, AppError> {
    let query = InsightsQuery::parse(raw.as_deref())?;
    let id = InsightSignalId::parse(&id)
        .ok_or_else(|| AppError::not_found(format!("Unknown signal \"{id}\"")))?;
    service::signal(&state.db, &ctx, id, &query.into()).await.map(Json)
}
