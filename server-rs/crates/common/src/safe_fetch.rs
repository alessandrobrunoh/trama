//! The one outbound HTTP path for URLs a user (not the operator) can choose: outgoing webhooks,
//! Web Push endpoints and integration base URLs (self-hosted GitHub / GitLab / Delta). A port of
//! `server/src/common/safe-fetch.ts` with the same rules and messages.
//!
//! Defence against SSRF, in every environment:
//!
//! * only http(s); https only in production; no credentials in the URL;
//! * the host is resolved by the connection itself, *all* addresses are checked and the
//!   connection goes to an address that was checked, so DNS rebinding cannot swap it afterwards;
//! * loopback, private, link-local, CGNAT, multicast, reserved, IPv4-mapped IPv6 and cloud
//!   metadata addresses are refused;
//! * redirects are never followed, requests have a deadline and the response size is capped.
//!
//! Escape hatches (operator only): `TRAMA_OUTBOUND_ALLOW_PRIVATE=true` and
//! `TRAMA_OUTBOUND_ALLOWED_HOSTS` ([`OutboundPolicy`], in `Config::outbound`). Cloud metadata
//! addresses stay blocked even then.
//!
//! ```no_run
//! # async fn run(state: trama_core::AppState) -> Result<(), trama_common::safe_fetch::FetchError> {
//! use trama_common::safe_fetch::SafeRequest;
//! let res = SafeRequest::post("https://hooks.example.com/x")
//!     .header("Content-Type", "application/json")
//!     .body(r#"{"a":1}"#)
//!     .send(&state.config.outbound)
//!     .await?;
//! assert_eq!(res.status, 200);
//! # Ok(()) }
//! ```

use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Method;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use url::{Host, Url};

pub use trama_core::config::OutboundPolicy;

/// Whole-request deadline of [`SafeRequest`] unless set.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// Response body cap of [`SafeRequest`] unless set (10 MB).
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

const METADATA: &str = "cloud metadata address";

/// Why an outbound request was not made or did not complete.
#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    /// The URL or an address it resolves to is not allowed (the NestJS `OutboundBlockedError`).
    #[error("{0}")]
    Blocked(String),
    /// The deadline passed (the NestJS `TimeoutError`).
    #[error("Timed out after {0} ms")]
    Timeout(u128),
    /// The response body is larger than the cap.
    #[error("Response larger than {0} bytes")]
    TooLarge(usize),
    /// DNS, connection or protocol failure.
    #[error("{0}")]
    Request(String),
}

impl FetchError {
    /// `true` for [`FetchError::Blocked`].
    #[must_use]
    pub fn is_blocked(&self) -> bool {
        matches!(self, Self::Blocked(_))
    }
}

// -------------------------------------------------------------------------------------------
// Address classification
// -------------------------------------------------------------------------------------------

const V4_BLOCKS: [([u8; 4], u32, &str); 15] = [
    ([0, 0, 0, 0], 8, "unspecified address"),
    ([10, 0, 0, 0], 8, "private address"),
    ([100, 64, 0, 0], 10, "carrier-grade NAT address"),
    ([127, 0, 0, 0], 8, "loopback address"),
    ([169, 254, 0, 0], 16, "link-local address"),
    ([172, 16, 0, 0], 12, "private address"),
    ([192, 0, 0, 0], 24, "reserved address"),
    ([192, 0, 2, 0], 24, "documentation address"),
    ([192, 88, 99, 0], 24, "reserved address"),
    ([192, 168, 0, 0], 16, "private address"),
    ([198, 18, 0, 0], 15, "benchmarking address"),
    ([198, 51, 100, 0], 24, "documentation address"),
    ([203, 0, 113, 0], 24, "documentation address"),
    ([224, 0, 0, 0], 4, "multicast address"),
    ([240, 0, 0, 0], 4, "reserved address"),
];

const METADATA_V4: [[u8; 4]; 5] = [
    [169, 254, 169, 254],
    [169, 254, 170, 2],
    [169, 254, 169, 123],
    [100, 100, 100, 200],
    [192, 0, 0, 192],
];

