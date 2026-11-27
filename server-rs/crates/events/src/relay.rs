//! Live events between API instances: `NOTIFY` on [`LIVE_CHANNEL`] for every published event,
//! and one `LISTEN`ing connection per instance that feeds the local bus.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sea_orm::sqlx::postgres::PgListener;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use tokio::sync::{broadcast, mpsc, watch};

use crate::service::PublishedEvent;

/// Postgres channel that carries live events between API instances (shared with NestJS).
pub const LIVE_CHANNEL: &str = "trama_live";
/// First delay before the listener reconnects.
pub const RECONNECT_MIN: Duration = Duration::from_secs(1);
/// The delay doubles after each failed attempt, up to this.
pub const RECONNECT_MAX: Duration = Duration::from_secs(30);

/// The sending half: whether the listener is up, and the queue of events to `NOTIFY`.
#[derive(Clone, Debug)]
pub(crate) struct Relay {
    listening: Arc<AtomicBool>,
    queue: mpsc::UnboundedSender<PublishedEvent>,
}

impl Relay {
    pub(crate) fn new(queue: mpsc::UnboundedSender<PublishedEvent>) -> Self {
        Self { listening: Arc::default(), queue }
    }

    pub(crate) fn listening(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.listening)
    }

    pub(crate) fn is_listening(&self) -> bool {
        self.listening.load(Ordering::SeqCst)
    }

    /// Queues `event` for `NOTIFY`; gives it back when the worker is gone.
    pub(crate) fn send(&self, event: PublishedEvent) -> Result<(), Box<PublishedEvent>> {
        self.queue.send(event).map_err(|e| Box::new(e.0))
    }
}

/// Sends the queued events one by one, in order. An event that cannot be relayed is delivered
/// locally instead.
pub(crate) async fn notify_worker(
    db: DatabaseConnection,
    mut queue: mpsc::UnboundedReceiver<PublishedEvent>,
    local: broadcast::Sender<PublishedEvent>,
) {
    while let Some(event) = queue.recv().await {
        let payload = match serde_json::to_string(&event) {
            Ok(payload) => payload,
            Err(err) => {
                tracing::warn!("Could not relay a live event: {err}");
                let _ = local.send(event);
                continue;
            }
        };
        let sent = db
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT pg_notify($1, $2)",
                [LIVE_CHANNEL.into(), payload.into()],
            ))
            .await;
        if let Err(err) = sent {
            tracing::warn!("Could not relay a live event: {err}");
            let _ = local.send(event);
        }
    }
}

/// Keeps one connection `LISTEN`ing on [`LIVE_CHANNEL`] until `stop` turns true (or its sender
/// is dropped), reconnecting with a 1 s..30 s backoff. `listening` is true exactly while the
/// connection is up.
pub(crate) async fn listen(
    url: String,
    local: broadcast::Sender<PublishedEvent>,
    listening: Arc<AtomicBool>,
    mut stop: watch::Receiver<bool>,
) {
    let mut delay = RECONNECT_MIN;
    loop {
        if *stop.borrow() {
            break;
        }
        let reason = tokio::select! {
            reason = session(&url, &local, &listening, &mut delay) => reason,
            _ = stop.wait_for(|stopped| *stopped) => break,
        };
        listening.store(false, Ordering::SeqCst);
        if *stop.borrow() {
            break;
        }
        tracing::warn!("Live event listener lost ({reason}); retrying in {}s", delay.as_secs());
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            _ = stop.wait_for(|stopped| *stopped) => break,
        }
        delay = (delay * 2).min(RECONNECT_MAX);
    }
    listening.store(false, Ordering::SeqCst);
}

/// One connection's life: connect, `LISTEN`, forward notifications. Returns why it ended.
async fn session(
    url: &str,
    local: &broadcast::Sender<PublishedEvent>,
    listening: &AtomicBool,
    delay: &mut Duration,
) -> String {
    let mut listener = match PgListener::connect(url).await {
        Ok(listener) => listener,
        Err(err) => return err.to_string(),
    };
    if let Err(err) = listener.listen(LIVE_CHANNEL).await {
        return err.to_string();
    }
    listening.store(true, Ordering::SeqCst);
    *delay = RECONNECT_MIN;
    loop {
        match listener.try_recv().await {
            Ok(Some(note)) => {
                if note.channel() != LIVE_CHANNEL || note.payload().is_empty() {
                    continue;
                }
                // a payload we did not write: ignore
                if let Ok(event) = serde_json::from_str::<PublishedEvent>(note.payload()) {
                    let _ = local.send(event);
                }
            }
            Ok(None) => return "connection closed".to_owned(),
            Err(err) => return err.to_string(),
        }
    }
}
