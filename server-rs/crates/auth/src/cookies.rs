//! The session cookie, byte for byte as Express 5 writes it (`res.cookie` / `res.clearCookie`
//! with the `cookie` package), and the `Cookie` header parser of the NestJS guard.

use std::collections::HashMap;

use axum::http::{HeaderMap, HeaderValue, header};
use chrono::{DateTime, Utc};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};

use crate::service::{LEGACY_SESSION_COOKIE, SESSION_COOKIE, SESSION_TTL};

/// What `encodeURIComponent` leaves alone.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// `Date.prototype.toUTCString()`.
fn utc_string(at: &DateTime<Utc>) -> String {
    at.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// `Name=value; [Max-Age=…; ]Path=/; Expires=…; HttpOnly; [Secure; ]SameSite=Lax`.
fn serialize(
    name: &str,
    value: &str,
    max_age: Option<i64>,
    expires: &DateTime<Utc>,
    secure: bool,
) -> String {
    let value = utf8_percent_encode(value, URI_COMPONENT);
    let max_age = max_age.map(|s| format!("; Max-Age={s}")).unwrap_or_default();
    let secure = if secure { "; Secure" } else { "" };
    format!(
        "{name}={value}{max_age}; Path=/; Expires={}; HttpOnly{secure}; SameSite=Lax",
        utc_string(expires)
    )
}

/// `res.clearCookie(name, flags)`: an empty value that expired at the epoch (+1 ms).
fn cleared(name: &str, secure: bool) -> String {
    serialize(name, "", None, &DateTime::<Utc>::UNIX_EPOCH, secure)
}

/// `Set-Cookie` values that start a session (`setSessionCookie`): the session cookie for 30
/// days, and the pre-rename cookie cleared. `secure` is `NODE_ENV === 'production'`.
#[must_use]
pub fn session_cookies(raw: &str, secure: bool) -> [String; 2] {
    let expires = Utc::now() + SESSION_TTL;
    [
        serialize(SESSION_COOKIE, raw, Some(SESSION_TTL.num_seconds()), &expires, secure),
        cleared(LEGACY_SESSION_COOKIE, secure),
    ]
}

/// `Set-Cookie` values that end a session (`clearSessionCookie`): both cookie names cleared.
#[must_use]
pub fn cleared_session_cookies(secure: bool) -> [String; 2] {
    [cleared(SESSION_COOKIE, secure), cleared(LEGACY_SESSION_COOKIE, secure)]
}

/// Appends `cookies` as `Set-Cookie` headers.
pub fn append_cookies(headers: &mut HeaderMap, cookies: &[String]) {
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(cookie) {
            headers.append(header::SET_COOKIE, value);
        }
    }
}

/// The request's cookies as the NestJS guard reads them: every `Cookie` header split on `;`,
/// name and value trimmed, the value percent-decoded (kept as sent when it does not decode); a
/// later duplicate wins.
#[must_use]
pub fn parse_cookies(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let joined: Vec<String> = headers
        .get_all(header::COOKIE)
        .iter()
        .map(|v| v.as_bytes().iter().map(|b| char::from(*b)).collect())
        .collect();
    // Node joins repeated Cookie headers with "; "
    for part in joined.join("; ").split(';') {
        let Some((name, value)) = part.split_once('=') else { continue };
        let value = value.trim();
        let decoded = percent_decode_str(value)
            .decode_utf8()
            .map_or_else(|_| value.to_owned(), std::borrow::Cow::into_owned);
        out.insert(name.trim().to_owned(), decoded);
    }
    out
}

/// The raw session cookie value: `trama_session`, else the legacy `nabla_session` (an empty
/// value counts as absent).
#[must_use]
pub fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let cookies = parse_cookies(headers);
    [SESSION_COOKIE, LEGACY_SESSION_COOKIE]
        .iter()
        .filter_map(|name| cookies.get(*name))
        .find(|v| !v.is_empty())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_cookies_like_express() {
        let [set, legacy] = session_cookies("abc-_123", false);
        assert!(
            set.starts_with("trama_session=abc-_123; Max-Age=2592000; Path=/; Expires="),
            "{set}"
        );
        assert!(set.ends_with(" GMT; HttpOnly; SameSite=Lax"), "{set}");
        assert_eq!(
            legacy,
            "nabla_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
        );
        let [a, b] = cleared_session_cookies(true);
        assert_eq!(
            a,
            "trama_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax"
        );
        assert!(b.starts_with("nabla_session=;"));
    }

    #[test]
    fn reads_cookies_like_the_guard() {
        let mut headers = HeaderMap::new();
        headers
            .insert(header::COOKIE, HeaderValue::from_static("a=1; nabla_session=old%20v ; bad"));
        assert_eq!(session_cookie(&headers).as_deref(), Some("old v"));
        headers.append(header::COOKIE, HeaderValue::from_static("trama_session=new; x=%E0"));
        assert_eq!(session_cookie(&headers).as_deref(), Some("new"));
        assert_eq!(parse_cookies(&headers)["x"], "%E0");
        headers.insert(header::COOKIE, HeaderValue::from_static("trama_session=; nabla_session=v"));
        assert_eq!(session_cookie(&headers).as_deref(), Some("v"));
    }
}