fn v4_reason(ip: Ipv4Addr) -> Option<&'static str> {
    if METADATA_V4.contains(&ip.octets()) {
        return Some(METADATA);
    }
    let n = u32::from(ip);
    V4_BLOCKS.iter().find_map(|(base, bits, label)| {
        let mask = u32::MAX << (32 - bits);
        (n & mask == u32::from_be_bytes(*base) & mask).then_some(*label)
    })
}

fn v6_reason(ip: Ipv6Addr) -> Option<&'static str> {
    let g = ip.segments();
    let embedded =
        |hi: u16, lo: u16| v4_reason(Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo)));
    if g[0] == 0xfd00 && g[1] == 0x0ec2 && g[2..7].iter().all(|x| *x == 0) && g[7] == 0x254 {
        return Some(METADATA);
    }
    if g[..5].iter().all(|x| *x == 0) && g[5] == 0xffff {
        return Some("IPv4-mapped IPv6 address");
    }
    if g[..6].iter().all(|x| *x == 0) {
        return Some("unspecified, loopback or IPv4-compatible address");
    }
    if g[0] == 0x64 && g[1] == 0xff9b {
        if g[2] == 1 {
            return Some("reserved address");
        }
        if g[2..6].iter().all(|x| *x == 0) {
            return embedded(g[6], g[7]).map(|_| "NAT64 address of a blocked IPv4 host");
        }
    }
    if g[0] == 0x2002 {
        return embedded(g[1], g[2]).map(|_| "6to4 address of a blocked IPv4 host");
    }
    if g[0] == 0x2001 && g[1] == 0 {
        return Some("Teredo address");
    }
    if g[0] == 0x2001 && g[1] == 0x0db8 {
        return Some("documentation address");
    }
    if g[0] & 0xff00 == 0xff00 {
        return Some("multicast address");
    }
    if g[0] & 0xffc0 == 0xfe80 {
        return Some("link-local address");
    }
    if g[0] & 0xfe00 == 0xfc00 {
        return Some("private address");
    }
    // everything outside 2000::/3 is not global unicast
    if g[0] >> 13 != 1 {
        return Some("reserved address");
    }
    None
}

/// Why `ip` must not be contacted, or `None` for a public unicast address.
#[must_use]
pub fn blocked_ip_reason(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => v4_reason(v4),
        IpAddr::V6(v6) => v6_reason(v6),
    }
}

/// [`blocked_ip_reason`] for an address literal, optionally in brackets or with a zone id
/// (`[fe80::1%en0]`); `invalid address` when it is not one.
#[must_use]
pub fn blocked_address_reason(ip: &str) -> Option<&'static str> {
    let text = ip.strip_prefix('[').unwrap_or(ip);
    let text = text.strip_suffix(']').unwrap_or(text);
    let text = text.split_once('%').map_or(text, |(addr, _)| addr);
    match text.parse::<IpAddr>() {
        Ok(addr) => blocked_ip_reason(addr),
        Err(_) => Some("invalid address"),
    }
}

// -------------------------------------------------------------------------------------------
// Policy checks
// -------------------------------------------------------------------------------------------

fn host_allowed(host: &str, policy: &OutboundPolicy) -> bool {
    let h = host.to_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    policy.allowed_hosts.iter().any(|a| match a.strip_prefix('*') {
        Some(suffix) if a.starts_with("*.") => h.ends_with(suffix),
        _ => h == a,
    })
}

/// Whether `ip` (reached through `host`) may be contacted under `policy`. Metadata addresses
/// never may.
fn address_problem(host: &str, ip: IpAddr, policy: &OutboundPolicy) -> Option<&'static str> {
    let reason = blocked_ip_reason(ip)?;
    if reason == METADATA {
        return Some(reason);
    }
    if policy.allow_private || host_allowed(host, policy) { None } else { Some(reason) }
}

fn local_name(host: &str) -> bool {
    let h = host.to_lowercase();
    h == "localhost" || [".localhost", ".local", ".internal"].iter().any(|s| h.ends_with(s))
}

