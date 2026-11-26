//! `AiController` and `ProjectAiController` (`server/src/ai`), mounted under `/api`.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::UnboundedReceiverStream;
use trama_auth::{Auth, AuthMethod, Ctx, Gate, Routes};
use trama_contracts::activity::AttentionSeverity;
use trama_contracts::projects::{
    PROJECT_AI_KINDS, ProjectAiIssueSuggestion, ProjectAiIssues, ProjectAiKind, ProjectAiResult,
    ProjectAiRisk, ProjectAiRisks, ProjectAiSummary, ProjectHealth,
};
use trama_contracts::roles::{Capability, LegacyRole};
use trama_core::{ApiJson, AppError, AppState};
use utoipa::OpenApi;

use crate::activity::{Activity, ActivityStep, ChatSink, StepKind};
use crate::config;
use crate::context::ChatScope;
use crate::dto::{parse_chat, parse_suggestion};
use crate::grok::{DisconnectResponse, GrokStatus, LoginDetails, LoginResponse};
use crate::project_service::ProjectAiScope;
use crate::runtime::AiRuntime;
use crate::schemas::{
    AiStatus, AssistantToolsStatus, ChatBody, ChatContextBody, ChatMessageBody, ChatResponse,
    ChatgptStatus, DraftOptionBody, DraftSimilarIssueBody, IssueDraftOptionsBody, SuggestionBody,
    SuggestionResponse, Triage, TriageSuggestion,
};
use crate::signal::Signal;

/// Seconds between the `: ping` comments of an open chat stream.
const HEARTBEAT: Duration = Duration::from_secs(15);

const SESSION_REQUIRED: &str = "AI features require a browser session.";
const CHATGPT_REASON: &str = "ChatGPT plan connections for remotely hosted apps require OpenAI approval. This installation uses the configured AI provider.";

/// `@RequireUser() @Roles('viewer') @NoGuests()` on both controllers.
const GATE: Gate = Gate::authenticated().require_user().roles(LegacyRole::Viewer).no_guests();

/// OpenAPI document of this module.
#[derive(OpenApi)]
#[openapi(
    paths(status, start_grok_login, disconnect_grok, suggest, chat, chat_stream, project_ai),
    components(schemas(
        Activity,
        ActivityStep,
        AiStatus,
        AssistantToolsStatus,
        ChatBody,
        ChatContextBody,
        ChatMessageBody,
        ChatResponse,
        ChatgptStatus,
        DisconnectResponse,
        DraftOptionBody,
        DraftSimilarIssueBody,
        GrokStatus,
        IssueDraftOptionsBody,
        LoginDetails,
        LoginResponse,
        ProjectAiIssueSuggestion,
        ProjectAiIssues,
        ProjectAiResult,
        ProjectAiRisk,
        ProjectAiRisks,
        ProjectAiSummary,
        ProjectHealth,
        AttentionSeverity,
        StepKind,
        SuggestionBody,
        SuggestionResponse,
        config::SuggestionsStatus,
        Triage,
        TriageSuggestion,
    ))
)]
pub struct ApiDoc;

/// Routes of this module. Everything needs a person (not an agent token), the `viewer` gate and a
/// non-guest; the handlers themselves require a browser session.
pub fn router() -> Routes {
    Routes::new()
        .get("/w/{slug}/ai/status", GATE, status)
        .post("/w/{slug}/ai/supergrok/login", GATE, start_grok_login)
        .delete("/w/{slug}/ai/supergrok/login", GATE, disconnect_grok)
        .post("/w/{slug}/ai/suggestions", GATE, suggest)
        .post("/w/{slug}/ai/chat", GATE, chat)
        .post("/w/{slug}/ai/chat/stream", GATE, chat_stream)
        .post("/w/{slug}/projects/{id}/ai/{kind}", GATE, project_ai)
}

/// The signed-in person of a browser session; API tokens may not use AI.
fn session_user(auth: &Auth) -> Result<String, AppError> {
    match (&auth.method, &auth.user) {
        (AuthMethod::Session, Some(user)) => Ok(user.id.clone()),
        _ => Err(AppError::forbidden(SESSION_REQUIRED)),
    }
}

fn no_store<T: IntoResponse>(body: T) -> Response {
    ([(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))], body).into_response()
}

/// What the AI features offer this person.
#[utoipa::path(
    get,
    path = "/api/w/{slug}/ai/status",
    tag = "ai",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "Provider, SuperGrok and tool availability", body = AiStatus),
        (status = 403, description = "Not a browser session, or a guest"),
    )
)]
async fn status(auth: Auth, State(state): State<AppState>) -> Result<Json<AiStatus>, AppError> {
    let user_id = session_user(&auth)?;
    let services = AiRuntime::of(&state).services(&state);
    let supergrok = services.grok.status(&user_id).await;
    let tools =
        services.ai.tools_enabled() && services.provider.supports_tools(Some(&user_id)).await;
    Ok(Json(AiStatus {
        suggestions: config::status(&state.config.ai),
        supergrok,
        assistant_tools: AssistantToolsStatus { enabled: tools },
        chatgpt: ChatgptStatus { status: "unavailable", reason: CHATGPT_REASON },
    }))
}

