//! Commands that are not generated from the catalog: their definitions and the small ones' handlers
//! (`api`, `commands`, `schema`, `completion`, `config`, `doctor`, `version`).

use std::time::Instant;

use clap::{Arg, ArgAction, ArgMatches, Command};
use serde_json::{Value, json};

use crate::auth;
use crate::catalog::Loc;
use crate::cmdtree::{self, Entry, Registry, first_sentence, kebab};
use crate::config::{self, Config, redact};
use crate::error::{CliError, Result};
use crate::http::{ACCEPT_JSON, Api, Request};
use crate::output;
use crate::{Ctx, TARGET, VERSION, exec, generic};

fn flag(id: &'static str, help: &'static str) -> Arg {
    Arg::new(id).long(id).action(ArgAction::SetTrue).help(help)
}

pub fn definitions() -> Vec<Command> {
    vec![
        Command::new("login")
            .about("Connect the CLI to a Trama workspace")
            .long_about(
                "Saves a workspace-bound API key in a profile. Without flags it asks how to sign in.\n\n\
                 Non-interactive (agents, CI):\n  echo $TRAMA_KEY | trama login --with-token --api-url https://trama.example.com\n\n\
                 Or skip `login` entirely and export TRAMA_API_KEY (and TRAMA_API_URL).",
            )
            .arg(flag("with-token", "Read the API token from stdin"))
            .arg(flag("web", "Open the Trama site to create a token, then paste it"))
            .arg(flag("no-browser", "With --web: print the address instead of opening a browser"))
            .arg(Arg::new("email").long("email").value_name("EMAIL").help("Sign in with email and password and create a token for this machine"))
            .arg(flag("password-stdin", "With --email: read the password from stdin (or set TRAMA_PASSWORD)"))
            .arg(Arg::new("workspace").long("workspace").value_name("SLUG").help("With --email: workspace to create the token in"))
            .arg(Arg::new("scope").long("scope").value_name("SCOPE").value_parser(["read", "write", "admin", "custom"]).help("With --email: token scope (server default: write)"))
            .arg(Arg::new("permissions").long("permissions").value_name("RESOURCE:ACTION").value_delimiter(',').action(ArgAction::Append).help("With --email: custom token with exactly these permissions, e.g. issues:read,issues:write"))
            .arg(Arg::new("expires-in").long("expires-in").value_name("DURATION").help("With --email: token lifetime, e.g. 30d, 12h, never (default: never)"))
            .arg(Arg::new("token-name").long("token-name").value_name("NAME").help("With --email: name shown in Settings → API tokens (default: trama-cli@<host>)")),
        Command::new("logout")
            .about("Forget a saved profile (optionally revoking its key)")
            .arg(flag("all", "Sign out of every profile"))
            .arg(flag("revoke", "Also revoke the API key on the server")),
        Command::new("whoami").about("Workspace, actor, permissions and caps of the current key"),
        Command::new("account")
            .about("Add several tokens or workspaces and read across all of them")
            .long_about(
                "An account groups one profile per workspace, so a read can cover more than the current one.\n\n\
                 Add keys you already have (one per line):\n  printf '%s\\n' \"$KEY_ACME\" \"$KEY_BETA\" | trama account add --with-token --api-url https://trama.example.com --name work\n\n\
                 Or sign in once and mint a key in every workspace the account belongs to:\n  trama account add --email you@acme.com --name work --workspace acme,beta\n\n\
                 Then: trama issue list --account work",
            )
            .subcommand_required(false)
            .subcommand(
                Command::new("add")
                    .about("Save one or more workspace keys under an account name")
                    .arg(flag("with-token", "Read API tokens from stdin, one per line"))
                    .arg(Arg::new("name").long("name").value_name("NAME").help("Account name that groups the new profiles (default: account)"))
                    .arg(Arg::new("email").long("email").value_name("EMAIL").help("Sign in and create a token in every workspace of this account"))
                    .arg(flag("password-stdin", "With --email: read the password from stdin (or set TRAMA_PASSWORD)"))
                    .arg(Arg::new("workspace").long("workspace").value_name("SLUG").value_delimiter(',').action(ArgAction::Append).help("With --email: only these workspaces (default: all of them)"))
                    .arg(Arg::new("scope").long("scope").value_name("SCOPE").value_parser(["read", "write", "admin", "custom"]).help("With --email: token scope (server default: write)"))
                    .arg(Arg::new("permissions").long("permissions").value_name("RESOURCE:ACTION").value_delimiter(',').action(ArgAction::Append).help("With --email: custom token with exactly these permissions"))
                    .arg(Arg::new("expires-in").long("expires-in").value_name("DURATION").help("With --email: token lifetime, e.g. 90d (default: never)"))
                    .arg(Arg::new("token-name").long("token-name").value_name("NAME").help("With --email: name shown in Settings → API tokens")),
            )
            .subcommand(Command::new("list").visible_alias("ls").about("Saved accounts and the workspaces in each"))
            .subcommand(Command::new("remove").visible_alias("rm").about("Forget an account and its profiles on this machine").arg(Arg::new("name").required(true))),
        Command::new("profile")
            .about("List and switch saved profiles")
            .subcommand_required(false)
            .subcommand(Command::new("list").visible_alias("ls").about("Saved profiles (keys are shown redacted)"))
            .subcommand(Command::new("show").about("One profile").arg(Arg::new("name")))
            .subcommand(Command::new("use").about("Make a profile the default").arg(Arg::new("name").required(true)))
            .subcommand(Command::new("remove").visible_alias("rm").about("Delete a profile from this machine").arg(Arg::new("name").required(true))),
        Command::new("doctor").about("Check configuration, connectivity and the key"),
        Command::new("config")
            .about("Where the CLI keeps its settings")
            .subcommand_required(true)
            .arg_required_else_help(true)
            .subcommand(Command::new("path").about("Print the config file path"))
            .subcommand(Command::new("show").about("Print the config (keys redacted) and the environment overrides in effect")),
        Command::new("api")
            .about("Call any workspace route directly")
            .long_about("Escape hatch for routes without a dedicated command. PATH is relative to the workspace (e.g. /integrations); the key's permissions still apply.")
            .arg(Arg::new("method").value_name("METHOD").required(true).value_parser(clap::builder::PossibleValuesParser::new(["GET", "POST", "PATCH", "DELETE", "get", "post", "patch", "delete"])).help("HTTP method"))
            .arg(Arg::new("path").value_name("PATH").required(true).help("Workspace-relative path, e.g. /issues/BUG-1"))
            .arg(Arg::new("query").long("query").short('Q').value_name("KEY=VALUE").action(ArgAction::Append).help("Query parameter (repeatable)"))
            .arg(Arg::new("data").long("data").short('d').value_name("JSON").help("JSON body: inline, @file.json, or - for stdin"))
            .after_help("Example:\n  trama api GET /issues -Q open=true -Q limit=5\n  trama api POST /outgoing-webhooks/ow_1/test -d '{}'"),
        Command::new("commands")
            .about("List every resource command with its HTTP route and permission")
            .arg(Arg::new("group").value_name("RESOURCE").help("Only this resource, e.g. issue"))
            .arg(flag("detail", "Include every flag with type, allowed values and description")),
        Command::new("schema")
            .about("JSON input schema of one command")
            .arg(Arg::new("command").value_name("RESOURCE [VERB]").required(true).num_args(1..=2).help("e.g. `issue create` (the MCP tool name, e.g. create_issue, works too)")),
        Command::new("completion")
            .about("Shell completion script")
            .arg(Arg::new("shell").required(true).value_parser(clap::value_parser!(clap_complete::Shell)))
            .after_help("Example:\n  trama completion zsh > ~/.zfunc/_trama"),
        Command::new("mcp")
            .about("Run as an MCP server over stdio (uses your saved login), or print client config")
            .long_about("`trama mcp` speaks the Model Context Protocol on stdin/stdout with the same tools as the hosted MCP server, authenticated by your saved profiles. By default it lists a short set of task-level tools (`--tools full` lists every operation); `list_capabilities` and `run_tool` reach the rest. With several profiles (or TRAMA_API_KEYS) every tool takes an optional `workspace` argument and reads run across all of them when it is omitted. Add it to a client as: command `trama`, args `mcp`.")
            .arg(Arg::new("tools").long("tools").value_name("PROFILE").value_parser(["core", "full"]).help("Tool set to list: core (default; task-oriented) or full (every operation). Env: TRAMA_MCP_PROFILE"))
            .subcommand(
                Command::new("config")
                    .about("Print the snippet that connects an MCP client")
                    .arg(Arg::new("client").long("client").value_parser(["claude", "cursor", "vscode", "codex", "json"]).default_value("claude"))
                    .arg(Arg::new("transport").long("transport").value_parser(["stdio", "http"]).default_value("stdio").help("stdio runs this binary; http points at the hosted /mcp endpoint")),
            ),
        Command::new("skill")
            .about("Install the Trama skill that teaches coding agents to use this CLI")
            .subcommand_required(true)
            .arg_required_else_help(true)
            .subcommand(Command::new("show").about("Print SKILL.md"))
            .subcommand(skill_target_args(Command::new("path").about("Where `install` would write it")))
            .subcommand(skill_target_args(Command::new("install").about("Write SKILL.md where your agent loads skills")).arg(flag("force", "Overwrite an existing file"))),
        Command::new("update")
            .about("Update this binary to the latest release")
            .arg(flag("check", "Only report whether a newer version exists"))
            .arg(Arg::new("to").long("to").value_name("VERSION").help("Install this version instead of the latest")),
        Command::new("version").about("Version and build target"),
    ]
}