fn host_ip(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(v4) => Some(IpAddr::V4(v4)),
        Host::Ipv6(v6) => Some(IpAddr::V6(v6)),
        Host::Domain(_) => None,
    }
}

/// The host without IPv6 brackets.
fn host_name(url: &Url) -> String {
    match url.host() {
        Some(Host::Ipv6(v6)) => v6.to_string(),
        Some(Host::Ipv4(v4)) => v4.to_string(),
        Some(Host::Domain(d)) => d.to_owned(),
        None => String::new(),
    }
}

/// Parses `raw` and checks its shape and literal host under `policy`.
///
/// # Errors
///
/// [`FetchError::Blocked`] with the NestJS message.
pub fn check_url(raw: &str, policy: &OutboundPolicy) -> Result<Url, FetchError> {
    let blocked = |m: &str| FetchError::Blocked(m.to_owned());
    let url = Url::parse(raw).map_err(|_| blocked("url must be a valid http(s) URL"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(blocked("url must start with https:// or http://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(blocked("url must not contain credentials"));
    }
    let host = host_name(&url);
    if host.is_empty() {
        return Err(blocked("url must be a valid http(s) URL"));
    }
    let trusted = policy.allow_private || host_allowed(&host, policy);
    if policy.require_https && url.scheme() != "https" && !trusted {
        return Err(blocked("url must use https://"));
    }
    let problem = match host_ip(&url) {
        Some(ip) => address_problem(&host, ip, policy),
        None => (local_name(&host) && !trusted).then_some("internal host name"),
    };
    if let Some(problem) = problem {
        return Err(FetchError::Blocked(format!(
            "url points to a {problem}, which is not allowed (see TRAMA_OUTBOUND_ALLOW_PRIVATE)"
        )));
    }
    Ok(url)
}

// -------------------------------------------------------------------------------------------
// DNS
// -------------------------------------------------------------------------------------------

/// The future a [`Resolver`] returns.
pub type ResolveFuture = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send>>;

/// Turns a host name into addresses. [`SystemResolver`] in production; tests pass a closure.
pub trait Resolver: Send + Sync + 'static {
    /// Every address of `host`.
    fn resolve(&self, host: String) -> ResolveFuture;
}

/// The operating system's resolver (`getaddrinfo`).
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(&self, host: String) -> ResolveFuture {
        Box::pin(async move {
            Ok(tokio::net::lookup_host((host.as_str(), 0)).await?.map(|a| a.ip()).collect())
        })
    }
}

impl<F> Resolver for F
where
    F: Fn(&str) -> io::Result<Vec<IpAddr>> + Send + Sync + 'static,
{
    fn resolve(&self, host: String) -> ResolveFuture {
        let result = self(&host);
        Box::pin(std::future::ready(result))
    }
}

/// Resolves `host` and returns its addresses when every one of them may be contacted.
///
/// # Errors
///
/// [`FetchError::Blocked`] (`Blocked: <host> resolves to a <reason>`) when any address is
/// refused, [`FetchError::Request`] when the name does not resolve.
pub async fn vetted_addresses(
    host: &str,
    policy: &OutboundPolicy,
    resolver: &dyn Resolver,
) -> Result<Vec<IpAddr>, FetchError> {
    let addrs =
        resolver.resolve(host.to_owned()).await.map_err(|e| FetchError::Request(e.to_string()))?;
    if addrs.is_empty() {
        return Err(FetchError::Request(format!("getaddrinfo ENOTFOUND {host}")));
    }
    for ip in &addrs {
        if let Some(problem) = address_problem(host, *ip, policy) {
            return Err(FetchError::Blocked(format!("Blocked: {host} resolves to a {problem}")));
        }
    }
    Ok(addrs)
}

/// A reqwest resolver that hands out only vetted addresses: the connection goes to exactly the
/// addresses that were checked.
struct GuardedResolver {
    policy: OutboundPolicy,
    inner: Arc<dyn Resolver>,
}

/// Carried through reqwest's error chain so a refusal is reported as [`FetchError::Blocked`].
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct BlockedLookup(String);

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let policy = self.policy.clone();
        let inner = Arc::clone(&self.inner);
        Box::pin(async move {
            match vetted_addresses(name.as_str(), &policy, inner.as_ref()).await {
                Ok(addrs) => {
                    let addrs: Addrs = Box::new(addrs.into_iter().map(|ip| SocketAddr::new(ip, 0)));
                    Ok(addrs)
                }
                Err(FetchError::Blocked(m)) => Err(Box::new(BlockedLookup(m)) as _),
                Err(other) => Err(Box::new(io::Error::other(other.to_string())) as _),
            }
        })
    }
}

