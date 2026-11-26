//! `EventsController` (`server/src/events/events.controller.ts`), mounted under `/api`.

use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderValue, Version, header};
use axum::response::{IntoResponse, Response};
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use trama_auth::{Auth, Ctx, Gate, Routes};
use trama_contracts::activity::LiveEvent;
use trama_core::{AppError, AppState};
use trama_entities::domain_events;
use utoipa::OpenApi;

use crate::js_date::parse_js_date;
use crate::schemas::{EventView, ListEventsQuery};
use crate::service::Events;
use crate::sse::{self, PING_EVERY, StreamParams};
use crate::visibility::filter_events;

/// `limit` when none is given.
const DEFAULT_LIMIT: u64 = 100;

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(paths(list, stream), components(schemas(EventView, LiveEvent)))]
pub struct ApiDoc;

/// Routes of this module (the controller has no decorators: members, `viewer` and up).
pub fn router() -> Routes {
    Routes::new().get("/w/{slug}/events", Gate::authenticated(), list).get(
        "/w/{slug}/events/stream",
        Gate::authenticated(),
        stream,
    )
}

/// The workspace's activity log, newest first, without what the caller's project access hides.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/events",
    tag = "events",
    params(("slug" = String, Path, description = "Workspace slug"), ListEventsQuery),
    responses(
        (status = 200, description = "Visible events, newest first", body = [EventView]),
        (status = 400, description = "Invalid filter"),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn list(
    ctx: Ctx,
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Vec<EventView>>, AppError> {
    let q = ListEventsQuery::parse(raw.as_deref())?;
    let mut query = domain_events::Entity::find()
        .filter(domain_events::Column::WorkspaceId.eq(ctx.workspace.id.clone()))
        .order_by_desc(domain_events::Column::At)
        .order_by_desc(domain_events::Column::Id)
        .limit(q.limit.unwrap_or(DEFAULT_LIMIT));
    if let Some(key) = q.legacy_workstream_key.filter(|k| !k.is_empty()) {
        query = query.filter(domain_events::Column::LegacyWorkstreamKey.eq(key));
    }
    if let Some(subject) = q.subject.filter(|s| !s.is_empty()) {
        let mut parts = subject.split(':');
        let (kind, id) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
        if kind.is_empty() || id.is_empty() {
            return Err(AppError::bad_request("subject must be \"<type>:<id>\""));
        }
        query = query.filter(Expr::cust_with_values(
            r#""subject"->>'type' = $1 AND "subject"->>'id' = $2"#,
            [kind.to_owned(), id.to_owned()],
        ));
    }
    if let Some(kind) = q.kind.filter(|t| !t.is_empty()) {
        query = query
            .filter(domain_events::Column::Type.like(format!("{}%", kind.replace(['%', '_'], ""))));
    }
    if let Some(before) = q.before.filter(|b| !b.is_empty()) {
        let before = parse_js_date(&before)
            .ok_or_else(|| AppError::bad_request("before must be an ISO date"))?;
        query = query.filter(domain_events::Column::At.lt(before.fixed_offset()));
    }
    let rows = query.all(&state.db).await?;
    let visible = filter_events(&state.db, &ctx.workspace.id, rows, ctx.access.as_ref()).await?;
    Ok(Json(visible.into_iter().map(EventView::from).collect()))
}

/// Server-Sent Events: one visible `LiveEvent` JSON per message, an `event: ping` every 25 s.
/// The stream ends when credentials, role, or project access change (checked every
/// `TRAMA_SSE_RECHECK_MS`).
#[utoipa::path(
    get,
    path = "/api/w/{slug}/events/stream",
    tag = "events",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "An event stream of LiveEvent messages", content_type = "text/event-stream", body = LiveEvent),
        (status = 401, description = "Not signed in"),
        (status = 404, description = "Unknown workspace, or not a member"),
    )
)]
async fn stream(ctx: Ctx, auth: Auth, version: Version, State(state): State<AppState>) -> Response {
    let live = Events::of(&state).subscribe();
    let body = sse::open(
        StreamParams {
            db: state.db.clone(),
            ctx: ctx.0,
            auth: auth.0,
            ping_every: PING_EVERY,
            recheck_every: Duration::from_millis(state.config.sse_recheck_ms),
        },
        live,
    );
    sse_response(body, version)
}

/// The headers `SseStream` sends.
fn sse_response(body: Body, version: Version) -> Response {
    let mut res = body.into_response();
    let headers = res.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    // hop-by-hop, forbidden in HTTP/2
    if version < Version::HTTP_2 {
        headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(
            "private, no-cache, no-store, must-revalidate, max-age=0, no-transform",
        ),
    );
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(header::EXPIRES, HeaderValue::from_static("0"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    res
}
