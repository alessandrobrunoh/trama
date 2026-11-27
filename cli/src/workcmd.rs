//! Commands that are not one catalog route: the subtask tree and the task timer,
//! plus two filters the API does not have (`task list --parent`, `project list --repository`).
//!
//! The requests and their validation live in `mcp/src/work.rs`, shared with the MCP composites, so the
//! shell and the MCP tools behave the same. These commands are not in `tools.json` because their routes
//! are outside the API permission catalog (custom tokens are refused there); they need a key that acts
//! as a person (the timer), and the API says so when it does not.

use clap::{Arg, ArgMatches, Command, value_parser};
use serde_json::{Value, json};

use crate::Ctx;
use crate::catalog::{Call, Method, encode_segment};
use crate::cmdtree::{self, Registry};
use crate::error::{CliError, Result};
use crate::http::ACCEPT_JSON;
use crate::output::{self, Mode};
use crate::{exec, work};

/// Commands shown by `trama commands` next to the generated ones: (resource, command, method, route, who may, summary).
pub const EXTRA_ROWS: &[(&str, &str, &str, &str, &str, &str)] = &[
    ("task", "task subtasks", "GET", "/tasks", "tasks:read", "A task's subtasks as an indented tree of any depth"),
    ("timer", "timer start", "POST", "/time-entries/start", "user key", "Start your timer, on a task if given"),
    ("timer", "timer stop", "POST", "/time-entries/stop", "user key", "Stop your running timer"),
    ("timer", "timer status", "GET", "/time-entries", "user key", "The running timer and its task"),
    ("timer", "timer list", "GET", "/time-entries", "user key", "Your latest time entries, optionally of one task, with durations"),
    ("timer", "timer add", "POST", "/time-entries", "user key", "Add a finished time entry"),
    ("timer", "timer delete", "DELETE", "/time-entries/{id}", "user key", "Delete one of your time entries"),
    // The short verbs of `/trama` (`shortcmd.rs`).
    ("task", "show", "GET", "/tasks/{id}/context", "tasks:read", "A task with its subtasks, decisions and thread record"),
    ("task", "ls", "GET", "/tasks", "tasks:read", "Open tasks, yours with --mine"),
    ("task", "link", "PATCH", "/tasks/{id}", "tasks:write", "Link the current thread to a task (one thread per task)"),
    ("task", "sub", "POST", "/tasks", "tasks:write", "New subtask of a task, in its project, optionally linked to the thread"),
    ("task", "status", "PATCH", "/tasks/{id}", "tasks:write", "Set a task's status (workspace status names work too)"),
    ("thread", "sync", "POST", "/tasks/{id}/thread/sync", "tasks:write", "Update the task's thread record: summary, decisions, files, PR, active minutes"),
    ("decision", "decisions", "GET", "/decisions", "tasks:read", "Past decisions, by file path or task"),
    ("search", "ask", "GET", "/search", "search:read", "Decisions and thread records that match a question (no generated answer)"),
    ("estimate", "estimate", "GET", "/tasks/{id}/estimate-suggestion", "tasks:read", "Points suggested from similar finished tasks (you decide)"),
    ("time", "time start", "POST", "/time-entries/start", "user key", "Start your timer, on a task if given (same as `timer start`)"),
    ("time", "time stop", "POST", "/time-entries/stop", "user key", "Stop your running timer"),
    ("time", "time status", "GET", "/time-entries", "user key", "The running timer and its task"),
    ("time", "time log", "POST", "/time-entries", "user key", "Log finished time on a task: 1h15, 45m, 90, 1:15"),
    ("time", "time suggestions", "GET", "/time-entries", "user key", "Time that `sync` suggested, waiting for you; `accept <id>` takes it"),
    ("time", "time accept", "POST", "/time-entries/{id}/accept", "user key", "Accept a suggested time entry"),
];