/// An HTTP client for libraries that take one (Web Push): every host name goes through the
/// address check, redirects are not followed and system proxies are ignored.
///
/// A URL with an IP literal host does not go through DNS: check it with [`check_url`] first.
///
/// # Errors
///
/// [`FetchError::Request`] when the TLS backend cannot be set up.
pub fn guarded_client(
    policy: &OutboundPolicy,
    resolver: Arc<dyn Resolver>,
) -> Result<reqwest::Client, FetchError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .pool_max_idle_per_host(0)
        .dns_resolver(Arc::new(GuardedResolver { policy: policy.clone(), inner: resolver }))
        .build()
        .map_err(|e| FetchError::Request(e.to_string()))
}

// -------------------------------------------------------------------------------------------
// URL check before storing
// -------------------------------------------------------------------------------------------

/// Checks a URL before it is stored: shape, literal host and (best effort) what its name
/// resolves to now, with the system resolver. A name that does not resolve yet is accepted;
/// the request-time check is the one that counts. Returns the problem, or `None`.
pub async fn outbound_url_problem(raw: &str, policy: &OutboundPolicy) -> Option<String> {
    outbound_url_problem_with(raw, policy, Some(&SystemResolver)).await
}

/// [`outbound_url_problem`] with a chosen resolver; `None` skips resolution.
pub async fn outbound_url_problem_with(
    raw: &str,
    policy: &OutboundPolicy,
    resolver: Option<&dyn Resolver>,
) -> Option<String> {
    let url = match check_url(raw, policy) {
        Ok(url) => url,
        Err(e) => return Some(e.to_string()),
    };
    let resolver = resolver?;
    if host_ip(&url).is_some() {
        return None;
    }
    let host = host_name(&url);
    let addrs = tokio::time::timeout(Duration::from_secs(3), resolver.resolve(host.clone()))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    addrs.into_iter().find_map(|ip| address_problem(&host, ip, policy)).map(|problem| {
        format!(
            "url resolves to a {problem}, which is not allowed (see TRAMA_OUTBOUND_ALLOW_PRIVATE)"
        )
    })
}

// -------------------------------------------------------------------------------------------
// Requests
// -------------------------------------------------------------------------------------------

/// A response read through the guard.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SafeResponse {
    /// HTTP status (a redirect is returned as is).
    pub status: u16,
    /// Headers by lowercase name; repeated headers joined with `, `.
    pub headers: BTreeMap<String, String>,
    /// The body, at most the cap.
    pub body: Vec<u8>,
}

/// An http(s) request through the SSRF guard. Redirects are returned as they are (3xx), never
/// followed. Sends `User-Agent: Trama` unless a header overrides it.
#[derive(Clone, Debug)]
#[must_use]
pub struct SafeRequest {
    url: String,
    method: Method,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    timeout: Duration,
    max_bytes: usize,
    truncate: bool,
}