/// Starts connecting the person's SuperGrok account (device login).
#[utoipa::path(
    post,
    path = "/api/w/{slug}/ai/supergrok/login",
    tag = "ai",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "Already connected, or the device code to enter", body = LoginResponse),
        (status = 403, description = "Not a browser session, or a guest"),
        (status = 409, description = "Too many logins are open"),
        (status = 503, description = "SuperGrok is not enabled"),
    )
)]
async fn start_grok_login(
    auth: Auth,
    State(state): State<AppState>,
) -> Result<Json<LoginResponse>, AppError> {
    let user_id = session_user(&auth)?;
    let services = AiRuntime::of(&state).services(&state);
    Ok(Json(services.grok.start_login(&user_id).await?))
}

/// Disconnects the person's SuperGrok account.
#[utoipa::path(
    delete,
    path = "/api/w/{slug}/ai/supergrok/login",
    tag = "ai",
    params(("slug" = String, Path, description = "Workspace slug")),
    responses(
        (status = 200, description = "Whether credentials remain", body = DisconnectResponse),
        (status = 403, description = "Not a browser session, or a guest"),
        (status = 503, description = "SuperGrok is not enabled or the CLI is unavailable"),
    )
)]
async fn disconnect_grok(
    auth: Auth,
    State(state): State<AppState>,
) -> Result<Json<DisconnectResponse>, AppError> {
    let user_id = session_user(&auth)?;
    let services = AiRuntime::of(&state).services(&state);
    Ok(Json(services.grok.disconnect(&user_id).await?))
}

/// Improves an issue draft and, when the draft sends its choices, proposes its triage.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/ai/suggestions",
    tag = "ai",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = SuggestionBody,
    responses(
        (status = 200, description = "The suggestion", body = SuggestionResponse),
        (status = 400, description = "Invalid body, or an empty draft"),
        (status = 403, description = "Not a browser session, or a guest"),
        (status = 429, description = "Too many AI requests"),
        (status = 502, description = "The provider failed or answered something unusable"),
        (status = 503, description = "AI is not configured"),
        (status = 504, description = "The provider timed out"),
    )
)]
async fn suggest(
    auth: Auth,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Response, AppError> {
    let dto = parse_suggestion(&body)?;
    let user_id = session_user(&auth)?;
    let services = AiRuntime::of(&state).services(&state);
    let _permit = services.ai.acquire(&user_id)?;
    let signal = Signal::new();
    let _cancel = signal.cancel_on_drop();
    let result = services.ai.suggest(&user_id, &dto, &signal).await?;
    Ok(no_store(Json(result)))
}

/// One assistant reply.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/ai/chat",
    tag = "ai",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = ChatBody,
    responses(
        (status = 200, description = "The reply and what the assistant did", body = ChatResponse),
        (status = 400, description = "Invalid body or conversation"),
        (status = 403, description = "Not a browser session, or a guest"),
        (status = 404, description = "The context record does not exist"),
        (status = 429, description = "Too many AI requests"),
        (status = 502, description = "The provider failed or answered something unusable"),
        (status = 503, description = "AI is not configured"),
        (status = 504, description = "The provider timed out"),
    )
)]
async fn chat(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Response, AppError> {
    let dto = parse_chat(&body)?;
    let user_id = session_user(&auth)?;
    let services = AiRuntime::of(&state).services(&state);
    let permit = services.ai.acquire(&user_id)?;
    let scope = ChatScope::of(&ctx);
    let signal = Signal::new();
    // when the client goes away this handler is dropped: cancel the work, which still cleans up
    let _cancel = signal.cancel_on_drop();
    let work = {
        let signal = signal.clone();
        tokio::spawn(async move {
            let _permit = permit;
            services.ai.chat(&user_id, &scope, &dto, &signal, None).await
        })
    };
    let result = work.await.map_err(AppError::internal)??;
    Ok(no_store(Json(result)))
}

/// Sends one `event: <name>` message.
fn frame(event: &str, data: &Value) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {data}\n\n"))
}

/// Writes what happens during a reply as server-sent events.
struct SseSink {
    tx: mpsc::UnboundedSender<Bytes>,
}

impl SseSink {
    fn send(&self, event: &str, data: &Value) {
        let _ = self.tx.send(frame(event, data));
    }
}

impl ChatSink for SseSink {
    fn step(&self, index: usize, step: &ActivityStep) {
        self.send("step", &json!({ "index": index, "step": step }));
    }

