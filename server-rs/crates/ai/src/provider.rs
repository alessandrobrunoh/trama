//! The model behind the assistant: an OpenAI-compatible Chat Completions endpoint, or a connected
//! SuperGrok account (`server/src/ai/ai-provider.ts`).

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::http::StatusCode;
use reqwest::Client;
use serde::Serialize;
use serde_json::{Map, Value, json};
use trama_contracts::js;
use trama_core::{AppError, Config};

use crate::config::{self, ProviderSettings};
use crate::grok::GrokBuild;
use crate::signal::Signal;

/// Longest reply the assistant accepts, in UTF-16 units.
const MAX_REPLY: usize = 16_000;
/// A response body larger than this is refused.
const MAX_BODY_BYTES: usize = 256_000;
const PLAIN_TIMEOUT: Duration = Duration::from_secs(30);
const STREAM_TIMEOUT: Duration = Duration::from_secs(90);

/// Who wrote a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Instructions.
    System,
    /// The person.
    User,
    /// The model.
    Assistant,
}

impl Role {
    /// The wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

/// A plain chat message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AiMessage {
    /// Author.
    pub role: Role,
    /// Text.
    pub content: String,
}

impl AiMessage {
    /// A message from `role`.
    #[must_use]
    pub fn new(role: Role, content: impl Into<String>) -> Self {
        Self { role, content: content.into() }
    }

    /// A system message.
    #[must_use]
    pub fn system(content: impl Into<String>) -> Self {
        Self::new(Role::System, content)
    }

    /// A user message.
    #[must_use]
    pub fn user(content: impl Into<String>) -> Self {
        Self::new(Role::User, content)
    }
}

/// A tool the model may call.
#[derive(Clone, Debug, PartialEq)]
pub struct AiToolDef {
    /// Tool name.
    pub name: String,
    /// What it does.
    pub description: String,
    /// JSON Schema of the arguments.
    pub parameters: Value,
}

/// A tool call the model asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiToolCall {
    /// Call id, echoed back with the result.
    pub id: String,
    /// Tool name.
    pub name: String,
    /// Raw JSON string, exactly as the model produced it.
    pub arguments: String,
}

/// Items of a tool-calling conversation (OpenAI Chat Completions shape).
#[derive(Clone, Debug, PartialEq)]
pub enum AiTurnMessage {
    /// A system, user or assistant text message.
    Plain(AiMessage),
    /// The assistant answered with tool calls (and maybe text).
    AssistantCalls {
        /// Text written before the calls.
        content: Option<String>,
        /// The calls.
        tool_calls: Vec<AiToolCall>,
    },
    /// The result of one call.
    Tool {
        /// The call this answers.
        tool_call_id: String,
        /// What the tool returned.
        content: String,
    },
}

impl From<AiMessage> for AiTurnMessage {
    fn from(message: AiMessage) -> Self {
        Self::Plain(message)
    }
}

/// One model turn: text, tool calls, or (rarely) both.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AiToolTurn {
    /// The text, trimmed.
    pub content: String,
    /// Calls in the order the model made them.
    pub tool_calls: Vec<AiToolCall>,
}

/// Called with text as the model writes it.
pub type OnText<'a> = &'a (dyn Fn(&str) + Send + Sync);

/// The language model.
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// One reply to `messages`.
    async fn complete(
        &self,
        messages: &[AiMessage],
        signal: &Signal,
        user_id: Option<&str>,
    ) -> Result<String, AppError>;

    /// Whether `user_id` has connected their own account (SuperGrok); chat then runs through it.
    async fn has_own_account(&self, user_id: &str) -> bool;

    /// False when the user's chat runs through a client that cannot call tools (Grok Build CLI).
    async fn supports_tools(&self, user_id: Option<&str>) -> bool {
        match user_id {
            Some(user) => !self.has_own_account(user).await,
            None => true,
        }
    }

    /// One model turn that may answer with text, with tool calls, or (rarely) both. When
    /// `on_text` is given the turn is streamed.
    async fn complete_with_tools(
        &self,
        messages: &[AiTurnMessage],
        tools: &[AiToolDef],
        signal: &Signal,
        user_id: Option<&str>,
        on_text: Option<OnText<'_>>,
    ) -> Result<AiToolTurn, AppError>;
}

