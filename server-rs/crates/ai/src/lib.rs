//! The AI features of the Trama API: the port of `server/src/ai`.
//!
//! | Route | What |
//! | --- | --- |
//! | `GET /api/w/{slug}/ai/status` | provider, SuperGrok and tool availability |
//! | `POST`, `DELETE /api/w/{slug}/ai/supergrok/login` | connect and disconnect a SuperGrok account |
//! | `POST /api/w/{slug}/ai/suggestions` | improve an issue draft and propose its triage |
//! | `POST /api/w/{slug}/ai/chat`, `…/chat/stream` | assistant reply, as JSON or as server-sent events |
//! | `POST /api/w/{slug}/projects/{id}/ai/{kind}` | project summary, issues to add and risks |
//!
//! Everything needs a browser session (API tokens are refused) and a non-guest member.
//!
//! # Pieces
//!
//! * [`config`]: `AI_API_URL`, `AI_API_KEY`, `AI_MODEL` and the HTTPS rules of the provider URL;
//! * [`provider`]: [`provider::AiProvider`] and the Chat Completions client (plain and streamed);
//! * [`grok`]: SuperGrok through the Grok Build CLI (`GROK_CLI_PATH`, `GROK_HOME_DIR`);
//! * [`tools`]: the assistant's tools, the MCP server (`MCP_URL`) reached with a temporary
//!   `custom` API token that acts as the person; the assistant never calls the issue, project
//!   or comment code directly, so every change goes through the same API, permissions, events
//!   and webhooks as any other client;
//! * [`service`]: suggestions and the bounded tool loop (12 steps, 20 calls, 10 changes per
//!   reply, `AI_ASSISTANT_MAX_WRITES_PER_DAY` per person and day, a 120 s deadline);
//! * [`limits`]: one request at a time per person, 20 overall, 10 per minute;
//! * [`project_logic`], [`project_store`], [`project_service`]: the project proposals;
//! * [`runtime`]: the process-wide state. Register it at startup with
//!   [`runtime::with_ai_services`].

// product names (SuperGrok, OpenAI) appear as prose throughout
#![allow(clippy::doc_markdown)]

pub mod activity;
pub mod config;
pub mod context;
pub mod dto;
pub mod grok;
pub mod issue_args;
pub mod limits;
pub mod project_logic;
pub mod project_service;
pub mod project_store;
pub mod provider;
pub mod router;
pub mod runtime;
pub mod schemas;
pub mod service;
pub mod signal;
pub mod tools;

pub use router::{ApiDoc, router};
pub use runtime::{AiRuntime, with_ai_services};
