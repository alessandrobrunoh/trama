//! Trama API: composes the module crates into one Axum application.
//!
//! [`app`] builds the router (every module under `/api`, the NestJS-style 404 and the HTTP
//! layers); [`run`] adds startup: config, database, migrations and graceful shutdown.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::http::{Method, Uri};
use sea_orm_migration::MigratorTrait;
use trama_core::{AppError, AppState, Config};
use utoipa_scalar::{Scalar, Servable};

mod openapi;

pub use openapi::api_doc;

/// The whole application over `state`.
///
/// Outside production the OpenAPI document is served at `/api/openapi.json` and a Scalar
/// reference at `/api/docs`.
pub fn app(state: AppState) -> Router {
    let mut api: Router<AppState> = Router::new().merge(trama_system::router());
    if !state.config.production {
        let doc = api_doc();
        api = api.merge(Scalar::with_url("/docs", doc.clone())).route(
            "/openapi.json",
            axum::routing::get(move || std::future::ready(axum::Json(doc))),
        );
    }
    let config = Arc::clone(&state.config);
    let router = Router::new().nest("/api", api).fallback(not_found).with_state(state);
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

    trama_core::db::ensure_database(&config.database_url).await;
    let db = trama_core::db::connect(&config.database_url).await?;
    trama_migration::Migrator::up(&db, None).await?;

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("Trama API listening on http://localhost:{}/api", config.port);

    axum::serve(listener, app(AppState::new(db.clone(), config)))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
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
