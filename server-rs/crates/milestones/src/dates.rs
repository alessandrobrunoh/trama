//! `@IsISO8601()` and `new Date(value)` for the `targetDate` field.
//!
//! [`is_iso8601`] follows validator.js (what class-validator calls) for the forms people send:
//! calendar, ordinal and week dates, with an optional time and zone. [`parse`] reads what
//! JavaScript's `Date` constructor reads natively: `YYYY`, `YYYY-MM` and `YYYY-MM-DD`, with an
//! optional `T`/space and `HH:mm[:ss[.fff]]` and a zone (`Z`, `+HH:mm`, `+HHmm`, `+HH`). A time
//! without a zone is UTC (the server's zone). Days up to 31 are accepted in every month and
//! overflow into the next one, as V8 does.

use chrono::{DateTime, Days, NaiveDate, NaiveTime, TimeDelta, Utc};

fn digit(c: &[char], i: usize) -> bool {
    c.get(i).is_some_and(char::is_ascii_digit)
}

fn digits(c: &[char], i: usize, n: usize) -> bool {
    (i..i + n).all(|j| digit(c, j))
}

fn num(c: &[char], i: usize, n: usize) -> Option<u32> {
    if !digits(c, i, n) {
        return None;
    }
    c[i..i + n].iter().collect::<String>().parse().ok()
}

