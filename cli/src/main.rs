//! `trama`: the agent-first command line for Trama.
//!
//! Every REST route in the MCP catalog (`mcp/src/tools.json`) is a command, so the CLI and the MCP
//! server expose the same surface by construction. See `cli/README.md`.

// The protocol layer, the catalog and the tool profiles are shared with the MCP server, not copied.
// The CLI itself always runs on the FULL catalog; profiles only shape what `trama mcp` lists.
#[path = "../../mcp/src/catalog.rs"]
#[allow(dead_code)]
mod catalog;
#[path = "../../mcp/src/composite.rs"]
#[allow(dead_code)]
mod composite;
#[path = "../../mcp/src/generic.rs"]
#[allow(dead_code)]
mod generic;
#[path = "../../mcp/src/profile.rs"]
#[allow(dead_code)]
mod profile;
#[path = "../../mcp/src/protocol.rs"]
#[allow(dead_code)]
mod protocol;
#[path = "../../mcp/src/upstream.rs"]
#[allow(dead_code)]
mod upstream;

mod auth;
mod builtin;
mod cmdtree;
mod config;
mod error;
mod events;
mod exec;
mod http;
mod mcp_cmd;
mod output;
mod skill;
mod update;
mod util;

use std::process::ExitCode;
use std::time::Duration;

use clap::{Arg, ArgAction, ArgMatches, Command};

use cmdtree::Registry;
use config::Overrides;
use error::{CliError, Result};
use output::{Format, Mode};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const TARGET: &str = env!("TRAMA_TARGET");

/// Settings every command shares.
pub struct Ctx {
    pub fmt: Format,
    pub ov: Overrides,
    pub dry_run: bool,
    pub yes: bool,
    pub timeout: Duration,
}

impl Ctx {
    fn from_matches(m: &ArgMatches) -> Result<Ctx> {
        let mode = m
            .get_one::<String>("output")
            .cloned()
            .or_else(|| config::env("TRAMA_OUTPUT"))
            .unwrap_or_else(|| "auto".into());
        let mode = Mode::parse(&mode).ok_or_else(|| {
            CliError::usage(format!(
                "unknown output mode '{mode}': use one of {}",
                Mode::NAMES.join(", ")
            ))
        })?;
        let secs = *m.get_one::<u64>("timeout").expect("has default");
        Ok(Ctx {
            fmt: Format {
                mode,
                fields: output::parse_fields(m.get_one::<String>("fields").map(String::as_str))?,
                tty: util::stdout_is_tty(),
            },
            ov: Overrides {
                profile: m.get_one::<String>("profile").cloned(),
                api_url: m.get_one::<String>("api-url").cloned(),
                accounts: m
                    .get_many::<String>("account")
                    .map(|v| v.cloned().collect())
                    .unwrap_or_default(),
                workspaces: m
                    .get_many::<String>("workspace")
                    .map(|v| v.cloned().collect())
                    .unwrap_or_default(),
                all: m.get_flag("all-workspaces"),
            },
            dry_run: m.get_flag("dry-run"),
            yes: m.get_flag("yes") || config::env("TRAMA_YES").is_some(),
            timeout: Duration::from_secs(secs),
        })
    }
}

