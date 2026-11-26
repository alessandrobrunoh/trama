//! Input rules the DTOs of `notifications.controller.ts` use: `@IsUrl({ protocols: ['https'],
//! require_protocol: true, require_tld: false })` (`validator.js` `isURL`) and the
//! class-validator messages of the other decorators.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use serde_json::Value;
use trama_core::validation::js_len;

/// `validator.js` default `max_allowed_length`.
const MAX_URL_LENGTH: usize = 2083;

/// `isIP(host)` for IPv4 and IPv6.
fn is_ip(host: &str) -> bool {
    Ipv4Addr::from_str(host).is_ok() || Ipv6Addr::from_str(host).is_ok()
}

/// `isFQDN(host, { require_tld: false })`.
fn is_fqdn(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    let tld = parts.last().copied().unwrap_or_default();
    if !tld.is_empty() && tld.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    parts.iter().all(|part| {
        !part.is_empty()
            && part.chars().count() <= 63
            && part.chars().all(|c| {
                c.is_ascii_alphanumeric() || c == '-' || ('\u{a1}'..='\u{ffff}').contains(&c)
            })
            && !part.chars().any(|c| ('\u{ff01}'..='\u{ff5e}').contains(&c))
            && !part.starts_with('-')
            && !part.ends_with('-')
    })
}

/// `@IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })`.
#[must_use]
pub fn is_https_url(url: &str) -> bool {
    if url.is_empty() || url.chars().any(|c| c.is_whitespace() || c == '<' || c == '>') {
        return false;
    }
    if url.starts_with("mailto:") || js_len(url) > MAX_URL_LENGTH {
        return false;
    }
    let url = url.split('#').next().unwrap_or_default();
    let url = url.split('?').next().unwrap_or_default();
    let Some((protocol, rest)) = url.split_once("://") else { return false };
    if protocol.to_lowercase() != "https" || rest.is_empty() {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or_default();
    let mut at = authority.split('@');
    let first = at.next().unwrap_or_default();
    let remaining: Vec<&str> = at.collect();
    let hostname = if remaining.is_empty() {
        first.to_owned()
    } else {
        if first.is_empty() {
            return false;
        }
        let credentials: Vec<&str> = first.split(':').collect();
        let blank = credentials[0].is_empty() && credentials.get(1).is_some_and(|p| p.is_empty());
        if credentials.len() > 2 || blank {
            return false;
        }
        remaining.join("@")
    };
    let (host, ipv6, port) =
        if let Some((inner, tail)) = hostname.strip_prefix('[').and_then(|h| h.split_once(']')) {
            let port = match tail {
                "" => None,
                t => match t.strip_prefix(':') {
                    Some(p) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => Some(p),
                    _ => return false,
                },
            };
            (String::new(), Some(inner.to_owned()), port.map(ToOwned::to_owned))
        } else {
            let mut parts = hostname.split(':');
            let host = parts.next().unwrap_or_default().to_owned();
            let port: Vec<&str> = parts.collect();
            (host, None, (!port.is_empty()).then(|| port.join(":")))
        };
    if let Some(port) = port.filter(|p| !p.is_empty()) {
        let valid = port.bytes().all(|b| b.is_ascii_digit())
            && port.parse::<u32>().is_ok_and(|n| (1..=65535).contains(&n));
        if !valid {
            return false;
        }
    }
    is_ip(&host) || is_fqdn(&host) || ipv6.is_some_and(|v6| Ipv6Addr::from_str(&v6).is_ok())
}

/// `@IsString()` and `@MaxLength(max)` on a value that may be of any type, as class-validator
/// reports them: decorators run bottom-up, so `@MaxLength` (the lower one) comes first.
pub fn string_with_max(field: &str, value: Option<&Value>, max: usize, out: &mut Vec<String>) {
    let text = value.and_then(Value::as_str);
    if text.is_none_or(|t| js_len(t) > max) {
        out.push(format!("{field} must be shorter than or equal to {max} characters"));
    }
    if text.is_none() {
        out.push(format!("{field} must be a string"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_urls_without_a_tld() {
        for url in [
            "https://push.example/a",
            "https://fcm.googleapis.com/fcm/send/abc:def",
            "https://localhost:8443/x?y=1#z",
            "https://8.8.8.8/push/abc",
            "https://[::1]:8080/x",
            "https://user:pass@push.example/x",
            "HTTPS://Push.Example/x",
        ] {
            assert!(is_https_url(url), "{url}");
        }
    }

    #[test]
    fn rejects_everything_else() {
        for url in [
            "",
            "http://insecure.example/x",
            "ftp://push.example/x",
            "push.example/x",
            "//push.example/x",
            "https://",
            "https:///x",
            "https://push example/x",
            "https://push.example:0/x",
            "https://push.example:70000/x",
            "https://push.example:80a/x",
            "https://-bad.example/x",
            "https://bad_.example/x",
            "https://1.2.3.4.5/x",
            "https://@push.example/x",
            "https://a:b:c@push.example/x",
            "mailto:a@b.dev",
            "https://push.example/<x>",
        ] {
            assert!(!is_https_url(url), "{url}");
        }
        assert!(!is_https_url(&format!("https://push.example/{}", "a".repeat(2100))));
    }

    #[test]
    fn reports_max_length_before_type_like_class_validator() {
        let mut out = Vec::new();
        string_with_max("endpoint", None, 2000, &mut out);
        assert_eq!(
            out,
            [
                "endpoint must be shorter than or equal to 2000 characters",
                "endpoint must be a string"
            ]
        );
        let mut out = Vec::new();
        string_with_max("endpoint", Some(&Value::String("x".repeat(2001))), 2000, &mut out);
        assert_eq!(out, ["endpoint must be shorter than or equal to 2000 characters"]);
        let mut out = Vec::new();
        string_with_max("endpoint", Some(&Value::String("x".into())), 2000, &mut out);
        assert!(out.is_empty());
    }
}
