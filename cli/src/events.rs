//! `trama event watch`: the workspace's live event stream (Server-Sent Events) as JSON lines.
//!
//! Each line is one `LiveEvent` (`{ "type": "updated", "entity": "issue", "id": "iss_…", "at": "…" }`):
//! a pointer to what changed, so an agent can wake up on activity and then read the object.
//! Reconnects on dropped connections; ends on Ctrl-C, after `--count` events or after `--for` seconds.

use std::time::Duration;

use clap::{Arg, ArgMatches, Command, value_parser};
use serde_json::Value;

use crate::Ctx;
use crate::auth;
use crate::config;
use crate::error::{Kind, Result};
use crate::http::Api;
use crate::output;

pub fn command() -> Command {
    Command::new("watch")
        .about("Stream live workspace events as JSON lines")
        .long_about("Streams LiveEvents (created, updated, deleted, attention) as they happen, one JSON object per line. Each is a pointer (entity + id); read the object with the matching `get` command.")
        .arg(Arg::new("entity").long("entity").value_name("ENTITY").help("Only events of this entity, e.g. issue, workstream, decision"))
        .arg(Arg::new("kind").long("type").value_name("TYPE").value_parser(["created", "updated", "deleted", "attention"]).help("Only this event type"))
        .arg(Arg::new("count").long("count").value_name("N").value_parser(value_parser!(u64).range(1..)).help("Exit after N matching events"))
        .arg(Arg::new("for").long("for").value_name("SECONDS").value_parser(value_parser!(u64).range(1..)).help("Exit after this many seconds"))
        .after_help("Example:\n  trama event watch --entity issue --count 1 --for 300\n\nRequires permission `events:read`.")
}

/// Accumulates SSE bytes into complete frames.
#[derive(Default)]
struct Frames {
    buf: String,
}

impl Frames {
    /// Feeds a chunk and returns the `(event, data)` of every frame it completed.
    fn push(&mut self, chunk: &str) -> Vec<(String, String)> {
        self.buf.push_str(&chunk.replace("\r\n", "\n"));
        let mut out = vec![];
        while let Some(end) = self.buf.find("\n\n") {
            let frame: String = self.buf.drain(..end + 2).collect();
            let mut event = String::from("message");
            let mut data: Vec<&str> = vec![];
            for line in frame.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    event = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push(v.strip_prefix(' ').unwrap_or(v));
                }
            }
            if !data.is_empty() {
                out.push((event, data.join("\n")));
            }
        }
        out
    }
}

fn matches_filter(event: &Value, entity: Option<&str>, kind: Option<&str>) -> bool {
    entity.is_none_or(|e| event.get("entity").and_then(Value::as_str) == Some(e)) && kind.is_none_or(|k| event.get("type").and_then(Value::as_str) == Some(k))
}

pub async fn watch(m: &ArgMatches, ctx: &Ctx) -> Result<()> {
    let creds = config::resolve(&ctx.ov)?;
    let api = Api::new(&creds.url, ctx.timeout)?;
    let slug = auth::workspace_slug(&api, &creds).await?;
    let path = format!("/w/{}/events/stream", crate::catalog::encode_segment(&slug));
    let entity = m.get_one::<String>("entity").map(String::as_str);
    let kind = m.get_one::<String>("kind").map(String::as_str);
    let limit = m.get_one::<u64>("count").copied();
    let deadline = m.get_one::<u64>("for").map(|s| tokio::time::Instant::now() + Duration::from_secs(*s));

    let mut seen = 0u64;
    let mut failures = 0u32;
    loop {
        let mut res = match api.stream(&creds.token, &path).await {
            Ok(r) => {
                failures = 0;
                r
            }
            // Auth, permission and not-found problems will not fix themselves.
            Err(e) if e.kind != Kind::Network || failures >= 5 => return Err(e),
            Err(_) => {
                failures += 1;
                tokio::time::sleep(Duration::from_secs(2u64.pow(failures.min(4)))).await;
                continue;
            }
        };
        let mut frames = Frames::default();
        loop {
            let next = async {
                match deadline {
                    Some(d) => tokio::time::timeout_at(d, res.chunk()).await.map_err(|_| ()),
                    None => Ok(res.chunk().await),
                }
            };
            let chunk = tokio::select! {
                c = next => c,
                _ = tokio::signal::ctrl_c() => return Ok(()),
            };
            match chunk {
                Err(()) => return Ok(()), // --for elapsed
                Ok(Ok(Some(bytes))) => {
                    for (event, data) in frames.push(&String::from_utf8_lossy(&bytes)) {
                        if event == "ping" {
                            continue;
                        }
                        let Ok(value) = serde_json::from_str::<Value>(&data) else { continue };
                        if !matches_filter(&value, entity, kind) {
                            continue;
                        }
                        output::emit(&value.to_string());
                        seen += 1;
                        if limit.is_some_and(|n| seen >= n) {
                            return Ok(());
                        }
                    }
                }
                Ok(Ok(None)) | Ok(Err(_)) => break, // dropped: reconnect
            }
        }
        if deadline.is_some_and(|d| tokio::time::Instant::now() >= d) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn assembles_frames_across_chunks() {
        let mut f = Frames::default();
        assert!(f.push("data: {\"type\":\"upd").is_empty());
        let out = f.push("ated\",\"entity\":\"issue\"}\n\nevent: ping\ndata: {\"at\":\"x\"}\n\n: comment\n\n");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], ("message".to_string(), "{\"type\":\"updated\",\"entity\":\"issue\"}".to_string()));
        assert_eq!(out[1].0, "ping");
        let out = f.push("data: a\r\ndata: b\r\n\r\n");
        assert_eq!(out, vec![("message".to_string(), "a\nb".to_string())]);
    }

    #[test]
    fn filters_by_entity_and_type() {
        let e = json!({ "type": "updated", "entity": "issue", "id": "iss_1" });
        assert!(matches_filter(&e, None, None));
        assert!(matches_filter(&e, Some("issue"), Some("updated")));
        assert!(!matches_filter(&e, Some("workstream"), None));
        assert!(!matches_filter(&e, None, Some("deleted")));
    }
}
