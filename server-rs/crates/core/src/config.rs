//! Process configuration read from the environment.
//!
//! Every variable the NestJS server reads is read here once, with the same name, default and
//! parsing quirks, so one `.env` serves both APIs while routes move from NestJS to Rust (see
//! `server/.env.example`). Modules read [`Config`] from `AppState::config` instead of the
//! environment.
//!
//! Most text values are trimmed and an empty value counts as unset, as they do in NestJS. The
//! exceptions are noted on the field: they reproduce a NestJS check that compares the raw value.

use std::collections::HashSet;
use std::fmt;
use std::net::IpAddr;
use std::sync::Mutex;

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

/// Sender used when `MAIL_FROM` is unset.
pub const DEFAULT_MAIL_FROM: &str = "Trama <no-reply@localhost>";

/// VAPID subject used when `VAPID_SUBJECT` is unset.
pub const DEFAULT_VAPID_SUBJECT: &str = "mailto:no-reply@localhost";

/// `TRAMA_SSE_RECHECK_MS` default: an open live-event stream re-checks its credential every 30 s.
pub const DEFAULT_SSE_RECHECK_MS: u64 = 30_000;

/// `TRAMA_WEBHOOK_RETRY_MS` default: delay before an outgoing webhook's single retry.
pub const DEFAULT_WEBHOOK_RETRY_MS: u64 = 2_000;

/// `AI_ASSISTANT_MAX_WRITES_PER_DAY` default.
pub const DEFAULT_AI_MAX_WRITES_PER_DAY: u32 = 200;

/// A configuration value that must not end up in logs (`Debug` prints `[redacted]`).
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Wraps `value`.
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The value itself.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

/// Which client addresses may set `X-Forwarded-For` / `X-Forwarded-Proto` (`TRAMA_TRUST_PROXY`),
/// with the semantics of Express's `trust proxy` setting.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum TrustProxy {
    /// Unset or `false`: the socket address is the client.
    #[default]
    None,
    /// `true`: the left-most `X-Forwarded-For` entry is the client.
    All,
    /// A hop count (`1`): trust that many proxies in front of the server.
    Hops(u32),
    /// A subnet list (`loopback, 10.0.0.0/8`): trust proxies inside these ranges.
    Subnets(Vec<Subnet>),
}

impl TrustProxy {
    /// Parses `TRAMA_TRUST_PROXY` as the NestJS `parseTrustProxy` and Express's `compileTrust`
    /// do: `true`, `false`, a hop count, or a comma-separated list of IPs, CIDR ranges and the
    /// names `loopback`, `linklocal` and `uniquelocal`.
    ///
    /// # Errors
    ///
    /// Returns the offending entry when an item of a subnet list is not an address or range
    /// (Express refuses to start then too).
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        let Some(value) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
            return Ok(Self::None);
        };
        match value {
            "true" => return Ok(Self::All),
            "false" => return Ok(Self::None),
            _ => {}
        }
        if value.bytes().all(|b| b.is_ascii_digit()) {
            return Ok(Self::Hops(value.parse().unwrap_or(u32::MAX)));
        }
        let mut subnets = Vec::new();
        for item in value.split(',').map(str::trim).filter(|i| !i.is_empty()) {
            match item {
                "loopback" => subnets.extend(["127.0.0.1/8", "::1/128"].map(Subnet::parse_known)),
                "linklocal" => {
                    subnets.extend(["169.254.0.0/16", "fe80::/10"].map(Subnet::parse_known));
                }
                "uniquelocal" => subnets.extend(
                    ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]
                        .map(Subnet::parse_known),
                ),
                other => subnets.push(Subnet::parse(other).ok_or_else(|| other.to_owned())?),
            }
        }
        Ok(Self::Subnets(subnets))
    }

    /// Whether the proxy at `addr`, `hop` steps away from the server (0 = the socket peer), may
    /// tell who its client is.
    #[must_use]
    pub fn trusts(&self, addr: &str, hop: usize) -> bool {
        match self {
            Self::None => false,
            Self::All => true,
            Self::Hops(n) => hop < *n as usize,
            Self::Subnets(subnets) => {
                let Ok(ip) = addr.trim().parse::<IpAddr>() else { return false };
                subnets.iter().any(|s| s.contains(ip))
            }
        }
    }
}

/// An address range (`10.0.0.0/8`, `::1/128`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subnet {
    addr: IpAddr,
    prefix: u8,
}

