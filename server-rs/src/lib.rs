//! Trama API: composes the module crates into one Axum application.
//!
//! [`app`] builds the router (every module under `/api`, the NestJS-style 404 and the HTTP
//! layers); [`run`] adds startup: config, database, migrations and graceful shutdown.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::http::{Method, Uri};
use sea_orm_migration::MigratorTrait;
use trama_auth::Routes;
use trama_core::{AppError, AppState, Config};
use utoipa_scalar::{Scalar, Servable};

mod openapi;

pub use openapi::api_doc;

/// Every module's routes, each behind its `trama_auth::Gate`. Keep sorted by crate name.
fn routes() -> Routes {
    Routes::new()
        .merge(trama_auth::router())
        .merge(trama_events::router())
        .merge(trama_notifications::router())
        .merge(trama_system::router())
}

/// The whole application over `state`.
///
/// Every module route sits behind the access guard (`trama_auth::guard`). Outside production
/// the OpenAPI document is served at `/api/openapi.json` and a Scalar reference at `/api/docs`;
/// they are merged after the guard, so they stay public.
pub fn app(state: AppState) -> Router {
    let mut api: Router<AppState> = routes().into_router(&state);
    if !state.config.production {
        let doc = api_doc();
        api = api.merge(Scalar::with_url("/docs", doc.clone())).route(
            "/openapi.json",
            axum::routing::get(move || std::future::ready(axum::Json(doc))),
        );
    }
    let config = Arc::clone(&state.config);
    let router = Router::new().nest("/api", api).fallback(not_found).with_state(state);
    let router = trama_common::with_platform_layers(router, &config);
    trama_core::http::with_http_layers(router, &config)
}

/// `{"statusCode":404,"message":"Cannot GET /api/x","error":"Not Found"}`, as NestJS answers.
async fn not_found(method: Method, uri: Uri) -> AppError {
    AppError::not_found(format!("Cannot {method} {}", uri.path()))
}

/// Starts the server and serves until SIGINT or SIGTERM.
///
/// # Errors
///
/// Returns an error when the configuration is invalid, the database cannot be reached or
/// migrated, or the port cannot be bound.
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    // refuse to start without an encryption key in production, before touching the database
    trama_common::Secrets::from_config(&config)?;

    trama_core::db::ensure_database(&config.database_url).await;
    let db = trama_core::db::connect(&config.database_url).await?;
    trama_migration::Migrator::up(&db, None).await?;

    let port = config.port;
    // live events reach every instance's streams through Postgres NOTIFY / LISTEN
    let events = trama_events::Events::start(db.clone(), config.database_url.clone());
    let state = trama_common::with_platform_services(AppState::new(db.clone(), config))?
        .with_extension(events.clone());
    let state = trama_notifications::with_services(state);
    // notifications are produced from the domain events this instance records
    let notifications = trama_notifications::spawn(&state);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("Trama API listening on http://localhost:{port}/api");

    // the socket address feeds the rate limiter and `TRAMA_TRUST_PROXY`
    axum::serve(listener, app(state).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    notifications.abort();
    events.shutdown().await;
    db.close().await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutting down");
}