    fn working(&self, label: &str) {
        self.send("working", &json!({ "label": label }));
    }

    fn text(&self, delta: &str) {
        self.send("text", &json!({ "delta": delta }));
    }

    fn text_reset(&self) {
        self.send("reset", &json!({}));
    }
}

/// What the `error` event says: the message of an HTTP error, else a generic one.
fn stream_error_message(error: &AppError) -> String {
    if error.status_code() == StatusCode::INTERNAL_SERVER_ERROR {
        return "The assistant could not finish this reply.".to_owned();
    }
    let text = error.to_string();
    let prefix = format!("{}: ", error.status_code());
    text.strip_prefix(&prefix).unwrap_or(&text).to_owned()
}

/// Same as `chat`, but streams what happens as server-sent events: `working`, `step`, `text`,
/// `reset`, then `done` (the final `{ content, activity }`) or `error`.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/ai/chat/stream",
    tag = "ai",
    params(("slug" = String, Path, description = "Workspace slug")),
    request_body = ChatBody,
    responses(
        (status = 200, description = "text/event-stream of working, step, text, reset, done and error events", content_type = "text/event-stream", body = String),
        (status = 400, description = "Invalid body"),
        (status = 403, description = "Not a browser session, or a guest"),
        (status = 429, description = "Too many AI requests"),
    )
)]
async fn chat_stream(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    ApiJson(body): ApiJson<Value>,
) -> Result<Response, AppError> {
    let dto = parse_chat(&body)?;
    let user_id = session_user(&auth)?;
    let services = AiRuntime::of(&state).services(&state);
    let permit = services.ai.acquire(&user_id)?;
    let scope = ChatScope::of(&ctx);
    let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
    tokio::spawn(async move {
        let _permit = permit;
        let signal = Signal::new();
        let sink: Arc<dyn ChatSink> = Arc::new(SseSink { tx: tx.clone() });
        let work = services.ai.chat(&user_id, &scope, &dto, &signal, Some(sink));
        tokio::pin!(work);
        let mut heartbeat =
            tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
        let result = loop {
            tokio::select! {
                done = &mut work => break done,
                _ = heartbeat.tick() => {
                    let _ = tx.send(Bytes::from_static(b": ping\n\n"));
                }
                () = tx.closed() => {
                    // the client went away: stop the model call and let the work clean up
                    signal.cancel();
                    break (&mut work).await;
                }
            }
        };
        let _ = match result {
            Ok(done) => tx.send(frame("done", &json!(done))),
            Err(error) => {
                tx.send(frame("error", &json!({ "message": stream_error_message(&error) })))
            }
        };
    });
    let stream = UnboundedReceiverStream::new(rx).map(Ok::<Bytes, Infallible>);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store, no-transform")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(stream))
        .map_err(AppError::internal)
}

/// A proposal for a project: a summary, issues to add, or risks. Changes nothing; the person
/// applies it from the UI. Whether the caller may use it (`manageProjects`, or lead of the
/// project) is checked after the project is loaded.
#[utoipa::path(
    post,
    path = "/api/w/{slug}/projects/{id}/ai/{kind}",
    tag = "ai",
    params(
        ("slug" = String, Path, description = "Workspace slug"),
        ("id" = String, Path, description = "Project id"),
        ("kind" = ProjectAiKind, Path, description = "What to propose"),
    ),
    responses(
        (status = 200, description = "The proposal", body = ProjectAiResult),
        (status = 400, description = "Unknown kind"),
        (status = 403, description = "Not a browser session, a guest, or neither a project manager nor the lead"),
        (status = 404, description = "Unknown project"),
        (status = 429, description = "Too many AI requests"),
        (status = 502, description = "The provider failed or answered something unusable"),
        (status = 503, description = "AI is not configured"),
        (status = 504, description = "The provider timed out"),
    )
)]
async fn project_ai(
    ctx: Ctx,
    auth: Auth,
    State(state): State<AppState>,
    Path((_slug, id, kind)): Path<(String, String, String)>,
) -> Result<Response, AppError> {
    let user_id = session_user(&auth)?;
    let Some(kind) = ProjectAiKind::parse(&kind) else {
        let kinds: Vec<&str> = PROJECT_AI_KINDS.iter().map(|k| k.as_str()).collect();
        return Err(AppError::bad_request(format!("kind must be one of: {}", kinds.join(", "))));
    };
    let services = AiRuntime::of(&state).services(&state);
    let scope = ProjectAiScope {
        workspace_id: ctx.workspace.id.clone(),
        user_id: ctx.user_id.clone(),
        can_manage_projects: ctx.can_do(Capability::ManageProjects),
    };
    let signal = Signal::new();
    let _cancel = signal.cancel_on_drop();
    let result = services.project.suggest(&user_id, &scope, &id, kind, &signal).await?;
    Ok(no_store(Json(result)))
}