impl Subnet {
    /// `ip`, `ip/bits` or (IPv4) `ip/netmask`.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let (ip, prefix) = match raw.split_once('/') {
            Some((ip, bits)) => (ip, Some(bits)),
            None => (raw, None),
        };
        let addr: IpAddr = ip.trim().parse().ok()?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix.map(str::trim) {
            None => max,
            Some(bits) if bits.bytes().all(|b| b.is_ascii_digit()) && !bits.is_empty() => {
                bits.parse::<u8>().ok().filter(|b| *b <= max)?
            }
            Some(mask) => match (addr, mask.parse::<IpAddr>().ok()?) {
                (IpAddr::V4(_), IpAddr::V4(mask)) => {
                    let bits = u32::from(mask);
                    if bits.leading_ones() + bits.trailing_zeros() != 32 {
                        return None;
                    }
                    u8::try_from(bits.leading_ones()).ok()?
                }
                _ => return None,
            },
        };
        Some(Self { addr, prefix })
    }

    fn parse_known(raw: &str) -> Self {
        Self::parse(raw).unwrap_or(Self { addr: IpAddr::from([0, 0, 0, 0]), prefix: 32 })
    }

    /// Whether `ip` is inside the range. An IPv4-mapped IPv6 address matches IPv4 ranges.
    #[must_use]
    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = match ip {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
            v4 @ IpAddr::V4(_) => v4,
        };
        match (self.addr, ip) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = u32::MAX.checked_shl(32 - u32::from(self.prefix)).unwrap_or(0);
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = u128::MAX.checked_shl(128 - u32::from(self.prefix)).unwrap_or(0);
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

/// Encryption key material for secrets at rest (see `trama_common::crypto`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EncryptionConfig {
    /// `TRAMA_ENCRYPTION_KEY`, else `NABLA_ENCRYPTION_KEY`, else `SECRETS_KEY`, untrimmed. As in
    /// NestJS an empty `TRAMA_ENCRYPTION_KEY=` without the legacy name counts as set (and selects
    /// the development key), so `SECRETS_KEY` is only read when the first is absent.
    pub key: Option<Secret>,
    /// `SECRETS_KEY` as written, for rows encrypted with the pre-shared-key derivation.
    pub legacy_secrets_key: Option<Secret>,
}

/// Outgoing email.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MailConfig {
    /// `SMTP_URL`; unset means emails are not sent.
    pub smtp_url: Option<Secret>,
    /// `MAIL_FROM` (default [`DEFAULT_MAIL_FROM`]).
    pub from: String,
}

/// The OpenAI-compatible provider behind AI suggestions and the assistant.
///
/// The three provider values are trimmed but an empty value is kept as `Some("")`: NestJS
/// reports `model: ""` in the AI status then, and treats the provider as unconfigured.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiConfig {
    /// `AI_API_URL`.
    pub api_url: Option<String>,
    /// `AI_API_KEY`.
    pub api_key: Option<Secret>,
    /// `AI_MODEL`.
    pub model: Option<String>,
    /// `AI_ASSISTANT_MAX_WRITES_PER_DAY` (default 200, at least 1; a fraction rounds up).
    pub max_writes_per_day: u32,
}

/// The optional Grok Build CLI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrokConfig {
    /// `GROK_CLI_PATH` (default `grok`).
    pub cli_path: String,
    /// `GROK_HOME_DIR`; unset means Grok Build is unavailable.
    pub home_dir: Option<String>,
}

/// Web Push.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushConfig {
    /// `VAPID_PUBLIC_KEY`.
    pub vapid_public_key: Option<String>,
    /// `VAPID_PRIVATE_KEY`.
    pub vapid_private_key: Option<Secret>,
    /// `VAPID_SUBJECT` (default [`DEFAULT_VAPID_SUBJECT`]).
    pub vapid_subject: String,
}

/// Per-IP request limits (`TRAMA_RATE_LIMIT_*`).
#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(clippy::struct_field_names)]
pub struct RateLimitConfig {
    /// `TRAMA_RATE_LIMIT_ENABLED` (`true`/`false`); unset: on unless `NODE_ENV=test`.
    pub enabled: bool,
    /// `POST /api/auth/login` per 15 minutes (default 10).
    pub login_per_15min: u32,
    /// `POST /api/auth/signup` per hour (default 10).
    pub signup_per_hour: u32,
    /// `/api/invites/:token[/accept]` per 15 minutes (default 30).
    pub invite_per_15min: u32,
    /// `GET /api/public/views/:token` per minute (default 30).
    pub public_view_per_min: u32,
    /// `POST /api/w/:slug/tokens|agents` per hour (default 30).
    pub credentials_per_hour: u32,
    /// Every `/api` request per minute (default 1200).
    pub global_per_min: u32,
}

