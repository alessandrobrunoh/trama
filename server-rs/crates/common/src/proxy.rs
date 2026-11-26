//! Who sent a request: the client address and protocol as Express computes `req.ip` and
//! `req.protocol` under `TRAMA_TRUST_PROXY` ([`TrustProxy`]).
//!
//! The server must be started with `into_make_service_with_connect_info::<SocketAddr>()` for
//! the socket address to be known; without it (router tests) the socket address is `unknown`.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{Extensions, HeaderMap};
use trama_core::config::TrustProxy;
use trama_core::{AppState, Config};

/// The socket peer of a request, when the server recorded it.
#[must_use]
pub fn socket_addr(extensions: &Extensions) -> Option<SocketAddr> {
    extensions.get::<ConnectInfo<SocketAddr>>().map(|ConnectInfo(addr)| *addr)
}

/// Express's `req.ip`: walks `X-Forwarded-For` from the right while each hop is a trusted
/// proxy. Returns the socket address when nothing is trusted, `unknown` when it is not known.
#[must_use]
pub fn client_ip(trust: &TrustProxy, socket: Option<SocketAddr>, headers: &HeaderMap) -> String {
    let socket = socket.map_or_else(|| "unknown".to_owned(), |a| a.ip().to_string());
    let mut addrs = vec![socket];
    if *trust != TrustProxy::None {
        addrs.extend(forwarded_for(headers).into_iter().rev());
    }
    let hops = addrs.len() - 1;
    let last = addrs[..hops]
        .iter()
        .enumerate()
        .position(|(i, addr)| !trust.trusts(addr, i))
        .unwrap_or(hops);
    addrs.swap_remove(last)
}

/// Express's `req.protocol`: `X-Forwarded-Proto` (first entry) when the socket peer is a
/// trusted proxy, otherwise `http` (this server does not terminate TLS itself).
#[must_use]
pub fn request_protocol(
    trust: &TrustProxy,
    socket: Option<SocketAddr>,
    headers: &HeaderMap,
) -> String {
    let peer = socket.map_or_else(|| "unknown".to_owned(), |a| a.ip().to_string());
    if !trust.trusts(&peer, 0) {
        return "http".to_owned();
    }
    match headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) {
        Some(proto) => proto.split(',').next().unwrap_or_default().trim().to_owned(),
        None => "http".to_owned(),
    }
}

/// Base URL of this API for links shown to admins (webhook URLs): `PUBLIC_URL`, else the
/// request's protocol and `Host`, else `http://localhost:<PORT>` (the NestJS
/// `IntegrationsService.publicUrl`).
#[must_use]
pub fn public_base_url(config: &Config, request: Option<&Parts>) -> String {
    if let Some(url) = &config.public_url {
        return url.clone();
    }
    if let Some(parts) = request {
        let proto =
            request_protocol(&config.trust_proxy, socket_addr(&parts.extensions), &parts.headers);
        let host = parts.headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or_default();
        return format!("{proto}://{host}");
    }
    format!("http://localhost:{}", config.port)
}

fn forwarded_for(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Extractor for the client address ([`client_ip`]), e.g. to record where a session signed in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientIp(pub String);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let ip =
            client_ip(&state.config.trust_proxy, socket_addr(&parts.extensions), &parts.headers);
        std::future::ready(Ok(Self(ip)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(xff: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_str(xff).unwrap());
        h
    }

    fn sock(ip: &str) -> Option<SocketAddr> {
        Some(SocketAddr::new(ip.parse().unwrap(), 1234))
    }

    #[test]
    fn ignores_forwarded_for_without_trust() {
        let h = headers("1.1.1.1");
        assert_eq!(client_ip(&TrustProxy::None, sock("10.0.0.1"), &h), "10.0.0.1");
        assert_eq!(client_ip(&TrustProxy::None, None, &h), "unknown");
    }

    #[test]
    fn trusts_hops_from_the_right() {
        let h = headers("1.1.1.1, 2.2.2.2, 3.3.3.3");
        assert_eq!(client_ip(&TrustProxy::Hops(1), sock("10.0.0.1"), &h), "3.3.3.3");
        assert_eq!(client_ip(&TrustProxy::Hops(2), sock("10.0.0.1"), &h), "2.2.2.2");
        assert_eq!(client_ip(&TrustProxy::Hops(9), sock("10.0.0.1"), &h), "1.1.1.1");
        assert_eq!(client_ip(&TrustProxy::All, sock("10.0.0.1"), &h), "1.1.1.1");
        assert_eq!(
            client_ip(&TrustProxy::Hops(1), sock("10.0.0.1"), &HeaderMap::new()),
            "10.0.0.1"
        );
    }

    #[test]
    fn trusts_subnets() {
        let trust = TrustProxy::parse(Some("loopback, 10.0.0.0/8")).unwrap();
        let h = headers("1.1.1.1, 10.0.0.7");
        assert_eq!(client_ip(&trust, sock("127.0.0.1"), &h), "1.1.1.1");
        assert_eq!(client_ip(&trust, sock("8.8.8.8"), &h), "8.8.8.8");
        let spoofed = headers("1.1.1.1, 9.9.9.9");
        assert_eq!(client_ip(&trust, sock("127.0.0.1"), &spoofed), "9.9.9.9");
    }

    #[test]
    fn protocol_from_a_trusted_proxy() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-proto", HeaderValue::from_static("https, http"));
        assert_eq!(request_protocol(&TrustProxy::Hops(1), sock("10.0.0.1"), &h), "https");
        assert_eq!(request_protocol(&TrustProxy::None, sock("10.0.0.1"), &h), "http");
    }

    #[test]
    fn public_base_url_prefers_the_configuration() {
        let cfg = Config::from_vars(&[("PUBLIC_URL", "https://api.dev/")]);
        assert_eq!(public_base_url(&cfg, None), "https://api.dev");
        let cfg = Config::from_vars(&[("PORT", "3100")]);
        assert_eq!(public_base_url(&cfg, None), "http://localhost:3100");
        let (parts, ()) =
            axum::http::Request::get("/").header("host", "h.dev:81").body(()).unwrap().into_parts();
        assert_eq!(public_base_url(&cfg, Some(&parts)), "http://h.dev:81");
    }
}
