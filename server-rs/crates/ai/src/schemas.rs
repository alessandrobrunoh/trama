//! Request and response bodies of the AI routes.

use serde::Serialize;
use serde_json::Value;
use utoipa::ToSchema;

use crate::activity::Activity;
use crate::config::SuggestionsStatus;
use crate::grok::GrokStatus;

/// A person the draft may be assigned to.
#[derive(Clone, Debug, ToSchema)]
pub struct DraftOptionBody {
    /// User id, at most 160 characters.
    pub id: String,
    /// Display name, at most 240 characters.
    pub label: String,
}

/// A finished issue that helps calibrate estimates.
#[derive(Clone, Debug, ToSchema)]
#[schema(rename_all = "camelCase")]
pub struct DraftSimilarIssueBody {
    /// Issue key, at most 40 characters.
    pub key: String,
    /// Title, at most 240 characters.
    pub title: String,
    /// Kind, at most 40 characters.
    pub kind: String,
    /// Priority, at most 40 characters.
    pub priority: String,
    /// Estimate.
    pub estimate: Option<f64>,
    /// Days from start to completion.
    pub cycle_days: Option<f64>,
}

/// The choices triage may pick from.
#[derive(Clone, Debug, ToSchema)]
pub struct IssueDraftOptionsBody {
    /// At most 10 kinds.
    pub kinds: Vec<String>,
    /// At most 5 priorities.
    pub priorities: Vec<String>,
    /// At most 12 estimates.
    pub estimates: Vec<f64>,
    /// At most 100 people.
    pub assignees: Vec<DraftOptionBody>,
    /// At most 4 similar finished issues.
    pub similar: Vec<DraftSimilarIssueBody>,
}

/// `POST /api/w/{slug}/ai/suggestions` body (`SuggestionDto`).
#[derive(Clone, Debug, ToSchema)]
#[schema(rename_all = "camelCase")]
pub struct SuggestionBody {
    /// Always `issue`.
    pub kind: String,
    /// Draft title, at most 300 characters.
    pub title: String,
    /// Draft description, at most 12000 characters.
    pub description: String,
    /// Triage choices.
    pub issue_options: Option<IssueDraftOptionsBody>,
}

/// One message of the conversation.
#[derive(Clone, Debug, ToSchema)]
pub struct ChatMessageBody {
    /// `user` or `assistant`.
    pub role: String,
    /// 1 to 16000 characters.
    pub content: String,
}

/// Where the person is.
#[derive(Clone, Debug, ToSchema)]
pub struct ChatContextBody {
    /// `page`, `issue` or `project`.
    pub kind: String,
    /// Name of the page or record, at most 160 characters.
    pub label: String,
    /// Id or key of the record, at most 160 characters.
    pub id: Option<String>,
}

/// `POST /api/w/{slug}/ai/chat` body (`ChatDto`).
#[derive(Clone, Debug, ToSchema)]
pub struct ChatBody {
    /// 1 to 20 messages, the last from the user.
    pub messages: Vec<ChatMessageBody>,
    /// Where the person is.
    pub context: Option<ChatContextBody>,
}

/// `assistantTools` of the status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct AssistantToolsStatus {
    /// `MCP_URL` is set and the person's chat can call tools.
    pub enabled: bool,
}

/// `chatgpt` of the status: always unavailable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct ChatgptStatus {
    /// Always `unavailable`.
    pub status: &'static str,
    /// Why.
    pub reason: &'static str,
}

/// `GET /api/w/{slug}/ai/status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct AiStatus {
    /// The configured provider.
    pub suggestions: SuggestionsStatus,
    /// The person's SuperGrok connection.
    pub supergrok: GrokStatus,
    /// Whether the assistant can use tools.
    #[serde(rename = "assistantTools")]
    pub assistant_tools: AssistantToolsStatus,
    /// ChatGPT plan connections.
    pub chatgpt: ChatgptStatus,
}

/// One triage suggestion for an issue draft.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
pub struct TriageSuggestion {
    /// `priority`, `kind`, `estimate` or `assigneeId`.
    pub field: String,
    /// The chosen value: a string, or a number for the estimate.
    #[schema(value_type = Object)]
    pub value: Value,
    /// Display name of the chosen assignee.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// One short sentence of evidence, at most 180 characters.
    pub why: String,
}

/// The triage part of a suggestion.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
pub struct Triage {
    /// What the model chose, restricted to the offered choices.
    pub suggestions: Vec<TriageSuggestion>,
}

/// `POST /api/w/{slug}/ai/suggestions`.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
pub struct SuggestionResponse {
    /// Improved title, at most 300 characters.
    pub title: String,
    /// Improved description, at most 12000 characters.
    pub description: String,
    /// At most three questions about missing information.
    pub questions: Vec<String>,
    /// Triage properties, when the draft sent its choices.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triage: Option<Triage>,
}

/// `POST /api/w/{slug}/ai/chat`, and the `done` event of the stream.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
pub struct ChatResponse {
    /// The reply, in Markdown.
    pub content: String,
    /// What the assistant did, when it used tools.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
}