/// Rules for requests to URLs a user chose (webhooks, push endpoints, integration base URLs).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OutboundPolicy {
    /// Allow loopback / private / link-local targets (`TRAMA_OUTBOUND_ALLOW_PRIVATE=true`, or
    /// the deprecated `NABLA_ALLOW_PRIVATE_WEBHOOKS`).
    pub allow_private: bool,
    /// Hosts exempt from the address check (`TRAMA_OUTBOUND_ALLOWED_HOSTS`, lowercased, without
    /// IPv6 brackets). `*.example.com` matches subdomains.
    pub allowed_hosts: Vec<String>,
    /// Require https for targets that are not explicitly allowed (production).
    pub require_https: bool,
}

/// Demo data written into an empty database.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedConfig {
    /// Seed the demo workspace (`SEED_DEMO`, off only when exactly `false`; never in production).
    pub demo: bool,
    /// Include mock history (`SEED_MOCK_HISTORY`, off only when exactly `false`).
    pub mock_history: bool,
}

/// Public Shared View tokens for the roadmap and changelog pages.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PublicViews {
    /// `PUBLIC_ROADMAP_VIEW_TOKEN`.
    pub roadmap_view_token: Option<String>,
    /// `PUBLIC_CHANGELOG_VIEW_TOKEN`.
    pub changelog_view_token: Option<String>,
}

/// Settings the server reads at startup.
#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // one flag per environment variable
pub struct Config {
    /// HTTP port (`PORT`, default 3000).
    pub port: u16,
    /// PostgreSQL connection string (`DATABASE_URL`).
    pub database_url: String,
    /// Origins allowed to call the API with credentials (`CORS_ORIGIN`, comma-separated).
    pub cors_origins: Vec<String>,
    /// `NODE_ENV=production`: HSTS, secure cookies, https-only outbound, no API docs, no seed.
    pub production: bool,
    /// `NODE_ENV` as set (trimmed).
    pub node_env: Option<String>,
    /// Base URL of the web app for links in emails: `APP_URL`, else the first `CORS_ORIGIN`
    /// entry, without trailing slashes.
    pub app_url: String,
    /// Externally reachable base URL of this API (`PUBLIC_URL`), without trailing slashes.
    pub public_url: Option<String>,
    /// MCP server the assistant uses (`MCP_URL`).
    pub mcp_url: Option<String>,
    /// `TRAMA_TRUST_PROXY`.
    pub trust_proxy: TrustProxy,
    /// Keys for secrets at rest.
    pub encryption: EncryptionConfig,
    /// Outgoing email.
    pub mail: MailConfig,
    /// AI provider.
    pub ai: AiConfig,
    /// Grok Build CLI.
    pub grok: GrokConfig,
    /// Web Push.
    pub push: PushConfig,
    /// Request limits.
    pub rate_limit: RateLimitConfig,
    /// Outbound request policy.
    pub outbound: OutboundPolicy,
    /// Demo seed.
    pub seed: SeedConfig,
    /// Show the demo credentials on the sign-in page (`DEMO_LOGIN`).
    pub demo_login: bool,
    /// Public roadmap and changelog views.
    pub public_views: PublicViews,
    /// `POST /api/admin/reset` (`TRAMA_ENABLE_ADMIN_RESET=true`, never in production).
    pub admin_reset_enabled: bool,
    /// Background import runner (off when `TRAMA_IMPORT_RUNNER=off`).
    pub import_runner_enabled: bool,
    /// `TRAMA_SSE_RECHECK_MS` (default 30000, at least 100).
    pub sse_recheck_ms: u64,
    /// `TRAMA_WEBHOOK_RETRY_MS` (or the deprecated `NABLA_WEBHOOK_RETRY_MS`; default 2000).
    pub webhook_retry_ms: u64,
}

