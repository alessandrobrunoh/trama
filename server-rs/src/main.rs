//! `trama-api` binary: loads `.env`, sets up logging and runs the server.

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "trama=info,tower_http=info,sqlx=warn".into()),
        )
        .init();
    trama_api::run().await
}
