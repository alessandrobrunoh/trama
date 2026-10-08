//! Small helpers: time, durations, stdin, prompts, browser, hostname.

use std::io::{IsTerminal, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{CliError, Result};

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// ISO-8601 UTC (`2026-10-08T14:03:09Z`) for a Unix timestamp.
pub fn iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil-from-days algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn now_iso() -> String {
    iso(now_secs())
}

/// `90d`, `12h`, `30m`, `2w` → seconds. `never` → `None`.
pub fn parse_duration(input: &str) -> Result<Option<u64>> {
    let s = input.trim().to_ascii_lowercase();
    if s == "never" || s == "none" {
        return Ok(None);
    }
    let bad = || CliError::usage(format!("'{input}' is not a duration: use 30m, 12h, 90d, 2w or 'never'"));
    let (num, unit) = s.split_at(s.len().saturating_sub(1));
    let n: u64 = num.parse().map_err(|_| bad())?;
    let mult = match unit {
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        "w" => 604_800,
        _ => return Err(bad()),
    };
    if n == 0 {
        return Err(bad());
    }
    n.checked_mul(mult).map(Some).ok_or_else(bad)
}

pub fn stdout_is_tty() -> bool {
    std::io::stdout().is_terminal()
}

pub fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal() && std::env::var_os("TRAMA_NO_INPUT").is_none()
}

static STDIN_USED: AtomicBool = AtomicBool::new(false);

/// Reads all of stdin. Only one consumer per run: a second read is a usage error, not a silent empty string.
pub fn read_stdin() -> Result<String> {
    if STDIN_USED.swap(true, Ordering::SeqCst) {
        return Err(CliError::usage("stdin (`-`) can only be used once per command"));
    }
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf)?;
    Ok(buf)
}

/// `-` = stdin, otherwise a file path.
pub fn read_path_or_stdin(path: &str) -> Result<String> {
    if path == "-" {
        return read_stdin();
    }
    std::fs::read_to_string(path).map_err(|e| CliError::usage(format!("cannot read '{path}': {e}")))
}

/// Prompts go to stderr so stdout stays machine-readable.
pub fn prompt(label: &str, default: Option<&str>) -> Result<String> {
    if !interactive() {
        return Err(CliError::usage(format!("{label} is required (no terminal to ask on)")));
    }
    let mut err = std::io::stderr();
    match default {
        Some(d) if !d.is_empty() => write!(err, "{label} [{d}]: ")?,
        _ => write!(err, "{label}: ")?,
    }
    err.flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    let line = line.trim();
    Ok(if line.is_empty() { default.unwrap_or("").to_string() } else { line.to_string() })
}

pub fn prompt_secret(label: &str) -> Result<String> {
    if !interactive() {
        return Err(CliError::usage(format!("{label} is required (no terminal to ask on)")));
    }
    let mut err = std::io::stderr();
    write!(err, "{label}: ")?;
    err.flush()?;
    let secret = rpassword::read_password()?;
    Ok(secret.trim().to_string())
}

pub fn confirm(question: &str) -> Result<bool> {
    let answer = prompt(&format!("{question} [y/N]"), Some("n"))?;
    Ok(matches!(answer.to_ascii_lowercase().as_str(), "y" | "yes"))
}

pub fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    let _ = result;
}

pub fn hostname() -> String {
    for var in ["HOSTNAME", "COMPUTERNAME", "HOST"] {
        if let Some(h) = crate::config::env(var) {
            return h;
        }
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "cli".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_iso_dates() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso(1_791_468_189), "2026-10-08T14:03:09Z");
        assert_eq!(iso(4_102_444_799), "2099-12-31T23:59:59Z");
    }

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration("90d").unwrap(), Some(90 * 86_400));
        assert_eq!(parse_duration("12h").unwrap(), Some(43_200));
        assert_eq!(parse_duration("2w").unwrap(), Some(1_209_600));
        assert_eq!(parse_duration("never").unwrap(), None);
        for bad in ["", "d", "0d", "10", "10y", "-5d", "1.5d"] {
            assert!(parse_duration(bad).is_err(), "{bad}");
        }
    }
}