/// `record(value)`: the object, or `None` for anything else.
#[must_use]
pub fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn gateway(message: &str) -> AppError {
    AppError::new(StatusCode::BAD_GATEWAY, message)
}

fn cut_short() -> AppError {
    gateway("The AI response was cut short. Try a smaller request.")
}

fn invalid_response() -> AppError {
    gateway("The AI provider returned an invalid response.")
}

fn unreachable_provider() -> AppError {
    gateway("Could not reach the AI provider or read its response.")
}

fn timed_out() -> AppError {
    AppError::new(StatusCode::GATEWAY_TIMEOUT, "The AI request was cancelled or timed out.")
}

/// Runs `work` until it ends, `signal` is cancelled, or `limit` passes (`AbortSignal.any([signal,
/// AbortSignal.timeout(limit)])`).
async fn guarded<T>(
    signal: &Signal,
    limit: Duration,
    work: impl Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    if signal.is_cancelled() {
        return Err(timed_out());
    }
    tokio::select! {
        () = signal.cancelled() => Err(timed_out()),
        done = tokio::time::timeout(limit, work) => done.unwrap_or_else(|_| Err(timed_out())),
    }
}

fn first_choice(body: &Value) -> Option<&Map<String, Value>> {
    body.get("choices")?.as_array()?.first().and_then(record)
}

/// The Chat Completions provider, or a SuperGrok account when the user has connected one.
pub struct ChatCompletionsProvider {
    settings: Settings,
    grok: GrokBuild,
    client: Client,
}

enum Settings {
    /// Read from the configuration on every call, as NestJS does.
    Config(Arc<Config>),
    /// Fixed (tests point it at a local server).
    Fixed(ProviderSettings),
}

impl ChatCompletionsProvider {
    /// A provider configured by `AI_API_URL`, `AI_API_KEY` and `AI_MODEL`.
    #[must_use]
    pub fn new(config: Arc<Config>, grok: GrokBuild, client: Client) -> Self {
        Self { settings: Settings::Config(config), grok, client }
    }

    /// A provider with fixed settings (no HTTPS requirement). For tests.
    #[must_use]
    pub fn with_settings(settings: ProviderSettings, grok: GrokBuild, client: Client) -> Self {
        Self { settings: Settings::Fixed(settings), grok, client }
    }

    fn provider(&self) -> Result<ProviderSettings, AppError> {
        match &self.settings {
            Settings::Config(config) => config::provider(&config.ai),
            Settings::Fixed(settings) => Ok(settings.clone()),
        }
    }

