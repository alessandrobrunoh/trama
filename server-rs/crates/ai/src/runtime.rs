//! The process-wide state of the AI features and the services built from it for a request.

use std::sync::{Arc, OnceLock};

use reqwest::Client;
use reqwest::redirect::Policy;
use trama_core::AppState;

use crate::config;
use crate::context::DbPageContext;
use crate::grok::{GrokAttempts, GrokBuild};
use crate::limits::Limits;
use crate::project_service::ProjectAiService;
use crate::project_store::DbProjectAiStore;
use crate::provider::{AiProvider, ChatCompletionsProvider};
use crate::service::AiService;
use crate::tools::{AssistantTools, McpTools};

/// What outlives a request: the request limits, the open SuperGrok logins and the HTTP client
/// (no redirects). Register one at startup with [`with_ai_services`]; a state without one uses a
/// shared process-local instance.
#[derive(Clone)]
pub struct AiRuntime {
    limits: Limits,
    attempts: GrokAttempts,
    client: Client,
    provider: Option<Arc<dyn AiProvider>>,
    tools: Option<Arc<dyn AssistantTools>>,
}

impl Default for AiRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl AiRuntime {
    /// A runtime with empty limits.
    ///
    /// # Panics
    ///
    /// When the HTTP client cannot be built (TLS backend unavailable).
    #[must_use]
    pub fn new() -> Self {
        Self {
            limits: Limits::default(),
            attempts: GrokAttempts::default(),
            client: Client::builder().redirect(Policy::none()).build().expect("HTTP client"),
            provider: None,
            tools: None,
        }
    }

    /// Replaces the model (tests answer with a script).
    #[must_use]
    pub fn with_provider(mut self, provider: Arc<dyn AiProvider>) -> Self {
        self.provider = Some(provider);
        self
    }

    /// Replaces the assistant's tools (tests answer with a script).
    #[must_use]
    pub fn with_tools(mut self, tools: Arc<dyn AssistantTools>) -> Self {
        self.tools = Some(tools);
        self
    }

    /// The runtime registered on `state`, else the shared process-local one.
    #[must_use]
    pub fn of(state: &AppState) -> Self {
        static SHARED: OnceLock<AiRuntime> = OnceLock::new();
        state.extension::<Self>().cloned().unwrap_or_else(|| SHARED.get_or_init(Self::new).clone())
    }

    /// The HTTP client for the provider and the MCP server.
    #[must_use]
    pub fn client(&self) -> &Client {
        &self.client
    }

    /// The services for one request.
    #[must_use]
    pub fn services(&self, state: &AppState) -> Services {
        let grok = GrokBuild::from_config(&state.config, self.attempts.clone());
        let provider: Arc<dyn AiProvider> = self.provider.clone().unwrap_or_else(|| {
            Arc::new(ChatCompletionsProvider::new(
                Arc::clone(&state.config),
                grok.clone(),
                self.client.clone(),
            ))
        });
        let tools: Arc<dyn AssistantTools> = self.tools.clone().unwrap_or_else(|| {
            Arc::new(McpTools::new(
                state.db.clone(),
                state.config.mcp_url.clone(),
                self.client.clone(),
            ))
        });
        let ai = AiService::new(
            Arc::clone(&provider),
            Arc::new(DbPageContext::new(state.db.clone())),
            tools,
            self.limits.clone(),
            state.config.ai.max_writes_per_day,
        );
        let project = ProjectAiService::new(
            Arc::new(DbProjectAiStore::new(state.db.clone())),
            Arc::clone(&provider),
            self.limits.clone(),
            config::status(&state.config.ai).configured,
        );
        Services { ai, project, grok, provider }
    }
}

/// Registers the process-wide AI state on `state` (see [`AiRuntime`]).
#[must_use]
pub fn with_ai_services(state: AppState) -> AppState {
    state.with_extension(AiRuntime::new())
}

/// The AI services of one request.
#[derive(Clone)]
pub struct Services {
    /// Suggestions and chat.
    pub ai: AiService,
    /// Project proposals.
    pub project: ProjectAiService,
    /// SuperGrok.
    pub grok: GrokBuild,
    /// The model.
    pub provider: Arc<dyn AiProvider>,
}
