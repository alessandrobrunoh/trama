//! SuperGrok through the official Grok Build CLI (`server/src/ai/grok-build.service.ts`): device
//! login, disconnect and one-shot replies, each person with their own credentials directory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use axum::http::StatusCode;
use regex::Regex;
use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use trama_common::crypto::sha256_hex;
use trama_contracts::js;
use trama_core::ids::uid;
use trama_core::{AppError, Config};
use url::Url;
use utoipa::ToSchema;

use crate::provider::AiMessage;
use crate::signal::Signal;

/// Login sessions that may be open at once.
const MAX_ATTEMPTS: usize = 20;
/// A device code is good for this long.
const LOGIN_TTL: Duration = Duration::from_secs(10 * 60);
/// How much CLI output a login keeps (characters).
const LOGIN_OUTPUT_KEEP: usize = 16_000;
/// How much of a CLI's output is read (characters).
const CLI_OUTPUT_MAX: usize = 256_000;
const REPLY_MAX: usize = 16_000;

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new("\u{1b}\\[[0-9;]*m").expect("regex"));
static CODE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:user\s+)?code\s*[:：]?\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b").expect("regex")
});
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"https://[^\s"'<>]+"#).expect("regex"));

/// `login` of the status and the answer of a login that is not finished.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct LoginDetails {
    /// Always false: the account is not connected yet.
    pub connected: bool,
    /// The device code to enter.
    pub code: Option<String>,
    /// Where to enter it.
    pub url: Option<String>,
    /// Why the login stopped.
    pub error: Option<String>,
}

/// `GET /ai/status` → `supergrok`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct GrokStatus {
    /// `GROK_HOME_DIR` is set.
    pub available: bool,
    /// This person has credentials.
    pub connected: bool,
    /// The login in progress, if any.
    pub login: Option<LoginDetails>,
}

/// `POST /ai/supergrok/login`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(untagged)]
pub enum LoginResponse {
    /// Already connected.
    Connected {
        /// Always true.
        connected: bool,
    },
    /// A login is running.
    Pending(LoginDetails),
}

/// `DELETE /ai/supergrok/login`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct DisconnectResponse {
    /// Whether credentials are still there after the logout.
    pub connected: bool,
}

#[derive(Debug, Default)]
struct AttemptState {
    output: String,
    code: Option<String>,
    url: Option<String>,
    error: Option<String>,
    running: bool,
}

#[derive(Debug)]
struct Attempt {
    state: Mutex<AttemptState>,
    /// Cancelled to stop the CLI (disconnect).
    stop: Signal,
}

impl Attempt {
    fn state(&self) -> MutexGuard<'_, AttemptState> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn details(&self) -> LoginDetails {
        let state = self.state();
        LoginDetails {
            connected: false,
            code: state.code.clone(),
            url: state.url.clone(),
            error: state.error.clone(),
        }
    }

    /// Reads what the CLI printed (`consume`).
    fn consume(&self, chunk: &str) {
        let mut state = self.state();
        state.output.push_str(chunk);
        let chars = state.output.chars().count();
        if chars > LOGIN_OUTPUT_KEEP {
            let cut =
                state.output.char_indices().nth(chars - LOGIN_OUTPUT_KEEP).map_or(0, |(i, _)| i);
            state.output.drain(..cut);
        }
        let plain = ANSI.replace_all(&state.output, "").into_owned();
        if state.code.is_none() {
            state.code = CODE.captures(&plain).map(|c| c[1].to_owned());
        }
        // NestJS searches the raw output, so a colour code right after the link ended up inside
        // the URL; searching the plain text gives the link the person can open
        if let Some(candidate) = LINK.find(&plain).map(|m| m.as_str().to_owned()) {
            let trimmed = candidate.trim_end_matches([')', ',', '.', ';']);
            match Url::parse(trimmed) {
                Ok(url) => {
                    let host = url.host_str().unwrap_or_default();
                    if host == "grok.com" || host.ends_with(".grok.com") || host == "auth.x.ai" {
                        state.url = Some(url.to_string());
                    }
                }
                Err(_) => state.url = None,
            }
        }
    }
}

