//! `@IsDateString()`: class-validator's `isISO8601(value)` (validator.js, non-strict).
//!
//! validator.js tests one regular expression with two back-references (the date separator and
//! the time separator must repeat). The `regex` crate has none, so the same grammar is written
//! once per value those groups can take.

use std::sync::LazyLock;

use regex::Regex;

const HOURS: &str = "(?:[01][0-9]|2[0-3])";
const MINUTES: &str = "[0-5][0-9]";
const FRACTION: &str = "[.,][0-9]+";
const ZONE: &str = "(?:[zZ]|[+-](?:[01][0-9]|2[0-3]):?(?:[0-5][0-9])?)?";

/// The part after `T` or a space: every way the optional hour/minute group and its `:?`
/// separator (`\17`) can have matched.
fn time() -> String {
    let seconds = format!("(?:{MINUTES}(?:{FRACTION})?)?");
    let bare_seconds = format!("{MINUTES}(?:{FRACTION})?");
    let alternatives = [
        // no hour group: the separator is unset, so seconds follow directly
        format!("(?:{bare_seconds})?{ZONE}"),
        format!("{HOURS}(?:{FRACTION})?{seconds}{ZONE}"),
        format!("{HOURS}{MINUTES}(?:{FRACTION})?{seconds}{ZONE}"),
        // `hh:mm`: seconds repeat the colon, and a fraction may not be followed by one
        format!("{HOURS}:{MINUTES}(?:{FRACTION}|:{bare_seconds})?{ZONE}"),
        format!("24:?00(?:{FRACTION})?{seconds}{ZONE}"),
    ];
    format!("[T\\s](?:{})", alternatives.join("|"))
}

/// What follows the four-digit year, for a date separator of `sep` (`-` or nothing).
fn rest(sep: &str) -> Regex {
    let month = format!("(?:0[1-9]|1[0-2])(?:{sep}(?:[12][0-9]|0[1-9]|3[01]))?");
    let week = "W(?:[0-4][0-9]|5[0-3])(?:-?[1-7])?";
    let ordinal = "(?:00[1-9]|0[1-9][0-9]|[12][0-9]{2}|3(?:[0-5][0-9]|6[1-6]))";
    let pattern = format!("^(?:{sep}(?:{month}|{week}|{ordinal})(?:{})?)?$", time());
    Regex::new(&pattern).unwrap_or_else(|e| unreachable!("{e}"))
}

static REST: LazyLock<[Regex; 2]> = LazyLock::new(|| [rest("-"), rest("")]);

/// Does `@IsDateString()` accept `value`?
#[must_use]
pub fn is_date_string(value: &str) -> bool {
    let bytes = value.as_bytes();
    let sign = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    if bytes.len() < sign + 4 || !bytes[sign..sign + 4].iter().all(u8::is_ascii_digit) {
        return false;
    }
    let tail = &value[sign + 4..];
    // (?!\d{2}\b): `201701` is not a year followed by a month
    let t = tail.as_bytes();
    let word = |b: &u8| b.is_ascii_alphanumeric() || *b == b'_';
    if t.len() >= 2 && t[0].is_ascii_digit() && t[1].is_ascii_digit() && !t.get(2).is_some_and(word)
    {
        return false;
    }
    REST.iter().any(|re| re.is_match(tail))
}

#[cfg(test)]
mod tests {
    use super::is_date_string;

    #[test]
    fn accepts_what_validator_js_accepts() {
        for ok in [
            "2030",
            "2030-01",
            "2030-01-01",
            "20300101",
            "2030-W05-3",
            "2030-123",
            "2030-01-01T00:00:00.000Z",
            "2030-01-01T00:00:00Z",
            "2030-01-01T00:00",
            "2030-01-01T10",
            "2030-01-01 10:00",
            "2030-01-01T10:00:00+02:00",
            "2030-01-01T10:00:00-0530",
            "20300101T100000Z",
            "2030-01-01T24:00",
            "+2030-01-01",
            "2030-02-30",
        ] {
            assert!(is_date_string(ok), "{ok}");
        }
    }

    #[test]
    fn rejects_everything_else() {
        for bad in [
            "",
            "tomorrow",
            "2030-13-01",
            "2030-01-32",
            "203001",
            "2030-01-01T25:00",
            "2030-01-01T10:60",
            "2030-01-01T10:00:00.5:30",
            "2030-0101",
            "2030-01-01T10:00:00 ",
            "2030-01-01Tx",
            "01/01/2030",
            "2030-W54",
            "2030-367",
            "99999",
        ] {
            assert!(!is_date_string(bad), "{bad}");
        }
    }
}
