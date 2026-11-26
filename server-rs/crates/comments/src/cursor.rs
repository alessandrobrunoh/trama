//! The cursor and limit of `GET /comments/page` (`server/src/comments/comment-cursor.ts`).

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::Value;
use trama_contracts::activity::{COMMENT_PAGE_SIZE_DEFAULT, COMMENT_PAGE_SIZE_MAX};
use trama_core::AppError;
use trama_core::time::to_iso;
use trama_events::js_date::parse_js_date;

/// Position of the last comment of a page: the next page starts strictly after it (older).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommentCursor {
    /// `createdAt`, truncated to milliseconds (the precision of the cursor).
    pub at: DateTime<Utc>,
    /// The comment id.
    pub id: String,
}

/// The base64url alphabet and length a cursor must have before it is decoded.
static RAW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,200}$").unwrap_or_else(|e| unreachable!("{e}")));

/// What a cursor holds once decoded: `<ISO date with milliseconds>|<comment id>`. `[0-9]`, not
/// `\d`: the JavaScript class is ASCII only.
static DECODED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)\|([A-Za-z0-9_-]{1,64})$")
        .unwrap_or_else(|e| unreachable!("{e}"))
});

/// The cursor as the client sees it (`encodeCommentCursor`).
#[must_use]
pub fn encode_comment_cursor(cursor: &CommentCursor) -> String {
    URL_SAFE_NO_PAD.encode(format!("{}|{}", to_iso(&cursor.at), cursor.id))
}

/// `Buffer.from(raw, 'base64url').toString('utf8')` for a string of base64url characters: every
/// complete byte is kept, leftover bits (a truncated last group) are dropped.
fn base64url_text(raw: &str) -> String {
    let mut bytes = Vec::with_capacity(raw.len() * 3 / 4);
    let (mut acc, mut bits) = (0_u32, 0_u32);
    for c in raw.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            _ => 63,
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            // the byte sits in the bits above the `bits` left over
            #[allow(clippy::cast_possible_truncation)]
            bytes.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Reads a cursor.
///
/// # Errors
///
/// 400 `cursor is not valid` for anything [`encode_comment_cursor`] did not produce.
pub fn decode_comment_cursor(raw: &str) -> Result<CommentCursor, AppError> {
    let invalid = || AppError::bad_request("cursor is not valid");
    if !RAW.is_match(raw) {
        return Err(invalid());
    }
    let text = base64url_text(raw);
    let caps = DECODED.captures(&text).ok_or_else(invalid)?;
    let at = parse_js_date(&caps[1]).ok_or_else(invalid)?;
    Ok(CommentCursor { at, id: caps[2].to_owned() })
}

/// `parseCommentLimit`: `None` (or `null`) is the default page size; otherwise an integer in
/// `1..=100`.
///
/// # Errors
///
/// 400 `limit must be an integer between 1 and 100`.
pub fn parse_comment_limit(limit: Option<&Value>) -> Result<u32, AppError> {
    let value = match limit {
        None | Some(Value::Null) => return Ok(COMMENT_PAGE_SIZE_DEFAULT),
        Some(value) => value,
    };
    let in_range = value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= f64::from(COMMENT_PAGE_SIZE_MAX));
    match in_range {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some(n) => Ok(n as u32),
        None => Err(AppError::bad_request(format!(
            "limit must be an integer between 1 and {COMMENT_PAGE_SIZE_MAX}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use chrono::TimeZone;
    use serde_json::json;

    use super::*;

    #[test]
    fn round_trips_created_at_and_id() {
        let at = Utc.with_ymd_and_hms(2026, 3, 4, 5, 6, 7).unwrap()
            + chrono::TimeDelta::milliseconds(89);
        let cursor = CommentCursor { at, id: "cm_abc-1".into() };
        assert_eq!(decode_comment_cursor(&encode_comment_cursor(&cursor)).unwrap(), cursor);
    }

    #[test]
    fn rejects_anything_not_produced_by_the_encoder() {
        let b64 = |s: &str| URL_SAFE_NO_PAD.encode(s);
        let long = "a".repeat(300);
        let bad = [
            String::new(),
            "not a cursor!".into(),
            "%%%".into(),
            b64("nope"),
            b64("2026-03-04|cm_1"),
            b64("2026-03-04T05:06:07.089Z|cm 1; drop"),
            b64("2026-13-45T25:61:61.000Z|cm_1"),
            b64("2026-03-04T05:06:07.089Z|"),
            b64(&format!("2026-03-04T05:06:07.089Z|{}", "x".repeat(65))),
            // a trailing newline: `$` must not match before it
            b64("2026-03-04T05:06:07.089Z|cm_1\n"),
            long,
        ];
        for raw in bad {
            let err = decode_comment_cursor(&raw).unwrap_err();
            assert_eq!(err.status_code(), StatusCode::BAD_REQUEST, "{raw}");
            assert_eq!(err.to_string(), "400 Bad Request: cursor is not valid", "{raw}");
        }
    }

    #[test]
    fn decodes_like_buffer_from_base64url() {
        assert_eq!(base64url_text("YWJ8Yw"), "ab|c");
        assert_eq!(base64url_text("YQ"), "a");
        // a single dangling character (6 bits) is dropped, as Node does
        assert_eq!(base64url_text("YWJ8Y"), "ab|");
    }

    #[test]
    fn limit_defaults_and_accepts_one_to_the_maximum() {
        assert_eq!(parse_comment_limit(None).unwrap(), COMMENT_PAGE_SIZE_DEFAULT);
        assert_eq!(parse_comment_limit(Some(&Value::Null)).unwrap(), COMMENT_PAGE_SIZE_DEFAULT);
        assert_eq!(parse_comment_limit(Some(&json!(1))).unwrap(), 1);
        assert_eq!(parse_comment_limit(Some(&json!(COMMENT_PAGE_SIZE_MAX))).unwrap(), 100);
    }

    #[test]
    fn limit_rejects_zero_negatives_fractions_too_large_and_non_numbers() {
        for bad in [json!(0), json!(-1), json!(1.5), json!(101), json!("10"), json!(true)] {
            let err = parse_comment_limit(Some(&bad)).unwrap_err();
            assert_eq!(err.status_code(), StatusCode::BAD_REQUEST, "{bad}");
            assert_eq!(
                err.to_string(),
                "400 Bad Request: limit must be an integer between 1 and 100",
                "{bad}"
            );
        }
    }
}