/// Generated groups whose short verb replaces them in the command tree: `trama decisions` and
/// `trama estimate` read the same routes as `decision list` and `estimate suggest`.
pub const REPLACED_GROUPS: &[&str] = &["decision", "estimate"];

// ───────────────────────────── command definitions ─────────────────────────────

fn task_arg(required: bool) -> Arg {
    Arg::new("task").value_name("ID_OR_KEY").required(required).help("Task id or key (e.g. CORA-142)")
}

fn project_arg() -> Arg {
    Arg::new("project-id").long("project-id").value_name("ID").help("Project to book the time on when there is no task")
}

fn description_arg() -> Arg {
    Arg::new("description").long("description").value_name("TEXT").help("What you work on (at most 500 characters)")
}

fn subtasks_command() -> Command {
    Command::new("subtasks")
        .about("A task's subtasks as an indented tree of any depth")
        .long_about(
            "Reads the task and every task below it (subtasks nest to any depth) and prints the tree. \
             On a terminal, or with `-o table`, it is indented text (`KEY  status  title  (points)`, two spaces per level). \
             Piped, or with `-o json`, it is JSON where each node's `subtasks` holds its children. \
             The API has no parent filter, so the newest 500 tasks are read once and the tree is built here.",
        )
        .arg(task_arg(true))
        .arg(Arg::new("depth").long("depth").value_name("N").value_parser(value_parser!(usize)).help("Levels to show; 1 = direct subtasks only (default: all)"))
        .arg(Arg::new("project-id").long("project-id").value_name("ID").help("Read only this project's tasks (use it on a big workspace)"))
        .after_help("Example:\n  trama task subtasks CORA-142\n  trama task subtasks CORA-142 --depth 1 -o json\n\nRequires permission `tasks:read`.")
}

/// Adds `task subtasks` and the `--parent` filter of `task list` to the generated `task` group.
pub fn extend_task(cmd: Command) -> Command {
    cmd.mut_subcommand("list", |list| {
        list.arg(
            Arg::new("parent")
                .long("parent")
                .value_name("ID_OR_KEY")
                .help("Only the direct subtasks of this task (matched here: the API has no parent filter, so the newest 500 matches are read)")
                .help_heading("Filters"),
        )
    })
    .subcommand(subtasks_command())
}

/// Adds the `--repository` filter to `project list`.
pub fn extend_project(cmd: Command) -> Command {
    cmd.mut_subcommand("list", |list| {
        list.arg(
            Arg::new("repository")
                .long("repository")
                .value_name("OWNER/NAME|URL")
                .help("Only projects with this repository (owner/name or a git URL, case-insensitive; matched here, the API does not filter by it)")
                .help_heading("Filters"),
        )
    })
}

pub fn timer_command() -> Command {
    Command::new("timer")
        .about("Your task timer: start, stop, list and edit time entries")
        .long_about(
            "The timer and time entries of the signed-in person; other people's entries are never listed or changed. \
             Needs a login that acts as a person (a key created with `trama login --email`, or a read/write/admin token of a user), not a custom token.\n\n\
             Instants are ISO-8601 with a zone: 2026-05-01T09:30:00Z or 2026-05-01T11:30:00+02:00.",
        )
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(
            Command::new("start")
                .about("Start the timer, on a task if given (a running timer is stopped first)")
                .arg(task_arg(false))
                .arg(project_arg())
                .arg(description_arg())
                .after_help("Example:\n  trama timer start CORA-142 --description \"login fix\""),
        )
        .subcommand(Command::new("stop").about("Stop the running timer"))
        .subcommand(Command::new("status").about("The running timer, its elapsed time and its task"))
        .subcommand(
            Command::new("list")
                .visible_alias("ls")
                .about("Your 100 latest time entries, with durations; of one task if given")
                .arg(task_arg(false)),
        )
        .subcommand(
            Command::new("add")
                .about("Add a finished time entry")
                .arg(task_arg(false))
                .arg(project_arg())
                .arg(description_arg())
                .arg(Arg::new("started-at").long("started-at").value_name("ISO").required(true).help("Start, with a zone (2026-05-01T09:00:00Z)"))
                .arg(Arg::new("ended-at").long("ended-at").value_name("ISO").required(true).help("End, with a zone; after the start"))
                .after_help("Example:\n  trama timer add CORA-142 --started-at 2026-05-01T09:00:00Z --ended-at 2026-05-01T10:15:00Z"),
        )
        .subcommand(
            Command::new("delete")
                .visible_alias("rm")
                .about("Delete one of your time entries")
                .arg(Arg::new("id").value_name("ENTRY_ID").required(true).help("Time entry id (te_…), from `trama timer list`")),
        )
}