impl SafeRequest {
    /// A request with `method` to `url`.
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            method,
            headers: Vec::new(),
            body: None,
            timeout: DEFAULT_TIMEOUT,
            max_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            truncate: false,
        }
    }

    /// A GET request.
    pub fn get(url: impl Into<String>) -> Self {
        Self::new(Method::GET, url)
    }

    /// A POST request.
    pub fn post(url: impl Into<String>) -> Self {
        Self::new(Method::POST, url)
    }

    /// Adds a header.
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Sets the body (`Content-Length` follows).
    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// Whole-request deadline (default 15 s).
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Response body cap in bytes (default 10 MB).
    pub fn max_bytes(mut self, max: usize) -> Self {
        self.max_bytes = max;
        self
    }

    /// Cut the body at the cap instead of failing (when only the status matters).
    pub fn truncate(mut self) -> Self {
        self.truncate = true;
        self
    }

    /// Sends the request with the system resolver.
    ///
    /// # Errors
    ///
    /// See [`FetchError`].
    pub async fn send(self, policy: &OutboundPolicy) -> Result<SafeResponse, FetchError> {
        self.send_with(policy, Arc::new(SystemResolver)).await
    }

    /// Sends the request, resolving host names with `resolver`.
    ///
    /// # Errors
    ///
    /// See [`FetchError`].
    pub async fn send_with(
        self,
        policy: &OutboundPolicy,
        resolver: Arc<dyn Resolver>,
    ) -> Result<SafeResponse, FetchError> {
        let url = check_url(&self.url, policy)?;
        let client = guarded_client(policy, resolver)?;
        let timeout = self.timeout;
        tokio::time::timeout(timeout, self.run(&client, url))
            .await
            .unwrap_or(Err(FetchError::Timeout(timeout.as_millis())))
    }

    async fn run(self, client: &reqwest::Client, url: Url) -> Result<SafeResponse, FetchError> {
        let mut req = client.request(self.method, url);
        if !self.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("user-agent")) {
            req = req.header(reqwest::header::USER_AGENT, "Trama");
        }
        for (name, value) in &self.headers {
            req = req.header(name.as_str(), value.as_str());
        }
        if let Some(body) = self.body {
            req = req.body(body);
        }
        let mut res = req.send().await.map_err(|e| map_reqwest(&e))?;
        let status = res.status().as_u16();
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        for (name, value) in res.headers() {
            let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
            headers
                .entry(name.as_str().to_owned())
                .and_modify(|v| {
                    v.push_str(", ");
                    v.push_str(&value);
                })
                .or_insert(value);
        }
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| map_reqwest(&e))? {
            if body.len() + chunk.len() > self.max_bytes {
                if !self.truncate {
                    return Err(FetchError::TooLarge(self.max_bytes));
                }
                body.extend_from_slice(&chunk[..self.max_bytes - body.len()]);
                break;
            }
            body.extend_from_slice(&chunk);
        }
        Ok(SafeResponse { status, headers, body })
    }
}