fn build_cli(reg: &Registry) -> Command {
    let mut root = Command::new("trama")
        .version(VERSION)
        .about("Agent-first command line for Trama: issues, workstreams, decisions and more")
        .long_about(
            "Agent-first command line for Trama.\n\n\
             Every Trama API route is a command: `trama <resource> <verb>`. Output is JSON when piped, a table in a terminal.\n\
             Errors go to stderr as JSON with a stable exit code (see `trama --help` footer).\n\n\
             Connect:   trama login            trama account add    (or export TRAMA_API_KEY and TRAMA_API_URL)\n\
             Discover:  trama commands         trama schema issue create\n\
             Agents:    trama skill install    trama mcp config",
        )
        .after_help(
            "Exit codes: 0 ok · 1 internal · 2 usage · 3 auth/permission · 4 not found · 5 rate limited (stop, do not loop) · 6 conflict · 7 network/server · 8 validation\n\
             Environment: TRAMA_API_KEY, TRAMA_API_KEYS, TRAMA_API_URL, TRAMA_WORKSPACE, TRAMA_WORKSPACES, TRAMA_PROFILE, TRAMA_ACCOUNTS, TRAMA_OUTPUT, TRAMA_NO_INPUT",
        )
        .arg_required_else_help(true)
        .subcommand_required(true)
        .arg(Arg::new("output").long("output").short('o').value_name("MODE").global(true).help_heading("Global options").hide_short_help(true).value_parser(Mode::NAMES).help("auto (json when piped, table in a terminal), json, pretty, jsonl, table, raw"))
        .arg(Arg::new("fields").long("fields").value_name("A,B.C").global(true).help_heading("Global options").hide_short_help(true).help("Keep only these fields (dot paths) of the result"))
        .arg(Arg::new("profile").long("profile").value_name("NAME").global(true).help_heading("Global options").hide_short_help(true).help("Use these saved profiles (comma-separated). A read runs once per profile"))
        .arg(Arg::new("account").long("account").value_name("NAME").global(true).help_heading("Global options").hide_short_help(true).value_delimiter(',').action(ArgAction::Append).help("Use every profile of these accounts (comma-separated)"))
        .arg(Arg::new("workspace").long("workspace").value_name("SLUG").global(true).help_heading("Global options").hide_short_help(true).value_delimiter(',').action(ArgAction::Append).help("Use the saved profiles bound to these workspace slugs"))
        .arg(Arg::new("all-workspaces").long("all-workspaces").action(ArgAction::SetTrue).global(true).help_heading("Global options").hide_short_help(true).help("Read from every saved profile, not just the current one"))
        .arg(Arg::new("api-url").long("api-url").value_name("URL").global(true).help_heading("Global options").hide_short_help(true).help("API (or site) URL, overriding the profile"))
        .arg(Arg::new("dry-run").long("dry-run").action(ArgAction::SetTrue).global(true).help_heading("Global options").hide_short_help(true).help("Print the request instead of sending it"))
        .arg(Arg::new("yes").long("yes").short('y').action(ArgAction::SetTrue).global(true).help_heading("Global options").hide_short_help(true).help("Do not ask for confirmation"))
        .arg(Arg::new("timeout").long("timeout").value_name("SECONDS").global(true).help_heading("Global options").hide_short_help(true).default_value("30").value_parser(clap::value_parser!(u64).range(1..=3600)).help("Per-request timeout"));
    for c in builtin::definitions() {
        root = root.subcommand(c);
    }
    for c in reg.commands() {
        let c = if c.get_name() == "event" {
            c.subcommand(events::command())
        } else {
            c
        };
        root = root.subcommand(c);
    }
    root
}

async fn run_tool(
    reg: &Registry,
    group: &str,
    group_matches: &ArgMatches,
    ctx: &Ctx,
) -> Result<()> {
    let (verb, m) = match group_matches.subcommand() {
        Some((verb, sub)) => (Some(verb), sub),
        None => (None, group_matches),
    };
    let entry = reg
        .find(group, verb)
        .ok_or_else(|| CliError::internal(format!("no handler for '{group}'")))?;
    let args = cmdtree::extract(entry, m)?;
    let call = entry.tool.build_call(&args).map_err(|e| {
        CliError::usage(cmdtree::friendly(entry, &e)).hint(format!(
            "`trama {} --help` lists the fields.",
            entry.command_name()
        ))
    })?;
    let mut label = entry.command_name();
    for ph in &entry.positionals {
        if let Some(v) = args.get(ph).and_then(|v| v.as_str()) {
            label.push(' ');
            label.push_str(v);
        }
    }
    // The workstream briefing is markdown unless JSON was asked for; the project briefing only exists as markdown.
    let accept = match entry.tool.name.as_str() {
        "get_workstream_context" if !ctx.fmt.mode.wants_json() => http::ACCEPT_MARKDOWN,
        "get_project_context" => http::ACCEPT_MARKDOWN,
        _ => http::ACCEPT_JSON,
    };
    exec::run(&label, &call, accept, ctx).await
}

