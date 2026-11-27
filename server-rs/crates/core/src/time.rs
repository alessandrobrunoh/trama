//! Timestamps in the API's wire format.

use chrono::{DateTime, SecondsFormat, TimeZone, Utc};

/// UTC with millisecond precision and a `Z` suffix (`2026-11-25T14:01:36.424Z`), the format of
/// JavaScript's `Date.toISOString()` that every NestJS response uses.
#[must_use]
pub fn to_iso<Tz: TimeZone>(at: &DateTime<Tz>) -> String {
    at.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The current time in [`to_iso`] format.
#[must_use]
pub fn now_iso() -> String {
    to_iso(&Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    #[test]
    fn matches_to_iso_string() {
        let at = FixedOffset::east_opt(2 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 11, 25, 16, 1, 36)
            .unwrap();
        assert_eq!(to_iso(&at), "2026-11-25T14:01:36.000Z");
    }
}
