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
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct Config {
    #[serde(default)]
    pub current: Option<String>,
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
}

pub fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
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
    env("HOME").or_else(|| env("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

impl Config {
    pub fn load() -> Result<Config> {
        let path = config_path();
        match std::fs::read_to_string(&path) {
            Ok(text) if text.trim().is_empty() => Ok(Config::default()),
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| CliError::internal(format!("{} is not valid: {e}", path.display())).hint("Fix or delete the file, then run `trama login`.")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(CliError::internal(format!("cannot read {}: {e}", path.display()))),
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

    /// The profile name used when none is requested.
    pub fn default_name(&self) -> Option<String> {
        self.current
            .clone()
            .filter(|n| self.profiles.contains_key(n))
            .or_else(|| self.profiles.contains_key(DEFAULT_PROFILE).then(|| DEFAULT_PROFILE.to_string()))
            .or_else(|| (self.profiles.len() == 1).then(|| self.profiles.keys().next().cloned()).flatten())
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
        return Err(CliError::usage(format!("'{input}' is not a URL: it must start with http:// or https://")));
    };
    if scheme != "http" && scheme != "https" {
        return Err(CliError::usage(format!("unsupported URL scheme '{scheme}': use http:// or https://")));
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
        authority.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or("").to_string()
    };
    let local = host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host.ends_with(".localhost");
    if local {
        Ok(())
    } else {
        Err(CliError::usage(format!("refusing to send the API key over plain http to '{host}'"))
            .hint("Use an https:// URL, or set TRAMA_ALLOW_INSECURE_HTTP=1 if the network is trusted."))
    }
}

/// `nbl_3f9a…` – enough to recognise a key, never the secret.
pub fn redact(token: &str) -> String {
    let head: String = token.chars().take(8).collect();
    format!("{head}…")
}

pub fn check_token_format(token: &str) -> Result<()> {
    if token.starts_with("nbl_") && token.len() <= 256 && !token.contains(char::is_whitespace) {
        Ok(())
    } else {
        Err(CliError::auth("the API key must start with nbl_ (create one in Trama → Settings → API tokens)"))
    }
}

#[derive(Default, Clone)]
pub struct Overrides {
    pub profile: Option<String>,
    pub api_url: Option<String>,
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

/// Flags > environment > profile on disk > defaults.
pub fn resolve(ov: &Overrides) -> Result<Creds> {
    let cfg = Config::load()?;
    let requested = ov.profile.clone().or_else(|| env("TRAMA_PROFILE"));
    if let Some(name) = &requested
        && !cfg.profiles.contains_key(name)
        && env("TRAMA_API_KEY").is_none()
    {
        return Err(CliError::usage(format!("no profile named '{name}'")).hint("`trama profile list` shows the saved ones."));
    }
    let name = requested.or_else(|| cfg.default_name());
    let profile = name.as_ref().and_then(|n| cfg.profiles.get(n));
    let env_key = env("TRAMA_API_KEY");
    let from_env = env_key.is_some();
    let token = match env_key {
        Some(k) => k,
        None => profile.map(|p| p.token.clone()).ok_or_else(CliError::not_logged_in)?,
    };
    check_token_format(&token)?;
    let raw_url = ov.api_url.clone().or_else(|| env("TRAMA_API_URL")).or_else(|| profile.map(|p| p.url.clone())).unwrap_or_else(|| DEFAULT_API_URL.to_string());
    let url = normalize_api_url(&raw_url)?;
    check_transport(&url)?;
    let workspace = env("TRAMA_WORKSPACE").or_else(|| if from_env { None } else { profile.map(|p| p.workspace.clone()).filter(|w| !w.is_empty()) });
    Ok(Creds { url, token, workspace, profile: name, from_env })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls() {
        let n = |s| normalize_api_url(s).unwrap();
        assert_eq!(n("https://trama.example.com"), "https://trama.example.com/api");
        assert_eq!(n("https://trama.example.com/"), "https://trama.example.com/api");
        assert_eq!(n("https://trama.example.com/api/"), "https://trama.example.com/api");
        assert_eq!(n("https://trama.example.com/mcp"), "https://trama.example.com/api");
        assert_eq!(n("http://localhost:3000/api"), "http://localhost:3000/api");
        assert_eq!(n("https://example.com/trama/mcp"), "https://example.com/trama/api");
        for bad in ["trama.example.com", "ftp://x", "https://", "https://u:p@x/api", "https://x/api?q=1", "http://a b"] {
            assert!(normalize_api_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn plain_http_only_for_loopback() {
        assert!(check_transport("https://trama.example.com/api").is_ok());
        for ok in ["http://localhost:3000/api", "http://127.0.0.1:3000/api", "http://[::1]:3000/api", "http://trama.localhost/api"] {
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
        let p = |url: &str| Profile { url: url.into(), token: "nbl_x".into(), workspace: "acme".into(), workspace_name: "Acme".into(), saved_at: String::new() };
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
}