fn skill_target_args(cmd: Command) -> Command {
    cmd.arg(
        Arg::new("target")
            .long("target")
            .value_parser(["claude", "agents"])
            .default_value("claude")
            .help("claude → .claude/skills, agents → .agents/skills"),
    )
    .arg(
        Arg::new("scope")
            .long("scope")
            .value_parser(["user", "project"])
            .default_value("user")
            .help("user → your home directory, project → the current directory"),
    )
    .arg(
        Arg::new("dir")
            .long("dir")
            .value_name("DIR")
            .help("Skills directory to use instead (the skill goes in DIR/trama-cli/)"),
    )
}

pub async fn api(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let method = m
        .get_one::<String>("method")
        .expect("required")
        .to_ascii_uppercase();
    let path = m.get_one::<String>("path").expect("required");
    let mut args = json!({ "method": method, "path": path });
    let mut query = serde_json::Map::new();
    for kv in m.get_many::<String>("query").into_iter().flatten() {
        let (k, v) = kv
            .split_once('=')
            .ok_or_else(|| CliError::usage(format!("--query expects KEY=VALUE, got '{kv}'")))?;
        query.insert(k.to_string(), Value::String(v.to_string()));
    }
    if !query.is_empty() {
        args["query"] = Value::Object(query);
    }
    if let Some(raw) = m.get_one::<String>("data") {
        args["body"] = cmdtree::parse_json_arg(raw, "--data")?;
    }
    let call = generic::build_call(&args).map_err(|e| {
        CliError::usage(e).hint("Put query parameters in -Q key=value, not in PATH.")
    })?;
    exec::run(&format!("api {method} {path}"), &call, ACCEPT_JSON, ctx).await
}