/// A variable is present but cannot be used.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// `PORT` is not a number between 0 and 65535.
    #[error("PORT must be a port number, got {0:?}")]
    InvalidPort(String),
    /// An entry of `TRAMA_TRUST_PROXY` is not an address or range.
    #[error("TRAMA_TRUST_PROXY: invalid IP address: {0}")]
    InvalidTrustProxy(String),
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

    /// Configuration from a fixed list of variables, everything else unset. Handy in tests:
    /// `Config::from_vars(&[("NODE_ENV", "production")])`.
    ///
    /// # Panics
    ///
    /// Panics when a value is unusable.
    #[must_use]
    pub fn from_vars(vars: &[(&str, &str)]) -> Self {
        Self::from_lookup(|key| vars.iter().find(|(k, _)| *k == key).map(|(_, v)| (*v).to_owned()))
            .expect("valid test configuration")
    }

    /// Reads configuration through `get`, which returns a variable's raw value.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] when a variable holds an unusable value.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let var = |key: &str| get(key).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let trimmed = |key: &str| get(key).map(|v| v.trim().to_owned());

        let port = match var("PORT") {
            Some(raw) => raw.parse().map_err(|_| ConfigError::InvalidPort(raw))?,
            None => 3000,
        };
        let cors_origins: Vec<String> = var("CORS_ORIGIN")
            .map(|raw| {
                raw.split(',').map(str::trim).filter(|o| !o.is_empty()).map(str::to_owned).collect()
            })
            .unwrap_or_default();
        let node_env = var("NODE_ENV");
        let production = node_env.as_deref() == Some("production");

        let app_url = var("APP_URL")
            .or_else(|| {
                get("CORS_ORIGIN")
                    .and_then(|raw| raw.split(',').next().map(|s| s.trim().to_owned()))
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| DEFAULT_CORS_ORIGINS[0].to_owned());

        let trust_proxy = TrustProxy::parse(get("TRAMA_TRUST_PROXY").as_deref())
            .map_err(ConfigError::InvalidTrustProxy)?;

        Ok(Self {
            port,
            database_url: var("DATABASE_URL").unwrap_or_else(|| DEFAULT_DATABASE_URL.to_owned()),
            cors_origins: if cors_origins.is_empty() {
                DEFAULT_CORS_ORIGINS.map(str::to_owned).to_vec()
            } else {
                cors_origins
            },
            production,
            node_env,
            app_url: strip_trailing_slashes(&app_url),
            public_url: var("PUBLIC_URL").map(|u| strip_trailing_slashes(&u)),
            mcp_url: var("MCP_URL"),
            trust_proxy,
            encryption: EncryptionConfig {
                key: env_with_legacy(&get, "TRAMA_ENCRYPTION_KEY", "NABLA_ENCRYPTION_KEY")
                    .or_else(|| get("SECRETS_KEY"))
                    .map(Secret),
                legacy_secrets_key: get("SECRETS_KEY").map(Secret),
            },
            mail: MailConfig {
                smtp_url: var("SMTP_URL").map(Secret),
                from: var("MAIL_FROM").unwrap_or_else(|| DEFAULT_MAIL_FROM.to_owned()),
            },
            ai: AiConfig {
                api_url: trimmed("AI_API_URL"),
                api_key: trimmed("AI_API_KEY").map(Secret),
                model: trimmed("AI_MODEL"),
                max_writes_per_day: max_writes_per_day(
                    get("AI_ASSISTANT_MAX_WRITES_PER_DAY").as_deref(),
                ),
            },
            grok: GrokConfig {
                cli_path: var("GROK_CLI_PATH").unwrap_or_else(|| "grok".to_owned()),
                home_dir: var("GROK_HOME_DIR"),
            },
            push: PushConfig {
                vapid_public_key: var("VAPID_PUBLIC_KEY"),
                vapid_private_key: var("VAPID_PRIVATE_KEY").map(Secret),
                vapid_subject: var("VAPID_SUBJECT")
                    .unwrap_or_else(|| DEFAULT_VAPID_SUBJECT.to_owned()),
            },
            rate_limit: rate_limit_config(&get),
            outbound: outbound_policy(&get, production),
            seed: SeedConfig {
                demo: !production && get("SEED_DEMO").as_deref() != Some("false"),
                mock_history: get("SEED_MOCK_HISTORY").as_deref() != Some("false"),
            },
            demo_login: demo_login(var("DEMO_LOGIN"), production),
            public_views: PublicViews {
                roadmap_view_token: var("PUBLIC_ROADMAP_VIEW_TOKEN"),
                changelog_view_token: var("PUBLIC_CHANGELOG_VIEW_TOKEN"),
            },
            admin_reset_enabled: !production
                && get("TRAMA_ENABLE_ADMIN_RESET").as_deref() == Some("true"),
            import_runner_enabled: get("TRAMA_IMPORT_RUNNER").as_deref() != Some("off"),
            sse_recheck_ms: get("TRAMA_SSE_RECHECK_MS")
                .as_deref()
                .and_then(js_number)
                .filter(|n| n.fract() == 0.0 && *n >= 100.0)
                .map_or(DEFAULT_SSE_RECHECK_MS, ms_from_f64),
            webhook_retry_ms: env_with_legacy(
                &get,
                "TRAMA_WEBHOOK_RETRY_MS",
                "NABLA_WEBHOOK_RETRY_MS",
            )
            .map_or(DEFAULT_WEBHOOK_RETRY_MS, |raw| js_number(&raw).map_or(0, ms_from_f64)),
        })
    }
}