fn is_word(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

/// `@IsISO8601()` (validator.js, non-strict).
#[must_use]
pub fn is_iso8601(value: &str) -> bool {
    let c: Vec<char> = value.chars().collect();
    let mut i = usize::from(matches!(c.first(), Some('+' | '-')));
    if !digits(&c, i, 4) {
        return false;
    }
    i += 4;
    // (?!\d{2}\b): a year followed by two digits is neither a date nor a year
    if digits(&c, i, 2) && !c.get(i + 2).copied().is_some_and(is_word) {
        return false;
    }
    if i == c.len() {
        return true;
    }
    let dash = c[i] == '-';
    let j = i + usize::from(dash);
    date_ends(&c, j, dash).into_iter().any(|end| rest_ok(&c, end))
}

/// Where the date part starting at `j` may end (the alternatives of the pattern).
fn date_ends(c: &[char], j: usize, dash: bool) -> Vec<usize> {
    let mut ends = Vec::new();
    // month, then an optional day behind the same separator
    if num(c, j, 2).is_some_and(|m| (1..=12).contains(&m)) {
        ends.push(j + 2);
        let d = j + 2 + usize::from(dash);
        if (!dash || c.get(j + 2) == Some(&'-'))
            && num(c, d, 2).is_some_and(|day| (1..=31).contains(&day))
        {
            ends.push(d + 2);
        }
    }
    // week, then an optional weekday
    if c.get(j) == Some(&'W') && num(c, j + 1, 2).is_some_and(|w| w <= 53) {
        let w = j + 3;
        ends.push(w);
        let d = w + usize::from(c.get(w) == Some(&'-'));
        if c.get(d).is_some_and(|ch| ('1'..='7').contains(ch)) {
            ends.push(d + 1);
        }
    }
    // day of the year
    if num(c, j, 3).is_some_and(|d| (1..=366).contains(&d)) {
        ends.push(j + 3);
    }
    ends
}

/// After the date: nothing, or `T`/whitespace and an optional time.
fn rest_ok(c: &[char], end: usize) -> bool {
    match c.get(end) {
        None => true,
        Some(ch) if *ch == 'T' || ch.is_whitespace() => time_ok(c, end + 1),
        Some(_) => false,
    }
}

fn time_ok(c: &[char], mut p: usize) -> bool {
    if num(c, p, 2).is_some_and(|h| h <= 23) {
        p += 2;
        // minutes, with or without a colon
        let colon = usize::from(c.get(p) == Some(&':'));
        if num(c, p + colon, 2).is_some_and(|m| m <= 59) {
            let sep = if colon == 1 { ":" } else { "" };
            p += colon + 2;
            p = fraction(c, p);
            if seconds_follow(c, p, sep) {
                p += sep.len() + 2;
                p = fraction(c, p);
            }
        } else {
            p = fraction(c, p);
        }
    } else if c.get(p) == Some(&'2') && c.get(p + 1) == Some(&'4') {
        // 24:00
        let colon = usize::from(c.get(p + 2) == Some(&':'));
        if num(c, p + 2 + colon, 2) == Some(0) {
            p += 4 + colon;
        }
    }
    p = zone(c, p);
    p == c.len()
}

fn seconds_follow(c: &[char], p: usize, sep: &str) -> bool {
    let colon = sep.len();
    (colon == 0 || c.get(p) == Some(&':')) && num(c, p + colon, 2).is_some_and(|s| s <= 59)
}

/// `[.,]\d+` not followed by a colon.
fn fraction(c: &[char], p: usize) -> usize {
    if !matches!(c.get(p), Some('.' | ',')) || !digit(c, p + 1) {
        return p;
    }
    let mut q = p + 1;
    while digit(c, q) {
        q += 1;
    }
    if c.get(q) == Some(&':') { p } else { q }
}

/// `Z`, or a sign, hours, an optional colon and optional minutes.
fn zone(c: &[char], p: usize) -> usize {
    match c.get(p) {
        Some('z' | 'Z') => p + 1,
        Some('+' | '-') if num(c, p + 1, 2).is_some_and(|h| h <= 23) => {
            let mut q = p + 3;
            let colon = usize::from(c.get(q) == Some(&':'));
            if num(c, q + colon, 2).is_some_and(|m| m <= 59) {
                q += colon + 2;
            }
            q
        }
        _ => p,
    }
}

/// `new Date(value)` for the ISO forms JavaScript reads natively; `None` when it does not.
#[must_use]
pub fn parse(value: &str) -> Option<DateTime<Utc>> {
    let c: Vec<char> = value.trim().chars().collect();
    let year = i32::try_from(num(&c, 0, 4)?).ok()?;
    let mut p = 4;
    let mut month = 1;
    let mut day = 1;
    if c.get(p) == Some(&'-') {
        month = num(&c, p + 1, 2).filter(|m| (1..=12).contains(m))?;
        p += 3;
        if c.get(p) == Some(&'-') {
            day = num(&c, p + 1, 2).filter(|d| (1..=31).contains(d))?;
            p += 3;
        }
    }
    let date =
        NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_days(Days::new(u64::from(day - 1)))?;
    let mut time = NaiveTime::MIN;
    let mut extra_day = false;
    let mut offset_secs: i64 = 0;
    if p < c.len() {
        if c[p] != 'T' && c[p] != ' ' {
            return None;
        }
        p += 1;
        let hour = num(&c, p, 2).filter(|h| *h <= 24)?;
        if c.get(p + 2) != Some(&':') {
            return None;
        }
        let minute = num(&c, p + 3, 2).filter(|m| *m <= 59)?;
        p += 5;
        let (mut second, mut milli) = (0, 0);
        if c.get(p) == Some(&':') {
            second = num(&c, p + 1, 2).filter(|s| *s <= 59)?;
            p += 3;
            if c.get(p) == Some(&'.') {
                let start = p + 1;
                let mut q = start;
                while digit(&c, q) {
                    q += 1;
                }
                if q == start {
                    return None;
                }
                let frac: String = c[start..q].iter().take(3).collect();
                milli = format!("{frac:0<3}").parse().ok()?;
                p = q;
            }
        }
        if hour == 24 {
            if minute != 0 || second != 0 || milli != 0 {
                return None;
            }
            extra_day = true;
            time = NaiveTime::MIN;
        } else {
            time = NaiveTime::from_hms_milli_opt(hour, minute, second, milli)?;
        }
        match c.get(p) {
            None => {}
            Some('Z' | 'z') if p + 1 == c.len() => {}
            Some(sign @ ('+' | '-')) => {
                let h = i64::from(num(&c, p + 1, 2).filter(|h| *h <= 23)?);
                let mut q = p + 3;
                if c.get(q) == Some(&':') {
                    q += 1;
                }
                let m =
                    if q < c.len() { i64::from(num(&c, q, 2).filter(|m| *m <= 59)?) } else { 0 };
                if q < c.len() && q + 2 != c.len() {
                    return None;
                }
                let secs = h * 3600 + m * 60;
                offset_secs = if *sign == '-' { -secs } else { secs };
            }
            Some(_) => return None,
        }
    }
    let mut at = date.and_time(time).and_utc();
    if extra_day {
        at += TimeDelta::days(1);
    }
    Some(at - TimeDelta::seconds(offset_secs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use trama_core::time::to_iso;

    #[test]
    fn validates_like_validator_js() {
        for ok in [
            "2026",
            "2026-12",
            "2026-12-01",
            "20261201",
            "2026-W10-3",
            "2026-001",
            "2026-12-01T00:00:00.000Z",
            "2026-12-01T10:30",
            "2026-12-01T10:30:15+02:00",
            "2026-12-01 10:30:15,5Z",
            "2026-12-01T24:00",
            "+20261201",
        ] {
            assert!(is_iso8601(ok), "{ok}");
        }
        for bad in [
            "",
            "tomorrow",
            "2026-13-01",
            "2026-12-32",
            "202612",
            "2026-12-01T25:00",
            "2026-12-01T10:60",
            "12/01/2026",
            "2026-12-01T10:30:00X",
            "2026-12-01x",
        ] {
            assert!(!is_iso8601(bad), "{bad}");
        }
    }

    #[test]
    fn parses_like_the_date_constructor() {
        let iso = |s: &str| parse(s).map(|d| to_iso(&d));
        assert_eq!(iso("2026-12-01T00:00:00.000Z").as_deref(), Some("2026-12-01T00:00:00.000Z"));
        assert_eq!(iso("2026-12-15").as_deref(), Some("2026-12-15T00:00:00.000Z"));
        assert_eq!(iso("2026-12").as_deref(), Some("2026-12-01T00:00:00.000Z"));
        assert_eq!(iso("2026").as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(iso("2026-12-01T10:30").as_deref(), Some("2026-12-01T10:30:00.000Z"));
        assert_eq!(iso("2026-12-01T10:30:15.5Z").as_deref(), Some("2026-12-01T10:30:15.500Z"));
        assert_eq!(iso("2026-12-01T10:30:00+02:00").as_deref(), Some("2026-12-01T08:30:00.000Z"));
        assert_eq!(iso("2026-12-01T10:30:00-0530").as_deref(), Some("2026-12-01T16:00:00.000Z"));
        assert_eq!(iso("2026-12-01 10:30:00Z").as_deref(), Some("2026-12-01T10:30:00.000Z"));
        assert_eq!(iso("2026-12-01T24:00:00Z").as_deref(), Some("2026-12-02T00:00:00.000Z"));
        // V8 lets a day overflow into the next month
        assert_eq!(iso("2026-02-31").as_deref(), Some("2026-03-03T00:00:00.000Z"));
        assert_eq!(iso("20261201"), None);
        assert_eq!(iso("2026-12-01T10:30:00X"), None);
    }
}
