//! Cross-cutting services of the Trama API, the port of `server/src/common`, `server/src/mail`,
//! the integrations' `SecretsService` and the events' request store. Module crates use these
//! instead of writing their own:
//!
//! | Module | NestJS | What |
//! | --- | --- | --- |
//! | [`crypto`] | `common/crypto.ts`, `integrations/secrets.service.ts` | [`Secrets`]: AES-256-GCM `v1`/`v2` payloads, byte-compatible; `sha256_hex`, `generate_webhook_secret` |
//! | [`safe_fetch`] | `common/safe-fetch.ts` | [`SafeRequest`], `outbound_url_problem`, `check_url`, `guarded_client`: SSRF-safe outgoing HTTP |
//! | [`mail`] | `mail/mail.service.ts` | [`Mailer`] and [`Mail`]: SMTP, a no-op without `SMTP_URL`, a capturing mailer for tests |
//! | [`rate_limit`] | `common/rate-limit.ts` | the per-IP limiter middleware (wired by [`with_platform_layers`]) |
//! | [`request_context`] | `events/request-store.ts` | `client_id()`: the `X-Client-Id` of the current request |
//! | [`proxy`] | Express `req.ip` / `req.protocol` | `client_ip`, `request_protocol`, `public_base_url`, the [`proxy::ClientIp`] extractor |
//! | [`counters`] | `common/counters.service.ts` | `next`, `next_above`, `bump_to` on `workspace_counters` |
//! | [`refs`] | `common/refs.service.ts` | `projects`, `issues`, `users`, `subject_exists` reference checks |
//! | [`util`] | `common/util.ts` | `slugify`, `unique`, `is_unique_violation` |
//! | [`validation`] | `common/validation.ts` | `is_thread_url` / `thread_url` (`@IsThreadUrl()`) |
//! | [`app_url`], [`env_with_legacy`] | `common/app-url.ts`, `common/env.ts` | read from `Config` |
//!
//! Configuration (every environment variable NestJS reads) is `trama_core::Config`.

pub mod counters;
pub mod crypto;
pub mod mail;
pub mod proxy;
pub mod rate_limit;
pub mod refs;
pub mod request_context;
pub mod safe_fetch;
pub mod util;
pub mod validation;

use axum::Router;
use trama_core::{AppState, Config};

pub use crypto::Secrets;
pub use mail::{Mail, Mailer};
pub use request_context::client_id;
pub use safe_fetch::{FetchError, OutboundPolicy, SafeRequest, SafeResponse};
pub use trama_core::config::env_with_legacy;

/// Base URL of the web app for links in emails: `APP_URL`, else the first `CORS_ORIGIN`, without
/// trailing slashes.
#[must_use]
pub fn app_url(config: &Config) -> &str {
    &config.app_url
}

/// Registers the process-wide services on `state`: the [`Mailer`] (one SMTP pool) and the
/// [`Secrets`] keys.
///
/// # Errors
///
/// [`crypto::MissingKeyError`] in production without `TRAMA_ENCRYPTION_KEY`: the server must not
/// start then.
pub fn with_platform_services(state: AppState) -> Result<AppState, crypto::MissingKeyError> {
    let secrets = Secrets::from_config(&state.config)?;
    let mailer = Mailer::from_config(&state.config.mail);
    Ok(state.with_extension(secrets).with_extension(mailer))
}

/// Adds the request-level middleware of `configureApp` and `AppModule` that is not in
/// `trama_core::http`: the rate limiter and the `X-Client-Id` request context. Call before
/// `trama_core::http::with_http_layers`, so 429 answers still carry CORS and security headers.
pub fn with_platform_layers<S: Clone + Send + Sync + 'static>(
    router: Router<S>,
    config: &Config,
) -> Router<S> {
    let router = request_context::layer(router);
    rate_limit::layer(router, config)
}
