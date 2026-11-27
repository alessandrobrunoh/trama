//! Custom validators of `server/src/common/validation.ts`.
//!
//! `@OptionalNotNull()` and `@Clearable()` are `trama_core::validation::Patch` (absent vs
//! `null` vs a value); `@IsThreadUrl()` is [`thread_url`].

use trama_core::validation::{Checks, js_len};

/// Longest `Issue.threadUrl` (`ISSUE_THREAD_URL_MAX` in `contracts/domain.ts`).
pub const ISSUE_THREAD_URL_MAX: usize = 2048;

/// `isThreadUrl` of `contracts/domain.ts`: an `http(s)` URL with a host, without surrounding
/// whitespace, of at most [`ISSUE_THREAD_URL_MAX`] characters.
#[must_use]
pub fn is_thread_url(value: &str) -> bool {
    let raw = value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if raw.is_empty() || raw != value || js_len(raw) > ISSUE_THREAD_URL_MAX {
        return false;
    }
    url::Url::parse(raw).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty())
    })
}

/// `@IsThreadUrl()`: records the class-validator message for `field` unless `value` is a
/// thread URL.
pub fn thread_url<'a>(checks: &'a mut Checks, field: &str, value: &str) -> &'a mut Checks {
    checks.check(
        is_thread_url(value),
        format!(
            "{field} must be an http or https URL of at most {ISSUE_THREAD_URL_MAX} characters"
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_urls_only() {
        for ok in ["https://delta.dev/t/1", "http://localhost:4300/x?y=1#z"] {
            assert!(is_thread_url(ok), "{ok}");
        }
        for bad in [
            "",
            " https://a.dev",
            "https://a.dev ",
            "ftp://a.dev",
            "mailto:a@b.dev",
            "not a url",
            "http://",
        ] {
            assert!(!is_thread_url(bad), "{bad}");
        }
        let long = format!("https://a.dev/{}", "x".repeat(ISSUE_THREAD_URL_MAX));
        assert!(!is_thread_url(&long));
    }

    #[test]
    fn reports_the_class_validator_message() {
        let mut c = Checks::new();
        thread_url(&mut c, "threadUrl", "nope");
        let err = c.finish().unwrap_err();
        assert!(
            err.to_string()
                .contains("threadUrl must be an http or https URL of at most 2048 characters")
        );
    }
}