/// Reads `name` and falls back to the deprecated `legacy` name from before the product was
/// renamed, as the NestJS `envWithLegacy` does: an empty value counts as unset, but when neither
/// is set to something the (possibly empty) current value is returned. Using the legacy name logs
/// a deprecation warning once per variable.
pub fn env_with_legacy(
    get: &impl Fn(&str) -> Option<String>,
    name: &str,
    legacy: &str,
) -> Option<String> {
    static WARNED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    let current = get(name);
    if current.as_deref().is_some_and(|v| !v.is_empty()) {
        return current;
    }
    let Some(old) = get(legacy).filter(|v| !v.is_empty()) else { return current };
    if let Ok(mut warned) = WARNED.lock()
        && warned.get_or_insert_with(HashSet::new).insert(legacy.to_owned())
    {
        tracing::warn!("{legacy} is deprecated: rename it to {name}.");
    }
    Some(old)
}

fn strip_trailing_slashes(url: &str) -> String {
    url.trim_end_matches('/').to_owned()
}

fn rate_limit_config(get: &impl Fn(&str) -> Option<String>) -> RateLimitConfig {
    let flag = get("TRAMA_RATE_LIMIT_ENABLED").map(|v| v.trim().to_lowercase());
    RateLimitConfig {
        enabled: match flag.as_deref() {
            Some("true") => true,
            Some("false") => false,
            _ => get("NODE_ENV").as_deref() != Some("test"),
        },
        login_per_15min: positive_int(get("TRAMA_RATE_LIMIT_LOGIN_PER_15MIN").as_deref(), 10),
        signup_per_hour: positive_int(get("TRAMA_RATE_LIMIT_SIGNUP_PER_HOUR").as_deref(), 10),
        invite_per_15min: positive_int(get("TRAMA_RATE_LIMIT_INVITE_PER_15MIN").as_deref(), 30),
        public_view_per_min: positive_int(
            get("TRAMA_RATE_LIMIT_PUBLIC_VIEW_PER_MIN").as_deref(),
            30,
        ),
        credentials_per_hour: positive_int(
            get("TRAMA_RATE_LIMIT_CREDENTIALS_PER_HOUR").as_deref(),
            30,
        ),
        global_per_min: positive_int(get("TRAMA_RATE_LIMIT_GLOBAL_PER_MIN").as_deref(), 1200),
    }
}

fn outbound_policy(get: &impl Fn(&str) -> Option<String>, production: bool) -> OutboundPolicy {
    OutboundPolicy {
        allow_private: env_with_legacy(
            get,
            "TRAMA_OUTBOUND_ALLOW_PRIVATE",
            "NABLA_ALLOW_PRIVATE_WEBHOOKS",
        )
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("true")),
        allowed_hosts: get("TRAMA_OUTBOUND_ALLOWED_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(|h| {
                let h = h.trim().to_lowercase();
                let h = h.strip_prefix('[').unwrap_or(&h);
                h.strip_suffix(']').unwrap_or(h).to_owned()
            })
            .filter(|h| !h.is_empty())
            .collect(),
        require_https: production,
    }
}

/// The NestJS `intEnv`: a positive integer, else `fallback`.
fn positive_int(raw: Option<&str>, fallback: u32) -> u32 {
    let Some(raw) = raw.filter(|r| !r.trim().is_empty()) else { return fallback };
    match js_number(raw) {
        Some(n) if n.fract() == 0.0 && n > 0.0 => {
            if n >= f64::from(u32::MAX) {
                u32::MAX
            } else {
                // in range and integral, checked above
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let v = n as u32;
                v
            }
        }
        _ => fallback,
    }
}

/// `Math.max(1, Number(raw) || 200)`, rounded up to a whole number of writes.
fn max_writes_per_day(raw: Option<&str>) -> u32 {
    let n = raw.and_then(js_number).filter(|n| *n != 0.0);
    let Some(n) = n else { return DEFAULT_AI_MAX_WRITES_PER_DAY };
    if n <= 1.0 {
        1
    } else if n >= f64::from(u32::MAX) {
        u32::MAX
    } else {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let v = n.ceil() as u32;
        v
    }
}

fn ms_from_f64(n: f64) -> u64 {
    if n <= 0.0 {
        0
    } else if n >= 9.0e15 {
        9_000_000_000_000_000
    } else {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let v = n as u64;
        v
    }
}

