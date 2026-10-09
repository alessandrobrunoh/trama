//! Connecting the CLI to a Trama instance: `login`, `logout`, `whoami`, `profile`.
//!
//! Three ways in, all ending with a workspace-bound API key (`trm_…`) saved in a profile:
//!
//! 1. paste / pipe a key you created in Settings → API tokens (`--with-token`, or interactively)
//! 2. email + password: the CLI signs in once, mints a key for this machine in the workspace you pick,
//!    then signs out again. The password is never stored.
//! 3. `--web`: open the Trama site so you can create the key, then paste it.

use std::collections::BTreeSet;

use clap::ArgMatches;
use serde_json::{Value, json};

use crate::Ctx;
use crate::catalog::Method;
use crate::config::{
    self, Config, Creds, Profile, check_token_format, check_transport, normalize_api_url, redact,
};
use crate::error::{CliError, Kind, Result};
use crate::http::{Api, Request, cookie_value};
use crate::output;
use crate::util;

const SESSION_COOKIE: &str = "trama_session";
/// Cookie name of API servers from before the rename; still read so the CLI works against them.
const LEGACY_SESSION_COOKIE: &str = "nabla_session";

fn session_cookie(headers: &reqwest::header::HeaderMap) -> Option<String> {
    cookie_value(headers, SESSION_COOKIE).or_else(|| cookie_value(headers, LEGACY_SESSION_COOKIE))
}

/// What `GET /auth/token` says about a key.
#[derive(Debug)]
pub struct Identity {
    pub slug: String,
    pub name: String,
    pub raw: Value,
}