    /// Sends a Chat Completions request (no redirects) and maps failures to safe errors.
    async fn send(&self, payload: Value) -> Result<reqwest::Response, AppError> {
        let provider = self.provider()?;
        let mut body = json!({ "model": provider.model });
        if let (Some(target), Value::Object(extra)) = (body.as_object_mut(), payload) {
            target.extend(extra);
        }
        let bytes = serde_json::to_vec(&body).map_err(AppError::internal)?;
        let response = self
            .client
            .post(&provider.url)
            .header("Authorization", format!("Bearer {}", provider.api_key))
            .header("Content-Type", "application/json")
            .body(bytes)
            .send()
            .await
            .map_err(|_| unreachable_provider())?;
        let status = response.status();
        if status.is_redirection() {
            return Err(unreachable_provider());
        }
        if !status.is_success() {
            if status == StatusCode::TOO_MANY_REQUESTS {
                return Err(AppError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "The AI provider is busy or its usage limit has been reached. Try again later.",
                ));
            }
            return Err(gateway(
                "The AI provider rejected the request. Check its configuration or try again later.",
            ));
        }
        Ok(response)
    }

    /// The next chunk of a response body, refusing anything over 256 kB in total.
    async fn next_chunk(
        response: &mut reqwest::Response,
        total: &mut usize,
    ) -> Result<Option<Vec<u8>>, AppError> {
        let Some(chunk) = response.chunk().await.map_err(|_| unreachable_provider())? else {
            return Ok(None);
        };
        *total += chunk.len();
        if *total > MAX_BODY_BYTES {
            return Err(gateway("The AI response is too large."));
        }
        Ok(Some(chunk.to_vec()))
    }

    /// POSTs a non-streaming request and returns the parsed JSON body.
    async fn post(&self, payload: Value, signal: &Signal) -> Result<Value, AppError> {
        let mut payload = payload;
        if let Some(map) = payload.as_object_mut() {
            map.insert("stream".to_owned(), Value::Bool(false));
        }
        guarded(signal, PLAIN_TIMEOUT, async {
            let mut response = self.send(payload).await?;
            let mut bytes = Vec::new();
            let mut total = 0;
            while let Some(chunk) = Self::next_chunk(&mut response, &mut total).await? {
                bytes.extend_from_slice(&chunk);
            }
            serde_json::from_slice::<Value>(&bytes).map_err(|_| unreachable_provider())
        })
        .await
    }

    /// POSTs a streaming request and calls `on_chunk` with every parsed `data:` event (server-sent
    /// events, OpenAI style). The whole stream is bounded to 90 s and 256 kB.
    async fn post_stream(
        &self,
        payload: Value,
        signal: &Signal,
        mut on_chunk: impl FnMut(&Map<String, Value>) + Send,
    ) -> Result<(), AppError> {
        let mut payload = payload;
        if let Some(map) = payload.as_object_mut() {
            map.insert("stream".to_owned(), Value::Bool(true));
        }
        guarded(signal, STREAM_TIMEOUT, async {
            let mut response = self.send(payload).await?;
            let mut buffer: Vec<u8> = Vec::new();
            let mut total = 0;
            let mut handle = |line: &str| -> Result<(), AppError> {
                let Some(data) = line.trim().strip_prefix("data:") else { return Ok(()) };
                let data = js::trim(data);
                if data.is_empty() || data == "[DONE]" {
                    return Ok(());
                }
                let parsed: Value =
                    serde_json::from_str(data).map_err(|_| unreachable_provider())?;
                if let Some(object) = record(&parsed) {
                    on_chunk(object);
                }
                Ok(())
            };
            while let Some(chunk) = Self::next_chunk(&mut response, &mut total).await? {
                buffer.extend_from_slice(&chunk);
                while let Some(newline) = buffer.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=newline).collect();
                    handle(&String::from_utf8_lossy(&line))?;
                }
            }
            handle(&String::from_utf8_lossy(&buffer))
        })
        .await
    }
}

fn to_wire_message(message: &AiTurnMessage) -> Value {
    match message {
        AiTurnMessage::Tool { tool_call_id, content } => {
            json!({ "role": "tool", "tool_call_id": tool_call_id, "content": content })
        }
        AiTurnMessage::AssistantCalls { content, tool_calls } => json!({
            "role": "assistant",
            "content": content,
            "tool_calls": tool_calls.iter().map(|c| json!({
                "id": c.id,
                "type": "function",
                "function": { "name": c.name, "arguments": c.arguments },
            })).collect::<Vec<_>>(),
        }),
        AiTurnMessage::Plain(m) => json!({ "role": m.role.as_str(), "content": m.content }),
    }
}

/// What a turn has gathered so far.
#[derive(Default)]
struct TurnState {
    content: String,
    finish: Option<Value>,
    calls: BTreeMap<i64, AiToolCall>,
}