/// Process-wide state of the SuperGrok logins; register one and hand clones to every
/// [`GrokBuild`].
#[derive(Clone, Debug, Default)]
pub struct GrokAttempts(Arc<Mutex<HashMap<String, Arc<Attempt>>>>);

impl GrokAttempts {
    fn map(&self) -> MutexGuard<'_, HashMap<String, Arc<Attempt>>> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The Grok Build CLI.
#[derive(Clone, Debug)]
pub struct GrokBuild {
    cli_path: String,
    home_root: Option<String>,
    attempts: GrokAttempts,
}

fn unavailable(message: &str) -> AppError {
    AppError::new(StatusCode::SERVICE_UNAVAILABLE, message)
}

fn bad_gateway(message: &str) -> AppError {
    AppError::new(StatusCode::BAD_GATEWAY, message)
}

/// Sets the mode of `path` to `mode` where the platform has modes.
async fn chmod(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).await
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

async fn make_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).await?;
    chmod(path, 0o700).await
}

/// SIGTERM, as `child.kill('SIGTERM')` sends it.
async fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let sent = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        if sent.is_ok_and(|s| s.success()) {
            return;
        }
    }
    let _ = child.start_kill();
}

impl GrokBuild {
    /// The CLI at `cli_path`, with credentials under `home_root` (`None`: not available).
    #[must_use]
    pub fn new(cli_path: String, home_root: Option<String>, attempts: GrokAttempts) -> Self {
        Self { cli_path, home_root, attempts }
    }

    /// From `GROK_CLI_PATH` and `GROK_HOME_DIR`.
    #[must_use]
    pub fn from_config(config: &Config, attempts: GrokAttempts) -> Self {
        Self::new(config.grok.cli_path.clone(), config.grok.home_dir.clone(), attempts)
    }

    /// A service for a configuration with its own login registry. For tests.
    #[must_use]
    pub fn disabled(config: &Config) -> Self {
        Self::from_config(config, GrokAttempts::default())
    }

    /// `status(userId)`.
    pub async fn status(&self, user_id: &str) -> GrokStatus {
        if self.home_root.is_none() {
            return GrokStatus { available: false, connected: false, login: None };
        }
        GrokStatus {
            available: true,
            connected: self.has_credentials(user_id).await,
            login: self.login_details(user_id),
        }
    }

    fn login_details(&self, user_id: &str) -> Option<LoginDetails> {
        self.attempts.map().get(user_id).map(|a| a.details())
    }

    /// `startLogin(userId)`: starts `grok login --device-auth`, or reports the one running.
    ///
    /// # Errors
    ///
    /// 503 without `GROK_HOME_DIR`, 409 with too many logins open.
    pub async fn start_login(&self, user_id: &str) -> Result<LoginResponse, AppError> {
        let home = self.user_home(user_id).await?;
        if self.has_credentials(user_id).await {
            return Ok(LoginResponse::Connected { connected: true });
        }
        {
            let attempts = self.attempts.map();
            if let Some(current) = attempts.get(user_id)
                && current.state().running
            {
                return Ok(LoginResponse::Pending(current.details()));
            }
            if attempts.len() >= MAX_ATTEMPTS && !attempts.contains_key(user_id) {
                return Err(AppError::conflict("Too many Grok login sessions are active."));
            }
        }

        let attempt = Arc::new(Attempt {
            state: Mutex::new(AttemptState { running: true, ..AttemptState::default() }),
            stop: Signal::new(),
        });
        if let Ok(child) = self.command(&["login", "--device-auth"], &home).spawn() {
            tokio::spawn(watch_login(child, Arc::clone(&attempt)));
        } else {
            let mut state = attempt.state();
            state.running = false;
            state.error =
                Some("The Grok Build CLI could not be started. Check GROK_CLI_PATH.".to_owned());
        }
        let details = attempt.details();
        self.attempts.map().insert(user_id.to_owned(), attempt);
        Ok(LoginResponse::Pending(details))
    }

