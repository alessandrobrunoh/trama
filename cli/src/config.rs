//! Profiles on disk and credential resolution.
//!
//! The file is `config.json` in `$TRAMA_CONFIG_DIR`, else `$XDG_CONFIG_HOME/trama` or `~/.config/trama`
//! (`%APPDATA%\trama` on Windows). It holds API keys, so it is written with mode 0600 in a 0700 directory.
//! Environment always wins over the file: `TRAMA_API_KEY`, `TRAMA_API_URL`, `TRAMA_WORKSPACE`, `TRAMA_PROFILE`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{CliError, Result};

pub const DEFAULT_API_URL: &str = "http://localhost:3000/api";
pub const DEFAULT_PROFILE: &str = "default";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Profile {
    pub url: String,
    pub token: String,
    /// Workspace slug the token belongs to (a token is bound to exactly one workspace).
    pub workspace: String,
    #[serde(default)]
    pub workspace_name: String,
    #[serde(default)]
    pub saved_at: String,
    /// Account this profile belongs to (`trama account add` groups several workspace keys under one name).
    /// Empty on profiles saved before accounts existed, or by a plain `trama login`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub account: String,
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct Config {
    #[serde(default)]
    pub current: Option<String>,
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
}

pub fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn config_dir() -> PathBuf {
    if let Some(dir) = env("TRAMA_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = env("APPDATA") {
            return PathBuf::from(appdata).join("trama");
        }
    }
    if let Some(xdg) = env("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg).join("trama");
    }
    home_dir().join(".config").join("trama")
}

