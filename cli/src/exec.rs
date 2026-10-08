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
    let base = creds.as_ref().map(|c| c.url.clone()).unwrap_or_else(|| config::DEFAULT_API_URL.to_string());
    let slug = creds.and_then(|c| c.workspace).map(|s| encode_segment(&s)).unwrap_or_else(|| "<workspace>".to_string());
    let query: Map<String, Value> = call.query.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
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
    if call.method == Method::Delete && !ctx.yes && util::interactive() && !util::confirm(&format!("Run `trama {label}`? This cannot be undone"))? {
        return Err(CliError::usage("aborted"));
    }
    let creds = config::resolve(&ctx.ov)?;
    let api = Api::new(&creds.url, ctx.timeout)?;
    let slug = auth::workspace_slug(&api, &creds).await?;
    let reply = api.workspace(&creds.token, &slug, call, accept).await?.into_result()?;
    output::print_reply(&reply, &ctx.fmt)
}