fn param_json(entry: &Entry, p: &crate::catalog::Param) -> Value {
    let (location, flag) = match p.loc {
        Loc::Path => (
            "path",
            format!("<{}>", kebab(&p.name).to_uppercase().replace('-', "_")),
        ),
        Loc::Query => ("query", format!("--{}", kebab(&p.name))),
        Loc::Body => ("body", format!("--{}", kebab(&p.name))),
    };
    let mut v = json!({ "name": p.name, "flag": flag, "in": location, "type": p.ty, "required": p.required, "description": p.description });
    if !p.choices.is_empty() {
        v["choices"] = json!(p.choices);
    }
    if p.loc == Loc::Path {
        v["position"] = json!(
            entry
                .positionals
                .iter()
                .position(|n| n == &p.name)
                .map(|i| i + 1)
        );
    }
    v
}

pub fn commands(m: &ArgMatches, reg: &Registry, ctx: &Ctx) -> Result<()> {
    let group = m.get_one::<String>("group");
    if let Some(g) = group
        && !reg.is_group(g)
    {
        let mut groups: Vec<&str> = reg.entries.iter().map(|e| e.group.as_str()).collect();
        groups.dedup();
        return Err(CliError::usage(format!("no resource named '{g}'"))
            .hint(format!("Resources: {}", groups.join(", "))));
    }
    let detail = m.get_flag("detail");
    let mut entries: Vec<&Entry> = reg
        .entries
        .iter()
        .filter(|e| group.is_none_or(|g| &e.group == g))
        .collect();
    entries.sort_by_key(|e| e.command_name());
    let rows: Vec<Value> = entries
        .into_iter()
        .map(|e| {
            let t = &e.tool;
            let mut row = json!({ "command": e.command_name(), "method": t.method.as_str(), "path": t.path, "permission": t.permission, "summary": first_sentence(&t.description) });
            if detail {
                row["params"] = Value::Array(t.params.iter().map(|p| param_json(e, p)).collect());
            }
            row
        })
        .collect();
    output::print(&Value::Array(rows), &ctx.fmt);
    Ok(())
}