impl TurnState {
    /// `addCall`: merges one (possibly partial) tool call into the call at its index.
    fn add_call(&mut self, raw: &Value, fallback_index: usize) {
        let call = record(raw);
        let function = call.and_then(|c| c.get("function")).and_then(record);
        let index = call
            .and_then(|c| c.get("index"))
            .and_then(Value::as_i64)
            .unwrap_or_else(|| i64::try_from(fallback_index).unwrap_or(0));
        let current = self.calls.entry(index).or_insert_with(|| AiToolCall {
            id: String::new(),
            name: String::new(),
            arguments: String::new(),
        });
        if let Some(id) = call.and_then(|c| c.get("id")).and_then(Value::as_str)
            && !id.is_empty()
        {
            id.clone_into(&mut current.id);
        }
        if let Some(name) = function.and_then(|f| f.get("name")).and_then(Value::as_str) {
            current.name.push_str(name);
        }
        if let Some(arguments) = function.and_then(|f| f.get("arguments")).and_then(Value::as_str) {
            current.arguments.push_str(arguments);
        }
    }

    fn add_calls(&mut self, raw: Option<&Value>) {
        if let Some(Value::Array(list)) = raw {
            for (i, call) in list.iter().enumerate() {
                self.add_call(call, i);
            }
        }
    }

    fn finish(self) -> Result<AiToolTurn, AppError> {
        if self.finish.as_ref().and_then(Value::as_str) == Some("length") {
            return Err(cut_short());
        }
        let mut tool_calls: Vec<AiToolCall> = self.calls.into_values().collect();
        if tool_calls.iter().any(|c| c.id.is_empty() || c.name.is_empty()) {
            return Err(gateway("The AI provider returned an invalid tool call."));
        }
        for call in &mut tool_calls {
            if call.arguments.is_empty() {
                "{}".clone_into(&mut call.arguments);
            }
        }
        let text = js::trim(&self.content);
        if (text.is_empty() && tool_calls.is_empty()) || js::len(text) > MAX_REPLY {
            return Err(invalid_response());
        }
        Ok(AiToolTurn { content: text.to_owned(), tool_calls })
    }
}

#[async_trait]
impl AiProvider for ChatCompletionsProvider {
    async fn complete(
        &self,
        messages: &[AiMessage],
        signal: &Signal,
        user_id: Option<&str>,
    ) -> Result<String, AppError> {
        if let Some(user) = user_id
            && self.grok.status(user).await.connected
        {
            return self.grok.complete(user, messages, signal).await;
        }
        let wire: Vec<Value> = messages
            .iter()
            .map(|m| json!({ "role": m.role.as_str(), "content": m.content }))
            .collect();
        let body = self.post(json!({ "messages": wire, "max_tokens": 1200 }), signal).await?;
        let choice = first_choice(&body);
        let content =
            choice.and_then(|c| c.get("message")).and_then(record).and_then(|m| m.get("content"));
        if choice.and_then(|c| c.get("finish_reason")).and_then(Value::as_str) == Some("length") {
            return Err(cut_short());
        }
        match content.and_then(Value::as_str) {
            Some(text) if !js::trim(text).is_empty() && js::len(text) <= MAX_REPLY => {
                Ok(js::trim(text).to_owned())
            }
            _ => Err(invalid_response()),
        }
    }

    async fn has_own_account(&self, user_id: &str) -> bool {
        self.grok.status(user_id).await.connected
    }

