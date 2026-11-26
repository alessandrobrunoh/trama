//! The short verbs of the `/trama` skill: `show`, `ls`, `link`, `sub`, `status`, `sync`, `decisions`, `ask`,
//! `estimate` and `time`. They sit next to the generated commands and use the same routes.
//!
//! Requests and validation live in `mcp/src/work.rs`, shared with the MCP composites, so the shell and the
//! MCP tools behave the same. On a terminal (or with `-o table`) the verbs print the short human lines of the
//! skill (`✓ summary · 2 decisions · 3 files · 47m suggested`); piped, or with `-o json`, they print JSON
//! that also carries the line as `message`.
//!
//! A task has one thread (`DELTA_THREAD_URL` names the current one). Linking a second one is refused by the
//! API (409 `thread_already_linked`); the agent asks the person and then opens a subtask with `sub --link`.

use std::process::Command as Process;

use clap::{Arg, ArgAction, ArgMatches, Command, value_parser};
use serde_json::{Value, json};

use crate::Ctx;
use crate::auth;
use crate::catalog::encode_segment;
use crate::config;
use crate::error::{CliError, Kind, Result};
use crate::exec;
use crate::http::{ACCEPT_JSON, Api, Reply};
use crate::output::{self, Format, Mode};
use crate::util;
use crate::work;
use crate::workcmd::{self, get, rows_of, task_call, task_id, usage, wants_text};

/// The top-level commands this module handles.
pub const NAMES: &[&str] = &["show", "ls", "link", "sub", "status", "sync", "decisions", "ask", "estimate", "time"];

const ASK_NOTE: &str = "This lists the decisions and thread records that match your words. It does not generate an answer: read them, then answer.";
/// What `--dry-run` shows when no thread is known.
const THREAD_PLACEHOLDER: &str = "https://<current-thread-url>";
/// Decisions `show` prints before pointing at `trama decisions`.
const SHOW_DECISIONS_MAX: usize = 10;

// ───────────────────────────── command definitions ─────────────────────────────

fn id_arg() -> Arg {
    Arg::new("id").value_name("ID").required(true).help("Task key or id (TRM-128, TRM-128.3, in_…)")
}

fn thread_arg(help: &'static str) -> Arg {
    Arg::new("thread").long("thread").value_name("URL_OR_ID").help(help)
}

pub fn commands() -> Vec<Command> {
    vec![
        Command::new("show")
            .about("A task with its subtasks, past decisions and thread record")
            .long_about(
                "Reads the task context, its subtasks (a tree of any depth), the decisions recorded on it and the record of its thread. \
                 On a terminal it is a short header, the subtasks and `N related decisions`; piped, or with --json, one object `{ task, subtasks, decisions, record }` (`record` is null until the first `sync`).",
            )
            .arg(id_arg())
            .arg(Arg::new("json").long("json").action(ArgAction::SetTrue).help("Print `{ task, subtasks, decisions, record }` as JSON"))
            .after_help("Example:\n  trama show TRM-128.3 --json\n\nRequires permission `tasks:read`."),
        Command::new("ls")
            .about("Open tasks, yours with --mine")
            .long_about("Open tasks (finished ones with --all). `--mine` keeps the tasks assigned to the person behind the key, so it needs a key that acts as a person (`trama login --email`).")
            .arg(Arg::new("mine").long("mine").action(ArgAction::SetTrue).help("Only tasks assigned to you"))
            .arg(Arg::new("open").long("open").action(ArgAction::SetTrue).conflicts_with("all").help("Only open tasks (the default)"))
            .arg(Arg::new("all").long("all").action(ArgAction::SetTrue).help("Include finished tasks"))
            .arg(Arg::new("limit").long("limit").value_name("N").value_parser(value_parser!(u32).range(1..=500)).default_value("50").help("Newest first, at most this many"))
            .after_help("Example:\n  trama ls --mine\n\nRequires permission `tasks:read`."),
        Command::new("link")
            .about("Link the current thread to a task (one thread per task)")
            .long_about(
                "Sets the task's thread. `--thread` takes the full URL or a bare thread id (`th_…`), which needs TRAMA_THREAD_URL_BASE (or DELTA_THREAD_URL, whose last segment it replaces). \
                 Without `--thread` the current thread is used: the DELTA_THREAD_URL variable. \
                 A task links one thread: if it already links a different one the command fails (exit 6) and names it; ask the person, then `trama sub <ID> \"<title>\" --link`.",
            )
            .arg(id_arg())
            .arg(thread_arg("Thread URL, or a thread id (default: DELTA_THREAD_URL)"))
            .after_help("Example:\n  trama link TRM-128.3 --thread th_d93f10\n\nRequires permission `tasks:write`."),
        Command::new("sub")
            .about("New subtask of a task, in its project and of its kind")
            .arg(id_arg().help("The parent task"))
            .arg(Arg::new("title").value_name("TITLE").required(true).help("Title of the subtask"))
            .arg(Arg::new("link").long("link").action(ArgAction::SetTrue).help("Link the new subtask to the current thread (DELTA_THREAD_URL, or --thread)"))
            .arg(thread_arg("Thread URL or id to link (implies --link)"))
            .after_help("Example:\n  trama sub TRM-128 \"Retry metrics\" --link\n\nRequires permission `tasks:write`."),
        Command::new("status")
            .about("Set a task's status")
            .long_about("Sets the status. `in-progress` and `in_progress` both work, and so do the names of the workspace's own statuses (Planning, Merged…). People own the status: an agent only sets in_progress.")
            .arg(id_arg())
            .arg(Arg::new("status").value_name("STATUS").required(true).help("draft, backlog, todo, in_progress, in_review, done, canceled, or a workspace status name"))
            .after_help("Example:\n  trama status TRM-128.3 in-progress\n\nRequires permission `tasks:write`."),
        sync_command(),
        Command::new("decisions")
            .visible_alias("decision")
            .about("Past decisions, by file path or task")
            .long_about(
                "Decisions recorded on tasks, newest first. `--path` keeps those whose paths equal the file, are a directory above it (`src/auth/`) or match it as a glob (`src/auth/*`, `src/**/*.ts`); \
                 a decision with no path only matches when `--issue` names its task. With no filter it lists them all. Read this before you touch a file.",
            )
            .arg(Arg::new("path").long("path").value_name("FILE").allow_hyphen_values(true).help("A file path relative to the repository root"))
            .arg(Arg::new("issue").long("issue").value_name("ID").help("Only the decisions of this task"))
            .arg(Arg::new("limit").long("limit").value_name("N").value_parser(value_parser!(usize)).help("At most this many (1-200, default 50)"))
            .after_help("Example:\n  trama decisions --path src/auth/refresh.ts\n\nRequires permission `tasks:read`."),
        Command::new("ask")
            .about("Decisions and thread records that match a question (no generated answer)")
            .long_about(
                "Searches the decisions and the thread records and lists what matches, with the task key and a one-line snippet. \
                 It does not generate an answer: it finds the records, you read them. Use the words the records would use.",
            )
            .arg(Arg::new("question").value_name("QUESTION").required(true).num_args(1..).help("What to look for"))
            .arg(Arg::new("limit").long("limit").value_name("N").value_parser(value_parser!(u32).range(1..=100)).default_value("10").help("At most this many matches"))
            .after_help("Example:\n  trama ask \"refresh tokens\"\n\nRequires permission `search:read`."),
        Command::new("estimate")
            .about("Points suggested from similar finished tasks (you decide)")
            .long_about("Reads the estimate suggestion of a task: the median of similar finished tasks, snapped to the workspace scale, with the tasks it is based on. It writes nothing: apply it with `trama task update <ID> --estimate N` if the person agrees.")
            .arg(id_arg())
            .after_help("Example:\n  trama estimate TRM-128.3\n\nRequires permission `tasks:read`."),
        time_command(),
    ]
}

