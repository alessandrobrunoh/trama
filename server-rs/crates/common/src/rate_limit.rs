//! Per-IP request limits, the port of `server/src/common/rate-limit.ts`.
//!
//! A request is counted in the first strict rule it matches (login, signup, invites, public
//! views, credential creation) *and* in the generous global one. Over a limit the API answers
//! 429 with `Retry-After`. Counters live in memory (one API process; a restart forgets them).
//! Limits come from `Config::rate_limit`; the client address honours `TRAMA_TRUST_PROXY`.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use indexmap::IndexMap;
use trama_core::config::{RateLimitConfig, TrustProxy};
use trama_core::{AppError, Config};

use crate::proxy::{client_ip, socket_addr};

const MINUTE: u64 = 60_000;
const HOUR: u64 = 60 * MINUTE;
const SWEEP_BUDGET: usize = 64;

/// The outcome of counting one request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateLimitResult {
    /// Under the limit.
    pub allowed: bool,
    /// Requests left in the window.
    pub remaining: u32,
    /// Whole seconds until the window resets (at least 1).
    pub retry_after_sec: u64,
}

#[derive(Debug)]
struct Bucket {
    count: u32,
    reset_at: u64,
}

#[derive(Debug)]
struct Buckets {
    map: IndexMap<String, Bucket>,
    last_sweep: u64,
    cursor: usize,
}

/// Fixed-window counters held in memory, at most `max_buckets` of them.
#[derive(Debug)]
pub struct RateLimiter {
    buckets: Mutex<Buckets>,
    max_buckets: usize,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new(100_000)
    }
}

impl RateLimiter {
    /// A limiter holding at most `max_buckets` counters; a new key is refused when it is full
    /// (live counters are never evicted).
    #[must_use]
    pub fn new(max_buckets: usize) -> Self {
        Self {
            buckets: Mutex::new(Buckets { map: IndexMap::new(), last_sweep: 0, cursor: 0 }),
            max_buckets,
        }
    }

    /// Counts one request for `key` at `now` (milliseconds on any monotonic clock).
    pub fn hit(&self, key: &str, limit: u32, window_ms: u64, now: u64) -> RateLimitResult {
        let mut b = self.buckets.lock().unwrap_or_else(PoisonError::into_inner);
        Self::sweep(&mut b, now);
        if !b.map.contains_key(key) && b.map.len() >= self.max_buckets {
            return RateLimitResult { allowed: false, remaining: 0, retry_after_sec: 1 };
        }
        let fresh = Bucket { count: 0, reset_at: now + window_ms };
        let bucket = b.map.entry(key.to_owned()).or_insert(fresh);
        if bucket.reset_at <= now {
            *bucket = Bucket { count: 0, reset_at: now + window_ms };
        }
        bucket.count += 1;
        let retry_after_sec = (bucket.reset_at - now).div_ceil(1000).max(1);
        RateLimitResult {
            allowed: bucket.count <= limit,
            remaining: limit.saturating_sub(bucket.count),
            retry_after_sec,
        }
    }

    /// Number of counters held.
    #[must_use]
    pub fn len(&self) -> usize {
        self.buckets.lock().unwrap_or_else(PoisonError::into_inner).map.len()
    }

    /// `true` when no counter is held.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Checks a bounded number of entries per second; live counters are never evicted.
    fn sweep(b: &mut Buckets, now: u64) {
        if now.saturating_sub(b.last_sweep) < 1000 {
            return;
        }
        b.last_sweep = now;
        for _ in 0..SWEEP_BUDGET {
            if b.cursor >= b.map.len() {
                b.cursor = 0;
                break;
            }
            if b.map[b.cursor].reset_at <= now {
                // the last entry moves into this slot and is checked next
                b.map.swap_remove_index(b.cursor);
            } else {
                b.cursor += 1;
            }
        }
    }
}

/// One counting window: at most `limit` requests per `window_ms`, per client address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateLimitRule {
    /// Bucket name: every rule counts separately, so a busy API does not lock a user out of
    /// logging in.
    pub name: &'static str,
    /// Only this method, or any.
    pub method: Option<Method>,
    /// Matches the request path (`/api/...`).
    pub path: PathPattern,
    /// Requests allowed per window.
    pub limit: u32,
    /// Window length in milliseconds.
    pub window_ms: u64,
}

/// The paths the NestJS rules match with regular expressions; a trailing slash is allowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathPattern {
    /// `^/api/auth/login/?$`
    Login,
    /// `^/api/auth/signup/?$`
    Signup,
    /// `^/api/invites/[^/]+(/accept)?/?$`
    Invite,
    /// `^/api/public/views/[^/]+/?$`
    PublicView,
    /// `^/api/w/[^/]+/(tokens|agents)/?$`
    Credentials,
    /// `^/api(/|$)`
    Api,
}