    /// `disconnect(userId)`: stops a login, runs `grok logout` and reports what is left.
    ///
    /// # Errors
    ///
    /// 503 without `GROK_HOME_DIR` or when the CLI is missing, 502/504 when it fails.
    pub async fn disconnect(&self, user_id: &str) -> Result<DisconnectResponse, AppError> {
        let home = self.user_home(user_id).await?;
        let attempt = self.attempts.map().remove(user_id);
        if let Some(attempt) = attempt {
            attempt.stop.cancel();
        }
        self.run_cli(&["logout"], &home, Duration::from_secs(10), None).await?;
        Ok(DisconnectResponse { connected: self.has_credentials(user_id).await })
    }

    /// `complete(userId, messages, signal)`: one reply through the person's SuperGrok account.
    ///
    /// # Errors
    ///
    /// 503 when no account is connected, 502/504 when the CLI fails or answers nothing usable.
    pub async fn complete(
        &self,
        user_id: &str,
        messages: &[AiMessage],
        signal: &Signal,
    ) -> Result<String, AppError> {
        if !self.has_credentials(user_id).await {
            return Err(unavailable("Connect a SuperGrok account in AI settings."));
        }
        let home = self.user_home(user_id).await?;
        let request_home = home.join(format!("request-{}", &uid("r")[2..]));
        make_private_dir(&request_home).await.map_err(AppError::internal)?;
        let credentials = home.join("auth.json");
        let copy = request_home.join("auth.json");
        let prepared = async {
            tokio::fs::copy(&credentials, &copy).await?;
            chmod(&copy, 0o600).await
        }
        .await;
        let prompt = messages
            .iter()
            .map(|m| format!("{}\n{}", m.role.as_str().to_uppercase(), m.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        let request_dir = request_home.to_string_lossy().into_owned();
        let output = match prepared {
            Ok(()) => {
                self.run_cli(
                    &[
                        "--no-auto-update",
                        "--no-subagents",
                        "--no-memory",
                        "--disable-web-search",
                        "--tools",
                        "",
                        "--max-turns",
                        "1",
                        "--cwd",
                        &request_dir,
                        "--output-format",
                        "plain",
                        "-p",
                        &prompt,
                    ],
                    &request_home,
                    Duration::from_secs(60),
                    Some(signal),
                )
                .await
            }
            Err(error) => Err(AppError::internal(error)),
        };
        // the CLI may have refreshed the token: keep the newer file, then drop the request dir
        let restored = async {
            tokio::fs::copy(&copy, &credentials).await?;
            chmod(&credentials, 0o600).await
        }
        .await;
        let _ = tokio::fs::remove_dir_all(&request_home).await;
        let output = output?;
        restored.map_err(AppError::internal)?;
        let text = js::trim(&output);
        if text.is_empty() || js::len(&output) > REPLY_MAX {
            return Err(bad_gateway("Grok returned an invalid response."));
        }
        Ok(text.to_owned())
    }

    async fn has_credentials(&self, user_id: &str) -> bool {
        if self.home_root.is_none() {
            return false;
        }
        let Ok(home) = self.user_home(user_id).await else { return false };
        tokio::fs::metadata(home.join("auth.json")).await.is_ok_and(|m| m.is_file())
    }

    /// `userHome(userId)`: `<GROK_HOME_DIR>/<sha256(userId)>`, created private.
    async fn user_home(&self, user_id: &str) -> Result<PathBuf, AppError> {
        let Some(root) = &self.home_root else {
            return Err(unavailable("SuperGrok is not enabled by the server administrator."));
        };
        let root = std::path::absolute(root).map_err(AppError::internal)?;
        let directory = root.join(sha256_hex(user_id));
        if !directory.starts_with(&root) {
            return Err(unavailable("The Grok credential directory is invalid."));
        }
        make_private_dir(&directory).await.map_err(AppError::internal)?;
        Ok(directory)
    }

    /// The CLI with the server's environment minus every Grok and xAI setting, and its own home.
    fn command(&self, args: &[&str], home: &Path) -> Command {
        let mut command = Command::new(&self.cli_path);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy();
            if name == "XAI_API_KEY" || name.starts_with("GROK_") {
                command.env_remove(&key);
            }
        }
        command.env("GROK_HOME", home);
        command
    }

    /// Runs the CLI to completion and returns the start of its standard output.
    async fn run_cli(
        &self,
        args: &[&str],
        home: &Path,
        limit: Duration,
        signal: Option<&Signal>,
    ) -> Result<String, AppError> {
        let cancelled = || AppError::internal("Request cancelled.");
        if signal.is_some_and(Signal::is_cancelled) {
            return Err(cancelled());
        }
        let mut child = self
            .command(args, home)
            .spawn()
            .map_err(|_| unavailable("The Grok Build CLI is unavailable."))?;
        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let reader = tokio::spawn(async move {
            let mut output = String::new();
            let mut buffer = vec![0_u8; 8192];
            if let Some(out) = stdout.as_mut() {
                while let Ok(n) = out.read(&mut buffer).await {
                    if n == 0 {
                        break;
                    }
                    if js::len(&output) < CLI_OUTPUT_MAX {
                        output.push_str(&String::from_utf8_lossy(&buffer[..n]));
                    }
                }
            }
            js::truncate(&output, CLI_OUTPUT_MAX).to_owned()
        });
        let drain = tokio::spawn(async move {
            let mut sink = Vec::new();
            if let Some(err) = stderr.as_mut() {
                let _ = err.read_to_end(&mut sink).await;
            }
        });
        let never = Signal::new();
        let stop = signal.unwrap_or(&never);
        let outcome = tokio::select! {
            status = child.wait() => Ok(status),
            () = tokio::time::sleep(limit) => Err(AppError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "The Grok request timed out.",
            )),
            () = stop.cancelled() => Err(cancelled()),
        };
        match outcome {
            Ok(Ok(status)) if status.success() => {
                let _ = drain.await;
                Ok(reader.await.unwrap_or_default())
            }
            Ok(Ok(_)) => {
                drain.abort();
                reader.abort();
                Err(bad_gateway("Grok could not complete the request."))
            }
            Ok(Err(_)) => {
                drain.abort();
                reader.abort();
                Err(unavailable("The Grok Build CLI is unavailable."))
            }
            Err(error) => {
                terminate(&mut child).await;
                drain.abort();
                reader.abort();
                Err(error)
            }
        }
    }
}

