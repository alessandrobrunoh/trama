//! `trama update`: replaces this binary with the latest GitHub release.
//!
//! Releases are tagged `cli-vX.Y.Z` and carry one raw binary per target (`trama-<target>[.exe]`) plus a
//! `SHA256SUMS` file. The download is verified against it before the running binary is swapped.

use std::time::Duration;

use clap::ArgMatches;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::{CliError, Result};
use crate::http::USER_AGENT;
use crate::output;
use crate::{Ctx, TARGET, VERSION};

const REPO: &str = "alessandrobrunoh/trama";
const TAG_PREFIX: &str = "cli-v";
const MAX_BINARY_BYTES: usize = 150 * 1024 * 1024;

pub fn asset_name(target: &str) -> String {
    if target.contains("windows") { format!("trama-{target}.exe") } else { format!("trama-{target}") }
}

pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut it = core.split('.');
    let v = (it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?);
    it.next().is_none().then_some(v)
}

#[derive(Debug, PartialEq)]
struct Release {
    version: String,
    assets: Vec<(String, String)>,
}

/// The newest stable CLI release (or exactly `wanted`) among a GitHub `releases` listing.
fn pick_release(releases: &Value, wanted: Option<&str>) -> Option<Release> {
    let wanted = wanted.map(|w| w.trim_start_matches('v'));
    releases
        .as_array()?
        .iter()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false) && (!r["prerelease"].as_bool().unwrap_or(false) || wanted.is_some()))
        .filter_map(|r| {
            let version = r["tag_name"].as_str()?.strip_prefix(TAG_PREFIX)?.to_string();
            let parsed = parse_version(&version)?;
            if wanted.is_some_and(|w| w != version) {
                return None;
            }
            let assets = r["assets"].as_array()?.iter().filter_map(|a| Some((a["name"].as_str()?.to_string(), a["browser_download_url"].as_str()?.to_string()))).collect();
            Some((parsed, Release { version, assets }))
        })
        .max_by_key(|(parsed, _)| *parsed)
        .map(|(_, r)| r)
}

/// `<hex>  <file>` lines, as written by `sha256sum`.
fn checksum_for(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, name) = line.split_once(char::is_whitespace)?;
        (name.trim().trim_start_matches('*') == file).then(|| hash.trim().to_ascii_lowercase())
    })
}

fn client(timeout: Duration) -> Result<reqwest::Client> {
    // Redirects are fine here: no credentials are sent, and GitHub serves assets from another host.
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| CliError::internal(e.to_string()))
}

async fn download(http: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let res = http.get(url).send().await.map_err(|_| CliError::network("could not download the release"))?;
    if !res.status().is_success() {
        return Err(CliError::network(format!("the download answered HTTP {}", res.status().as_u16())));
    }
    let bytes = res.bytes().await.map_err(|_| CliError::network("the download was interrupted"))?;
    if bytes.len() > MAX_BINARY_BYTES {
        return Err(CliError::internal("the downloaded file is unexpectedly large; refusing to install it"));
    }
    Ok(bytes.to_vec())
}

fn replace_running_binary(new_bytes: &[u8]) -> Result<std::path::PathBuf> {
    let exe = std::env::current_exe()?.canonicalize()?;
    let dir = exe.parent().ok_or_else(|| CliError::internal("cannot locate the install directory"))?;
    let staged = dir.join(format!(".trama-update-{}", std::process::id()));
    let write = || -> std::io::Result<()> {
        std::fs::write(&staged, new_bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&staged);
        CliError::internal(format!("cannot write to {}: {e}", dir.display())).hint("Reinstall with the install script, or rerun with permission to write there.")
    })?;
    #[cfg(windows)]
    {
        // A running .exe can be renamed but not overwritten.
        let old = exe.with_extension("exe.old");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&exe, &old)?;
        if let Err(e) = std::fs::rename(&staged, &exe) {
            let _ = std::fs::rename(&old, &exe);
            return Err(e.into());
        }
        let _ = std::fs::remove_file(&old);
    }
    #[cfg(not(windows))]
    std::fs::rename(&staged, &exe).inspect_err(|_| {
        let _ = std::fs::remove_file(&staged);
    })?;
    Ok(exe)
}