fn sync_command() -> Command {
    Command::new("sync")
        .about("Update the task's thread record: summary, decisions, files, PR, active minutes")
        .long_about(
            "Sends what changed in this thread to the task's record, in one request: the summary (replaces the last one), decisions (appended), files touched (merged), \
             the pull request (attached to the task), the active minutes (stored as a *suggested* time entry a person accepts) and the turns. Every part is optional. It never changes the task status.\n\n\
             `--decision \"TEXT@path,path\"`: the paths after the last `@` (no spaces) are the files, directories (`src/auth/`) or globs (`src/auth/*`) it applies to; end a text with a lone `@` to keep an @handle in it. Paths are relative to the repository root.\n\
             `--files-from-git` adds the changed files of the working tree (`git status`) and of the branch since it left the default branch (`git diff <merge-base>`); outside a repository it only warns.\n\
             `--pr` takes a URL, or `owner/repo#123` when the project's repository is on GitHub.\n\
             `--thread` links the thread when the task has none, and fails (exit 6) when it links another.\n\
             `--all` syncs every task linked to the current thread (DELTA_THREAD_URL) with the same parts.",
        )
        .arg(Arg::new("id").value_name("ID").help("Task key or id (omit with --all)"))
        .arg(Arg::new("all").long("all").action(ArgAction::SetTrue).conflicts_with("id").help("Every task linked to the current thread (DELTA_THREAD_URL)"))
        .arg(Arg::new("summary").long("summary").value_name("TEXT").allow_hyphen_values(true).conflicts_with("summary-file").help("What the thread did and where it stands; `-` reads stdin"))
        .arg(Arg::new("summary-file").long("summary-file").value_name("FILE").conflicts_with("summary").help("Read the summary from a file (`-` = stdin)"))
        .arg(Arg::new("decision").long("decision").value_name("TEXT[@PATH,PATH]").action(ArgAction::Append).allow_hyphen_values(true).help("A decision, with the paths it applies to; repeatable"))
        .arg(Arg::new("file").long("file").value_name("PATH").action(ArgAction::Append).help("A file you touched, relative to the repository root; repeatable"))
        .arg(Arg::new("files-from-git").long("files-from-git").action(ArgAction::SetTrue).help("Add the changed files of this git checkout"))
        .arg(Arg::new("pr").long("pr").value_name("URL|OWNER/REPO#N").help("The PR you opened: attached to the task"))
        .arg(Arg::new("minutes").long("minutes").value_name("N").value_parser(value_parser!(u32)).help("Active minutes since the last sync (1-720): a suggestion, not logged time"))
        .arg(Arg::new("turns").long("turns").value_name("N").value_parser(value_parser!(u32)).help("Turns of the thread so far"))
        .arg(thread_arg("Link this thread when the task has none (URL or id)"))
        .after_help("Example:\n  trama sync TRM-128.3 --summary \"Alert wired\" --decision \"Alert after 3 failures@src/auth/\" --files-from-git --minutes 47\n  trama sync TRM-128.3 --pr acme/web#423\n\nRequires permission `tasks:write`.")
}

fn time_command() -> Command {
    let task = || Arg::new("task").value_name("ID").help("Task key or id");
    Command::new("time")
        .about("Your timer and time entries: start, stop, log, accept suggestions")
        .long_about(
            "The short form of `trama timer`, plus `log` and the suggestions `trama sync --minutes` makes. Needs a login that acts as a person. \
             Durations: 1h15, 1h, 45m, 90 (minutes), 1:15.",
        )
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(
            Command::new("start")
                .about("Start the timer, on a task if given (same as `timer start`)")
                .arg(task())
                .arg(Arg::new("project-id").long("project-id").value_name("ID").help("Project to book the time on when there is no task"))
                .arg(Arg::new("description").long("description").value_name("TEXT").help("What you work on (at most 500 characters)"))
                .after_help("Example:\n  trama time start TRM-128.3"),
        )
        .subcommand(Command::new("stop").about("Stop the running timer"))
        .subcommand(Command::new("status").about("The running timer, its elapsed time and its task"))
        .subcommand(
            Command::new("log")
                .about("Log finished time on a task, ending now (or at --at)")
                .arg(task().required(true))
                .arg(Arg::new("duration").value_name("DURATION").required(true).help("1h15, 1h, 45m, 90 (minutes) or 1:15"))
                .arg(Arg::new("at").long("at").value_name("END").help("When it ended, ISO-8601 with a zone (default: now)"))
                .arg(Arg::new("description").long("description").value_name("TEXT").help("What you worked on (at most 500 characters)"))
                .after_help("Example:\n  trama time log TRM-128.3 1h15"),
        )
        .subcommand(
            Command::new("suggestions")
                .about("Time that `sync` suggested, waiting for you; `accept <ENTRY_ID>` takes one")
                .subcommand(accept_command()),
        )
        .subcommand(accept_command())
}

fn accept_command() -> Command {
    Command::new("accept")
        .about("Accept a suggested time entry: it then counts as yours")
        .arg(Arg::new("entry").value_name("ENTRY_ID").required(true).help("Time entry id (te_…), from `trama time suggestions`"))
}

// ───────────────────────────── routing ─────────────────────────────

pub async fn run(name: &str, m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    match name {
        "show" => show(m, ctx).await,
        "ls" => ls(m, ctx).await,
        "link" => link(m, ctx).await,
        "sub" => sub(m, ctx).await,
        "status" => status(m, ctx).await,
        "sync" => sync(m, ctx).await,
        "decisions" => decisions(m, ctx).await,
        "ask" => ask(m, ctx).await,
        "estimate" => estimate(m, ctx).await,
        "time" => time(m, ctx).await,
        other => Err(CliError::internal(format!("no handler for '{other}'"))),
    }
}

// ───────────────────────────── helpers ─────────────────────────────

fn flag(m: &ArgMatches, id: &str) -> Option<String> {
    m.get_one::<String>(id).cloned()
}

fn required(m: &ArgMatches, id: &str) -> String {
    m.get_one::<String>(id).cloned().expect("required by clap")
}

/// Prints the human lines on a terminal (or with `-o table`); otherwise the JSON, which also carries them.
fn say(ctx: &Ctx, human: &str, mut data: Value) {
    if wants_text(ctx) {
        output::emit(&output::escape_terminal_controls(human));
        return;
    }
    if let Some(map) = data.as_object_mut() {
        map.insert("message".into(), json!(human));
    }
    output::print(&data, &ctx.fmt);
}

/// `--json` shows JSON even where the default would be text.
fn json_format(ctx: &Ctx, forced: bool) -> Format {
    let mut fmt = ctx.fmt.clone();
    if forced && matches!(fmt.mode, Mode::Auto | Mode::Table) {
        fmt.mode = if fmt.tty { Mode::Pretty } else { Mode::Json };
    }
    fmt
}