/// Feeds a running `grok login` into its [`Attempt`] until it exits, is stopped or expires.
async fn watch_login(mut child: Child, attempt: Arc<Attempt>) {
    let mut readers = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let target = Arc::clone(&attempt);
        readers.push(tokio::spawn(async move {
            let mut buffer = vec![0_u8; 4096];
            while let Ok(n) = out.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                target.consume(&String::from_utf8_lossy(&buffer[..n]));
            }
        }));
    }
    if let Some(mut err) = child.stderr.take() {
        let target = Arc::clone(&attempt);
        readers.push(tokio::spawn(async move {
            let mut buffer = vec![0_u8; 4096];
            while let Ok(n) = err.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                target.consume(&String::from_utf8_lossy(&buffer[..n]));
            }
        }));
    }
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        () = tokio::time::sleep(LOGIN_TTL) => {
            attempt.state().error = Some("The Grok device code expired. Start a new login.".to_owned());
            terminate(&mut child).await;
            child.wait().await.ok()
        }
        () = attempt.stop.cancelled() => {
            terminate(&mut child).await;
            child.wait().await.ok()
        }
    };
    for reader in readers {
        let _ = reader.await;
    }
    let mut state = attempt.state();
    state.running = false;
    if !status.is_some_and(|s| s.success()) && state.error.is_none() {
        state.error = Some("Grok login ended before the account was connected.".to_owned());
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    struct Sandbox {
        root: PathBuf,
    }

    impl Sandbox {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("trama-grok-{}", uid("t")));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        /// A fake `grok` shell script with `body` as its program.
        fn cli(&self, body: &str) -> String {
            let path = self.root.join("grok");
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        }

        fn grok(&self, cli: String) -> GrokBuild {
            GrokBuild::new(
                cli,
                Some(self.root.join("homes").to_string_lossy().into_owned()),
                GrokAttempts::default(),
            )
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test]
    async fn is_unavailable_without_a_home_directory() {
        let grok = GrokBuild::new("grok".into(), None, GrokAttempts::default());
        assert_eq!(
            grok.status("u1").await,
            GrokStatus { available: false, connected: false, login: None }
        );
        let err = grok.start_login("u1").await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(err.to_string().contains("SuperGrok is not enabled by the server administrator."));
        assert!(grok.disconnect("u1").await.is_err());
        let err = grok.complete("u1", &[], &Signal::new()).await.unwrap_err();
        assert!(err.to_string().contains("Connect a SuperGrok account in AI settings."));
    }

    #[tokio::test]
    async fn keeps_one_private_directory_per_person_and_detects_credentials() {
        let sandbox = Sandbox::new();
        let grok = sandbox.grok(sandbox.cli("exit 0"));
        let status = grok.status("u1").await;
        assert_eq!(status, GrokStatus { available: true, connected: false, login: None });
        let home = grok.user_home("u1").await.unwrap();
        assert_eq!(home.file_name().unwrap().to_string_lossy(), sha256_hex("u1"));
        assert_eq!(fs::metadata(&home).unwrap().permissions().mode() & 0o777, 0o700);
        assert_ne!(home, grok.user_home("u2").await.unwrap());
        fs::write(home.join("auth.json"), "{}").unwrap();
        assert!(grok.status("u1").await.connected);
        assert!(!grok.status("u2").await.connected);
        assert_eq!(
            grok.start_login("u1").await.unwrap(),
            LoginResponse::Connected { connected: true }
        );
    }

    #[tokio::test]
    async fn login_reads_the_device_code_and_link_from_the_cli_output() {
        let sandbox = Sandbox::new();
        let cli = sandbox.cli(
            "[ \"$1\" = logout ] && exit 0\n\
             printf 'Open \\033[1mhttps://auth.x.ai/device?x=1)\\033[0m and enter code: ABCD-1234\\n'\n\
             printf 'noise https://evil.example/x\\n'\n\
             sleep 5",
        );
        let grok = sandbox.grok(cli);
        let LoginResponse::Pending(first) = grok.start_login("u1").await.unwrap() else {
            panic!("expected a pending login");
        };
        assert!(!first.connected);
        // the output arrives a moment later
        let mut details = first;
        for _ in 0..50 {
            details = grok.status("u1").await.login.unwrap();
            if details.code.is_some() && details.url.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(details.code.as_deref(), Some("ABCD-1234"));
        assert_eq!(details.url.as_deref(), Some("https://auth.x.ai/device?x=1"));
        assert_eq!(details.error, None);
        // a second request reports the running login instead of starting another
        let LoginResponse::Pending(again) = grok.start_login("u1").await.unwrap() else {
            panic!("expected the same login");
        };
        assert_eq!(again.code.as_deref(), Some("ABCD-1234"));
        // disconnect stops it
        assert_eq!(grok.disconnect("u1").await.unwrap(), DisconnectResponse { connected: false });
        assert!(grok.status("u1").await.login.is_none());
    }

    #[tokio::test]
    async fn a_login_that_exits_early_reports_why() {
        let sandbox = Sandbox::new();
        let grok = sandbox.grok(sandbox.cli("echo nope; exit 3"));
        grok.start_login("u1").await.unwrap();
        let mut error = None;
        for _ in 0..50 {
            error = grok.status("u1").await.login.unwrap().error;
            if error.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(error.as_deref(), Some("Grok login ended before the account was connected."));
    }

    #[tokio::test]
    async fn a_missing_cli_is_reported_on_the_login_and_as_503_elsewhere() {
        let sandbox = Sandbox::new();
        let grok = sandbox.grok(sandbox.root.join("nope").to_string_lossy().into_owned());
        let LoginResponse::Pending(details) = grok.start_login("u1").await.unwrap() else {
            panic!("expected a pending login");
        };
        assert_eq!(
            details.error.as_deref(),
            Some("The Grok Build CLI could not be started. Check GROK_CLI_PATH.")
        );
        let err = grok.disconnect("u1").await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(err.to_string().contains("The Grok Build CLI is unavailable."));
    }

    #[tokio::test]
    async fn limits_open_logins() {
        let sandbox = Sandbox::new();
        let grok = sandbox.grok(sandbox.cli("[ \"$1\" = logout ] && exit 0\nsleep 5"));
        for n in 0..MAX_ATTEMPTS {
            grok.start_login(&format!("user{n}")).await.unwrap();
        }
        let err = grok.start_login("one-more").await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::CONFLICT);
        assert!(err.to_string().contains("Too many Grok login sessions are active."));
        for n in 0..MAX_ATTEMPTS {
            grok.disconnect(&format!("user{n}")).await.ok();
        }
    }

    #[tokio::test]
    async fn completes_through_a_throwaway_directory_and_keeps_refreshed_credentials() {
        let sandbox = Sandbox::new();
        // prints its arguments' prompt and refreshes the token in its own GROK_HOME
        let cli = sandbox.cli(
            "echo '{\"refreshed\":true}' > \"$GROK_HOME/auth.json\"\n\
             echo \"home=$(basename \"$GROK_HOME\" | cut -c1-8) key=${XAI_API_KEY:-none}\"\n\
             for last; do :; done\n\
             printf '%s' \"$last\"",
        );
        let grok = sandbox.grok(cli);
        let home = grok.user_home("u1").await.unwrap();
        fs::write(home.join("auth.json"), "{}").unwrap();
        let reply = grok
            .complete(
                "u1",
                &[AiMessage::system("be brief"), AiMessage::user("hello")],
                &Signal::new(),
            )
            .await
            .unwrap();
        assert!(reply.starts_with("home=request-"), "{reply}");
        assert!(reply.contains("key=none"), "{reply}");
        assert!(reply.ends_with("SYSTEM\nbe brief\n\nUSER\nhello"), "{reply}");
        assert_eq!(
            fs::read_to_string(home.join("auth.json")).unwrap().trim(),
            "{\"refreshed\":true}"
        );
        let leftovers: Vec<_> = fs::read_dir(&home)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("request-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[tokio::test]
    async fn completion_failures_map_to_gateway_errors() {
        let sandbox = Sandbox::new();
        let grok = sandbox.grok(sandbox.cli("exit 1"));
        let home = grok.user_home("u1").await.unwrap();
        fs::write(home.join("auth.json"), "{}").unwrap();
        let err = grok.complete("u1", &[AiMessage::user("x")], &Signal::new()).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::BAD_GATEWAY);
        assert!(err.to_string().contains("Grok could not complete the request."));

        let silent = sandbox.grok(sandbox.cli("exit 0"));
        let err = silent.complete("u1", &[AiMessage::user("x")], &Signal::new()).await.unwrap_err();
        assert!(err.to_string().contains("Grok returned an invalid response."));

        let slow = sandbox.grok(sandbox.cli("sleep 30"));
        let signal = Signal::new();
        let stopper = signal.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            stopper.cancel();
        });
        let err = slow.complete("u1", &[AiMessage::user("x")], &signal).await.unwrap_err();
        assert_eq!(err.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