/// Help and `--version` print and exit 0. Real usage errors keep clap's friendly text on a terminal and
/// become the same JSON error as every other failure when stderr is piped (agents, CI).
fn usage_error(e: clap::Error) -> CliError {
    use clap::error::ErrorKind;
    use std::io::IsTerminal;
    if matches!(
        e.kind(),
        ErrorKind::DisplayHelp
            | ErrorKind::DisplayVersion
            | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
    ) || std::io::stderr().is_terminal()
    {
        e.exit();
    }
    let text = e.render().to_string();
    let plain: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    // The message is everything before the `Usage:` block (clap lists the offending arguments on the lines after the header).
    let head: Vec<&str> = plain
        .iter()
        .copied()
        .take_while(|l| !l.starts_with("Usage:") && !l.starts_with("For more information"))
        .filter(|l| !l.starts_with("tip:"))
        .collect();
    let message = if head.is_empty() {
        "invalid command line".to_string()
    } else {
        head.join(" ").trim_start_matches("error: ").to_string()
    };
    let tips: Vec<&str> = plain
        .iter()
        .filter_map(|l| l.strip_prefix("tip: "))
        .collect();
    let usage = plain.iter().find_map(|l| l.strip_prefix("Usage: "));
    let hint = match (tips.is_empty(), usage) {
        (false, _) => tips.join(" "),
        (true, Some(u)) => format!("Usage: {u}. Run the command with --help for every flag."),
        (true, None) => {
            "Run the command with --help; `trama commands` lists every command.".to_string()
        }
    };
    CliError::usage(message).hint(hint)
}

async fn run() -> Result<()> {
    let reg = Registry::load().map_err(|e| CliError::internal(format!("tool catalog: {e}")))?;
    let mut cli = build_cli(&reg);
    let matches = match cli.clone().try_get_matches() {
        Ok(m) => m,
        Err(e) => return Err(usage_error(e)),
    };
    let ctx = Ctx::from_matches(&matches)?;
    let (name, sub) = matches.subcommand().expect("a subcommand is required");
    match name {
        "login" => auth::login(sub, &ctx).await,
        "logout" => auth::logout(sub, &ctx).await,
        "whoami" => auth::whoami(&ctx).await,
        "profile" => auth::profile(sub, &ctx),
        "account" => auth::account(sub, &ctx).await,
        "doctor" => builtin::doctor(&ctx).await,
        "config" => builtin::config_cmd(sub, &ctx),
        "api" => builtin::api(sub, &ctx).await,
        "commands" => builtin::commands(sub, &reg, &ctx),
        "schema" => builtin::schema(sub, &reg, &ctx),
        "completion" => {
            builtin::completion(sub, &mut cli);
            Ok(())
        }
        "mcp" => match sub.subcommand() {
            Some(("config", cm)) => mcp_cmd::config_snippet(cm, &ctx),
            _ => mcp_cmd::serve(&ctx, sub).await,
        },
        "skill" => skill::run(sub, &ctx),
        "update" => update::run(sub, &ctx).await,
        "version" => {
            builtin::version(&ctx);
            Ok(())
        }
        "event" if sub.subcommand_name() == Some("watch") => {
            events::watch(sub.subcommand_matches("watch").expect("checked"), &ctx).await
        }
        group => run_tool(&reg, group, sub, &ctx).await,
    }
}

fn main() -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("error: cannot start the async runtime: {e}");
            return ExitCode::from(1);
        }
    };
    match runtime.block_on(run()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            e.report();
            ExitCode::from(e.kind.exit_code())
        }
    }
}