pub async fn run(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let http = client(ctx.timeout.max(Duration::from_secs(120)))?;
    let listing_url = crate::config::env("TRAMA_RELEASES_URL").unwrap_or_else(|| format!("https://api.github.com/repos/{REPO}/releases?per_page=50"));
    let res = http.get(&listing_url).header("Accept", "application/vnd.github+json").send().await.map_err(|_| CliError::network("could not reach GitHub to look for releases"))?;
    if !res.status().is_success() {
        return Err(CliError::network(format!("GitHub answered HTTP {} while listing releases", res.status().as_u16())));
    }
    let listing: Value = res.json().await.map_err(|_| CliError::internal("GitHub sent an unreadable release list"))?;
    let wanted = m.get_one::<String>("to").map(String::as_str);
    if let Some(w) = wanted
        && parse_version(w).is_none()
    {
        return Err(CliError::usage(format!("'{w}' is not a version like 1.2.3")));
    }
    let release = pick_release(&listing, wanted).ok_or_else(|| CliError::new(crate::error::Kind::NotFound, wanted.map_or("no CLI release found".to_string(), |w| format!("no release {w}"))))?;
    let current = parse_version(VERSION);
    let target_version = parse_version(&release.version);
    let newer = target_version > current;
    let info = json!({ "current": VERSION, "latest": release.version, "updateAvailable": newer, "target": TARGET });

    if m.get_flag("check") || (!newer && wanted.is_none()) {
        output::print(&info, &ctx.fmt);
        return Ok(());
    }
    if target_version == current {
        output::print(&info, &ctx.fmt);
        return Ok(());
    }

    let asset = asset_name(TARGET);
    let find = |name: &str| release.assets.iter().find(|(n, _)| n == name).map(|(_, u)| u.clone());
    let binary_url = find(&asset).ok_or_else(|| CliError::new(crate::error::Kind::NotFound, format!("release {} has no build for {TARGET}", release.version)))?;
    let sums_url = find("SHA256SUMS").ok_or_else(|| CliError::internal(format!("release {} has no SHA256SUMS; refusing to install an unverified binary", release.version)))?;

    let sums = String::from_utf8_lossy(&download(&http, &sums_url).await?).to_string();
    let expected = checksum_for(&sums, &asset).ok_or_else(|| CliError::internal(format!("SHA256SUMS does not list {asset}")))?;
    let bytes = download(&http, &binary_url).await?;
    let actual = hex::encode(Sha256::digest(&bytes));
    if actual != expected {
        return Err(CliError::internal(format!("checksum mismatch for {asset}: expected {expected}, got {actual}; nothing was installed")));
    }
    let path = replace_running_binary(&bytes)?;
    output::print(&json!({ "updated": true, "from": VERSION, "to": release.version, "path": path }), &ctx.fmt);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_assets_per_target() {
        assert_eq!(asset_name("aarch64-apple-darwin"), "trama-aarch64-apple-darwin");
        assert_eq!(asset_name("x86_64-pc-windows-msvc"), "trama-x86_64-pc-windows-msvc.exe");
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(parse_version("0.10.0") > parse_version("0.9.9"));
        assert!(parse_version("v1.0.0") > parse_version("0.99.99"));
        assert_eq!(parse_version("1.2.3-rc.1"), Some((1, 2, 3)));
        for bad in ["", "1.2", "1.2.3.4", "a.b.c"] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn picks_the_newest_stable_cli_release() {
        let listing = json!([
            { "tag_name": "v9.9.9", "assets": [] },
            { "tag_name": "cli-v0.2.0-rc1", "prerelease": true, "assets": [] },
            { "tag_name": "cli-v0.1.0", "assets": [{ "name": "SHA256SUMS", "browser_download_url": "https://x/sums" }] },
            { "tag_name": "cli-v0.1.5", "draft": true, "assets": [] },
            { "tag_name": "cli-v0.1.10", "assets": [{ "name": "trama-aarch64-apple-darwin", "browser_download_url": "https://x/bin" }] },
        ]);
        let r = pick_release(&listing, None).unwrap();
        assert_eq!(r.version, "0.1.10");
        assert_eq!(r.assets, vec![("trama-aarch64-apple-darwin".to_string(), "https://x/bin".to_string())]);
        assert_eq!(pick_release(&listing, Some("v0.1.0")).unwrap().version, "0.1.0");
        assert_eq!(pick_release(&listing, Some("0.2.0-rc1")).unwrap().version, "0.2.0-rc1");
        assert!(pick_release(&listing, Some("3.0.0")).is_none());
        assert!(pick_release(&json!([]), None).is_none());
    }

    #[test]
    fn reads_checksum_lines() {
        let sums = "AAAA11  trama-x86_64-unknown-linux-gnu\nbbbb22 *trama-x86_64-pc-windows-msvc.exe\n";
        assert_eq!(checksum_for(sums, "trama-x86_64-unknown-linux-gnu").as_deref(), Some("aaaa11"));
        assert_eq!(checksum_for(sums, "trama-x86_64-pc-windows-msvc.exe").as_deref(), Some("bbbb22"));
        assert_eq!(checksum_for(sums, "trama-other"), None);
    }
}