// ───────────────────────────── helpers ─────────────────────────────

pub(crate) fn get(path: String, query: Vec<(String, String)>) -> Call {
    Call { method: Method::Get, path, query, body: None }
}

pub(crate) fn task_call(reference: &str) -> Call {
    get(format!("/tasks/{}", encode_segment(reference)), vec![])
}

fn is_task_id(reference: &str) -> bool {
    matches!(reference.split_once('_'), Some(("in" | "iss", rest)) if !rest.is_empty())
}

/// The id the API wants in a body: an id stays as it is, a key is looked up.
pub(crate) async fn task_id(reference: &str, ctx: &Ctx) -> Result<String> {
    if is_task_id(reference) {
        return Ok(reference.to_string());
    }
    let task = exec::fetch(&task_call(reference), ctx).await?;
    task["id"].as_str().map(str::to_string).ok_or_else(|| CliError::internal("the API sent a task without an id"))
}

pub(crate) fn rows_of(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        // Some replies wrap their rows: `{ "results": [...] }`.
        Value::Object(map) => ["results", "items"].iter().find_map(|k| map.get(*k).and_then(Value::as_array)).cloned().unwrap_or_default(),
        _ => vec![],
    }
}

/// Text rather than JSON: on a terminal or when a table is asked for.
pub(crate) fn wants_text(ctx: &Ctx) -> bool {
    ctx.fmt.mode == Mode::Table || (ctx.fmt.mode == Mode::Auto && ctx.fmt.tty)
}

pub(crate) fn usage(message: String) -> CliError {
    CliError::usage(message)
}

// ───────────────────────────── routing ─────────────────────────────

/// Handles the generated commands that this module extends. `None` = not one of them.
pub async fn intercept(reg: &Registry, group: &str, verb: Option<&str>, m: &ArgMatches, ctx: &Ctx) -> Option<Result<()>> {
    match (group, verb) {
        ("task", Some("subtasks")) => Some(subtasks(m, ctx).await),
        ("task", Some("list")) if m.try_contains_id("parent").unwrap_or(false) => Some(list_children(reg, m, ctx).await),
        ("project", Some("list")) if m.try_contains_id("repository").unwrap_or(false) => Some(list_by_repository(reg, m, ctx).await),
        _ => None,
    }
}

// ───────────────────────────── subtasks ─────────────────────────────