/// JavaScript's `Number(string)` for the inputs a variable can hold: surrounding whitespace is
/// ignored, an empty string is 0, and anything that is not a decimal or `0x` number is `None`
/// (`NaN`).
#[must_use]
pub fn js_number(raw: &str) -> Option<f64> {
    let s = raw.trim();
    if s.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok().map(|v| {
            #[allow(clippy::cast_precision_loss)]
            let f = v as f64;
            f
        });
    }
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    if unsigned == "Infinity" {
        return Some(if s.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    if !unsigned
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return None;
    }
    s.parse::<f64>().ok().filter(|n| !n.is_nan())
}

/// `DEMO_LOGIN`: 1/true/yes/on or 0/false/no/off; otherwise shown outside production.
fn demo_login(raw: Option<String>, production: bool) -> bool {
    match raw.map(|r| r.to_lowercase()).as_deref() {
        Some("1" | "true" | "yes" | "on") => true,
        Some("0" | "false" | "no" | "off") => false,
        _ => !production,
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
        assert_eq!(cfg.app_url, "http://localhost:4300");
        assert_eq!(cfg.public_url, None);
        assert_eq!(cfg.trust_proxy, TrustProxy::None);
        assert_eq!(cfg.mail, MailConfig { smtp_url: None, from: DEFAULT_MAIL_FROM.into() });
        assert_eq!(cfg.ai.max_writes_per_day, 200);
        assert_eq!(cfg.ai.model, None);
        assert_eq!(cfg.grok.cli_path, "grok");
        assert_eq!(cfg.push.vapid_subject, DEFAULT_VAPID_SUBJECT);
        assert!(cfg.rate_limit.enabled);
        assert_eq!(cfg.rate_limit.login_per_15min, 10);
        assert_eq!(cfg.rate_limit.global_per_min, 1200);
        assert_eq!(cfg.outbound, OutboundPolicy::default());
        assert!(cfg.seed.demo && cfg.seed.mock_history);
        assert!(cfg.demo_login);
        assert_eq!(cfg.public_views, PublicViews::default());
        assert!(!cfg.admin_reset_enabled);
        assert!(cfg.import_runner_enabled);
        assert_eq!(cfg.sse_recheck_ms, 30_000);
        assert_eq!(cfg.webhook_retry_ms, 2_000);
        assert_eq!(cfg.encryption, EncryptionConfig::default());
    }

    #[test]
    fn empty_values_count_as_unset() {
        let cfg = config(&[("PORT", " "), ("DATABASE_URL", ""), ("CORS_ORIGIN", " , ")]).unwrap();
        assert_eq!(cfg.port, 3000);
        assert_eq!(cfg.database_url, DEFAULT_DATABASE_URL);
        assert_eq!(cfg.cors_origins.len(), DEFAULT_CORS_ORIGINS.len());
        assert_eq!(cfg.app_url, "http://localhost:4300");
    }

    #[test]
    fn reads_values() {
        let cfg = config(&[
            ("PORT", "3100"),
            ("CORS_ORIGIN", "https://a.dev/, https://b.dev"),
            ("NODE_ENV", "production"),
            ("PUBLIC_URL", "https://api.dev//"),
            ("SMTP_URL", " smtp://u:p@mail "),
            ("MAIL_FROM", "Me <me@a.dev>"),
            ("TRAMA_SSE_RECHECK_MS", "50"),
        ])
        .unwrap();
        assert_eq!(cfg.port, 3100);
        assert_eq!(cfg.cors_origins, ["https://a.dev/", "https://b.dev"]);
        assert!(cfg.production);
        assert_eq!(cfg.app_url, "https://a.dev");
        assert_eq!(cfg.public_url.as_deref(), Some("https://api.dev"));
        assert_eq!(cfg.mail.smtp_url.as_ref().map(Secret::expose), Some("smtp://u:p@mail"));
        assert_eq!(cfg.mail.from, "Me <me@a.dev>");
        assert_eq!(cfg.sse_recheck_ms, 30_000);
        assert!(cfg.outbound.require_https);
        assert!(!cfg.demo_login);
        assert!(!cfg.seed.demo);
        assert!(format!("{cfg:?}").contains("[redacted]"));
        assert!(!format!("{cfg:?}").contains("u:p@mail"));
    }

    #[test]
    fn app_url_prefers_app_url_then_the_first_raw_origin() {
        assert_eq!(config(&[("APP_URL", "https://app.dev/")]).unwrap().app_url, "https://app.dev");
        // the first entry is empty: the default origin, as `split(',')[0] || DEFAULT` does
        let cfg = config(&[("CORS_ORIGIN", ",https://b.dev")]).unwrap();
        assert_eq!(cfg.app_url, "http://localhost:4300");
        assert_eq!(cfg.cors_origins, ["https://b.dev"]);
    }

    #[test]
    fn rejects_a_bad_port() {
        assert!(matches!(config(&[("PORT", "http")]), Err(ConfigError::InvalidPort(_))));
    }

    #[test]
    fn encryption_key_follows_env_with_legacy() {
        let key = |vars: &[(&str, &str)]| {
            config(vars).unwrap().encryption.key.map(|s| s.expose().to_owned())
        };
        assert_eq!(key(&[("TRAMA_ENCRYPTION_KEY", "a"), ("SECRETS_KEY", "c")]), Some("a".into()));
        assert_eq!(key(&[("NABLA_ENCRYPTION_KEY", "b"), ("SECRETS_KEY", "c")]), Some("b".into()));
        assert_eq!(key(&[("SECRETS_KEY", "c")]), Some("c".into()));
        // an empty current name without a legacy value wins over SECRETS_KEY (`"" ?? x` is "")
        assert_eq!(key(&[("TRAMA_ENCRYPTION_KEY", ""), ("SECRETS_KEY", "c")]), Some(String::new()));
        assert_eq!(
            key(&[("TRAMA_ENCRYPTION_KEY", ""), ("NABLA_ENCRYPTION_KEY", "b")]),
            Some("b".into())
        );
        assert_eq!(key(&[]), None);
        let cfg = config(&[("SECRETS_KEY", " raw ")]).unwrap();
        assert_eq!(cfg.encryption.legacy_secrets_key.unwrap().expose(), " raw ");
    }

    #[test]
    fn rate_limit_settings() {
        assert!(!config(&[("NODE_ENV", "test")]).unwrap().rate_limit.enabled);
        assert!(config(&[("NODE_ENV", "production")]).unwrap().rate_limit.enabled);
        let forced = config(&[("NODE_ENV", "test"), ("TRAMA_RATE_LIMIT_ENABLED", "TRUE")]).unwrap();
        assert!(forced.rate_limit.enabled);
        let off =
            config(&[("NODE_ENV", "production"), ("TRAMA_RATE_LIMIT_ENABLED", "false")]).unwrap();
        assert!(!off.rate_limit.enabled);
        let cfg = config(&[
            ("TRAMA_RATE_LIMIT_LOGIN_PER_15MIN", "3"),
            ("TRAMA_RATE_LIMIT_SIGNUP_PER_HOUR", "0"),
            ("TRAMA_RATE_LIMIT_INVITE_PER_15MIN", "2.5"),
            ("TRAMA_RATE_LIMIT_GLOBAL_PER_MIN", "lots"),
        ])
        .unwrap();
        assert_eq!(cfg.rate_limit.login_per_15min, 3);
        assert_eq!(cfg.rate_limit.signup_per_hour, 10);
        assert_eq!(cfg.rate_limit.invite_per_15min, 30);
        assert_eq!(cfg.rate_limit.global_per_min, 1200);
    }

    #[test]
    fn outbound_policy_from_env() {
        for node_env in ["development", "test", "production", ""] {
            let cfg = config(&[("NODE_ENV", node_env)]).unwrap();
            assert!(!cfg.outbound.allow_private);
            assert!(cfg.outbound.allowed_hosts.is_empty());
        }
        let allow = |vars: &[(&str, &str)]| config(vars).unwrap().outbound.allow_private;
        assert!(allow(&[("TRAMA_OUTBOUND_ALLOW_PRIVATE", "true")]));
        assert!(!allow(&[("TRAMA_OUTBOUND_ALLOW_PRIVATE", "yes")]));
        assert!(allow(&[("NABLA_ALLOW_PRIVATE_WEBHOOKS", "true")]));
        let cfg =
            config(&[("TRAMA_OUTBOUND_ALLOWED_HOSTS", " Git.Corp, *.Ci.Corp ,[::1]")]).unwrap();
        assert_eq!(cfg.outbound.allowed_hosts, ["git.corp", "*.ci.corp", "::1"]);
    }

    #[test]
    fn demo_login_and_public_views() {
        for value in ["1", "true", "TRUE", "yes", "on"] {
            assert!(
                config(&[("NODE_ENV", "production"), ("DEMO_LOGIN", value)]).unwrap().demo_login
            );
        }
        for value in ["0", "false", "FALSE", "no", "off"] {
            assert!(
                !config(&[("NODE_ENV", "development"), ("DEMO_LOGIN", value)]).unwrap().demo_login
            );
        }
        assert!(!config(&[("NODE_ENV", "production"), ("DEMO_LOGIN", "  ")]).unwrap().demo_login);
        assert!(config(&[("NODE_ENV", "development")]).unwrap().demo_login);
        let cfg = config(&[
            ("PUBLIC_ROADMAP_VIEW_TOKEN", " roadmap-token "),
            ("PUBLIC_CHANGELOG_VIEW_TOKEN", " "),
        ])
        .unwrap();
        assert_eq!(cfg.public_views.roadmap_view_token.as_deref(), Some("roadmap-token"));
        assert_eq!(cfg.public_views.changelog_view_token, None);
    }

    #[test]
    fn flags_compare_the_raw_value() {
        let cfg = config(&[
            ("SEED_DEMO", "false"),
            ("SEED_MOCK_HISTORY", "FALSE"),
            ("TRAMA_ENABLE_ADMIN_RESET", "true"),
            ("TRAMA_IMPORT_RUNNER", "off"),
        ])
        .unwrap();
        assert!(!cfg.seed.demo);
        assert!(cfg.seed.mock_history);
        assert!(cfg.admin_reset_enabled);
        assert!(!cfg.import_runner_enabled);
        let prod = config(&[("NODE_ENV", "production"), ("TRAMA_ENABLE_ADMIN_RESET", "true")]);
        assert!(!prod.unwrap().admin_reset_enabled);
        assert!(!config(&[("TRAMA_ENABLE_ADMIN_RESET", "TRUE")]).unwrap().admin_reset_enabled);
    }

    #[test]
    fn ai_settings_keep_empty_values() {
        let cfg = config(&[("AI_MODEL", " "), ("AI_ASSISTANT_MAX_WRITES_PER_DAY", "0")]).unwrap();
        assert_eq!(cfg.ai.model.as_deref(), Some(""));
        assert_eq!(cfg.ai.max_writes_per_day, 200);
        let max = |raw: &str| {
            config(&[("AI_ASSISTANT_MAX_WRITES_PER_DAY", raw)]).unwrap().ai.max_writes_per_day
        };
        assert_eq!(max("5"), 5);
        assert_eq!(max("-3"), 1);
        assert_eq!(max("x"), 200);
        assert_eq!(max("2.5"), 3);
    }

    #[test]
    fn numbers_parse_like_javascript() {
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(js_number(" 12 "), Some(12.0));
        assert_eq!(js_number("0x10"), Some(16.0));
        assert_eq!(js_number("1e3"), Some(1000.0));
        assert_eq!(js_number("12px"), None);
        assert_eq!(js_number("inf"), None);
        let retry = |vars: &[(&str, &str)]| config(vars).unwrap().webhook_retry_ms;
        assert_eq!(retry(&[("TRAMA_WEBHOOK_RETRY_MS", "50")]), 50);
        assert_eq!(retry(&[("NABLA_WEBHOOK_RETRY_MS", "70")]), 70);
        assert_eq!(retry(&[("TRAMA_WEBHOOK_RETRY_MS", "")]), 0);
    }

    #[test]
    fn trust_proxy_values() {
        assert_eq!(TrustProxy::parse(None), Ok(TrustProxy::None));
        assert_eq!(TrustProxy::parse(Some(" ")), Ok(TrustProxy::None));
        assert_eq!(TrustProxy::parse(Some("true")), Ok(TrustProxy::All));
        assert_eq!(TrustProxy::parse(Some("false")), Ok(TrustProxy::None));
        assert_eq!(TrustProxy::parse(Some("1")), Ok(TrustProxy::Hops(1)));
        let list = TrustProxy::parse(Some("loopback, 10.0.0.0/8")).unwrap();
        assert!(list.trusts("127.0.0.1", 0));
        assert!(list.trusts("::1", 3));
        assert!(list.trusts("::ffff:10.1.2.3", 0));
        assert!(!list.trusts("11.0.0.1", 0));
        assert!(!list.trusts("not-an-ip", 0));
        let mask = TrustProxy::parse(Some("192.168.0.0/255.255.0.0, fc00::/7")).unwrap();
        assert!(mask.trusts("192.168.4.4", 0));
        assert!(mask.trusts("fd12::1", 0));
        assert!(TrustProxy::parse(Some("loopback, nonsense")).is_err());
        assert!(matches!(
            config(&[("TRAMA_TRUST_PROXY", "10.0.0.0/33")]),
            Err(ConfigError::InvalidTrustProxy(_))
        ));
        assert!(TrustProxy::Hops(2).trusts("x", 1));
        assert!(!TrustProxy::Hops(2).trusts("x", 2));
        assert!(!TrustProxy::Hops(0).trusts("x", 0));
    }
}