    async fn complete_with_tools(
        &self,
        messages: &[AiTurnMessage],
        tools: &[AiToolDef],
        signal: &Signal,
        _user_id: Option<&str>,
        on_text: Option<OnText<'_>>,
    ) -> Result<AiToolTurn, AppError> {
        let mut payload = json!({
            "messages": messages.iter().map(to_wire_message).collect::<Vec<_>>(),
            "max_tokens": 2000,
        });
        if !tools.is_empty() {
            payload["tools"] = tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        },
                    })
                })
                .collect();
            payload["tool_choice"] = json!("auto");
        }

        let mut state = TurnState::default();
        if let Some(on_text) = on_text {
            self.post_stream(payload, signal, |chunk| {
                let choice = chunk
                    .get("choices")
                    .and_then(Value::as_array)
                    .and_then(|c| c.first())
                    .and_then(record);
                let delta = choice.and_then(|c| c.get("delta")).and_then(record);
                if let Some(text) = delta.and_then(|d| d.get("content")).and_then(Value::as_str)
                    && !text.is_empty()
                {
                    state.content.push_str(text);
                    if js::len(&state.content) <= MAX_REPLY {
                        on_text(text);
                    }
                }
                state.add_calls(delta.and_then(|d| d.get("tool_calls")));
                if let Some(reason) = choice.and_then(|c| c.get("finish_reason"))
                    && !reason.is_null()
                    && reason != &Value::String(String::new())
                {
                    state.finish = Some(reason.clone());
                }
            })
            .await?;
        } else {
            let body = self.post(payload, signal).await?;
            let choice = first_choice(&body);
            let message = choice.and_then(|c| c.get("message")).and_then(record);
            if let Some(text) = message.and_then(|m| m.get("content")).and_then(Value::as_str) {
                text.clone_into(&mut state.content);
            }
            state.add_calls(message.and_then(|m| m.get("tool_calls")));
            state.finish = choice.and_then(|c| c.get("finish_reason")).cloned();
        }
        state.finish()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::Router;
    use axum::body::Body;
    use axum::extract::State;
    use axum::http::{HeaderMap, Response};
    use axum::routing::post;
    use serde_json::Value;
    use tokio::net::TcpListener;

    use super::*;

    /// One scripted reply of the fake provider.
    #[derive(Clone)]
    enum Reply {
        /// `200 text/event-stream`, the body split into the given network chunks.
        Sse(Vec<String>),
        Json(Value),
        Status(u16, &'static str),
        Raw(String),
        Big,
    }

    #[derive(Clone, Default)]
    struct Fake {
        replies: Arc<Mutex<Vec<Reply>>>,
        seen: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    }

    async fn handle(
        State(fake): State<Fake>,
        headers: HeaderMap,
        body: axum::body::Bytes,
    ) -> Response<Body> {
        fake.seen
            .lock()
            .unwrap()
            .push((headers, serde_json::from_slice(&body).unwrap_or_default()));
        let reply = fake.replies.lock().unwrap().remove(0);
        match reply {
            Reply::Sse(chunks) => {
                let stream = tokio_stream::iter(
                    chunks
                        .into_iter()
                        .map(|c| Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(c))),
                );
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from_stream(stream))
                    .unwrap()
            }
            Reply::Json(value) => Response::builder()
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            Reply::Status(code, text) => {
                Response::builder().status(code).body(Body::from(text)).unwrap()
            }
            Reply::Raw(text) => Response::builder().body(Body::from(text)).unwrap(),
            Reply::Big => Response::builder().body(Body::from("x".repeat(300_000))).unwrap(),
        }
    }

    async fn serve(replies: Vec<Reply>) -> (ChatCompletionsProvider, Fake) {
        let fake = Fake { replies: Arc::new(Mutex::new(replies)), ..Fake::default() };
        let app =
            Router::new().route("/v1/chat/completions", post(handle)).with_state(fake.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let config = Arc::new(Config::from_vars(&[]));
        let provider = ChatCompletionsProvider::with_settings(
            ProviderSettings {
                url: format!("http://{addr}/v1/chat/completions"),
                api_key: "k".to_owned(),
                model: "m".to_owned(),
            },
            GrokBuild::disabled(&config),
            Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap(),
        );
        (provider, fake)
    }

    fn data(value: &Value) -> String {
        format!("data: {value}\n\n")
    }

    fn tool() -> Vec<AiToolDef> {
        vec![AiToolDef { name: "t".into(), description: String::new(), parameters: json!({}) }]
    }

    async fn run(
        provider: &ChatCompletionsProvider,
        on_text: Option<OnText<'_>>,
    ) -> Result<AiToolTurn, AppError> {
        provider
            .complete_with_tools(
                &[AiMessage::user("hi").into()],
                &tool(),
                &Signal::new(),
                Some("u"),
                on_text,
            )
            .await
    }

    #[tokio::test]
    async fn streams_text_deltas_and_reassembles_tool_calls_split_across_chunks_and_lines() {
        let lines = vec![
            data(&json!({ "choices": [{ "delta": { "content": "Look" } }] })),
            // a line cut in the middle between two network chunks
            r#"data: {"choices":[{"delta":{"content":"ing"}}]}"#.to_owned(),
            "\n\n".to_owned(),
            data(&json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "id": "c1", "function": { "name": "list_", "arguments": "{\"a\"" } }
            ] } }] })),
            data(&json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "function": { "name": "issues", "arguments": ":1}" } }
            ] }, "finish_reason": "tool_calls" }] })),
            "data: [DONE]\n\n".to_owned(),
        ];
        let (provider, fake) = serve(vec![Reply::Sse(lines)]).await;
        let deltas = Mutex::new(Vec::<String>::new());
        let on_text = |d: &str| deltas.lock().unwrap().push(d.to_owned());
        let turn = run(&provider, Some(&on_text)).await.unwrap();
        assert_eq!(deltas.lock().unwrap().join(""), "Looking");
        assert_eq!(turn.content, "Looking");
        assert_eq!(
            turn.tool_calls,
            vec![AiToolCall {
                id: "c1".into(),
                name: "list_issues".into(),
                arguments: "{\"a\":1}".into()
            }]
        );
        let seen = fake.seen.lock().unwrap();
        let (headers, sent) = &seen[0];
        assert_eq!(sent["stream"], json!(true));
        assert_eq!(sent["model"], json!("m"));
        assert_eq!(sent["tools"].as_array().unwrap().len(), 1);
        assert_eq!(sent["tool_choice"], json!("auto"));
        assert_eq!(headers["authorization"], "Bearer k");
    }

    #[tokio::test]
    async fn without_a_listener_it_uses_a_plain_request_and_parses_the_same_shape() {
        let reply = json!({ "choices": [{
            "message": { "content": "x", "tool_calls": [
                { "id": "c", "function": { "name": "n", "arguments": "{}" } }
            ] },
            "finish_reason": "tool_calls",
        }] });
        let (provider, fake) = serve(vec![Reply::Json(reply)]).await;
        let turn = run(&provider, None).await.unwrap();
        assert_eq!(
            turn.tool_calls,
            vec![AiToolCall { id: "c".into(), name: "n".into(), arguments: "{}".into() }]
        );
        assert_eq!(turn.content, "x");
        assert_eq!(fake.seen.lock().unwrap()[0].1["stream"], json!(false));
    }

    #[tokio::test]
    async fn tool_calls_without_arguments_get_an_empty_object_and_follow_their_index_order() {
        let reply = json!({ "choices": [{ "message": { "tool_calls": [
            { "index": 1, "id": "b", "function": { "name": "two" } },
            { "index": 0, "id": "a", "function": { "name": "one", "arguments": "{\"x\":1}" } },
        ] } }] });
        let (provider, _) = serve(vec![Reply::Json(reply)]).await;
        let turn = run(&provider, None).await.unwrap();
        let names: Vec<_> =
            turn.tool_calls.iter().map(|c| (c.name.as_str(), c.arguments.as_str())).collect();
        assert_eq!(names, [("one", "{\"x\":1}"), ("two", "{}")]);
    }

    #[tokio::test]
    async fn rejects_a_truncated_stream_empty_replies_and_provider_errors_with_safe_messages() {
        let stream = |chunk: Value| Reply::Sse(vec![data(&chunk)]);
        let (provider, _) = serve(vec![
            stream(json!({ "choices": [{ "delta": { "content": "cut" }, "finish_reason": "length" }] })),
            stream(json!({ "choices": [{ "delta": {} }] })),
            Reply::Status(429, "secret upstream body"),
            Reply::Status(500, "secret upstream body"),
        ])
        .await;
        let sink = |_: &str| {};
        let err = run(&provider, Some(&sink)).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_GATEWAY);
        assert!(err.to_string().contains("cut short"));
        let err = run(&provider, Some(&sink)).await.unwrap_err();
        assert!(err.to_string().contains("invalid response"));
        let err = run(&provider, Some(&sink)).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::TOO_MANY_REQUESTS);
        assert!(err.to_string().contains("busy or its usage limit"));
        let err = run(&provider, None).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_GATEWAY);
        assert!(!err.to_string().contains("secret"));
    }

    #[tokio::test]
    async fn completes_a_plain_message() {
        let good = |content: &str, finish: &str| {
            Reply::Json(
                json!({ "choices": [{ "message": { "content": content }, "finish_reason": finish }] }),
            )
        };
        let (provider, fake) = serve(vec![
            good("  hello  ", "stop"),
            good("cut", "length"),
            good("   ", "stop"),
            Reply::Json(json!({ "choices": [] })),
            Reply::Json(json!([1])),
            Reply::Raw("not json".into()),
            Reply::Big,
        ])
        .await;
        let ask = || async {
            provider
                .complete(&[AiMessage::system("s"), AiMessage::user("u")], &Signal::new(), None)
                .await
        };
        assert_eq!(ask().await.unwrap(), "hello");
        {
            let seen = fake.seen.lock().unwrap();
            assert_eq!(seen[0].1["max_tokens"], json!(1200));
            assert_eq!(seen[0].1["stream"], json!(false));
            assert_eq!(seen[0].1["messages"][1], json!({ "role": "user", "content": "u" }));
        }
        assert!(ask().await.unwrap_err().to_string().contains("cut short"));
        for _ in 0..3 {
            assert!(ask().await.unwrap_err().to_string().contains("invalid response"));
        }
        let unreadable = ask().await.unwrap_err();
        assert_eq!(unreadable.status_code(), StatusCode::BAD_GATEWAY);
        assert!(unreadable.to_string().contains("Could not reach the AI provider"));
        assert!(ask().await.unwrap_err().to_string().contains("too large"));
    }

    #[tokio::test]
    async fn a_cancelled_request_is_a_gateway_timeout() {
        let (provider, _) = serve(vec![Reply::Json(json!({}))]).await;
        let signal = Signal::new();
        signal.cancel();
        let err = provider.complete(&[AiMessage::user("u")], &signal, None).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::GATEWAY_TIMEOUT);
        assert!(err.to_string().contains("cancelled or timed out"));
    }

    #[tokio::test]
    async fn an_unreachable_provider_is_a_bad_gateway() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let config = Arc::new(Config::from_vars(&[]));
        let provider = ChatCompletionsProvider::with_settings(
            ProviderSettings {
                url: format!("http://{addr}/x"),
                api_key: "k".into(),
                model: "m".into(),
            },
            GrokBuild::disabled(&config),
            Client::new(),
        );
        let err =
            provider.complete(&[AiMessage::user("u")], &Signal::new(), None).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_GATEWAY);
        assert!(err.to_string().contains("Could not reach the AI provider"));
    }

    #[tokio::test]
    async fn wire_messages_carry_tool_calls_and_results() {
        let calls = AiTurnMessage::AssistantCalls {
            content: None,
            tool_calls: vec![AiToolCall {
                id: "c1".into(),
                name: "n".into(),
                arguments: "{}".into(),
            }],
        };
        assert_eq!(
            to_wire_message(&calls),
            json!({ "role": "assistant", "content": null, "tool_calls": [
                { "id": "c1", "type": "function", "function": { "name": "n", "arguments": "{}" } }
            ] })
        );
        assert_eq!(
            to_wire_message(&AiTurnMessage::Tool {
                tool_call_id: "c1".into(),
                content: "r".into()
            }),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "r" })
        );
    }
}