async fn subtasks(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let reference = m.get_one::<String>("task").expect("required");
    let depth = m.get_one::<usize>("depth").copied();
    let mut query = vec![("limit".to_string(), work::LIST_TASKS_MAX.to_string())];
    let scoped = m.get_one::<String>("project-id");
    if let Some(p) = scoped {
        query.push(("projectId".to_string(), p.clone()));
    }
    let list = get("/tasks".to_string(), query);
    if ctx.dry_run {
        return exec::run("task subtasks", &list, ACCEPT_JSON, ctx).await;
    }
    let root = exec::fetch(&task_call(reference), ctx).await?;
    let root_id = root["id"].as_str().ok_or_else(|| CliError::internal("the API sent a task without an id"))?.to_string();
    let all = rows_of(exec::fetch(&list, ctx).await?);
    let truncated = all.len() >= work::LIST_TASKS_MAX && scoped.is_none();
    if truncated {
        eprintln!("warning: only the newest {} tasks were read, so deeper subtasks may be missing; narrow with --project-id", work::LIST_TASKS_MAX);
    }
    let nodes = work::subtree(&all, &root_id, depth);
    let head = work::summary(&root);
    if wants_text(ctx) {
        let mut text = work::render_tree(&head, &nodes);
        if nodes.is_empty() {
            text.push_str("\n  (no subtasks)");
        }
        output::emit(&output::escape_terminal_controls(&text));
        return Ok(());
    }
    let mut out = json!({ "task": head, "count": work::count_nodes(&nodes), "subtasks": nodes });
    if truncated {
        out["truncated"] = json!(true);
    }
    output::print(&out, &ctx.fmt);
    Ok(())
}

async fn list_children(reg: &Registry, m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let entry = reg.find("task", Some("list")).ok_or_else(|| CliError::internal("no task list command"))?;
    let mut args = cmdtree::extract(entry, m)?;
    // The filter runs here, so read the widest page and apply the user's limit afterwards.
    let wanted = args.get("limit").and_then(Value::as_u64).map(|n| n as usize);
    args["limit"] = json!(work::LIST_TASKS_MAX);
    let call = entry.tool.build_call(&args).map_err(|e| CliError::usage(cmdtree::friendly(entry, &e)))?;
    if ctx.dry_run {
        return exec::run("task list", &call, ACCEPT_JSON, ctx).await;
    }
    let parent = task_id(m.get_one::<String>("parent").expect("checked"), ctx).await?;
    let all = rows_of(exec::fetch(&call, ctx).await?);
    if all.len() >= work::LIST_TASKS_MAX {
        eprintln!("warning: only the newest {} matching tasks were read; narrow with --project-id, --q or --status to be sure no subtask is missing", work::LIST_TASKS_MAX);
    }
    let mut kids = work::children_of(&all, &parent);
    if let Some(n) = wanted {
        kids.truncate(n);
    }
    output::print(&Value::Array(kids), &ctx.fmt);
    Ok(())
}

// ───────────────────────────── projects ─────────────────────────────

async fn list_by_repository(reg: &Registry, m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let entry = reg.find("project", Some("list")).ok_or_else(|| CliError::internal("no project list command"))?;
    let args = cmdtree::extract(entry, m)?;
    let call = entry.tool.build_call(&args).map_err(|e| CliError::usage(cmdtree::friendly(entry, &e)))?;
    if ctx.dry_run {
        return exec::run("project list", &call, ACCEPT_JSON, ctx).await;
    }
    let wanted = m.get_one::<String>("repository").expect("checked");
    let found = work::filter_by_repository(rows_of(exec::fetch(&call, ctx).await?), wanted);
    output::print(&Value::Array(found), &ctx.fmt);
    Ok(())
}

// ───────────────────────────── timer ─────────────────────────────

async fn entries(ctx: &Ctx) -> Result<Vec<Value>> {
    Ok(rows_of(exec::fetch(&work::timer_list_call(), ctx).await?))
}