pub fn schema(m: &ArgMatches, reg: &Registry, ctx: &Ctx) -> Result<()> {
    let words: Vec<&str> = m
        .get_many::<String>("command")
        .expect("required")
        .map(String::as_str)
        .collect();
    let entry = match words.as_slice() {
        [one] => reg
            .entries
            .iter()
            .find(|e| e.tool.name == *one)
            .or_else(|| reg.find(one, None)),
        [group, verb] => reg.find(group, Some(verb)),
        _ => None,
    };
    let Some(e) = entry else {
        let hint = match words.first().filter(|g| reg.is_group(g)) {
            Some(g) => format!(
                "`{g}` has: {}",
                reg.entries
                    .iter()
                    .filter(|e| &e.group == g)
                    .filter_map(|e| e.verb.as_deref())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            None => "`trama commands` lists every command.".to_string(),
        };
        return Err(CliError::usage(format!("no command '{}'", words.join(" "))).hint(hint));
    };
    let t = &e.tool;
    output::print(
        &json!({
            "command": format!("trama {}", e.command_name()),
            "mcpTool": t.name,
            "method": t.method.as_str(),
            "path": t.path,
            "permission": t.permission,
            "description": t.description,
            "params": t.params.iter().map(|p| param_json(e, p)).collect::<Vec<_>>(),
            "inputSchema": t.input_schema(),
        }),
        &ctx.fmt,
    );
    Ok(())
}

pub fn completion(m: &ArgMatches, cli: &mut Command) {
    let shell = *m
        .get_one::<clap_complete::Shell>("shell")
        .expect("required");
    clap_complete::generate(shell, cli, "trama", &mut std::io::stdout());
}

pub fn config_cmd(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    match m.subcommand() {
        Some(("path", _)) => output::emit(&config::config_path().display().to_string()),
        Some(("show", _)) => {
            let cfg = Config::load()?;
            let profiles: Vec<Value> = cfg
                .profiles
                .iter()
                .map(|(n, p)| {
                    let mut row = json!({ "name": n, "url": p.url, "workspace": p.workspace, "token": redact(&p.token), "savedAt": p.saved_at });
                    if !p.account.is_empty() {
                        row["account"] = json!(p.account);
                    }
                    row
                })
                .collect();
            let env_set = |name: &str| config::env(name).is_some();
            output::print(
                &json!({
                    "path": config::config_path(),
                    "current": cfg.default_name(),
                    "profiles": profiles,
                    "environment": {
                        "TRAMA_API_KEY": env_set("TRAMA_API_KEY").then_some("set"),
                        "TRAMA_API_URL": config::env("TRAMA_API_URL"),
                        "TRAMA_WORKSPACE": config::env("TRAMA_WORKSPACE"),
                        "TRAMA_PROFILE": config::env("TRAMA_PROFILE"),
                        "TRAMA_ACCOUNTS": config::env("TRAMA_ACCOUNTS"),
                        "TRAMA_WORKSPACES": config::env("TRAMA_WORKSPACES"),
                        "TRAMA_API_KEYS": env_set("TRAMA_API_KEYS").then_some("set"),
                        "TRAMA_CONFIG_DIR": config::env("TRAMA_CONFIG_DIR"),
                    },
                }),
                &ctx.fmt,
            );
        }
        _ => unreachable!("subcommand is required"),
    }
    Ok(())
}

pub fn version(ctx: &Ctx) {
    output::print(&json!({ "version": VERSION, "target": TARGET }), &ctx.fmt);
}

pub async fn doctor(ctx: &Ctx) -> Result<()> {
    let mut report = Report::default();
    report.record("version", Ok(format!("trama {VERSION} ({TARGET})")));
    let path = config::config_path();
    report.record(
        "config",
        Ok(format!(
            "{} ({})",
            path.display(),
            if path.exists() {
                "found"
            } else {
                "not created yet"
            }
        )),
    );

    match config::resolve(&ctx.ov) {
        Err(e) => report.record("credentials", Err(e)),
        Ok(creds) => {
            let source = if creds.from_env {
                "TRAMA_API_KEY".to_string()
            } else {
                format!("profile '{}'", creds.profile.clone().unwrap_or_default())
            };
            report.record(
                "credentials",
                Ok(format!(
                    "{source} → {} ({})",
                    creds.url,
                    redact(&creds.token)
                )),
            );
            match Api::new(&creds.url, ctx.timeout) {
                Err(e) => report.record("api", Err(e)),
                Ok(api) => {
                    let started = Instant::now();
                    let health = api.send(&Request::get("/health")).await;
                    let ms = started.elapsed().as_millis();
                    report.record(
                        "api",
                        match health {
                            Ok(r) if (200..300).contains(&r.status) => {
                                Ok(format!("{} answered {} in {ms} ms", api.base(), r.status))
                            }
                            Ok(r) => Err(CliError::from_http(r.status, &r.body)),
                            Err(e) => Err(e),
                        },
                    );
                    if report.first_error.is_none() {
                        report.record(
                            "token",
                            auth::introspect(&api, &creds.token).await.map(|id| {
                                let expires = id
                                    .raw
                                    .pointer("/token/expiresAt")
                                    .and_then(Value::as_str)
                                    .map(|e| format!(", expires {e}"))
                                    .unwrap_or_default();
                                format!(
                                    "workspace {} ({}), {} permissions{expires}",
                                    id.name,
                                    id.slug,
                                    id.permissions().len()
                                )
                            }),
                        );
                    }
                }
            }
        }
    }
    output::print(&Value::Array(report.checks), &ctx.fmt);
    report.first_error.map_or(Ok(()), Err)
}

#[derive(Default)]
struct Report {
    checks: Vec<Value>,
    first_error: Option<CliError>,
}

impl Report {
    fn record(&mut self, name: &str, result: Result<String>) {
        match result {
            Ok(detail) => self
                .checks
                .push(json!({ "check": name, "ok": true, "detail": detail })),
            Err(e) => {
                self.checks
                    .push(json!({ "check": name, "ok": false, "detail": e.message }));
                self.first_error.get_or_insert(e);
            }
        }
    }
}