pub fn home_dir() -> PathBuf {
    env("HOME")
        .or_else(|| env("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

impl Config {
    pub fn load() -> Result<Config> {
        let path = config_path();
        match std::fs::read_to_string(&path) {
            Ok(text) if text.trim().is_empty() => Ok(Config::default()),
            Ok(text) => serde_json::from_str(&text).map_err(|e| {
                CliError::internal(format!("{} is not valid: {e}", path.display()))
                    .hint("Fix or delete the file, then run `trama login`.")
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(CliError::internal(format!(
                "cannot read {}: {e}",
                path.display()
            ))),
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
        }
        write_private(&path, serde_json::to_string_pretty(self)?.as_bytes())
    }

    /// A profile name that does not collide with one already saved.
    pub fn unique_name(&self, wanted: &str) -> String {
        let base = sanitize_name(wanted);
        if !self.profiles.contains_key(&base) {
            return base;
        }
        for n in 2.. {
            let candidate = format!("{base}-{n}");
            if !self.profiles.contains_key(&candidate) {
                return candidate;
            }
        }
        unreachable!("the counter above never stops")
    }

    /// The profile name used when none is requested.
    pub fn default_name(&self) -> Option<String> {
        self.current
            .clone()
            .filter(|n| self.profiles.contains_key(n))
            .or_else(|| {
                self.profiles
                    .contains_key(DEFAULT_PROFILE)
                    .then(|| DEFAULT_PROFILE.to_string())
            })
            .or_else(|| {
                (self.profiles.len() == 1)
                    .then(|| self.profiles.keys().next().cloned())
                    .flatten()
            })
    }
}

/// Writes `bytes` to `path` atomically (temp file + rename) readable only by the current user.
pub fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Accepts a site origin (`https://trama.example.com`), the API URL (`…/api`) or the MCP URL (`…/mcp`)
/// and returns the API base URL without a trailing slash.
pub fn normalize_api_url(input: &str) -> Result<String> {
    let trimmed = input.trim().trim_end_matches('/');
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err(CliError::usage(format!(
            "'{input}' is not a URL: it must start with http:// or https://"
        )));
    };
    if scheme != "http" && scheme != "https" {
        return Err(CliError::usage(format!(
            "unsupported URL scheme '{scheme}': use http:// or https://"
        )));
    }
    if rest.is_empty() || rest.contains(['?', '#']) || rest.contains(char::is_whitespace) {
        return Err(CliError::usage(format!("'{input}' is not a valid API URL")));
    }
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if host.is_empty() || host.contains('@') {
        return Err(CliError::usage(format!("'{input}' is not a valid API URL")));
    }
    let path = if path.is_empty() {
        "/api".to_string()
    } else if let Some(prefix) = path.strip_suffix("/mcp") {
        format!("{prefix}/api")
    } else {
        path.to_string()
    };
    Ok(format!("{scheme}://{host}{path}"))
}

/// `http://` is only acceptable for loopback hosts: the key travels in every request.
pub fn check_transport(url: &str) -> Result<()> {
    if url.starts_with("https://") || env("TRAMA_ALLOW_INSECURE_HTTP").is_some() {
        return Ok(());
    }
    let rest = url.strip_prefix("http://").unwrap_or(url);
    let authority = rest.split('/').next().unwrap_or("");
    let host = if authority.starts_with('[') {
        authority
            .split(']')
            .next()
            .map(|h| format!("{h}]"))
            .unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or("").to_string()
    };
    let local = host == "localhost"
        || host == "127.0.0.1"
        || host == "[::1]"
        || host.ends_with(".localhost");
    if local {
        Ok(())
    } else {
        Err(CliError::usage(format!(
            "refusing to send the API key over plain http to '{host}'"
        ))
        .hint("Use an https:// URL, or set TRAMA_ALLOW_INSECURE_HTTP=1 if the network is trusted."))
    }
}

/// `nbl_3f9a…` – enough to recognise a key, never the secret.
pub fn redact(token: &str) -> String {
    let head: String = token.chars().take(8).collect();
    format!("{head}…")
}

/// Profile and account names are what `--profile` and `--account` select, so keep them shell-friendly.
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "profile".to_string()
    } else {
        trimmed.chars().take(40).collect()
    }
}

/// Comma- or whitespace-separated list (`acme,beta` or one per line), empty pieces dropped.
pub fn split_list(input: &str) -> Vec<String> {
    input
        .split([',', '\n', '\r', '\t', ' '])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn check_token_format(token: &str) -> Result<()> {
    if token.starts_with("nbl_") && token.len() <= 256 && !token.contains(char::is_whitespace) {
        Ok(())
    } else {
        Err(CliError::auth(
            "the API key must start with nbl_ (create one in Trama → Settings → API tokens)",
        ))
    }
}

#[derive(Default, Clone)]
pub struct Overrides {
    pub profile: Option<String>,
    pub api_url: Option<String>,
    /// `--account`: only profiles that belong to these accounts (comma-separated).
    pub accounts: Vec<String>,
    /// `--workspace`: only profiles bound to these workspace slugs.
    pub workspaces: Vec<String>,
    /// `--all-workspaces`: every saved profile, not just the current one.
    pub all: bool,
}

#[derive(Debug, Clone)]
pub struct Creds {
    pub url: String,
    pub token: String,
    /// Known workspace slug; `None` means "ask `/auth/token`".
    pub workspace: Option<String>,
    pub profile: Option<String>,
    pub from_env: bool,
}

/// True when the command asked for more than the single current profile.
pub fn multi_requested(ov: &Overrides) -> bool {
    ov.all
        || !ov.accounts.is_empty()
        || !ov.workspaces.is_empty()
        || ov.profile.as_deref().is_some_and(|p| p.contains(','))
        || env("TRAMA_ACCOUNTS").is_some()
        || env("TRAMA_WORKSPACES").is_some()
}

/// The credentials a command should run against.
///
/// One entry unless `--all-workspaces`, `--account`, `--workspace` or a comma-separated `--profile` asked for
/// several. `TRAMA_API_KEY` still means exactly one key and wins over every selection: a CI job that
/// injects a key must not silently also talk to every workspace saved on the machine.
///
/// `every_saved` is for `trama mcp`: with no narrower selection it speaks for every saved profile,
/// because an MCP connection is what an agent keeps open, not one command.
pub fn resolve_many(ov: &Overrides) -> Result<Vec<Creds>> {
    resolve_selected(ov, false)
}

/// Like [`resolve_many`], but with nothing selected it returns every saved profile instead of the current one.
pub fn resolve_all_saved(ov: &Overrides) -> Result<Vec<Creds>> {
    resolve_selected(ov, true)
}

fn resolve_selected(ov: &Overrides, every_saved: bool) -> Result<Vec<Creds>> {
    if env("TRAMA_API_KEY").is_some() {
        if multi_requested(ov) {
            return Err(CliError::usage("TRAMA_API_KEY is a single key, so it cannot be combined with --all-workspaces, --account or several profiles")
                .hint("Unset TRAMA_API_KEY, or run once per key."));
        }
        return Ok(vec![resolve(ov)?]);
    }
    if !multi_requested(ov) && !every_saved {
        return Ok(vec![resolve(ov)?]);
    }
    let cfg = Config::load()?;
    let url_override = ov
        .api_url
        .clone()
        .or_else(|| env("TRAMA_API_URL"))
        .map(|u| normalize_api_url(&u))
        .transpose()?;
    if let Some(url) = &url_override {
        check_transport(url)?;
    }
    let mut selected: Vec<(String, Profile)> = Vec::new();
    let wanted_profiles: Vec<String> = ov
        .profile
        .clone()
        .or_else(|| env("TRAMA_PROFILE"))
        .map(|p| split_list(&p))
        .unwrap_or_default();
    if !wanted_profiles.is_empty() {
        for name in &wanted_profiles {
            let profile = cfg.profiles.get(name).cloned().ok_or_else(|| {
                CliError::usage(format!("no profile named '{name}'"))
                    .hint("`trama profile list` shows the saved ones.")
            })?;
            selected.push((name.clone(), profile));
        }
    } else if every_saved
        || ov.all
        || !ov.workspaces.is_empty()
        || !ov.accounts.is_empty()
        || env("TRAMA_ACCOUNTS").is_some()
        || env("TRAMA_WORKSPACES").is_some()
    {
        selected = cfg
            .profiles
            .iter()
            .map(|(n, p)| (n.clone(), p.clone()))
            .collect();
    }
    let accounts = if ov.accounts.is_empty() {
        env("TRAMA_ACCOUNTS")
            .map(|v| split_list(&v))
            .unwrap_or_default()
    } else {
        ov.accounts.clone()
    };
    if !accounts.is_empty() {
        selected.retain(|(_, p)| accounts.iter().any(|a| a == &p.account));
        if selected.is_empty() {
            let known = account_names(&cfg);
            return Err(CliError::usage(format!(
                "no profile belongs to account '{}'",
                accounts.join(",")
            ))
            .hint(if known.is_empty() {
                "Add one with `trama account add`.".into()
            } else {
                format!("Saved accounts: {}", known.join(", "))
            }));
        }
    }
    let workspaces = if ov.workspaces.is_empty() {
        env("TRAMA_WORKSPACES")
            .map(|v| split_list(&v))
            .unwrap_or_default()
    } else {
        ov.workspaces.clone()
    };
    if !workspaces.is_empty() {
        selected.retain(|(_, p)| workspaces.iter().any(|w| w == &p.workspace));
        if selected.is_empty() {
            return Err(CliError::usage(format!(
                "no saved profile is bound to workspace '{}'",
                workspaces.join(",")
            ))
            .hint("`trama profile list` shows the workspace of each profile."));
        }
    }
    if let Some(url) = &url_override {
        selected.retain(|(_, p)| &p.url == url);
    }
    if selected.is_empty() {
        return Err(CliError::not_logged_in());
    }
    selected.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for (name, profile) in selected {
        check_token_format(&profile.token)?;
        let url = url_override.clone().unwrap_or(profile.url.clone());
        check_transport(&url)?;
        // The same key saved twice would double every row.
        if !seen.insert((url.clone(), profile.token.clone())) {
            continue;
        }
        out.push(Creds {
            url,
            token: profile.token,
            workspace: Some(profile.workspace).filter(|w| !w.is_empty()),
            profile: Some(name),
            from_env: false,
        });
    }
    Ok(out)
}

fn account_names(cfg: &Config) -> Vec<String> {
    let mut names: Vec<String> = cfg
        .profiles
        .values()
        .map(|p| p.account.clone())
        .filter(|a| !a.is_empty())
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Flags > environment > profile on disk > defaults.
pub fn resolve(ov: &Overrides) -> Result<Creds> {
    let cfg = Config::load()?;
    let requested = ov
        .profile
        .clone()
        .or_else(|| env("TRAMA_PROFILE"))
        .filter(|p| !p.contains(','));
    if let Some(name) = &requested
        && !cfg.profiles.contains_key(name)
        && env("TRAMA_API_KEY").is_none()
    {
        return Err(CliError::usage(format!("no profile named '{name}'"))
            .hint("`trama profile list` shows the saved ones."));
    }
    let name = requested.or_else(|| cfg.default_name());
    let profile = name.as_ref().and_then(|n| cfg.profiles.get(n));
    let env_key = env("TRAMA_API_KEY");
    let from_env = env_key.is_some();
    let token = match env_key {
        Some(k) => k,
        None => profile
            .map(|p| p.token.clone())
            .ok_or_else(CliError::not_logged_in)?,
    };
    check_token_format(&token)?;
    let raw_url = ov
        .api_url
        .clone()
        .or_else(|| env("TRAMA_API_URL"))
        .or_else(|| profile.map(|p| p.url.clone()))
        .unwrap_or_else(|| DEFAULT_API_URL.to_string());
    let url = normalize_api_url(&raw_url)?;
    check_transport(&url)?;
    let workspace = env("TRAMA_WORKSPACE").or_else(|| {
        if from_env {
            None
        } else {
            profile
                .map(|p| p.workspace.clone())
                .filter(|w| !w.is_empty())
        }
    });
    Ok(Creds {
        url,
        token,
        workspace,
        profile: name,
        from_env,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls() {
        let n = |s| normalize_api_url(s).unwrap();
        assert_eq!(
            n("https://trama.example.com"),
            "https://trama.example.com/api"
        );
        assert_eq!(
            n("https://trama.example.com/"),
            "https://trama.example.com/api"
        );
        assert_eq!(
            n("https://trama.example.com/api/"),
            "https://trama.example.com/api"
        );
        assert_eq!(
            n("https://trama.example.com/mcp"),
            "https://trama.example.com/api"
        );
        assert_eq!(n("http://localhost:3000/api"), "http://localhost:3000/api");
        assert_eq!(
            n("https://example.com/trama/mcp"),
            "https://example.com/trama/api"
        );
        for bad in [
            "trama.example.com",
            "ftp://x",
            "https://",
            "https://u:p@x/api",
            "https://x/api?q=1",
            "http://a b",
        ] {
            assert!(normalize_api_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn plain_http_only_for_loopback() {
        assert!(check_transport("https://trama.example.com/api").is_ok());
        for ok in [
            "http://localhost:3000/api",
            "http://127.0.0.1:3000/api",
            "http://[::1]:3000/api",
            "http://trama.localhost/api",
        ] {
            assert!(check_transport(ok).is_ok(), "{ok}");
        }
        assert!(check_transport("http://trama.example.com/api").is_err());
        assert!(check_transport("http://localhost.evil.com/api").is_err());
    }

    #[test]
    fn validates_and_redacts_tokens() {
        assert!(check_token_format("nbl_abc123").is_ok());
        assert!(check_token_format("ghp_abc").is_err());
        assert!(check_token_format("nbl_a b").is_err());
        assert_eq!(redact("nbl_3f9a1c2d4e5f"), "nbl_3f9a…");
    }

    #[test]
    fn picks_the_default_profile() {
        let p = |url: &str| Profile {
            url: url.into(),
            token: "nbl_x".into(),
            workspace: "acme".into(),
            workspace_name: "Acme".into(),
            saved_at: String::new(),
            account: String::new(),
        };
        let mut cfg = Config::default();
        assert_eq!(cfg.default_name(), None);
        cfg.profiles.insert("work".into(), p("a"));
        assert_eq!(cfg.default_name().as_deref(), Some("work"));
        cfg.profiles.insert("default".into(), p("b"));
        assert_eq!(cfg.default_name().as_deref(), Some("default"));
        cfg.current = Some("work".into());
        assert_eq!(cfg.default_name().as_deref(), Some("work"));
        cfg.current = Some("gone".into());
        assert_eq!(cfg.default_name().as_deref(), Some("default"));
    }

    fn sample(url: &str, token: &str, workspace: &str, account: &str) -> Profile {
        Profile {
            url: url.into(),
            token: token.into(),
            workspace: workspace.into(),
            workspace_name: workspace.into(),
            saved_at: String::new(),
            account: account.into(),
        }
    }

    #[test]
    fn unique_names_skip_what_is_taken() {
        let mut cfg = Config::default();
        assert_eq!(cfg.unique_name("Acme Inc."), "Acme-Inc");
        cfg.profiles
            .insert("acme".into(), sample("a", "nbl_x", "acme", ""));
        assert_eq!(cfg.unique_name("acme"), "acme-2");
        cfg.profiles
            .insert("acme-2".into(), sample("a", "nbl_y", "other", ""));
        assert_eq!(cfg.unique_name("acme"), "acme-3");
        assert_eq!(cfg.unique_name("***"), "profile");
    }

    #[test]
    fn splits_token_lists() {
        assert_eq!(
            split_list("nbl_a, nbl_b\nnbl_c"),
            vec!["nbl_a", "nbl_b", "nbl_c"]
        );
        assert!(split_list("  ,  ").is_empty());
    }
}
