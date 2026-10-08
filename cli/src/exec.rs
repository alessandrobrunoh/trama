//! Runs one resolved workspace request: dry-run, confirmation of deletes, credentials, call, output.

use serde_json::{Map, Value, json};

use crate::Ctx;
use crate::auth;
use crate::catalog::{Call, Method, encode_segment};
use crate::config;
use crate::error::{CliError, Result};
use crate::http::Api;
use crate::output;
use crate::util;

/// Prints the request that would be sent, without sending it or requiring a login.
fn dry_run(call: &Call, ctx: &Ctx) -> Result<()> {
    let creds = config::resolve(&ctx.ov).ok();
    let base = creds
        .as_ref()
        .map(|c| c.url.clone())
        .unwrap_or_else(|| config::DEFAULT_API_URL.to_string());
    let slug = creds
        .and_then(|c| c.workspace)
        .map(|s| encode_segment(&s))
        .unwrap_or_else(|| "<workspace>".to_string());
    let query: Map<String, Value> = call
        .query
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    let mut request = json!({
        "method": call.method.as_str(),
        "url": format!("{base}/w/{slug}{}", call.path),
    });
    if !query.is_empty() {
        request["query"] = Value::Object(query);
    }
    if let Some(body) = &call.body {
        request["body"] = body.clone();
    }
    output::print(&json!({ "dryRun": true, "request": request }), &ctx.fmt);
    Ok(())
}

/// `label` names the command for the confirmation prompt (e.g. `issue delete BUG-1`).
pub async fn run(label: &str, call: &Call, accept: &str, ctx: &Ctx) -> Result<()> {
    if ctx.dry_run {
        return dry_run(call, ctx);
    }
    if call.method == Method::Delete
        && !ctx.yes
        && util::interactive()
        && !util::confirm(&format!("Run `trama {label}`? This cannot be undone"))?
    {
        return Err(CliError::usage("aborted"));
    }
    let targets = config::resolve_many(&ctx.ov)?;
    // A write names one object. Fanning it out would create or edit it in every workspace.
    if targets.len() > 1 && call.method != Method::Get {
        let where_: Vec<String> = targets
            .iter()
            .map(|c| c.workspace.clone().unwrap_or_else(|| "?".into()))
            .collect();
        return Err(CliError::usage(format!("'{label}' changes data, so it needs exactly one workspace (it matched {})", where_.join(", ")))
            .hint("Add `--profile <name>` or `--workspace <slug>`. Reads (`list`, `get`, `search`) are the ones that run across every match."));
    }
    if targets.len() <= 1 {
        let creds = targets
            .into_iter()
            .next()
            .ok_or_else(CliError::not_logged_in)?;
        let api = Api::new(&creds.url, ctx.timeout)?;
        let slug = auth::workspace_slug(&api, &creds).await?;
        let reply = api
            .workspace(&creds.token, &slug, call, accept)
            .await?
            .into_result()?;
        return output::print_reply(&reply, &ctx.fmt);
    }
    run_across(&targets, call, accept, ctx).await
}

/// One read, sent to every matching profile. Each row carries the workspace it came from, so keys
/// that exist in more than one workspace stay distinguishable. A workspace that fails is reported,
/// not fatal, as long as another one answered.
async fn run_across(targets: &[config::Creds], call: &Call, accept: &str, ctx: &Ctx) -> Result<()> {
    let mut rows: Vec<Value> = vec![];
    let mut texts: Vec<(String, String)> = vec![];
    let mut errors: Vec<Value> = vec![];
    for creds in targets {
        let slug = creds.workspace.clone().unwrap_or_default();
        let profile = creds.profile.clone().unwrap_or_default();
        let reply = match call_one(creds, call, accept, ctx).await {
            Ok(r) => r,
            Err(e) => {
                errors.push(json!({ "workspace": slug, "profile": profile, "error": e.message }));
                continue;
            }
        };
        if !reply.is_json() && !reply.body.trim().is_empty() {
            texts.push((slug, reply.body));
            continue;
        }
        let value = reply.json().unwrap_or(Value::Null);
        match value {
            Value::Array(items) => {
                rows.extend(items.into_iter().map(|item| tag(item, &slug, &profile)))
            }
            other => rows.push(tag(other, &slug, &profile)),
        }
    }
    for err in &errors {
        eprintln!(
            "warning: {} ({}): {}",
            err["workspace"].as_str().unwrap_or(""),
            err["profile"].as_str().unwrap_or(""),
            err["error"].as_str().unwrap_or("")
        );
    }
    if rows.is_empty() && texts.is_empty() {
        return Err(errors
            .first()
            .and_then(|e| e.get("error"))
            .and_then(Value::as_str)
            .map(|m| CliError::new(crate::error::Kind::Network, m))
            .unwrap_or_else(|| CliError::internal("every workspace failed")));
    }
    if !texts.is_empty() {
        // Markdown briefings have no row to stamp, so each one gets a heading naming its workspace.
        let joined = texts
            .iter()
            .map(|(slug, body)| format!("# {slug}\n\n{body}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        output::emit(&joined);
        return Ok(());
    }
    output::print(&Value::Array(rows), &ctx.fmt);
    Ok(())
}

async fn call_one(
    creds: &config::Creds,
    call: &Call,
    accept: &str,
    ctx: &Ctx,
) -> Result<crate::http::Reply> {
    let api = Api::new(&creds.url, ctx.timeout)?;
    let slug = auth::workspace_slug(&api, creds).await?;
    api.workspace(&creds.token, &slug, call, accept)
        .await?
        .into_result()
}

/// Stamps a row with the workspace it was read from. A reply that is already an object keeps its
/// fields; anything else is wrapped so the workspace is never lost.
fn tag(value: Value, workspace: &str, profile: &str) -> Value {
    match value {
        Value::Object(mut map) => {
            map.insert("workspace".into(), json!(workspace));
            map.insert("profile".into(), json!(profile));
            Value::Object(map)
        }
        other => json!({ "workspace": workspace, "profile": profile, "result": other }),
    }
}