fn pick_fields(v: &Value, fields: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for f in fields {
        if let Some(x) = v.get(*f)
            && !x.is_null()
        {
            out.insert((*f).to_string(), x.clone());
        }
    }
    Value::Object(out)
}

/// A read whose absence is fine: a 404 is "nothing", a refused permission a warning.
fn tolerate(read: Result<Value>, what: &str) -> Result<Value> {
    match read {
        Err(e) if e.kind == Kind::NotFound => Ok(Value::Null),
        Err(e) if e.kind == Kind::Auth => {
            eprintln!("warning: {what} not shown: {}", e.message);
            Ok(Value::Null)
        }
        other => other,
    }
}

fn one_line(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 160 {
        let mut short: String = flat.chars().take(159).collect();
        short.push('…');
        short
    } else {
        flat
    }
}

fn plural(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

/// `1h 15m`, `2h`, `45m`.
fn fmt_minutes(minutes: i64) -> String {
    match (minutes / 60, minutes % 60) {
        (0, m) => format!("{m}m"),
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h {m}m"),
    }
}

/// The error of a failed reply; a 409 `thread_already_linked` names the thread the task already has.
fn api_failure(reference: &str, reply: &Reply) -> CliError {
    let body: Value = serde_json::from_str(&reply.body).unwrap_or(Value::Null);
    if reply.status == 409 && body["code"].as_str() == Some(work::THREAD_ALREADY_LINKED) {
        let message = match body["threadUrl"].as_str() {
            Some(url) => format!("{reference} already linked to {url}"),
            None => format!("{reference} already links another thread"),
        };
        return CliError::new(Kind::Conflict, message)
            .status(409)
            .hint(format!("A task has one thread. Ask the person; if they agree, work in a new subtask: trama sub {reference} \"<title>\" --link"));
    }
    CliError::from_http(reply.status, &reply.body)
}

/// The thread to link: `--thread` (a URL, or an id turned into one), else the current thread
/// (`DELTA_THREAD_URL`). `--dry-run` shows a placeholder instead of failing, so a request can be previewed anywhere.
fn thread_to_link(m: &ArgMatches, ctx: &Ctx) -> Result<String> {
    let base = config::env("TRAMA_THREAD_URL_BASE");
    let current = config::env("DELTA_THREAD_URL");
    let Some(raw) = flag(m, "thread").or_else(|| current.clone()) else {
        if ctx.dry_run {
            return Ok(THREAD_PLACEHOLDER.to_string());
        }
        return Err(CliError::usage("no thread to link").hint("Pass --thread <url-or-id>, or run inside a Delta thread (it sets DELTA_THREAD_URL)."));
    };
    match work::thread_url_from(&raw, base.as_deref(), current.as_deref()) {
        Ok(url) => Ok(url),
        Err(_) if ctx.dry_run => Ok(format!("https://<TRAMA_THREAD_URL_BASE>/{raw}")),
        Err(e) => Err(CliError::usage(e)),
    }
}

/// The person behind the key.
async fn me(ctx: &Ctx) -> Result<String> {
    let creds = config::resolve(&ctx.ov)?;
    let api = Api::new(&creds.url, ctx.timeout)?;
    let identity = auth::introspect(&api, &creds.token).await?;
    match (identity.raw.pointer("/actor/type").and_then(Value::as_str), identity.raw.pointer("/actor/id").and_then(Value::as_str)) {
        (Some("user"), Some(id)) => Ok(id.to_string()),
        _ => Err(CliError::usage("--mine needs a key that acts as a person").hint("Sign in with `trama login --email you@example.com`, or list with `trama task list --assignee-id <user>`.")),
    }
}

// ───────────────────────────── show ─────────────────────────────

async fn show(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let reference = required(m, "id");
    let context = get(format!("/tasks/{}/context", encode_segment(&reference)), vec![]);
    if ctx.dry_run {
        return exec::run("show", &context, ACCEPT_JSON, ctx).await;
    }
    let reply = exec::fetch(&context, ctx).await?;
    let task = if reply["issue"].is_object() { reply["issue"].clone() } else { reply.clone() };
    let id = task["id"].as_str().ok_or_else(|| CliError::internal("the API sent a task without an id"))?.to_string();

    // The API has no parent filter: read the newest tasks once and build the tree here (as `task subtasks` does).
    let list = get("/tasks".to_string(), vec![("limit".to_string(), work::LIST_TASKS_MAX.to_string())]);
    let all = rows_of(exec::fetch(&list, ctx).await?);
    if all.len() >= work::LIST_TASKS_MAX {
        eprintln!("warning: only the newest {} tasks were read, so deeper subtasks may be missing", work::LIST_TASKS_MAX);
    }
    let subtasks = work::subtree(&all, &id, None);
    let parent_key = task["parentId"].as_str().map(|pid| all.iter().find(|t| t["id"].as_str() == Some(pid)).and_then(|t| t["key"].as_str()).unwrap_or(pid).to_string());

    let decisions_call = work::decisions_call(None, Some(&id), None).map_err(usage)?;
    let decisions = rows_of(tolerate(exec::fetch(&decisions_call, ctx).await, "decisions")?);
    let record = tolerate(exec::fetch(&work::thread_record_call(&id).map_err(usage)?, ctx).await, "the thread record")?;

    if m.get_flag("json") || !wants_text(ctx) {
        let out = json!({ "task": task, "subtasks": subtasks, "decisions": decisions, "record": record });
        output::print(&out, &json_format(ctx, m.get_flag("json")));
        return Ok(());
    }
    output::emit(&output::escape_terminal_controls(&render_show(&task, parent_key.as_deref(), &subtasks, &decisions, &record)));
    Ok(())
}

fn decision_line(d: &Value, with_key: bool) -> String {
    let paths: Vec<&str> = d["paths"].as_array().map(|p| p.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut line = String::new();
    if with_key {
        line.push_str(d["issueKey"].as_str().or_else(|| d["key"].as_str()).unwrap_or("-"));
        line.push_str("  ");
    }
    line.push_str(&one_line(d["text"].as_str().unwrap_or("")));
    if !paths.is_empty() {
        line.push_str(&format!("  ({})", paths.join(", ")));
    }
    line
}

fn render_show(task: &Value, parent_key: Option<&str>, subtasks: &[Value], decisions: &[Value], record: &Value) -> String {
    let key = task["key"].as_str().unwrap_or("?");
    let mut out = vec![format!("{key}  {}", task["title"].as_str().unwrap_or(""))];
    let mut facts = vec![work::humanize_status(task["status"].as_str().unwrap_or("?"))];
    if let Some(parent) = parent_key {
        facts.push(format!("parent {parent}"));
    }
    if let Some(points) = task["estimate"].as_f64() {
        facts.push(if points.fract() == 0.0 { format!("{} pt", points as i64) } else { format!("{points} pt") });
    }
    if let Some(url) = task["threadUrl"].as_str() {
        facts.push(format!("thread {url}"));
    }
    out.push(facts.join(" · "));
    if !subtasks.is_empty() {
        out.push(String::new());
        out.push(plural(work::count_nodes(subtasks), "subtask"));
        out.push(work::render_subtasks(subtasks));
    }
    out.push(String::new());
    out.push(match decisions.len() {
        0 => "no related decisions".to_string(),
        1 => "1 related decision".to_string(),
        n => format!("{n} related decisions"),
    });
    out.extend(decisions.iter().take(SHOW_DECISIONS_MAX).map(|d| format!("  {}", decision_line(d, false))));
    if decisions.len() > SHOW_DECISIONS_MAX {
        out.push(format!("  … and {} more: trama decisions --issue {key}", decisions.len() - SHOW_DECISIONS_MAX));
    }
    if record.is_object() {
        out.push(String::new());
        let files = record["files"].as_array().map_or(0, Vec::len);
        out.push(format!(
            "record  synced {}× · {} · last {}",
            record["syncCount"].as_u64().unwrap_or(0),
            plural(files, "file"),
            record["lastSyncAt"].as_str().unwrap_or("?")
        ));
        if let Some(summary) = record["summary"].as_str().filter(|s| !s.trim().is_empty()) {
            out.push(format!("  {}", one_line(summary)));
        }
    }
    out.join("\n")
}

// ───────────────────────────── ls ─────────────────────────────

async fn ls(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let limit = m.get_one::<u32>("limit").copied().unwrap_or(50);
    let mut query = vec![("limit".to_string(), limit.to_string())];
    if !m.get_flag("all") {
        query.push(("open".to_string(), "true".to_string()));
    }
    if m.get_flag("mine") {
        let mine = if ctx.dry_run { "<you>".to_string() } else { me(ctx).await? };
        query.push(("assigneeId".to_string(), mine));
    }
    let call = get("/tasks".to_string(), query);
    if ctx.dry_run {
        return exec::run("ls", &call, ACCEPT_JSON, ctx).await;
    }
    let rows: Vec<Value> = rows_of(exec::fetch(&call, ctx).await?).iter().map(work::summary).collect();
    output::print(&Value::Array(rows), &ctx.fmt);
    Ok(())
}

// ───────────────────────────── link, sub, status ─────────────────────────────

async fn link(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let reference = required(m, "id");
    let url = thread_to_link(m, ctx)?;
    let call = work::link_call(&reference, Some(&url)).map_err(usage)?;
    if ctx.dry_run {
        return exec::run("link", &call, ACCEPT_JSON, ctx).await;
    }
    let reply = exec::send(&call, ctx).await?;
    if !(200..300).contains(&reply.status) {
        return Err(api_failure(&reference, &reply));
    }
    let task = reply.json().unwrap_or(Value::Null);
    let key = task["key"].as_str().unwrap_or(&reference).to_string();
    say(ctx, &format!("✓ linked · {key} → {url}"), json!({ "linked": true, "task": key, "threadUrl": url }));
    Ok(())
}

async fn sub(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let reference = required(m, "id");
    let title = required(m, "title");
    let thread = if m.get_flag("link") || m.contains_id("thread") { Some(thread_to_link(m, ctx)?) } else { None };
    if ctx.dry_run {
        let parent = json!({ "id": reference, "kind": "<kind of the parent>" });
        let call = work::subtask_call(&parent, &title, thread.as_deref()).map_err(usage)?;
        return exec::run("sub", &call, ACCEPT_JSON, ctx).await;
    }
    let parent = exec::fetch(&task_call(&reference), ctx).await?;
    let call = work::subtask_call(&parent, &title, thread.as_deref()).map_err(usage)?;
    let created = exec::fetch(&call, ctx).await?;
    let key = created["key"].as_str().unwrap_or("?").to_string();
    let human = if thread.is_some() { format!("✓ {key} created · thread linked") } else { format!("✓ {key} created") };
    say(ctx, &human, json!({ "created": true, "linked": thread.is_some(), "task": work::summary(&created) }));
    Ok(())
}

/// The workspace's own status entries (`settings.statuses.issue`), empty when they cannot be read.
async fn status_catalog(ctx: &Ctx) -> Vec<Value> {
    let workspace = get(String::new(), vec![]);
    match exec::fetch(&workspace, ctx).await {
        Ok(ws) => ws["settings"]["statuses"]["issue"].as_array().cloned().unwrap_or_default(),
        Err(_) => vec![],
    }
}

async fn status(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let reference = required(m, "id");
    let raw = required(m, "status");
    if ctx.dry_run {
        let wire = work::status_type(&raw, &[]).unwrap_or_else(|| raw.clone());
        return exec::run("status", &work::status_call(&reference, &wire).map_err(usage)?, ACCEPT_JSON, ctx).await;
    }
    let wire = match work::status_type(&raw, &[]) {
        Some(t) => t,
        None => {
            let catalog = status_catalog(ctx).await;
            work::status_type(&raw, &catalog).ok_or_else(|| {
                let names: Vec<&str> = catalog.iter().filter_map(|e| e["name"].as_str()).collect();
                let mut hint = format!("Use one of {}", work::STATUS_TYPES.join(", "));
                if !names.is_empty() {
                    hint.push_str(&format!(", or a workspace status: {}", names.join(", ")));
                }
                CliError::usage(format!("'{raw}' is not a status")).hint(hint)
            })?
        }
    };
    let task = exec::fetch(&task_call(&reference), ctx).await?;
    let key = task["key"].as_str().unwrap_or(&reference).to_string();
    let before = task["status"].as_str().unwrap_or("?").to_string();
    if before == wire {
        let label = work::humanize_status(&wire);
        say(ctx, &format!("✓ {key} is already {label}"), json!({ "task": key, "status": wire, "changed": false }));
        return Ok(());
    }
    exec::fetch(&work::status_call(&reference, &wire).map_err(usage)?, ctx).await?;
    let human = format!("✓ {key} {} → {}", work::humanize_status(&before), work::humanize_status(&wire));
    say(ctx, &human, json!({ "task": key, "from": before, "status": wire, "changed": true }));
    Ok(())
}

// ───────────────────────────── sync ─────────────────────────────

/// `git`, run in the working directory: its stdout, or `None` when it fails or is not installed.
fn git(args: &[&str]) -> Option<Vec<u8>> {
    let out = Process::new("git").args(args).output().ok()?;
    out.status.success().then_some(out.stdout)
}

fn split_nul(bytes: &[u8]) -> Vec<String> {
    bytes.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
}

/// The paths of `git status --porcelain -z`: `XY path` entries, a rename or copy followed by its old path.
fn porcelain_paths(bytes: &[u8]) -> Vec<String> {
    let mut out = vec![];
    let mut entries = split_nul(bytes).into_iter();
    while let Some(entry) = entries.next() {
        let (Some(status), Some(path)) = (entry.get(..2), entry.get(3..)) else { continue };
        if status == "!!" || path.is_empty() {
            continue;
        }
        out.push(path.to_string());
        if status.contains('R') || status.contains('C') {
            entries.next();
        }
    }
    out
}

/// `origin/main` (what `origin/HEAD` points at), else the first of the usual default branches that exists.
fn default_branch() -> Option<String> {
    if let Some(out) = git(&["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        let name = String::from_utf8_lossy(&out).trim().to_string();
        if !name.is_empty() {
            return Some(name);
        }
    }
    ["origin/main", "origin/master", "main", "master"].into_iter().find(|b| git(&["rev-parse", "--verify", "--quiet", *b]).is_some()).map(str::to_string)
}

/// The files changed in the working tree and since the branch left the default branch.
fn files_from_git() -> std::result::Result<Vec<String>, String> {
    if git(&["rev-parse", "--is-inside-work-tree"]).is_none() {
        return Err("not inside a git repository (or git is not installed): no files were collected".into());
    }
    let mut files = git(&["status", "--porcelain", "-z", "--untracked-files=all"]).map(|o| porcelain_paths(&o)).unwrap_or_default();
    if let Some(base) = default_branch().and_then(|b| git(&["merge-base", "HEAD", &b])) {
        let base = String::from_utf8_lossy(&base).trim().to_string();
        if !base.is_empty()
            && let Some(diff) = git(&["diff", "--name-only", "-z", &base])
        {
            files.extend(split_nul(&diff));
        }
    }
    Ok(files)
}

/// What `sync` sends, from the flags.
fn sync_parts(m: &ArgMatches, ctx: &Ctx) -> Result<work::SyncParts> {
    let summary = match (flag(m, "summary"), flag(m, "summary-file")) {
        (Some(text), _) if text == "-" => Some(util::read_stdin()?),
        (Some(text), _) => Some(text),
        (None, Some(path)) => Some(util::read_path_or_stdin(&path)?),
        (None, None) => None,
    };
    let mut decisions = vec![];
    for spec in m.get_many::<String>("decision").into_iter().flatten() {
        decisions.push(work::parse_decision(spec).map_err(usage)?);
    }
    let mut files: Vec<String> = m.get_many::<String>("file").into_iter().flatten().cloned().collect();
    if m.get_flag("files-from-git") {
        match files_from_git() {
            Ok(found) => {
                if found.len() > work::THREAD_FILES_MAX {
                    eprintln!("warning: {} changed files; only the first {} are sent", found.len(), work::THREAD_FILES_MAX);
                }
                files.extend(found);
            }
            Err(why) => eprintln!("warning: {why}"),
        }
    }
    let thread_url = if m.contains_id("thread") { Some(thread_to_link(m, ctx)?) } else { None };
    Ok(work::SyncParts {
        summary,
        decisions,
        files,
        pull_request_url: None,
        active_minutes: m.get_one::<u32>("minutes").map(|n| i64::from(*n)),
        turns: m.get_one::<u32>("turns").map(|n| i64::from(*n)),
        thread_url,
    })
}

/// The URL of `--pr`: a URL as it is, or `owner/repo#123` read as GitHub when the project's repository is.
async fn pull_request_of(reference: &str, spec: &str, ctx: &Ctx) -> Result<String> {
    if spec.contains("://") {
        return work::pull_request_url(spec, None).map_err(usage);
    }
    if ctx.dry_run {
        // Previewing a request must not need the project: an unreadable spec shows a placeholder.
        return Ok(work::pull_request_url(spec, Some("github.com/owner/repo")).unwrap_or_else(|_| "https://<pull-request-url>".to_string()));
    }
    let task = exec::fetch(&task_call(reference), ctx).await?;
    let repository = match task["projectId"].as_str() {
        Some(project) => exec::fetch(&get(format!("/projects/{}", encode_segment(project)), vec![]), ctx).await.ok().and_then(|p| p["repository"].as_str().map(str::to_string)),
        None => None,
    };
    work::pull_request_url(spec, repository.as_deref()).map_err(usage)
}

/// One sync of one task: the reply of the API and the body that was sent.
async fn sync_task(reference: &str, parts: &work::SyncParts, pr: Option<&str>, ctx: &Ctx) -> Result<(Value, Value)> {
    let mut parts = parts.clone();
    if let Some(spec) = pr {
        parts.pull_request_url = Some(pull_request_of(reference, spec, ctx).await?);
    }
    let body = work::sync_body(&parts).map_err(usage)?;
    let call = work::thread_sync_call(reference, body.clone()).map_err(usage)?;
    let reply = exec::send(&call, ctx).await?;
    if !(200..300).contains(&reply.status) {
        return Err(api_failure(reference, &reply));
    }
    Ok((reply.json()?, body))
}

/// The lines of the skill: `✓ linked`, `✓ summary · 2 decisions · 3 files · 47m suggested`, `✓ PR attached`.
fn sync_lines(result: &Value, sent: &Value) -> Vec<String> {
    let mut lines = vec![];
    if result["linked"].as_bool() == Some(true) {
        lines.push("✓ linked".to_string());
    }
    let mut parts: Vec<String> = vec![];
    if sent.get("summary").is_some() {
        parts.push("summary".into());
    }
    let added = result["decisionsAdded"].as_u64().unwrap_or(0) as usize;
    if added > 0 {
        parts.push(plural(added, "decision"));
    }
    let files = sent["files"].as_array().map_or(0, Vec::len);
    if files > 0 {
        parts.push(plural(files, "file"));
    }
    match (result["timeSuggestion"]["minutes"].as_i64(), sent["activeMinutes"].as_i64()) {
        (Some(minutes), _) => parts.push(format!("{} suggested", fmt_minutes(minutes))),
        (None, Some(minutes)) => lines.push(format!("! {} not suggested: nobody owns the entry (use a key that acts as a person, or assign the task)", fmt_minutes(minutes))),
        (None, None) => {}
    }
    if parts.is_empty() && lines.is_empty() && !result["artifact"].is_object() {
        parts.push("synced".into());
    }
    if !parts.is_empty() {
        lines.push(format!("✓ {}", parts.join(" · ")));
    }
    if result["artifact"].is_object() {
        lines.push("✓ PR attached".to_string());
    }
    lines
}

fn sync_json(reference: &str, result: &Value, sent: &Value) -> Value {
    json!({
        "synced": true,
        "task": reference,
        "linked": result["linked"].as_bool().unwrap_or(false),
        "decisionsAdded": result["decisionsAdded"].as_u64().unwrap_or(0),
        "files": sent["files"].as_array().map_or(0, Vec::len),
        "syncCount": result["record"]["syncCount"],
        "threadUrl": result["record"]["threadUrl"],
        "artifact": if result["artifact"].is_object() { pick_fields(&result["artifact"], &["id", "kind", "title", "state", "url"]) } else { Value::Null },
        "timeSuggestion": result["timeSuggestion"],
    })
}

fn same_thread(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

async fn sync(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let reference = flag(m, "id");
    let all = m.get_flag("all");
    if !all && reference.is_none() {
        return Err(CliError::usage("sync needs a task, or --all").hint("`trama sync TRM-128`, or `trama sync --all` for every task linked to this thread (DELTA_THREAD_URL)."));
    }
    let parts = sync_parts(m, ctx)?;
    let pr = flag(m, "pr");

    let Some(reference) = reference else {
        return sync_all(&parts, pr.as_deref(), ctx).await;
    };
    if ctx.dry_run {
        let mut parts = parts;
        if let Some(spec) = &pr {
            parts.pull_request_url = Some(pull_request_of(&reference, spec, ctx).await?);
        }
        let call = work::thread_sync_call(&reference, work::sync_body(&parts).map_err(usage)?).map_err(usage)?;
        return exec::run("sync", &call, ACCEPT_JSON, ctx).await;
    }
    let (result, sent) = sync_task(&reference, &parts, pr.as_deref(), ctx).await?;
    say(ctx, &sync_lines(&result, &sent).join("\n"), sync_json(&reference, &result, &sent));
    Ok(())
}

/// `sync --all`: the same parts, for every task linked to the current thread.
async fn sync_all(parts: &work::SyncParts, pr: Option<&str>, ctx: &Ctx) -> Result<()> {
    let Some(current) = config::env("DELTA_THREAD_URL").or_else(|| ctx.dry_run.then(|| THREAD_PLACEHOLDER.to_string())) else {
        return Err(CliError::usage("--all syncs the tasks linked to this thread, and DELTA_THREAD_URL is not set").hint("Run inside a Delta thread, or name the task: `trama sync TRM-128`."));
    };
    let list = get("/tasks".to_string(), vec![("limit".to_string(), work::LIST_TASKS_MAX.to_string())]);
    if ctx.dry_run {
        return exec::run("sync --all", &list, ACCEPT_JSON, ctx).await;
    }
    let linked: Vec<Value> = rows_of(exec::fetch(&list, ctx).await?).into_iter().filter(|t| t["threadUrl"].as_str().is_some_and(|u| same_thread(u, &current))).collect();
    if linked.is_empty() {
        eprintln!("warning: no task is linked to this thread ({current}); link one with `trama link <ID>`");
    }
    let (mut synced, mut failed): (Vec<Value>, Vec<Value>) = (vec![], vec![]);
    let mut lines: Vec<String> = vec![];
    let mut first_error: Option<CliError> = None;
    for task in &linked {
        let key = task["key"].as_str().or_else(|| task["id"].as_str()).unwrap_or("?").to_string();
        match sync_task(&key, parts, pr, ctx).await {
            Ok((result, sent)) => {
                lines.push(format!("{key}\n{}", sync_lines(&result, &sent).iter().map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n")));
                synced.push(sync_json(&key, &result, &sent));
            }
            Err(e) => {
                lines.push(format!("{key}\n  ✗ {}", e.message));
                failed.push(json!({ "task": key, "error": e.message }));
                let stop = e.kind == Kind::RateLimited;
                first_error.get_or_insert(e);
                if stop {
                    break; // a rate limit is a stop sign, not something to loop over
                }
            }
        }
    }
    say(ctx, &lines.join("\n"), json!({ "synced": synced, "failed": failed }));
    first_error.map_or(Ok(()), Err)
}

// ───────────────────────────── decisions, ask, estimate ─────────────────────────────

fn render_decisions(rows: &[Value]) -> String {
    if rows.is_empty() {
        return "no decisions match".to_string();
    }
    rows.iter().map(|d| decision_line(d, true)).collect::<Vec<_>>().join("\n")
}

async fn decisions(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let call = work::decisions_call(flag(m, "path").as_deref(), flag(m, "issue").as_deref(), m.get_one::<usize>("limit").copied()).map_err(usage)?;
    if ctx.dry_run {
        return exec::run("decisions", &call, ACCEPT_JSON, ctx).await;
    }
    let rows = rows_of(exec::fetch(&call, ctx).await?);
    if wants_text(ctx) {
        output::emit(&output::escape_terminal_controls(&render_decisions(&rows)));
    } else {
        output::print(&Value::Array(rows), &ctx.fmt);
    }
    Ok(())
}

fn render_ask(question: &str, hits: &[Value]) -> String {
    let mut out = vec![format!("{} for \"{}\". {ASK_NOTE}", plural(hits.len(), "match").replace("matchs", "matches"), one_line(question))];
    for hit in hits {
        let key = hit["key"].as_str().or_else(|| hit["issueKey"].as_str()).unwrap_or("-");
        let mut line = format!("{key}  {}  {}", hit["type"].as_str().unwrap_or("?"), one_line(hit["title"].as_str().unwrap_or("")));
        if let Some(snippet) = hit["snippet"].as_str().or_else(|| hit["subtitle"].as_str()).map(one_line).filter(|s| !s.is_empty()) {
            let short: String = snippet.chars().take(100).collect();
            line.push_str(&format!(" — {short}"));
        }
        out.push(line);
    }
    out.join("\n")
}

async fn ask(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let question = m.get_many::<String>("question").map(|words| words.cloned().collect::<Vec<_>>().join(" ")).unwrap_or_default();
    let limit = m.get_one::<u32>("limit").copied().unwrap_or(10) as usize;
    let call = work::ask_call(&question, limit).map_err(usage)?;
    if ctx.dry_run {
        return exec::run("ask", &call, ACCEPT_JSON, ctx).await;
    }
    let hits = rows_of(exec::fetch(&call, ctx).await?);
    if wants_text(ctx) {
        output::emit(&output::escape_terminal_controls(&render_ask(&question, &hits)));
    } else {
        output::print(&json!({ "question": question, "results": hits, "note": ASK_NOTE }), &ctx.fmt);
    }
    Ok(())
}

fn render_estimate(reference: &str, v: &Value) -> String {
    let mut out = vec![];
    match v["suggestion"].as_f64() {
        Some(points) => {
            let n = if points.fract() == 0.0 { format!("{}", points as i64) } else { format!("{points}") };
            out.push(format!("{reference}: suggested estimate {n} pt"));
        }
        None => out.push(format!("{reference}: no suggestion yet")),
    }
    if let Some(reason) = v["reason"].as_str() {
        out.push(reason.to_string());
    }
    let basis = v["basis"].as_array().cloned().unwrap_or_default();
    if !basis.is_empty() {
        out.push("based on".to_string());
        for b in &basis {
            let mut line = format!("  {}  {}  {} pt", b["key"].as_str().unwrap_or("?"), one_line(b["title"].as_str().unwrap_or("")), b["estimate"].as_f64().map_or("?".to_string(), |e| format!("{e}")));
            if let Some(minutes) = b["trackedMinutes"].as_i64() {
                line.push_str(&format!(" · {} tracked", fmt_minutes(minutes)));
            }
            out.push(line);
        }
    }
    match v["suggestion"].as_f64() {
        Some(points) => out.push(format!("Nothing was changed. If the person agrees: trama task update {reference} --estimate {points}")),
        None => out.push("Nothing was changed. Leave the estimate to the person.".to_string()),
    }
    out.join("\n")
}

async fn estimate(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let reference = required(m, "id");
    let call = work::estimate_call(&reference).map_err(usage)?;
    if ctx.dry_run {
        return exec::run("estimate", &call, ACCEPT_JSON, ctx).await;
    }
    let reply = exec::fetch(&call, ctx).await?;
    if wants_text(ctx) {
        output::emit(&output::escape_terminal_controls(&render_estimate(&reference, &reply)));
    } else {
        let mut out = if reply.is_object() { reply } else { json!({ "result": reply }) };
        out["hint"] = json!(format!("A suggestion only; nothing was changed. If the person agrees: trama task update {reference} --estimate <points>"));
        output::print(&out, &ctx.fmt);
    }
    Ok(())
}

// ───────────────────────────── time ─────────────────────────────

async fn time(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    match m.subcommand() {
        // The same requests as `trama timer …`.
        Some(("start" | "stop" | "status", _)) => workcmd::timer(m, ctx).await,
        Some(("log", s)) => time_log(s, ctx).await,
        Some(("suggestions", s)) => match s.subcommand() {
            Some(("accept", a)) => time_accept(a, ctx).await,
            _ => time_suggestions(ctx).await,
        },
        Some(("accept", a)) => time_accept(a, ctx).await,
        _ => unreachable!("a subcommand is required"),
    }
}

async fn time_log(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let reference = required(m, "task");
    let minutes = work::parse_minutes(&required(m, "duration")).map_err(usage)?;
    let end_ms = match flag(m, "at") {
        Some(at) => work::parse_instant(&at).map_err(usage)?,
        None => work::now_ms(),
    };
    let description = flag(m, "description");
    if ctx.dry_run {
        let call = work::timer_log_call(Some(&reference), None, description.as_deref(), minutes, end_ms).map_err(usage)?;
        return exec::run("time log", &call, ACCEPT_JSON, ctx).await;
    }
    let issue = task_id(&reference, ctx).await?;
    let call = work::timer_log_call(Some(&issue), None, description.as_deref(), minutes, end_ms).map_err(usage)?;
    let entry = exec::fetch(&call, ctx).await?;
    say(
        ctx,
        &format!("✓ logged {} on {reference}", fmt_minutes(minutes)),
        json!({ "added": true, "entry": work::annotate_entry(&entry, work::now_ms()) }),
    );
    Ok(())
}

async fn time_suggestions(ctx: &Ctx) -> Result<()> {
    let call = work::time_suggestions_call();
    if ctx.dry_run {
        return exec::run("time suggestions", &call, ACCEPT_JSON, ctx).await;
    }
    let now = work::now_ms();
    let rows: Vec<Value> = rows_of(exec::fetch(&call, ctx).await?).iter().map(|e| work::annotate_entry(e, now)).collect();
    if ctx.fmt.tty {
        match rows.len() {
            0 => eprintln!("no suggested time is waiting"),
            n => eprintln!("{n} suggested: accept one with `trama time accept <id>`, dismiss it with `trama timer delete <id>`"),
        }
    }
    output::print(&Value::Array(rows), &ctx.fmt);
    Ok(())
}

async fn time_accept(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let id = required(m, "entry");
    let call = work::time_accept_call(&id).map_err(usage)?;
    if ctx.dry_run {
        return exec::run("time accept", &call, ACCEPT_JSON, ctx).await;
    }
    let entry = exec::fetch(&call, ctx).await?;
    let annotated = work::annotate_entry(&entry, work::now_ms());
    let duration = annotated["duration"].as_str().map(|d| format!(" · {d}")).unwrap_or_default();
    say(ctx, &format!("✓ accepted {id}{duration}"), json!({ "accepted": true, "entry": annotated }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmdtree::Registry;

    fn parse(args: &[&str]) -> ArgMatches {
        let root = Command::new("trama").subcommands(commands());
        let m = root.try_get_matches_from(std::iter::once("trama").chain(args.iter().copied())).unwrap_or_else(|e| panic!("{args:?}: {e}"));
        m.subcommand().map(|(_, sub)| sub.clone()).unwrap()
    }

    fn refuses(args: &[&str]) -> bool {
        Command::new("trama").subcommands(commands()).try_get_matches_from(std::iter::once("trama").chain(args.iter().copied())).is_err()
    }

    #[test]
    fn the_short_verbs_do_not_collide_with_the_other_commands() {
        let reg = Registry::load().unwrap();
        let mut root = Command::new("trama");
        for c in crate::builtin::definitions() {
            root = root.subcommand(c);
        }
        root = root.subcommand(workcmd::timer_command());
        root = root.subcommands(commands());
        for c in reg.commands() {
            if !workcmd::REPLACED_GROUPS.contains(&c.get_name()) {
                root = root.subcommand(c);
            }
        }
        root.clone().debug_assert();
        for name in NAMES {
            assert!(root.find_subcommand(name).is_some(), "{name} is registered");
        }
    }

    #[test]
    fn every_short_verb_is_listed_by_commands() {
        let listed: Vec<&str> = workcmd::EXTRA_ROWS.iter().map(|r| r.1).collect();
        for name in NAMES.iter().copied() {
            assert!(listed.iter().any(|c| c.split(' ').next() == Some(name)), "{name} is in EXTRA_ROWS");
        }
    }

    #[test]
    fn sync_takes_every_part_of_the_frame() {
        let m = parse(&[
            "sync", "TRM-128.3", "--summary", "Alert wired", "--decision", "Alert after 3 failures@src/auth/", "--decision", "Keep it simple", "--file", "a.ts", "--file", "b.ts",
            "--files-from-git", "--pr", "acme/web#423", "--minutes", "47", "--turns", "9", "--thread", "th_1",
        ]);
        assert_eq!(m.get_one::<String>("id").unwrap(), "TRM-128.3");
        assert_eq!(m.get_many::<String>("decision").unwrap().count(), 2);
        assert_eq!(m.get_many::<String>("file").unwrap().count(), 2);
        assert!(m.get_flag("files-from-git"));
        assert_eq!(m.get_one::<u32>("minutes"), Some(&47));
        assert_eq!(m.get_one::<String>("pr").unwrap(), "acme/web#423");
        assert!(parse(&["sync", "--all"]).get_flag("all"));
        assert_eq!(parse(&["sync", "TRM-1", "--summary", "-"]).get_one::<String>("summary").unwrap(), "-");
        assert!(refuses(&["sync", "TRM-1", "--all"]), "a task or --all");
        assert!(refuses(&["sync", "TRM-1", "--summary", "a", "--summary-file", "f"]));
        assert!(refuses(&["sync", "TRM-1", "--minutes", "x"]));
    }

    #[test]
    fn the_other_verbs_parse_as_in_the_skill() {
        assert_eq!(parse(&["show", "TRM-128", "--json"]).get_flag("json"), true);
        let m = parse(&["ls", "--mine", "--open"]);
        assert!(m.get_flag("mine") && m.get_flag("open") && !m.get_flag("all"));
        assert!(refuses(&["ls", "--open", "--all"]));
        assert_eq!(parse(&["link", "TRM-128.3", "--thread", "th_d93f10"]).get_one::<String>("thread").unwrap(), "th_d93f10");
        let m = parse(&["sub", "TRM-128", "Retry metrics", "--link"]);
        assert_eq!((m.get_one::<String>("title").unwrap().as_str(), m.get_flag("link")), ("Retry metrics", true));
        assert_eq!(parse(&["status", "TRM-128.3", "in-progress"]).get_one::<String>("status").unwrap(), "in-progress");
        let m = parse(&["decisions", "--path", "src/auth/x.ts", "--issue", "TRM-1", "--limit", "5"]);
        assert_eq!(m.get_one::<usize>("limit"), Some(&5));
        assert_eq!(parse(&["ask", "refresh", "tokens"]).get_many::<String>("question").unwrap().count(), 2);
        assert_eq!(parse(&["estimate", "TRM-128.3"]).get_one::<String>("id").unwrap(), "TRM-128.3");
        assert!(refuses(&["show"]));
        assert!(refuses(&["status", "TRM-1"]));
    }

    #[test]
    fn time_has_start_stop_status_log_and_suggestions() {
        let m = parse(&["time", "log", "TRM-128.3", "1h15", "--at", "2026-05-01T10:15:00Z", "--description", "x"]);
        let (name, s) = m.subcommand().unwrap();
        assert_eq!(name, "log");
        assert_eq!(s.get_one::<String>("duration").unwrap(), "1h15");
        for args in [vec!["time", "start", "TRM-1"], vec!["time", "start"], vec!["time", "stop"], vec!["time", "status"], vec!["time", "suggestions"], vec!["time", "suggestions", "accept", "te_1"], vec!["time", "accept", "te_1"]] {
            assert!(!refuses(&args), "{args:?}");
        }
        assert!(refuses(&["time"]));
        assert!(refuses(&["time", "log", "TRM-1"]));
    }

    #[test]
    fn porcelain_output_gives_the_changed_paths() {
        let out = b" M src/a.ts\0A  src/new file.ts\0R  src/renamed.ts\0src/old.ts\0?? notes.md\0!! dist/x.js\0D  gone.ts\0";
        assert_eq!(porcelain_paths(out), vec!["src/a.ts", "src/new file.ts", "src/renamed.ts", "notes.md", "gone.ts"]);
        assert!(porcelain_paths(b"").is_empty());
        assert!(porcelain_paths(b"x\0").is_empty());
        assert_eq!(split_nul(b"a\0b\0\0c"), vec!["a", "b", "c"]);
    }

    #[test]
    fn sync_prints_the_lines_of_the_frame() {
        let result = json!({
            "linked": true,
            "decisionsAdded": 2,
            "artifact": { "id": "ar_1", "kind": "pull_request" },
            "timeSuggestion": { "id": "te_1", "userId": "u", "minutes": 47 },
            "record": { "syncCount": 3, "threadUrl": "https://delta.example/t/1" }
        });
        let sent = json!({ "summary": "s", "files": ["a", "b", "c"], "activeMinutes": 47 });
        assert_eq!(sync_lines(&result, &sent), vec!["✓ linked", "✓ summary · 2 decisions · 3 files · 47m suggested", "✓ PR attached"]);
        let j = sync_json("TRM-1", &result, &sent);
        assert_eq!((j["files"].clone(), j["decisionsAdded"].clone(), j["syncCount"].clone()), (json!(3), json!(2), json!(3)));
        assert_eq!(j["artifact"], json!({ "id": "ar_1", "kind": "pull_request" }));

        let plain = json!({ "linked": false, "decisionsAdded": 0, "artifact": null, "timeSuggestion": null, "record": {} });
        assert_eq!(sync_lines(&plain, &json!({})), vec!["✓ synced"]);
        assert_eq!(sync_lines(&plain, &json!({ "files": ["a"], "summary": "x" })), vec!["✓ summary · 1 file"]);
        assert_eq!(sync_lines(&json!({ "artifact": { "id": "ar" } }), &json!({})), vec!["✓ PR attached"]);
        let lines = sync_lines(&plain, &json!({ "activeMinutes": 30 }));
        assert!(lines.len() == 1 && lines[0].starts_with("! 30m not suggested"), "{lines:?}");
    }

    #[test]
    fn show_is_a_short_header_subtasks_and_decisions() {
        let task = json!({ "key": "TRM-128.3", "title": "Alerting when refresh fails", "status": "todo", "estimate": 3, "threadUrl": "https://delta.example/t/1" });
        let subtasks = vec![json!({ "key": "TRM-128.4", "title": "Retry", "status": "todo", "id": "in_4" })];
        let decisions = vec![
            json!({ "text": "Alert after 3 failed refreshes", "paths": ["src/auth/*"] }),
            json!({ "text": "Keep the queue", "paths": [] }),
        ];
        let record = json!({ "syncCount": 3, "files": ["a", "b"], "lastSyncAt": "2026-05-01T09:00:00.000Z", "summary": "Wired the alert\nand tested it" });
        assert_eq!(
            render_show(&task, Some("TRM-128"), &subtasks, &decisions, &record),
            "TRM-128.3  Alerting when refresh fails\n\
             Todo · parent TRM-128 · 3 pt · thread https://delta.example/t/1\n\
             \n\
             1 subtask\n\
             \x20 TRM-128.4  todo  Retry\n\
             \n\
             2 related decisions\n\
             \x20 Alert after 3 failed refreshes  (src/auth/*)\n\
             \x20 Keep the queue\n\
             \n\
             record  synced 3× · 2 files · last 2026-05-01T09:00:00.000Z\n\
             \x20 Wired the alert and tested it"
        );
        let bare = render_show(&json!({ "key": "A-1", "title": "t", "status": "in_progress" }), None, &[], &[], &Value::Null);
        assert_eq!(bare, "A-1  t\nIn progress\n\nno related decisions");
    }

    #[test]
    fn decisions_read_as_key_text_and_paths() {
        let rows = vec![json!({ "issueKey": "TRM-128", "text": "Rotate tokens", "paths": ["src/auth/", "src/session.ts"] }), json!({ "issueKey": "TRM-9", "text": "No paths" })];
        assert_eq!(render_decisions(&rows), "TRM-128  Rotate tokens  (src/auth/, src/session.ts)\nTRM-9  No paths");
        assert_eq!(render_decisions(&[]), "no decisions match");
        assert_eq!(decision_line(&json!({ "text": "a\n  b" }), true), "-  a b");
    }

    #[test]
    fn ask_says_it_only_lists_matches() {
        let hits = vec![
            json!({ "type": "decision", "key": "TRM-128", "id": "in_1", "title": "Rotate refresh tokens" }),
            json!({ "type": "record", "key": "TRM-127", "id": "in_2", "title": "Alerting", "snippet": "Wired the alert to the job" }),
        ];
        let text = render_ask("refresh tokens", &hits);
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].starts_with("2 matches for \"refresh tokens\"."), "{text}");
        assert!(lines[0].contains("does not generate an answer"));
        assert_eq!(lines[1], "TRM-128  decision  Rotate refresh tokens");
        assert_eq!(lines[2], "TRM-127  record  Alerting — Wired the alert to the job");
        assert!(render_ask("x", &[]).starts_with("0 matches for"));
        assert!(render_ask("x", &hits[..1]).starts_with("1 match for"));
    }

    #[test]
    fn estimate_never_applies_the_suggestion() {
        let v = json!({
            "suggestion": 3,
            "reason": "Median of 2 similar tasks.",
            "basis": [{ "key": "TRM-101", "title": "Retry queue", "estimate": 3, "trackedMinutes": 130 }, { "key": "TRM-90", "title": "Backoff", "estimate": 2, "trackedMinutes": null }]
        });
        assert_eq!(
            render_estimate("TRM-128.3", &v),
            "TRM-128.3: suggested estimate 3 pt\n\
             Median of 2 similar tasks.\n\
             based on\n\
             \x20 TRM-101  Retry queue  3 pt · 2h 10m tracked\n\
             \x20 TRM-90  Backoff  2 pt\n\
             Nothing was changed. If the person agrees: trama task update TRM-128.3 --estimate 3"
        );
        let none = render_estimate("TRM-1", &json!({ "suggestion": null, "reason": "Only one similar task.", "basis": [] }));
        assert_eq!(none, "TRM-1: no suggestion yet\nOnly one similar task.\nNothing was changed. Leave the estimate to the person.");
    }

    #[test]
    fn minutes_read_like_people_say_them() {
        assert_eq!((fmt_minutes(45), fmt_minutes(60), fmt_minutes(75), fmt_minutes(130)), ("45m".to_string(), "1h".to_string(), "1h 15m".to_string(), "2h 10m".to_string()));
        assert!(same_thread("https://d.example/t/1/", "https://d.example/t/1"));
        assert!(!same_thread("https://d.example/t/1", "https://d.example/t/2"));
    }
}