impl Identity {
    pub fn permissions(&self) -> Vec<String> {
        let set: BTreeSet<String> = self
            .raw
            .get("permissions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|p| p.as_str().map(str::to_string))
            .collect();
        set.into_iter().collect()
    }

    pub fn token_id(&self) -> Option<String> {
        self.raw
            .pointer("/token/id")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// The introspection reply with the permission list sorted and anything hash-like removed.
    pub fn summary(&self, api_url: &str, profile: Option<&str>) -> Value {
        let mut token = self.raw.get("token").cloned().unwrap_or(Value::Null);
        if let Some(map) = token.as_object_mut() {
            map.retain(|k, _| {
                !k.to_ascii_lowercase().contains("hash")
                    && !k.to_ascii_lowercase().contains("secret")
            });
        }
        json!({
            "api": api_url,
            "profile": profile,
            "workspace": self.raw.get("workspace"),
            "actor": self.raw.get("actor"),
            "token": token,
            "permissions": self.permissions(),
        })
    }
}

pub async fn introspect(api: &Api, token: &str) -> Result<Identity> {
    let reply = api
        .send(&Request::get("/auth/token").token(token))
        .await?
        .into_result()?;
    let raw = reply.json()?;
    let slug = raw.pointer("/workspace/slug").and_then(Value::as_str);
    let name = raw.pointer("/workspace/name").and_then(Value::as_str);
    match (slug, name) {
        (Some(slug), Some(name)) => Ok(Identity {
            slug: slug.to_string(),
            name: name.to_string(),
            raw: raw.clone(),
        }),
        _ => Err(CliError::new(
            Kind::Internal,
            "unexpected reply from /auth/token: is this a Trama API URL?",
        )),
    }
}

/// The slug of the key's workspace: from the profile/env when known, else asked of the API.
pub async fn workspace_slug(api: &Api, creds: &Creds) -> Result<String> {
    match &creds.workspace {
        Some(slug) => Ok(slug.clone()),
        None => Ok(introspect(api, &creds.token).await?.slug),
    }
}

fn origin_of(api_url: &str) -> String {
    api_url.strip_suffix("/api").unwrap_or(api_url).to_string()
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_string()
}

enum Method3 {
    Token,
    Password,
    Web,
}

pub async fn login(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let existing = Config::load()?;
    let profile_name = ctx
        .ov
        .profile
        .clone()
        .or_else(|| config::env("TRAMA_PROFILE"))
        .or_else(|| existing.default_name())
        .unwrap_or_else(|| config::DEFAULT_PROFILE.to_string());
    let previous_url = existing.profiles.get(&profile_name).map(|p| p.url.clone());

    let url_raw = match ctx
        .ov
        .api_url
        .clone()
        .or_else(|| config::env("TRAMA_API_URL"))
    {
        Some(u) => u,
        None => {
            let default = previous_url
                .clone()
                .unwrap_or_else(|| config::DEFAULT_API_URL.to_string());
            util::prompt("Trama URL (site or API)", Some(&default))?
        }
    };
    let url = normalize_api_url(&url_raw)?;
    check_transport(&url)?;
    let api = Api::new(&url, ctx.timeout)?;

    let with_token = m.get_flag("with-token");
    let method = if with_token {
        Method3::Token
    } else if m.get_one::<String>("email").is_some() {
        Method3::Password
    } else if m.get_flag("web") {
        Method3::Web
    } else if config::env("TRAMA_API_KEY").is_some() && !util::interactive() {
        Method3::Token
    } else if util::interactive() {
        eprintln!("How do you want to sign in to {url}?");
        eprintln!("  1) Paste an API token   (Trama → Settings → API tokens)");
        eprintln!("  2) Email and password   (creates a token for this machine)");
        eprintln!("  3) Open the browser to create a token");
        match util::prompt("Choose", Some("1"))?.as_str() {
            "1" => Method3::Token,
            "2" => Method3::Password,
            "3" => Method3::Web,
            other => return Err(CliError::usage(format!("'{other}' is not one of 1, 2, 3"))),
        }
    } else {
        return Err(CliError::usage("nothing to sign in with")
            .hint("Pipe a key: `echo $KEY | trama login --with-token --api-url <url>`, or set TRAMA_API_KEY, or use --email."));
    };

    let token = match method {
        Method3::Token => {
            let key = if with_token {
                first_line(&util::read_stdin()?)
            } else if let Some(k) = config::env("TRAMA_API_KEY").filter(|_| !util::interactive()) {
                k
            } else {
                util::prompt_secret("API token (trm_…)")?
            };
            check_token_format(&key)?;
            key
        }
        Method3::Web => {
            let origin = origin_of(&url);
            eprintln!("Create a token in Settings → API tokens at {origin}");
            if !m.get_flag("no-browser") {
                util::open_browser(&origin);
            }
            let key = util::prompt_secret("Paste the token (trm_…)")?;
            check_token_format(&key)?;
            key
        }
        Method3::Password => mint_with_password(&api, m).await?,
    };

    let identity = introspect(&api, &token).await?;
    let mut cfg = existing;
    cfg.profiles.insert(
        profile_name.clone(),
        Profile {
            url: url.clone(),
            token: token.clone(),
            workspace: identity.slug.clone(),
            workspace_name: identity.name.clone(),
            saved_at: util::now_iso(),
            account: String::new(),
        },
    );
    cfg.current = Some(profile_name.clone());
    cfg.save()?;

    let human = ctx.fmt.tty && ctx.fmt.mode == output::Mode::Auto;
    if human {
        eprintln!(
            "Signed in to {} ({}) · profile '{profile_name}' · {} permissions",
            identity.name,
            identity.slug,
            identity.permissions().len()
        );
        eprintln!(
            "Key {} saved in {}",
            redact(&token),
            config::config_path().display()
        );
        return Ok(());
    }
    let mut summary = identity.summary(&url, Some(&profile_name));
    if let Some(map) = summary.as_object_mut() {
        // `trama whoami` lists them all; a login confirmation only needs the count.
        map.insert("permissions".into(), json!(identity.permissions().len()));
    }
    output::print(&summary, &ctx.fmt);
    Ok(())
}

/// Email + password → session → token for this machine → session closed. Returns the token secret.
async fn mint_with_password(api: &Api, m: &ArgMatches) -> Result<String> {
    let email = match m.get_one::<String>("email") {
        Some(e) => e.clone(),
        None => util::prompt("Email", None)?,
    };
    let password = if m.get_flag("password-stdin") {
        first_line(&util::read_stdin()?)
    } else if let Some(p) = config::env("TRAMA_PASSWORD") {
        p
    } else {
        util::prompt_secret("Password")?
    };
    if password.is_empty() {
        return Err(CliError::usage("the password is empty"));
    }

    let body = json!({ "email": email, "password": password });
    let login = api
        .send(&Request {
            method: Method::Post,
            path: "/auth/login",
            query: &[],
            body: Some(&body),
            token: None,
            accept: crate::http::ACCEPT_JSON,
            cookie: None,
        })
        .await?;
    if login.status == 401 {
        return Err(CliError::auth("wrong email or password").status(401));
    }
    let login = login.into_result()?;
    let cookie = session_cookie(&login.headers)
        .ok_or_else(|| CliError::internal("the API did not start a session"))?;
    let result = mint_in_session(api, m, &login.json()?, &cookie).await;
    // Always close the session, whatever happened.
    let _ = api
        .send(&Request {
            method: Method::Post,
            path: "/auth/logout",
            query: &[],
            body: None,
            token: None,
            accept: crate::http::ACCEPT_JSON,
            cookie: Some(&cookie),
        })
        .await;
    result
}

async fn mint_in_session(api: &Api, m: &ArgMatches, login: &Value, cookie: &str) -> Result<String> {
    let workspaces: Vec<(String, String)> = login
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|w| {
            Some((
                w.get("slug")?.as_str()?.to_string(),
                w.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ))
        })
        .collect();
    if workspaces.is_empty() {
        return Err(
            CliError::usage("this account is not a member of any workspace")
                .hint("Create or join one in the web app first."),
        );
    }
    let slug = match m.get_one::<String>("workspace") {
        Some(s) if workspaces.iter().any(|(slug, _)| slug == s) => s.clone(),
        Some(s) => {
            let known: Vec<&str> = workspaces.iter().map(|(s, _)| s.as_str()).collect();
            return Err(CliError::usage(format!("you are not a member of '{s}'"))
                .hint(format!("Your workspaces: {}", known.join(", "))));
        }
        None if workspaces.len() == 1 => workspaces[0].0.clone(),
        None if util::interactive() => {
            eprintln!("Workspaces:");
            for (i, (slug, name)) in workspaces.iter().enumerate() {
                eprintln!("  {}) {name} ({slug})", i + 1);
            }
            let pick = util::prompt("Choose", Some("1"))?;
            let index: usize = pick
                .parse()
                .ok()
                .filter(|n| (1..=workspaces.len()).contains(n))
                .ok_or_else(|| CliError::usage(format!("'{pick}' is not a valid choice")))?;
            workspaces[index - 1].0.clone()
        }
        None => {
            let known: Vec<&str> = workspaces.iter().map(|(s, _)| s.as_str()).collect();
            return Err(CliError::usage(
                "this account has several workspaces: pick one with --workspace",
            )
            .hint(format!("Your workspaces: {}", known.join(", "))));
        }
    };

    let mut body = json!({ "name": m.get_one::<String>("token-name").cloned().unwrap_or_else(|| format!("trama-cli@{}", util::hostname())) });
    let name_len = body["name"]
        .as_str()
        .map(|s| s.chars().count())
        .unwrap_or(0);
    if name_len > 80 {
        let short: String = body["name"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(80)
            .collect();
        body["name"] = json!(short);
    }
    if let Some(perms) = m.get_many::<String>("permissions") {
        body["permissions"] = json!(perms.cloned().collect::<Vec<_>>());
        body["scope"] = json!("custom");
    } else if let Some(scope) = m.get_one::<String>("scope") {
        body["scope"] = json!(scope);
    }
    if let Some(expires) = m.get_one::<String>("expires-in")
        && let Some(secs) = util::parse_duration(expires)?
    {
        body["expiresAt"] = json!(util::iso(util::now_secs() + secs));
    }
    let path = format!("/w/{}/tokens", crate::catalog::encode_segment(&slug));
    let reply = api
        .send(&Request {
            method: Method::Post,
            path: &path,
            query: &[],
            body: Some(&body),
            token: None,
            accept: crate::http::ACCEPT_JSON,
            cookie: Some(cookie),
        })
        .await?
        .into_result()?;
    let secret = reply
        .json()?
        .get("secret")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| CliError::internal("the API did not return the token secret"))?;
    check_token_format(&secret)?;
    Ok(secret)
}

pub async fn whoami(ctx: &Ctx) -> Result<()> {
    let creds = config::resolve(&ctx.ov)?;
    let api = Api::new(&creds.url, ctx.timeout)?;
    let identity = introspect(&api, &creds.token).await?;
    if !creds.from_env {
        refresh_profile(&creds, &identity);
    }
    output::print(
        &identity.summary(&creds.url, creds.profile.as_deref()),
        &ctx.fmt,
    );
    Ok(())
}

/// Keeps the saved workspace slug/name current (best effort: a read-only config is not an error here).
fn refresh_profile(creds: &Creds, identity: &Identity) {
    let (Some(name), Ok(mut cfg)) = (creds.profile.as_ref(), Config::load()) else {
        return;
    };
    if let Some(p) = cfg.profiles.get_mut(name)
        && (p.workspace != identity.slug || p.workspace_name != identity.name)
    {
        p.workspace = identity.slug.clone();
        p.workspace_name = identity.name.clone();
        let _ = cfg.save();
    }
}

pub async fn logout(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let mut cfg = Config::load()?;
    let names: Vec<String> = if m.get_flag("all") {
        cfg.profiles.keys().cloned().collect()
    } else {
        let name = ctx
            .ov
            .profile
            .clone()
            .or_else(|| config::env("TRAMA_PROFILE"))
            .or_else(|| cfg.default_name())
            .ok_or_else(|| CliError::usage("no profile to sign out of"))?;
        if !cfg.profiles.contains_key(&name) {
            return Err(CliError::usage(format!("no profile named '{name}'")));
        }
        vec![name]
    };
    let mut revoked: Vec<String> = vec![];
    let mut warnings: Vec<String> = vec![];
    for name in &names {
        let Some(profile) = cfg.profiles.remove(name) else {
            continue;
        };
        if m.get_flag("revoke") {
            match revoke(&profile, ctx).await {
                Ok(()) => revoked.push(name.clone()),
                Err(e) => warnings.push(format!(
                    "could not revoke the key of '{name}': {}",
                    e.message
                )),
            }
        }
    }
    if cfg
        .current
        .as_ref()
        .is_some_and(|c| !cfg.profiles.contains_key(c))
    {
        cfg.current = cfg.default_name();
    }
    cfg.save()?;
    for w in &warnings {
        eprintln!("warning: {w}");
    }
    output::print(
        &json!({ "loggedOut": names, "revoked": revoked, "warnings": warnings }),
        &ctx.fmt,
    );
    Ok(())
}

async fn revoke(profile: &Profile, ctx: &Ctx) -> Result<()> {
    let api = Api::new(&profile.url, ctx.timeout)?;
    let identity = introspect(&api, &profile.token).await?;
    let id = identity
        .token_id()
        .ok_or_else(|| CliError::internal("the API did not say which token this is"))?;
    let path = format!(
        "/w/{}/tokens/{}",
        crate::catalog::encode_segment(&identity.slug),
        crate::catalog::encode_segment(&id)
    );
    api.send(&Request {
        method: Method::Delete,
        path: &path,
        query: &[],
        body: None,
        token: Some(&profile.token),
        accept: crate::http::ACCEPT_JSON,
        cookie: None,
    })
    .await?
    .into_result()?;
    Ok(())
}

pub fn profile(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let mut cfg = Config::load()?;
    let current = ctx
        .ov
        .profile
        .clone()
        .or_else(|| config::env("TRAMA_PROFILE"))
        .or_else(|| cfg.default_name());
    let row = |name: &str, p: &Profile| profile_row(name, p, current.as_deref());
    match m.subcommand() {
        Some(("list", _)) | None => {
            let rows: Vec<Value> = cfg.profiles.iter().map(|(n, p)| row(n, p)).collect();
            output::print(&Value::Array(rows), &ctx.fmt);
        }
        Some(("show", sm)) => {
            let name = sm
                .get_one::<String>("name")
                .cloned()
                .or_else(|| current.clone())
                .ok_or_else(CliError::not_logged_in)?;
            let p = cfg
                .profiles
                .get(&name)
                .ok_or_else(|| CliError::usage(format!("no profile named '{name}'")))?;
            output::print(&row(&name, p), &ctx.fmt);
        }
        Some(("use", sm)) => {
            let name = sm.get_one::<String>("name").expect("required").clone();
            if !cfg.profiles.contains_key(&name) {
                return Err(CliError::usage(format!("no profile named '{name}'"))
                    .hint("`trama profile list` shows the saved ones."));
            }
            cfg.current = Some(name.clone());
            cfg.save()?;
            output::print(&json!({ "current": name }), &ctx.fmt);
        }
        Some(("remove", sm)) => {
            let name = sm.get_one::<String>("name").expect("required").clone();
            if cfg.profiles.remove(&name).is_none() {
                return Err(CliError::usage(format!("no profile named '{name}'")));
            }
            if cfg.current.as_deref() == Some(name.as_str()) {
                cfg.current = cfg.default_name();
            }
            cfg.save()?;
            output::print(&json!({ "removed": name }), &ctx.fmt);
        }
        Some((other, _)) => {
            return Err(CliError::usage(format!(
                "unknown profile command '{other}'"
            )));
        }
    }
    Ok(())
}

fn profile_row(name: &str, p: &Profile, current: Option<&str>) -> Value {
    let mut row = json!({
        "name": name,
        "current": current == Some(name),
        "url": p.url,
        "workspace": p.workspace,
        "workspaceName": p.workspace_name,
        "token": redact(&p.token),
        "savedAt": p.saved_at,
    });
    if !p.account.is_empty() {
        row["account"] = json!(p.account);
    }
    row
}

/// `trama account`: add one or many tokens (or sign in and mint one key per workspace), then list or remove them.
///
/// A token is still bound to exactly one workspace. An *account* is just the name that groups the
/// profiles `add` created, so `trama issue list --account work` can read all of them at once.
pub async fn account(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    match m.subcommand() {
        Some(("add", sm)) => account_add(sm, ctx).await,
        Some(("list", _)) | None => account_list(ctx),
        Some(("remove", sm)) => account_remove(sm, ctx),
        Some((other, _)) => Err(CliError::usage(format!(
            "unknown account command '{other}'"
        ))),
    }
}

pub fn account_list(ctx: &Ctx) -> Result<()> {
    let cfg = Config::load()?;
    let current = cfg.default_name();
    let mut names: Vec<String> = cfg
        .profiles
        .values()
        .map(|p| p.account.clone())
        .filter(|a| !a.is_empty())
        .collect();
    names.sort();
    names.dedup();
    let rows: Vec<Value> = names
        .into_iter()
        .map(|name| {
            let profiles: Vec<Value> = cfg.profiles.iter().filter(|(_, p)| p.account == name).map(|(n, p)| profile_row(n, p, current.as_deref())).collect();
            json!({ "name": name, "profiles": profiles.len(), "workspaces": profiles.iter().filter_map(|p| p.get("workspace")).collect::<Vec<_>>() })
        })
        .collect();
    output::print(&Value::Array(rows), &ctx.fmt);
    Ok(())
}

async fn account_add(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let label = m
        .get_one::<String>("name")
        .cloned()
        .or_else(|| config::env("TRAMA_ACCOUNT"));
    let url_raw = ctx
        .ov
        .api_url
        .clone()
        .or_else(|| config::env("TRAMA_API_URL"))
        .or_else(|| {
            Config::load().ok().and_then(|c| {
                c.default_name()
                    .and_then(|n| c.profiles.get(&n).map(|p| p.url.clone()))
            })
        });
    let url_raw = match url_raw {
        Some(u) => u,
        None if util::interactive() => {
            util::prompt("Trama URL (site or API)", Some(config::DEFAULT_API_URL))?
        }
        None => {
            return Err(CliError::usage("no API URL").hint("Pass --api-url, or set TRAMA_API_URL."));
        }
    };
    let url = normalize_api_url(&url_raw)?;
    check_transport(&url)?;
    let api = Api::new(&url, ctx.timeout)?;

    let tokens = if m.get_flag("with-token")
        || config::env("TRAMA_API_KEY").is_some()
            && !util::interactive()
            && m.get_one::<String>("email").is_none()
    {
        pasted_tokens(m.get_flag("with-token"))?
    } else if m.get_one::<String>("email").is_some()
        || util::interactive() && !m.get_flag("with-token")
    {
        mint_many(&api, m).await?
    } else {
        return Err(CliError::usage("nothing to add").hint("Pipe keys, one per line: `trama account add --with-token --api-url <url> --name work`, or use --email."));
    };
    if tokens.is_empty() {
        return Err(CliError::usage("no token was given"));
    }

    let account = label.unwrap_or_else(|| "account".to_string());
    let mut cfg = Config::load()?;
    let mut added: Vec<Value> = vec![];
    let mut skipped: Vec<Value> = vec![];
    for token in tokens {
        check_token_format(&token)?;
        if let Some((name, existing)) = cfg
            .profiles
            .iter()
            .find(|(_, p)| p.token == token && p.url == url)
        {
            skipped.push(json!({ "profile": name, "workspace": existing.workspace, "reason": "already saved" }));
            continue;
        }
        let identity = introspect(&api, &token).await?;
        let name = cfg.unique_name(&identity.slug);
        cfg.profiles.insert(
            name.clone(),
            Profile {
                url: url.clone(),
                token: token.clone(),
                workspace: identity.slug.clone(),
                workspace_name: identity.name.clone(),
                saved_at: util::now_iso(),
                account: account.clone(),
            },
        );
        if cfg.current.is_none() {
            cfg.current = Some(name.clone());
        }
        added.push(json!({ "profile": name, "workspace": identity.slug, "workspaceName": identity.name, "permissions": identity.permissions().len() }));
    }
    cfg.save()?;
    let human = ctx.fmt.tty && ctx.fmt.mode == output::Mode::Auto;
    if human {
        for row in &added {
            eprintln!(
                "Added {} ({}) to account '{account}' as profile '{}'",
                row["workspaceName"].as_str().unwrap_or(""),
                row["workspace"].as_str().unwrap_or(""),
                row["profile"].as_str().unwrap_or("")
            );
        }
        if added.is_empty() {
            eprintln!("Nothing new: every token was already saved.");
        }
        eprintln!("Read all of them at once with `trama issue list --account {account}`.");
        return Ok(());
    }
    output::print(
        &json!({ "account": account, "added": added, "skipped": skipped }),
        &ctx.fmt,
    );
    Ok(())
}

/// One token per non-empty line of stdin, or the single `TRAMA_API_KEY`.
fn pasted_tokens(from_stdin: bool) -> Result<Vec<String>> {
    let text = if from_stdin {
        util::read_stdin()?
    } else {
        config::env("TRAMA_API_KEY").unwrap_or_default()
    };
    let tokens: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    for token in &tokens {
        check_token_format(token)?;
    }
    Ok(tokens)
}

/// Email + password once, then one machine token per workspace the account belongs to.
async fn mint_many(api: &Api, m: &ArgMatches) -> Result<Vec<String>> {
    let email = match m.get_one::<String>("email") {
        Some(e) => e.clone(),
        None => util::prompt("Email", None)?,
    };
    let password = if m.get_flag("password-stdin") {
        first_line(&util::read_stdin()?)
    } else if let Some(p) = config::env("TRAMA_PASSWORD") {
        p
    } else {
        util::prompt_secret("Password")?
    };
    if password.is_empty() {
        return Err(CliError::usage("the password is empty"));
    }
    let body = json!({ "email": email, "password": password });
    let login = api
        .send(&Request {
            method: Method::Post,
            path: "/auth/login",
            query: &[],
            body: Some(&body),
            token: None,
            accept: crate::http::ACCEPT_JSON,
            cookie: None,
        })
        .await?;
    if login.status == 401 {
        return Err(CliError::auth("wrong email or password").status(401));
    }
    let login = login.into_result()?;
    let cookie = session_cookie(&login.headers)
        .ok_or_else(|| CliError::internal("the API did not start a session"))?;
    let wanted = m
        .get_many::<String>("workspace")
        .map(|v| v.cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let result = mint_all(api, m, &login.json()?, &cookie, &wanted).await;
    let _ = api
        .send(&Request {
            method: Method::Post,
            path: "/auth/logout",
            query: &[],
            body: None,
            token: None,
            accept: crate::http::ACCEPT_JSON,
            cookie: Some(&cookie),
        })
        .await;
    result
}

async fn mint_all(
    api: &Api,
    m: &ArgMatches,
    login: &Value,
    cookie: &str,
    wanted: &[String],
) -> Result<Vec<String>> {
    let workspaces: Vec<(String, String)> = login
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|w| {
            Some((
                w.get("slug")?.as_str()?.to_string(),
                w.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ))
        })
        .collect();
    if workspaces.is_empty() {
        return Err(
            CliError::usage("this account is not a member of any workspace")
                .hint("Create or join one in the web app first."),
        );
    }
    let chosen: Vec<(String, String)> = if wanted.is_empty() {
        workspaces.clone()
    } else {
        let mut out = vec![];
        for slug in wanted {
            match workspaces.iter().find(|(s, _)| s == slug) {
                Some(w) => out.push(w.clone()),
                None => {
                    let known: Vec<&str> = workspaces.iter().map(|(s, _)| s.as_str()).collect();
                    return Err(CliError::usage(format!("you are not a member of '{slug}'"))
                        .hint(format!("Your workspaces: {}", known.join(", "))));
                }
            }
        }
        out
    };
    let mut tokens = vec![];
    for (slug, _) in &chosen {
        tokens.push(mint_one(api, m, cookie, slug).await?);
    }
    Ok(tokens)
}

/// One machine token in `slug`, inside a session that is already open.
async fn mint_one(api: &Api, m: &ArgMatches, cookie: &str, slug: &str) -> Result<String> {
    let mut body = json!({ "name": m.get_one::<String>("token-name").cloned().unwrap_or_else(|| format!("trama-cli@{}-{slug}", util::hostname())) });
    let name_len = body["name"]
        .as_str()
        .map(|s| s.chars().count())
        .unwrap_or(0);
    if name_len > 80 {
        let short: String = body["name"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(80)
            .collect();
        body["name"] = json!(short);
    }
    if let Some(perms) = m.get_many::<String>("permissions") {
        body["permissions"] = json!(perms.cloned().collect::<Vec<_>>());
        body["scope"] = json!("custom");
    } else if let Some(scope) = m.get_one::<String>("scope") {
        body["scope"] = json!(scope);
    }
    if let Some(expires) = m.get_one::<String>("expires-in")
        && let Some(secs) = util::parse_duration(expires)?
    {
        body["expiresAt"] = json!(util::iso(util::now_secs() + secs));
    }
    let path = format!("/w/{}/tokens", crate::catalog::encode_segment(slug));
    let reply = api
        .send(&Request {
            method: Method::Post,
            path: &path,
            query: &[],
            body: Some(&body),
            token: None,
            accept: crate::http::ACCEPT_JSON,
            cookie: Some(cookie),
        })
        .await?
        .into_result()?;
    let secret = reply
        .json()?
        .get("secret")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| CliError::internal("the API did not return the token secret"))?;
    check_token_format(&secret)?;
    Ok(secret)
}

fn account_remove(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let name = m.get_one::<String>("name").expect("required").clone();
    let mut cfg = Config::load()?;
    let gone: Vec<String> = cfg
        .profiles
        .iter()
        .filter(|(_, p)| p.account == name)
        .map(|(n, _)| n.clone())
        .collect();
    if gone.is_empty() {
        return Err(CliError::usage(format!("no account named '{name}'")).hint("`trama account list` shows the saved ones. Removing an account forgets its keys on this machine; it does not revoke them."));
    }
    for profile in &gone {
        cfg.profiles.remove(profile);
    }
    if cfg
        .current
        .as_ref()
        .is_some_and(|c| !cfg.profiles.contains_key(c))
    {
        cfg.current = cfg.default_name();
    }
    cfg.save()?;
    output::print(&json!({ "removed": name, "profiles": gone }), &ctx.fmt);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_cookie_falls_back_to_the_pre_rename_name() {
        use reqwest::header::{HeaderMap, HeaderValue, SET_COOKIE};
        let mut old = HeaderMap::new();
        old.append(SET_COOKIE, HeaderValue::from_static("nabla_session=abc; Path=/; HttpOnly"));
        assert_eq!(session_cookie(&old).as_deref(), Some("nabla_session=abc"));
        let mut new = HeaderMap::new();
        new.append(SET_COOKIE, HeaderValue::from_static("trama_session=def; Path=/; HttpOnly"));
        new.append(SET_COOKIE, HeaderValue::from_static("nabla_session=; Max-Age=0; Path=/"));
        assert_eq!(session_cookie(&new).as_deref(), Some("trama_session=def"));
    }

    #[test]
    fn summary_hides_hashes_and_sorts_permissions() {
        let id = Identity {
            slug: "acme".into(),
            name: "Acme".into(),
            raw: json!({
                "token": { "id": "tok_1", "name": "ci", "tokenHash": "deadbeef", "prefix": "nbl_3f9a" },
                "actor": { "type": "user", "id": "usr_1" },
                "workspace": { "id": "ws_1", "slug": "acme", "name": "Acme" },
                "permissions": ["issues:write", "issues:read", "issues:read"],
            }),
        };
        let s = id.summary("https://x/api", Some("default"));
        assert_eq!(s["permissions"], json!(["issues:read", "issues:write"]));
        assert!(s["token"].get("tokenHash").is_none());
        assert_eq!(s["token"]["prefix"], "nbl_3f9a");
        assert_eq!(id.token_id().as_deref(), Some("tok_1"));
    }

    #[test]
    fn origin_drops_the_api_suffix() {
        assert_eq!(
            origin_of("https://trama.example.com/api"),
            "https://trama.example.com"
        );
        assert_eq!(
            origin_of("http://localhost:3000/api"),
            "http://localhost:3000"
        );
    }
}
