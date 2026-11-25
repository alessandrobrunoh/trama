//! Process configuration read from the environment.
//!
//! Variable names and defaults follow `server/.env.example`, so one `.env` can serve both APIs
//! while routes move from NestJS to Rust. Empty values count as unset, as they do there.

/// Browser origins allowed when `CORS_ORIGIN` is unset: the Angular dev server and a second QA
/// instance.
pub const DEFAULT_CORS_ORIGINS: [&str; 4] = [
    "http://localhost:4300",
    "http://127.0.0.1:4300",
    "http://localhost:4301",
    "http://127.0.0.1:4301",
];

/// Database used when `DATABASE_URL` is unset (the docker compose `delta-postgres` service).
pub const DEFAULT_DATABASE_URL: &str = "postgres://delta:delta@localhost:5435/trama";

/// Settings the server needs at startup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// HTTP port (`PORT`, default 3000).
    pub port: u16,
    /// PostgreSQL connection string (`DATABASE_URL`).
    pub database_url: String,
    /// Origins allowed to call the API with credentials (`CORS_ORIGIN`, comma-separated).
    pub cors_origins: Vec<String>,
    /// `NODE_ENV=production`: HSTS, secure cookies, no API docs.
    pub production: bool,
}

/// A variable is present but cannot be used.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// `PORT` is not a number between 0 and 65535.
    #[error("PORT must be a port number, got {0:?}")]
    InvalidPort(String),
}

impl Config {
    /// Reads the process environment.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] when a variable holds an unusable value.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Reads configuration through `get`, which returns a variable's raw value.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] when a variable holds an unusable value.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let var = |key: &str| get(key).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());

        let port = match var("PORT") {
            Some(raw) => raw.parse().map_err(|_| ConfigError::InvalidPort(raw))?,
            None => 3000,
        };
        let cors_origins: Vec<String> = var("CORS_ORIGIN")
            .map(|raw| {
                raw.split(',').map(str::trim).filter(|o| !o.is_empty()).map(str::to_owned).collect()
            })
            .unwrap_or_default();

        Ok(Self {
            port,
            database_url: var("DATABASE_URL").unwrap_or_else(|| DEFAULT_DATABASE_URL.to_owned()),
            cors_origins: if cors_origins.is_empty() {
                DEFAULT_CORS_ORIGINS.map(str::to_owned).to_vec()
            } else {
                cors_origins
            },
            production: var("NODE_ENV").as_deref() == Some("production"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
        Config::from_lookup(|key| {
            vars.iter().find(|(k, _)| *k == key).map(|(_, v)| (*v).to_owned())
        })
    }

    #[test]
    fn defaults_match_the_nest_api() {
        let cfg = config(&[]).unwrap();
        assert_eq!(cfg.port, 3000);
        assert_eq!(cfg.database_url, DEFAULT_DATABASE_URL);
        assert_eq!(cfg.cors_origins, DEFAULT_CORS_ORIGINS.to_vec());
        assert!(!cfg.production);
    }

    #[test]
    fn empty_values_count_as_unset() {
        let cfg = config(&[("PORT", " "), ("DATABASE_URL", ""), ("CORS_ORIGIN", " , ")]).unwrap();
        assert_eq!(cfg.port, 3000);
        assert_eq!(cfg.database_url, DEFAULT_DATABASE_URL);
        assert_eq!(cfg.cors_origins.len(), DEFAULT_CORS_ORIGINS.len());
    }

    #[test]
    fn reads_values() {
        let cfg = config(&[
            ("PORT", "3100"),
            ("CORS_ORIGIN", "https://a.dev, https://b.dev"),
            ("NODE_ENV", "production"),
        ])
        .unwrap();
        assert_eq!(cfg.port, 3100);
        assert_eq!(cfg.cors_origins, ["https://a.dev", "https://b.dev"]);
        assert!(cfg.production);
    }

    #[test]
    fn rejects_a_bad_port() {
        assert!(matches!(config(&[("PORT", "http")]), Err(ConfigError::InvalidPort(_))));
    }
}