pub async fn timer(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let flag = |s: &ArgMatches, id: &str| s.get_one::<String>(id).map(String::to_string);
    match m.subcommand() {
        Some(("start", s)) => {
            let (task, project, description) = (flag(s, "task"), flag(s, "project-id"), flag(s, "description"));
            if ctx.dry_run {
                let call = work::timer_start_call(task.as_deref(), project.as_deref(), description.as_deref()).map_err(usage)?;
                return exec::run("timer start", &call, ACCEPT_JSON, ctx).await;
            }
            let issue = match &task {
                Some(t) => Some(task_id(t, ctx).await?),
                None => None,
            };
            let call = work::timer_start_call(issue.as_deref(), project.as_deref(), description.as_deref()).map_err(usage)?;
            // The API stops a running timer when a new one starts; say which one it was.
            let before = entries(ctx).await.unwrap_or_default();
            let entry = exec::fetch(&call, ctx).await?;
            let now = work::now_ms();
            let mut out = json!({ "started": true, "entry": work::annotate_entry(&entry, now) });
            if let Some(prev) = work::running_entry(&before) {
                out["stopped"] = work::annotate_entry(prev, now);
            }
            output::print(&out, &ctx.fmt);
            Ok(())
        }
        Some(("stop", _)) => {
            if ctx.dry_run {
                return exec::run("timer stop", &work::timer_stop_call(), ACCEPT_JSON, ctx).await;
            }
            let entry = exec::fetch(&work::timer_stop_call(), ctx).await?;
            output::print(&json!({ "stopped": true, "entry": work::annotate_entry(&entry, work::now_ms()) }), &ctx.fmt);
            Ok(())
        }
        Some(("status", _)) => {
            if ctx.dry_run {
                return exec::run("timer status", &work::timer_list_call(), ACCEPT_JSON, ctx).await;
            }
            let all = entries(ctx).await?;
            let Some(running) = work::running_entry(&all) else {
                output::print(&json!({ "running": null }), &ctx.fmt);
                return Ok(());
            };
            let mut out = json!({ "running": work::annotate_entry(running, work::now_ms()) });
            if let Some(id) = running["issueId"].as_str()
                && let Ok(task) = exec::fetch(&task_call(id), ctx).await
            {
                out["task"] = work::summary(&task);
            }
            output::print(&out, &ctx.fmt);
            Ok(())
        }
        Some(("list", s)) => {
            if ctx.dry_run {
                return exec::run("timer list", &work::timer_list_call(), ACCEPT_JSON, ctx).await;
            }
            let issue = match flag(s, "task") {
                Some(t) => Some(task_id(&t, ctx).await?),
                None => None,
            };
            let now = work::now_ms();
            let shown: Vec<Value> = entries(ctx)
                .await?
                .iter()
                .filter(|e| issue.as_deref().is_none_or(|id| e["issueId"].as_str() == Some(id)))
                .map(|e| work::annotate_entry(e, now))
                .collect();
            if ctx.fmt.tty {
                eprintln!("total {} on {} finished entries", work::format_duration(work::total_seconds(&shown)), shown.iter().filter(|e| e["durationSeconds"].is_i64()).count());
            }
            output::print(&Value::Array(shown), &ctx.fmt);
            Ok(())
        }
        Some(("add", s)) => {
            let (started, ended) = (flag(s, "started-at").expect("required"), flag(s, "ended-at").expect("required"));
            let (task, project, description) = (flag(s, "task"), flag(s, "project-id"), flag(s, "description"));
            if ctx.dry_run {
                let call = work::timer_add_call(task.as_deref(), project.as_deref(), description.as_deref(), &started, &ended).map_err(usage)?;
                return exec::run("timer add", &call, ACCEPT_JSON, ctx).await;
            }
            let issue = match &task {
                Some(t) => Some(task_id(t, ctx).await?),
                None => None,
            };
            let call = work::timer_add_call(issue.as_deref(), project.as_deref(), description.as_deref(), &started, &ended).map_err(usage)?;
            let entry = exec::fetch(&call, ctx).await?;
            output::print(&json!({ "added": true, "entry": work::annotate_entry(&entry, work::now_ms()) }), &ctx.fmt);
            Ok(())
        }
        Some(("delete", s)) => {
            let id = flag(s, "id").expect("required");
            let call = work::timer_delete_call(&id).map_err(usage)?;
            exec::run(&format!("timer delete {id}"), &call, ACCEPT_JSON, ctx).await
        }
        _ => unreachable!("a subcommand is required"),
    }
}