fn map_reqwest(err: &reqwest::Error) -> FetchError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = source {
        if let Some(blocked) = e.downcast_ref::<BlockedLookup>() {
            return FetchError::Blocked(blocked.0.clone());
        }
        source = e.source();
    }
    let mut message = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(e) = source {
        message = format!("{message}: {e}");
        source = e.source();
    }
    FetchError::Request(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::body::Bytes;
    use axum::http::{HeaderMap, StatusCode, Uri};
    use axum::response::IntoResponse;
    use axum::routing::any;

    const STRICT: fn() -> OutboundPolicy = OutboundPolicy::default;

    fn private_ok() -> OutboundPolicy {
        OutboundPolicy { allow_private: true, ..OutboundPolicy::default() }
    }

    #[allow(clippy::needless_pass_by_value)]
    fn allowing(hosts: &[&str], base: OutboundPolicy) -> OutboundPolicy {
        OutboundPolicy { allowed_hosts: hosts.iter().map(|h| (*h).to_owned()).collect(), ..base }
    }

    fn resolver_to(addrs: &[&str]) -> impl Resolver + Clone {
        let addrs: Vec<IpAddr> = addrs.iter().map(|a| a.parse().unwrap()).collect();
        move |_: &str| Ok(addrs.clone())
    }

    async fn problem(
        url: &str,
        policy: &OutboundPolicy,
        resolver: Option<&dyn Resolver>,
    ) -> Option<String> {
        outbound_url_problem_with(url, policy, resolver).await
    }

    fn contains(p: Option<String>, needle: &str) -> bool {
        p.is_some_and(|m| m.contains(needle))
    }

    #[test]
    fn blocks_internal_addresses() {
        for ip in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "100.127.255.255",
            "127.0.0.1",
            "127.8.8.8",
            "169.254.169.254",
            "169.254.1.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "::ffff:8.8.8.8",
            "fe80::1",
            "fc00::1",
            "fd00:ec2::254",
            "ff02::1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::1",
            "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            "2001:db8::1",
            "[::1]",
            "fe80::1%en0",
            "not-an-ip",
        ] {
            assert!(blocked_address_reason(ip).is_some(), "{ip}");
        }
    }

    #[test]
    fn labels_cloud_metadata_addresses() {
        assert_eq!(blocked_address_reason("169.254.169.254"), Some(METADATA));
        assert_eq!(blocked_address_reason("fd00:ec2::254"), Some(METADATA));
    }

    #[test]
    fn allows_public_addresses() {
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "193.0.0.1",
            "2606:4700:4700::1111",
            "2a00:1450:4001:81b::200e",
            "64:ff9b::808:808",
        ] {
            assert_eq!(blocked_address_reason(ip), None, "{ip}");
        }
    }

    #[tokio::test]
    async fn accepts_public_urls() {
        let r = resolver_to(&["93.184.216.34"]);
        assert_eq!(problem("https://example.com/hook", &STRICT(), Some(&r)).await, None);
        assert_eq!(problem("http://example.com/hook", &STRICT(), Some(&r)).await, None);
    }

    #[tokio::test]
    async fn rejects_other_schemes_bad_urls_and_credentials() {
        assert!(contains(problem("ftp://example.com", &STRICT(), None).await, "https"));
        assert!(contains(problem("file:///etc/passwd", &STRICT(), None).await, "https"));
        assert!(contains(problem("not a url", &STRICT(), None).await, "valid"));
        assert!(contains(
            problem("https://user:pw@example.com/", &STRICT(), None).await,
            "credentials"
        ));
    }

    #[tokio::test]
    async fn requires_https_in_production_unless_allowed() {
        let prod = OutboundPolicy { require_https: true, ..STRICT() };
        assert!(contains(problem("http://example.com", &prod, None).await, "https"));
        assert_eq!(problem("https://example.com", &prod, None).await, None);
        assert_eq!(problem("http://git.corp", &allowing(&["git.corp"], prod), None).await, None);
    }

    #[tokio::test]
    async fn blocks_literal_internal_hosts() {
        for url in [
            "http://localhost:3000/x",
            "http://api.localhost/x",
            "http://127.0.0.1/x",
            "http://127.1/x",
            "http://2130706433/x",
            "http://0x7f.0.0.1/x",
            "http://10.1.2.3/x",
            "http://192.168.0.5/x",
            "http://172.20.0.1/x",
            "http://100.64.0.1/x",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/x",
            "http://[::ffff:127.0.0.1]/x",
            "http://[fd00:ec2::254]/x",
            "http://db.internal/x",
        ] {
            assert!(contains(problem(url, &STRICT(), None).await, "not allowed"), "{url}");
        }
    }

    #[tokio::test]
    async fn blocks_names_resolving_to_private_addresses() {
        let p = problem(
            "http://169.254.169.254.nip.io/",
            &STRICT(),
            Some(&resolver_to(&["169.254.169.254"])),
        )
        .await;
        assert!(contains(p, "metadata"));
        let p =
            problem("https://internal.example.com/", &STRICT(), Some(&resolver_to(&["10.0.0.5"])))
                .await;
        assert!(contains(p, "private"));
    }

    #[tokio::test]
    async fn checks_every_resolved_address() {
        let r = resolver_to(&["93.184.216.34", "127.0.0.1"]);
        assert!(contains(
            problem("https://mixed.example.com/", &STRICT(), Some(&r)).await,
            "loopback"
        ));
    }

    #[tokio::test]
    async fn accepts_a_name_that_does_not_resolve_yet() {
        let failing = |_: &str| -> io::Result<Vec<IpAddr>> { Err(io::Error::other("ENOTFOUND")) };
        assert_eq!(problem("https://later.example.com/", &STRICT(), Some(&failing)).await, None);
    }

    #[tokio::test]
    async fn allowlist_and_allow_private_never_open_metadata() {
        let private = resolver_to(&["10.0.0.5"]);
        assert_eq!(problem("http://10.0.0.5:8080/x", &private_ok(), Some(&private)).await, None);
        assert_eq!(
            problem("http://localhost:3000/x", &private_ok(), Some(&resolver_to(&["127.0.0.1"])))
                .await,
            None
        );
        assert_eq!(
            problem("http://git.corp/x", &allowing(&["git.corp"], STRICT()), Some(&private)).await,
            None
        );
        assert!(contains(
            problem("http://other.corp/x", &allowing(&["git.corp"], STRICT()), Some(&private))
                .await,
            "private"
        ));
        assert_eq!(
            problem("http://a.corp/x", &allowing(&["*.corp"], STRICT()), Some(&private)).await,
            None
        );
        assert!(contains(
            problem("http://169.254.169.254/", &private_ok(), None).await,
            "metadata"
        ));
        let meta = resolver_to(&["169.254.169.254"]);
        assert!(contains(
            problem("http://meta.corp/", &allowing(&["meta.corp"], private_ok()), Some(&meta))
                .await,
            "metadata"
        ));
    }

    #[tokio::test]
    async fn lookup_hands_out_the_vetted_address() {
        let addrs = vetted_addresses("a.example.com", &STRICT(), &resolver_to(&["93.184.216.34"]))
            .await
            .unwrap();
        assert_eq!(addrs, ["93.184.216.34".parse::<IpAddr>().unwrap()]);
    }

    #[tokio::test]
    async fn lookup_refuses_private_answers() {
        let err = vetted_addresses("a.example.com", &STRICT(), &resolver_to(&["192.168.1.10"]))
            .await
            .unwrap_err();
        assert!(err.is_blocked() && err.to_string().contains("private address"), "{err}");
        let err = vetted_addresses(
            "a.example.com",
            &STRICT(),
            &resolver_to(&["93.184.216.34", "::ffff:10.0.0.1"]),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("IPv4-mapped"), "{err}");
    }

    #[tokio::test]
    async fn lookup_revalidates_every_time() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let flipping = move |_: &str| {
            let first = counter.fetch_add(1, Ordering::SeqCst) == 0;
            Ok(vec![if first { "93.184.216.34" } else { "169.254.169.254" }.parse().unwrap()])
        };
        assert!(vetted_addresses("rebind.example.com", &STRICT(), &flipping).await.is_ok());
        let err = vetted_addresses("rebind.example.com", &STRICT(), &flipping).await.unwrap_err();
        assert!(err.to_string().contains("metadata"));
    }

    #[tokio::test]
    async fn lookup_follows_the_policy_it_is_given() {
        let r = resolver_to(&["10.0.0.5"]);
        assert!(vetted_addresses("x.corp", &STRICT(), &r).await.is_err());
        assert!(vetted_addresses("x.corp", &allowing(&["x.corp"], STRICT()), &r).await.is_ok());
    }

    #[derive(Debug)]
    struct Seen {
        host: Option<String>,
        method: String,
        body: String,
        user_agent: Option<String>,
    }

    async fn server() -> (String, Arc<Mutex<Vec<Seen>>>) {
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let log = Arc::clone(&seen);
        let app = Router::new().fallback(any(
            move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
                let log = Arc::clone(&log);
                async move {
                    let header = |name: &str| {
                        headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
                    };
                    log.lock().unwrap().push(Seen {
                        host: header("host"),
                        method: method.to_string(),
                        body: String::from_utf8_lossy(&body).into_owned(),
                        user_agent: header("user-agent"),
                    });
                    match uri.path() {
                        "/redirect" => (
                            StatusCode::FOUND,
                            [("location", "http://169.254.169.254/latest/meta-data")],
                        )
                            .into_response(),
                        "/big" => "x".repeat(5000).into_response(),
                        "/slow" => {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                            "late".into_response()
                        }
                        _ => (
                            [("content-type", "application/json"), ("x-echo", "yes")],
                            r#"{"ok":true}"#,
                        )
                            .into_response(),
                    }
                }
            },
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, seen)
    }

    #[tokio::test]
    async fn refuses_loopback_by_default_and_never_connects() {
        let (base, seen) = server().await;
        let err = SafeRequest::get(format!("{base}/ok")).send(&STRICT()).await.unwrap_err();
        assert!(err.to_string().contains("loopback"), "{err}");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn refuses_a_name_that_resolves_to_loopback() {
        let (base, seen) = server().await;
        let port = Url::parse(&base).unwrap().port().unwrap();
        let err = SafeRequest::get(format!("http://sneaky.example.com:{port}/ok"))
            .send_with(&STRICT(), Arc::new(resolver_to(&["127.0.0.1"])))
            .await
            .unwrap_err();
        assert!(err.is_blocked(), "{err:?}");
        assert!(err.to_string().contains("resolves to a loopback"), "{err}");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn sends_the_request_when_private_targets_are_allowed() {
        let (base, seen) = server().await;
        let res = SafeRequest::post(format!("{base}/ok"))
            .header("Content-Type", "application/json")
            .body(r#"{"a":1}"#)
            .send(&private_ok())
            .await
            .unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(res.headers["x-echo"], "yes");
        assert_eq!(res.body, br#"{"ok":true}"#);
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].method, "POST");
        assert_eq!(seen[0].body, r#"{"a":1}"#);
        assert_eq!(seen[0].user_agent.as_deref(), Some("Trama"));
    }

    #[tokio::test]
    async fn connects_to_the_vetted_address_with_the_original_host() {
        let (base, seen) = server().await;
        let port = Url::parse(&base).unwrap().port().unwrap();
        let lookups = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&lookups);
        let resolver = move |_: &str| {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(vec![IpAddr::from([127, 0, 0, 1])])
        };
        let res = SafeRequest::get(format!("http://pinned.corp:{port}/ok"))
            .send_with(&allowing(&["pinned.corp"], STRICT()), Arc::new(resolver))
            .await
            .unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(lookups.load(Ordering::SeqCst), 1);
        assert_eq!(
            seen.lock().unwrap()[0].host.as_deref(),
            Some(format!("pinned.corp:{port}").as_str())
        );
    }

    #[tokio::test]
    async fn does_not_follow_redirects() {
        let (base, seen) = server().await;
        let res = SafeRequest::get(format!("{base}/redirect")).send(&private_ok()).await.unwrap();
        assert_eq!(res.status, 302);
        assert!(res.headers["location"].contains("169.254.169.254"));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn caps_the_response_size() {
        let (base, _) = server().await;
        let err = SafeRequest::get(format!("{base}/big"))
            .max_bytes(1000)
            .send(&private_ok())
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Response larger than 1000 bytes");
        let cut = SafeRequest::get(format!("{base}/big"))
            .max_bytes(1000)
            .truncate()
            .send(&private_ok())
            .await
            .unwrap();
        assert_eq!(cut.status, 200);
        assert_eq!(cut.body.len(), 1000);
    }

    #[tokio::test]
    async fn times_out() {
        let (base, _) = server().await;
        let err = SafeRequest::get(format!("{base}/slow"))
            .timeout(Duration::from_millis(150))
            .send(&private_ok())
            .await
            .unwrap_err();
        assert!(matches!(err, FetchError::Timeout(150)), "{err:?}");
    }

    #[tokio::test]
    async fn refuses_metadata_even_with_allow_private() {
        let err = SafeRequest::get("http://169.254.169.254/latest/meta-data")
            .send(&private_ok())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("metadata"));
    }
}
