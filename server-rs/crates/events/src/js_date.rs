//! `new Date(string)` for the timestamps clients send: ISO 8601 in the forms V8 accepts, and
//! RFC 2822 (`toUTCString()`). Anything else is `NaN`.

use std::sync::LazyLock;

use chrono::{DateTime, Local, NaiveDate, TimeDelta, TimeZone, Utc};
use regex::Regex;

static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([+-]\d{6}|\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[Tt ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?([Zz]|[+-]\d{2}:?\d{2})?$",
    )
    .unwrap_or_else(|e| unreachable!("{e}"))
});

/// The instant `new Date(raw)` stands for, `None` where it is `NaN`. A date without a time is
/// UTC; a date and time without an offset is local time, as in JavaScript.
#[must_use]
pub fn parse_js_date(raw: &str) -> Option<DateTime<Utc>> {
    let s = raw.trim();
    if let Some(c) = ISO.captures(s) {
        return iso(&c);
    }
    DateTime::parse_from_rfc2822(s).ok().map(|d| d.to_utc())
}

fn iso(c: &regex::Captures<'_>) -> Option<DateTime<Utc>> {
    let num = |i: usize| c.get(i).map(|m| m.as_str().parse::<i64>()).transpose().ok().flatten();
    let year = i32::try_from(num(1)?).ok()?;
    let month = u32::try_from(num(2).unwrap_or(1)).ok()?;
    let day = num(3).unwrap_or(1);
    let (hour, minute, second) = (num(4).unwrap_or(0), num(5).unwrap_or(0), num(6).unwrap_or(0));
    if !(1..=31).contains(&day) || hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    if hour == 24 && (minute, second) != (0, 0) {
        return None;
    }
    let millis = c.get(7).map_or(0, |m| {
        let digits: String = m.as_str().chars().chain("000".chars()).take(3).collect();
        digits.parse::<i64>().unwrap_or(0)
    });
    // V8 rolls a day past the end of the month over (2026-02-30 is March 2nd)
    let naive = NaiveDate::from_ymd_opt(year, month, 1)?.and_hms_opt(0, 0, 0)?
        + TimeDelta::days(day - 1)
        + TimeDelta::hours(hour)
        + TimeDelta::minutes(minute)
        + TimeDelta::seconds(second)
        + TimeDelta::milliseconds(millis);
    match c.get(8).map(|m| m.as_str()) {
        Some("Z" | "z") => Some(naive.and_utc()),
        Some(offset) => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let digits: String = offset[1..].chars().filter(char::is_ascii_digit).collect();
            let hours: i64 = digits[..2].parse().ok()?;
            let minutes: i64 = digits[2..].parse().ok()?;
            Some((naive - TimeDelta::minutes(sign * (hours * 60 + minutes))).and_utc())
        }
        None if c.get(4).is_none() => Some(naive.and_utc()),
        None => Local.from_local_datetime(&naive).earliest().map(|d| d.to_utc()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(raw: &str) -> Option<i64> {
        parse_js_date(raw).map(|d| d.timestamp_millis())
    }

    #[test]
    fn reads_what_v8_reads() {
        assert_eq!(ms("2026-01-01"), Some(1_767_225_600_000));
        assert_eq!(ms(" 2026-01-01 "), Some(1_767_225_600_000));
        assert_eq!(ms("2026"), Some(1_767_225_600_000));
        assert_eq!(ms("2026-01-01Z"), Some(1_767_225_600_000));
        assert_eq!(ms("+002026-01-01T00:00:00Z"), Some(1_767_225_600_000));
        assert_eq!(ms("2026-02-30"), Some(1_772_409_600_000));
        assert_eq!(ms("2026-01-01T24:00Z"), Some(1_767_312_000_000));
        assert_eq!(ms("2026-01-01T10:00:00.123456Z"), Some(1_767_261_600_123));
        assert_eq!(ms("2026-01-01t10:00:00z"), Some(1_767_261_600_000));
        assert_eq!(ms("2026-01-01T10:00:00+0200"), Some(1_767_254_400_000));
        assert_eq!(ms("2026-01-01T10:00:00+02:00"), Some(1_767_254_400_000));
        assert_eq!(ms("Thu, 01 Jan 2026 10:00:00 GMT"), Some(1_767_261_600_000));
        assert_eq!(ms("2026-11-25T14:01:36.424Z"), Some(1_795_615_296_424));
    }

    #[test]
    fn refuses_what_v8_refuses() {
        for bad in [
            "x",
            "",
            "2026-13-01",
            "2026-01-01T10Z",
            "2026-01-01T10:00:00,5Z",
            "2026-01-01T10:00:00.5+02",
            "2026-01-01T10:00:00 Z",
        ] {
            assert_eq!(ms(bad), None, "{bad}");
        }
    }
}
