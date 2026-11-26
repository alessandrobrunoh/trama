//! The live-event stream of `GET /api/w/:slug/events/stream`, written the way NestJS's
//! `@Sse()` (`SseStream`) writes it: a blank line once the headers are out, then one message per
//! event with an `id:` counting from 1, `event: ping` every 25 s, and `event: error` before
//! closing when an event cannot be checked.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use chrono::Utc;
use sea_orm::DatabaseConnection;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc};
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use trama_auth::{AuthInfo, WorkspaceContext};
use trama_core::time::now_iso;

use crate::service::PublishedEvent;
use crate::{stream_auth, visibility};

/// Interval of the `event: ping` messages.
pub const PING_EVERY: Duration = Duration::from_secs(25);
/// `MESSAGES.UNKNOWN_EXCEPTION_MESSAGE`, sent as the data of `event: error`.
const UNKNOWN_EXCEPTION: &str = "Internal server error";
/// Messages buffered for a client that is not reading.
const BUFFER: usize = 64;

/// Formats messages, numbering them like `SseStream.writeMessage`.
#[derive(Debug, Default)]
pub(crate) struct Framer {
    last_id: u64,
}

impl Framer {
    /// `event: <kind>` (when given), `id: <n>`, one `data:` line per line of `data`, a blank line.
    pub(crate) fn message(&mut self, kind: Option<&str>, data: &str) -> Bytes {
        self.last_id += 1;
        let mut out = String::with_capacity(data.len() + 32);
        if let Some(kind) = kind {
            out.push_str("event: ");
            out.push_str(&kind.replace(['\r', '\n'], ""));
            out.push('\n');
        }
        out.push_str("id: ");
        out.push_str(&self.last_id.to_string());
        out.push('\n');
        for line in split_lines(data) {
            out.push_str("data: ");
            out.push_str(line);
            out.push('\n');
        }
        out.push('\n');
        Bytes::from(out)
    }
}

/// `value.split(/\r\n|\r|\n/)`.
fn split_lines(value: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut rest = value;
    while let Some(at) = rest.find(['\r', '\n']) {
        lines.push(&rest[..at]);
        let skip = if rest[at..].starts_with("\r\n") { 2 } else { 1 };
        rest = &rest[at + skip..];
    }
    lines.push(rest);
    lines
}

/// What one stream needs.
pub(crate) struct StreamParams {
    pub db: DatabaseConnection,
    pub ctx: Arc<WorkspaceContext>,
    pub auth: Arc<AuthInfo>,
    pub ping_every: Duration,
    pub recheck_every: Duration,
}

/// Starts the stream over `live` (subscribed before the response goes out, so nothing published
/// after the request was accepted is missed) and returns its body.
pub(crate) fn open(params: StreamParams, live: broadcast::Receiver<PublishedEvent>) -> Body {
    let (tx, rx) = mpsc::channel::<Bytes>(BUFFER);
    tokio::spawn(run(params, live, tx));
    Body::from_stream(ReceiverStream::new(rx).map(Ok::<_, Infallible>))
}

/// Events of this workspace, and of this person when addressed to someone.
fn addressed(published: &PublishedEvent, ctx: &WorkspaceContext) -> bool {
    published.workspace_id == ctx.workspace.id
        && published.user_id.as_ref().is_none_or(|u| ctx.user_id.as_ref() == Some(u))
}

async fn run(
    params: StreamParams,
    mut live: broadcast::Receiver<PublishedEvent>,
    tx: mpsc::Sender<Bytes>,
) {
    let StreamParams { db, ctx, auth, ping_every, recheck_every } = params;
    if tx.send(Bytes::from_static(b"\n")).await.is_err() {
        return;
    }
    let (db_ref, auth_ref, ctx_ref) = (&db, &*auth, &*ctx);
    let invalid = stream_auth::invalidated(
        move || stream_auth::is_still_valid(db_ref, auth_ref, ctx_ref, Utc::now()),
        recheck_every,
    );
    tokio::pin!(invalid);
    let mut ping = interval_at(Instant::now() + ping_every, ping_every);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut framer = Framer::default();
    loop {
        let chunk = tokio::select! {
            () = tx.closed() => return,
            () = &mut invalid => return,
            _ = ping.tick() => {
                let data = serde_json::json!({ "at": now_iso() }).to_string();
                framer.message(Some("ping"), &data)
            }
            received = live.recv() => match received {
                Ok(published) => {
                    if !addressed(&published, &ctx) {
                        continue;
                    }
                    // Events addressed to this person carry nothing of anyone else's work.
                    let visible = if published.user_id.is_some() {
                        Ok(true)
                    } else {
                        visibility::is_live_visible(
                            &db,
                            &ctx.workspace.id,
                            &published.event,
                            ctx.access.as_ref(),
                            published.subject.as_ref(),
                        )
                        .await
                    };
                    match visible {
                        Ok(true) => match serde_json::to_string(&published.event) {
                            Ok(data) => framer.message(None, &data),
                            Err(_) => continue,
                        },
                        Ok(false) => continue,
                        Err(err) => {
                            tracing::error!("live event visibility check failed: {err}");
                            let _ = tx.send(framer.message(Some("error"), UNKNOWN_EXCEPTION)).await;
                            return;
                        }
                    }
                }
                // Fell behind: end the stream like NestJS drops a client that does not read; the
                // browser reconnects and refetches.
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!("live event stream fell {missed} event(s) behind; closing it");
                    return;
                }
                Err(RecvError::Closed) => return,
            },
        };
        tokio::select! {
            sent = tx.send(chunk) => if sent.is_err() { return },
            () = &mut invalid => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_messages_like_sse_stream() {
        let mut framer = Framer::default();
        assert_eq!(
            &framer.message(None, r#"{"id":"in_1"}"#)[..],
            b"id: 1\ndata: {\"id\":\"in_1\"}\n\n"
        );
        assert_eq!(
            &framer.message(Some("ping"), r#"{"at":"x"}"#)[..],
            b"event: ping\nid: 2\ndata: {\"at\":\"x\"}\n\n"
        );
        assert_eq!(
            &framer.message(Some("error"), "a\r\nb\rc\nd")[..],
            b"event: error\nid: 3\ndata: a\ndata: b\ndata: c\ndata: d\n\n"
        );
    }

    #[test]
    fn splits_lines_like_the_regex() {
        assert_eq!(split_lines(""), vec![""]);
        assert_eq!(split_lines("a\n"), vec!["a", ""]);
        assert_eq!(split_lines("a\r\n\nb"), vec!["a", "", "b"]);
    }
}