impl PathPattern {
    /// Whether `path` matches.
    #[must_use]
    pub fn matches(self, path: &str) -> bool {
        if self == Self::Api {
            return path == "/api" || path.starts_with("/api/");
        }
        let trimmed = path.strip_suffix('/').unwrap_or(path);
        let Some(rest) = trimmed.strip_prefix("/api/") else { return false };
        let segs: Vec<&str> = rest.split('/').collect();
        let named = |s: &str| !s.is_empty();
        match self {
            Self::Login => segs == ["auth", "login"],
            Self::Signup => segs == ["auth", "signup"],
            Self::Invite => {
                matches!(segs.as_slice(), ["invites", t] | ["invites", t, "accept"] if named(t))
            }
            Self::PublicView => matches!(segs.as_slice(), ["public", "views", t] if named(t)),
            Self::Credentials => {
                matches!(segs.as_slice(), ["w", slug, "tokens" | "agents"] if named(slug))
            }
            Self::Api => unreachable!("handled above"),
        }
    }
}

/// The strict rules and the global rule for `config`.
#[must_use]
pub fn rate_limit_rules(config: &RateLimitConfig) -> (Vec<RateLimitRule>, RateLimitRule) {
    let rule = |name, method, path, limit, window_ms| RateLimitRule {
        name,
        method,
        path,
        limit,
        window_ms,
    };
    let strict = vec![
        rule("login", Some(Method::POST), PathPattern::Login, config.login_per_15min, 15 * MINUTE),
        rule("signup", Some(Method::POST), PathPattern::Signup, config.signup_per_hour, HOUR),
        rule("invite", None, PathPattern::Invite, config.invite_per_15min, 15 * MINUTE),
        rule(
            "public-view",
            Some(Method::GET),
            PathPattern::PublicView,
            config.public_view_per_min,
            MINUTE,
        ),
        // token and agent creation mint credentials
        rule(
            "credentials",
            Some(Method::POST),
            PathPattern::Credentials,
            config.credentials_per_hour,
            HOUR,
        ),
    ];
    (strict, rule("global", None, PathPattern::Api, config.global_per_min, MINUTE))
}

/// Shared state of the middleware.
#[derive(Debug)]
pub struct RateLimitState {
    limiter: RateLimiter,
    strict: Vec<RateLimitRule>,
    global: RateLimitRule,
    enabled: bool,
    trust: TrustProxy,
    started: Instant,
}

impl RateLimitState {
    /// Middleware state for `config` with a fresh limiter.
    #[must_use]
    pub fn new(config: &Config) -> Self {
        Self::with_limiter(config, RateLimiter::default())
    }

    /// Middleware state for `config` counting in `limiter`.
    #[must_use]
    pub fn with_limiter(config: &Config, limiter: RateLimiter) -> Self {
        let (strict, global) = rate_limit_rules(&config.rate_limit);
        Self {
            limiter,
            strict,
            global,
            enabled: config.rate_limit.enabled,
            trust: config.trust_proxy.clone(),
            started: Instant::now(),
        }
    }

    fn now(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// Adds the rate limiter for `config` to `router`.
pub fn layer<S: Clone + Send + Sync + 'static>(router: Router<S>, config: &Config) -> Router<S> {
    with_state(router, Arc::new(RateLimitState::new(config)))
}

/// Adds the rate limiter with explicit state to `router` (tests use their own limiter).
pub fn with_state<S: Clone + Send + Sync + 'static>(
    router: Router<S>,
    state: Arc<RateLimitState>,
) -> Router<S> {
    router.layer(middleware::from_fn_with_state(state, limit_requests))
}

