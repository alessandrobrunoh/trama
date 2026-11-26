//! Connections to git hosts and Delta, their provider clients and the artifact linker: the port
//! of `server/src/integrations`.
//!
//! A connection is a credential for GitHub, GitLab, Bitbucket or Delta, owned by a workspace
//! (managed by whoever has the integrations permission) or by one person (only that person
//! sees or changes it: anyone else gets a 404, never the row). Tokens and webhook secrets are
//! encrypted at rest with [`trama_common::Secrets`] (byte-compatible with NestJS) and never
//! returned after creation.
//!
//! # Routes
//!
//! | Route | Notes |
//! | --- | --- |
//! | `GET`, `POST /api/w/{slug}/integrations` | `manageIntegrations`; `POST` answers 201 `{ connection, webhook? }` |
//! | `GET`, `PATCH`, `DELETE /api/w/{slug}/integrations/{id}` | `DELETE` answers 204 |
//! | `POST /api/w/{slug}/integrations/{id}/revoke` | 200; status `revoked`, token wiped |
//! | `POST /api/w/{slug}/integrations/{id}/rotate-webhook-secret` | 200 `{ connection, webhook }` |
//! | `GET /api/w/{slug}/integrations/{id}/remote-repositories` | `?page&perPage` |
//! | the same eight under `/api/me/connections` | browser sessions of a user only |
//!
//! # Public API for other crates
//!
//! | NestJS | Rust |
//! | --- | --- |
//! | `IntegrationsService.list/get/create/update/revoke/remove/rotateWebhookSecret/remoteRepositories` | [`service`]`::{list, get, create, update, revoke, remove, rotate_webhook_secret, remote_repositories}` with a [`ConnectionScope`] |
//! | `summarize`, `present`, entity `toJSON` | [`service::summarize`], [`service::present`], [`service::connection_view`] (the workspace snapshot embeds the latter) |
//! | `SecretsService.decrypt(conn.secret, '<id>:secret')` | [`service::connection_token`]; the webhook secret: [`service::connection_webhook_secret`] |
//! | `createGitClient`, `RoutingRulesService.clientFor` | [`providers::create_git_client`], [`service::connection_client`] |
//! | `HttpClient.request` | [`Http::of`]`(&state).request(`[`HttpRequest`]`)`; tests register a fake with `state.with_extension(Http::new(fake))` |
//! | `ConnectionsService.usableFor` | [`connections::usable_for`] |
//! | `ArtifactLinkerService.upsert/applyCi/keyMap` | [`linker::upsert`], [`linker::apply_ci`], [`linker::key_map`] |
//! | `extractKeys` | [`keys::extract_keys`] |
//! | `ArtifactCandidate`, `CiPatch`, … | [`candidates`] |
//!
//! Provider calls go through [`Http`], which uses `trama_common::safe_fetch` (no private
//! addresses, no redirects, https only in production).

pub mod candidates;
pub mod connections;
pub mod http;
pub mod keys;
pub mod linker;
pub mod providers;
pub mod router;
pub mod schemas;
pub mod service;

pub use candidates::{ArtifactCandidate, CiPatch, IssueCandidate, ItemMeta, RepoMeta};
pub use http::{Http, HttpClient, HttpFailure, HttpRequest, HttpResponse, ProviderHttpError};
pub use linker::LinkResult;
pub use providers::{GitProviderClient, ProviderError, RemoteRepository, RemoteRepositoryPage};
pub use router::{ApiDoc, router};
pub use service::ConnectionScope;