async fn limit_requests(
    State(state): State<Arc<RateLimitState>>,
    req: Request,
    next: Next,
) -> Response {
    if !state.enabled || req.method() == Method::OPTIONS {
        return next.run(req).await;
    }
    let path = req.uri().path();
    let ip = client_ip(&state.trust, socket_addr(req.extensions()), req.headers());
    let strict = state
        .strict
        .iter()
        .find(|r| r.method.as_ref().is_none_or(|m| m == req.method()) && r.path.matches(path));
    let global = state.global.path.matches(path).then_some(&state.global);
    let now = state.now();
    for rule in [strict, global].into_iter().flatten() {
        let r = state.limiter.hit(&format!("{}:{ip}", rule.name), rule.limit, rule.window_ms, now);
        if !r.allowed {
            let mut res =
                AppError::new(StatusCode::TOO_MANY_REQUESTS, "Too many requests, retry later")
                    .into_response();
            res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(r.retry_after_sec));
            return res;
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::routing::any;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[test]
    fn counts_within_a_window_and_starts_over_after_it() {
        let l = RateLimiter::default();
        assert!(l.hit("k", 2, 1000, 0).allowed);
        assert!(l.hit("k", 2, 1000, 10).allowed);
        assert_eq!(
            l.hit("k", 2, 1000, 500),
            RateLimitResult { allowed: false, remaining: 0, retry_after_sec: 1 }
        );
        assert!(l.hit("k", 2, 1000, 1000).allowed);
    }

    #[test]
    fn keeps_keys_apart_and_rounds_retry_after_up() {
        let l = RateLimiter::default();
        l.hit("a", 1, 60_000, 0);
        let r = l.hit("a", 1, 60_000, 1_500);
        assert!(!r.allowed);
        assert_eq!(r.retry_after_sec, 59);
        assert!(l.hit("b", 1, 60_000, 1_500).allowed);
    }

    #[test]
    fn rejects_new_keys_at_capacity_without_evicting() {
        let l = RateLimiter::new(3);
        for i in 0..3 {
            l.hit(&format!("k{i}"), 1, 60_000, 0);
        }
        let r = l.hit("overflow", 1, 60_000, 1);
        assert!(!r.allowed);
        assert_eq!(r.remaining, 0);
        assert!(!l.hit("k0", 1, 60_000, 2).allowed);
        assert_eq!(l.len(), 3);
    }

    #[test]
    fn cleans_expired_entries_and_reuses_capacity() {
        let l = RateLimiter::new(3);
        l.hit("expired", 1, 1, 0);
        l.hit("active-a", 1, 60_000, 0);
        l.hit("active-b", 1, 60_000, 0);
        assert!(l.hit("new", 1, 60_000, 1000).allowed);
        assert!(!l.hit("active-a", 1, 60_000, 1001).allowed);
    }

    #[test]
    fn bounds_cleanup_work_when_every_bucket_is_live() {
        let l = RateLimiter::new(100_000);
        for i in 0..100_000 {
            l.hit(&format!("k{i}"), 1, 60_000, 0);
        }
        let start = Instant::now();
        l.hit("k99999", 1, 60_000, 1000);
        assert!(start.elapsed().as_millis() < 100);
        assert_eq!(l.len(), 100_000);
    }

    #[test]
    fn paths_match_like_the_nest_patterns() {
        assert!(PathPattern::Login.matches("/api/auth/login"));
        assert!(PathPattern::Login.matches("/api/auth/login/"));
        assert!(!PathPattern::Login.matches("/api/auth/login/x"));
        assert!(PathPattern::Invite.matches("/api/invites/tok"));
        assert!(PathPattern::Invite.matches("/api/invites/tok/accept/"));
        assert!(!PathPattern::Invite.matches("/api/invites/"));
        assert!(!PathPattern::Invite.matches("/api/invites/tok/decline"));
        assert!(PathPattern::PublicView.matches("/api/public/views/abc"));
        assert!(PathPattern::Credentials.matches("/api/w/acme/agents"));
        assert!(!PathPattern::Credentials.matches("/api/w/acme/agents/1"));
        assert!(PathPattern::Api.matches("/api"));
        assert!(PathPattern::Api.matches("/api/x"));
        assert!(!PathPattern::Api.matches("/apix"));
    }

    fn app(vars: &[(&str, &str)]) -> Router {
        let config = Config::from_vars(vars);
        let router = Router::new().fallback(any(|| async { "ok" }));
        with_state(router, Arc::new(RateLimitState::with_limiter(&config, RateLimiter::default())))
    }

    async fn call(app: &Router, method: Method, path: &str, xff: Option<&str>) -> Response {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(xff) = xff {
            req = req.header("x-forwarded-for", xff);
        }
        let mut req = req.body(Body::empty()).unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 5000))));
        app.clone().oneshot(req).await.unwrap()
    }

    async fn status(app: &Router, method: Method, path: &str) -> StatusCode {
        call(app, method, path, None).await.status()
    }

    #[tokio::test]
    async fn answers_429_with_retry_after_on_login() {
        let app = app(&[("TRAMA_RATE_LIMIT_LOGIN_PER_15MIN", "3")]);
        for _ in 0..3 {
            assert_eq!(status(&app, Method::POST, "/api/auth/login").await, StatusCode::OK);
        }
        let res = call(&app, Method::POST, "/api/auth/login", None).await;
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        let retry: u64 = res.headers()[header::RETRY_AFTER].to_str().unwrap().parse().unwrap();
        assert!(retry > 0);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"statusCode": 429, "error": "Too Many Requests", "message": "Too many requests, retry later"})
        );
    }

    #[tokio::test]
    async fn limits_public_views_but_not_other_reads() {
        let app = app(&[("TRAMA_RATE_LIMIT_PUBLIC_VIEW_PER_MIN", "2")]);
        assert_eq!(status(&app, Method::GET, "/api/public/views/abc").await, StatusCode::OK);
        assert_eq!(status(&app, Method::GET, "/api/public/views/def").await, StatusCode::OK);
        assert_eq!(
            status(&app, Method::GET, "/api/public/views/ghi").await,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(status(&app, Method::GET, "/api/w/acme/issues").await, StatusCode::OK);
    }

    #[tokio::test]
    async fn limits_signup_invites_and_tokens_separately() {
        let app = app(&[
            ("TRAMA_RATE_LIMIT_SIGNUP_PER_HOUR", "1"),
            ("TRAMA_RATE_LIMIT_INVITE_PER_15MIN", "1"),
            ("TRAMA_RATE_LIMIT_CREDENTIALS_PER_HOUR", "1"),
        ]);
        let many = StatusCode::TOO_MANY_REQUESTS;
        assert_eq!(status(&app, Method::POST, "/api/auth/signup").await, StatusCode::OK);
        assert_eq!(status(&app, Method::POST, "/api/auth/signup").await, many);
        assert_eq!(status(&app, Method::GET, "/api/invites/tok").await, StatusCode::OK);
        assert_eq!(status(&app, Method::POST, "/api/invites/tok/accept").await, many);
        assert_eq!(status(&app, Method::POST, "/api/w/acme/tokens").await, StatusCode::OK);
        assert_eq!(status(&app, Method::POST, "/api/w/acme/tokens").await, many);
        // listing tokens is not credential creation
        assert_eq!(status(&app, Method::GET, "/api/w/acme/tokens").await, StatusCode::OK);
        // login has its own bucket and was never used
        assert_eq!(status(&app, Method::POST, "/api/auth/login").await, StatusCode::OK);
    }

    #[tokio::test]
    async fn applies_the_global_limit_under_api() {
        let app = app(&[("TRAMA_RATE_LIMIT_GLOBAL_PER_MIN", "3")]);
        for _ in 0..3 {
            assert_eq!(status(&app, Method::GET, "/api/w/acme/issues").await, StatusCode::OK);
        }
        let res = call(&app, Method::GET, "/api/w/acme/issues", None).await;
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(res.headers().contains_key(header::RETRY_AFTER));
        // outside /api nothing is counted
        assert_eq!(status(&app, Method::GET, "/other").await, StatusCode::OK);
    }

    #[tokio::test]
    async fn defaults_are_generous_globally_and_strict_on_login() {
        let app = app(&[]);
        for _ in 0..10 {
            assert_eq!(status(&app, Method::POST, "/api/auth/login").await, StatusCode::OK);
        }
        assert_eq!(
            status(&app, Method::POST, "/api/auth/login").await,
            StatusCode::TOO_MANY_REQUESTS
        );
        for _ in 0..20 {
            assert_eq!(status(&app, Method::GET, "/api/w/acme/issues").await, StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn counts_clients_by_forwarded_for_when_the_proxy_is_trusted() {
        let app = app(&[("TRAMA_RATE_LIMIT_LOGIN_PER_15MIN", "1"), ("TRAMA_TRUST_PROXY", "1")]);
        let login = |xff| call(&app, Method::POST, "/api/auth/login", Some(xff));
        assert_eq!(login("1.1.1.1").await.status(), StatusCode::OK);
        assert_eq!(login("1.1.1.1").await.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(login("2.2.2.2").await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn ignores_forwarded_for_when_the_proxy_is_not_trusted() {
        let app = app(&[("TRAMA_RATE_LIMIT_LOGIN_PER_15MIN", "1")]);
        let login = |xff| call(&app, Method::POST, "/api/auth/login", Some(xff));
        assert_eq!(login("1.1.1.1").await.status(), StatusCode::OK);
        assert_eq!(login("2.2.2.2").await.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn does_nothing_when_disabled_and_never_counts_preflights() {
        let off = app(&[
            ("TRAMA_RATE_LIMIT_ENABLED", "false"),
            ("TRAMA_RATE_LIMIT_LOGIN_PER_15MIN", "1"),
        ]);
        for _ in 0..5 {
            assert_eq!(status(&off, Method::POST, "/api/auth/login").await, StatusCode::OK);
        }
        let on = app(&[("TRAMA_RATE_LIMIT_LOGIN_PER_15MIN", "1")]);
        for _ in 0..5 {
            assert_eq!(status(&on, Method::OPTIONS, "/api/auth/login").await, StatusCode::OK);
        }
        assert_eq!(status(&on, Method::POST, "/api/auth/login").await, StatusCode::OK);
        let test_env = app(&[("NODE_ENV", "test"), ("TRAMA_RATE_LIMIT_LOGIN_PER_15MIN", "1")]);
        for _ in 0..3 {
            assert_eq!(status(&test_env, Method::POST, "/api/auth/login").await, StatusCode::OK);
        }
    }
}
