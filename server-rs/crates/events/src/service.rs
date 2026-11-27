//! `EventsService` of `server/src/events/events.service.ts`: [`Events::record`] appends a
//! `DomainEvent` and broadcasts a `LiveEvent`, [`Events::publish`] broadcasts a `LiveEvent` alone.

use std::sync::{Arc, LazyLock, Mutex};

use chrono::{DateTime, DurationRound, TimeDelta, Utc};
use sea_orm::{ActiveModelTrait, ConnectionTrait, DatabaseConnection, DbErr, Set};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;
use trama_contracts::activity::{LiveEvent, LiveEventEntity, LiveEventType};
use trama_contracts::common::{ActorRef, LegacySubjectRef, SubjectRef, SubjectType};
use trama_core::AppState;
use trama_core::ids::uid;
use trama_core::time::now_iso;
use trama_entities::domain_events;

use crate::relay::{self, Relay};

/// How many live events a slow subscriber may fall behind before it sees
/// [`broadcast::error::RecvError::Lagged`].
pub const LIVE_CAPACITY: usize = 1024;
/// How many recorded domain events a slow subscriber may fall behind.
pub const RECORDED_CAPACITY: usize = 1024;

/// A live event as it travels between API instances (`PublishedEvent`): the JSON NestJS sends on
/// the `trama_live` channel, field for field, so a NestJS and a Rust instance can share it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedEvent {
    /// Workspace whose streams receive it.
    pub workspace_id: String,
    /// When set, only this person's streams receive the event (private things, like
    /// notifications).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// Owner of the change; comment events differ from their comment entity id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<LegacySubjectRef>,
    /// What the browsers receive.
    pub event: LiveEvent,
}

/// What changed, without the `clientId` and `at` that [`Events::publish`] adds
/// (`Pick<LiveEvent, 'type' | 'entity' | 'id'>`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveChange {
    /// `created`, `updated`, `deleted` or `attention`.
    pub kind: LiveEventType,
    /// What it is about.
    pub entity: LiveEventEntity,
    /// Record id.
    pub id: String,
}

impl LiveChange {
    /// A change of any type.
    #[must_use]
    pub fn new(kind: LiveEventType, entity: LiveEventEntity, id: impl Into<String>) -> Self {
        Self { kind, entity, id: id.into() }
    }

    /// `{ type: 'created', entity, id }`.
    #[must_use]
    pub fn created(entity: LiveEventEntity, id: impl Into<String>) -> Self {
        Self::new(LiveEventType::Created, entity, id)
    }

    /// `{ type: 'updated', entity, id }`.
    #[must_use]
    pub fn updated(entity: LiveEventEntity, id: impl Into<String>) -> Self {
        Self::new(LiveEventType::Updated, entity, id)
    }

    /// `{ type: 'deleted', entity, id }`.
    #[must_use]
    pub fn deleted(entity: LiveEventEntity, id: impl Into<String>) -> Self {
        Self::new(LiveEventType::Deleted, entity, id)
    }

    /// The default live event of a recorded domain event: `<x>.created` → `created`,
    /// `<x>.deleted` → `deleted`, anything else → `updated`, about the subject.
    #[must_use]
    pub fn for_event(event_type: &str, subject: &SubjectRef) -> Self {
        let kind = if event_type.ends_with(".created") {
            LiveEventType::Created
        } else if event_type.ends_with(".deleted") {
            LiveEventType::Deleted
        } else {
            LiveEventType::Updated
        };
        Self::new(kind, subject_entity(subject.kind), subject.id.clone())
    }
}

/// The live entity named like a subject type.
#[must_use]
pub const fn subject_entity(kind: SubjectType) -> LiveEventEntity {
    match kind {
        SubjectType::Issue => LiveEventEntity::Issue,
        SubjectType::Artifact => LiveEventEntity::Artifact,
        SubjectType::Project => LiveEventEntity::Project,
        SubjectType::Milestone => LiveEventEntity::Milestone,
        SubjectType::Import => LiveEventEntity::Import,
    }
}

/// Which live event [`Events::record`] broadcasts.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Live {
    /// [`LiveChange::for_event`] (the NestJS default argument).
    #[default]
    Default,
    /// Only persist (`live: false`).
    Off,
    /// A custom live event (still scoped by the recorded subject).
    Custom(LiveChange),
}

/// `RecordEventInput`: one domain event to append.
#[derive(Clone, Debug, PartialEq)]
pub struct RecordEvent {
    /// Workspace id.
    pub workspace_id: String,
    /// Who did it.
    pub actor: ActorRef,
    /// Event type (see `contracts/domain.ts`), e.g. `issue.status_changed`.
    pub kind: String,
    /// What it is about.
    pub subject: SubjectRef,
    /// Payload; `None` stores `{}`.
    pub data: Option<Map<String, Value>>,
    /// Backdating (seed only). A backdated event is not sent to [`Events::subscribe_recorded`].
    pub at: Option<DateTime<Utc>>,
    /// The live event to broadcast.
    pub live: Live,
}

impl RecordEvent {
    /// An event with no data, recorded now, with the default live event.
    #[must_use]
    pub fn new(
        workspace_id: impl Into<String>,
        actor: ActorRef,
        kind: impl Into<String>,
        subject: SubjectRef,
    ) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            actor,
            kind: kind.into(),
            subject,
            data: None,
            at: None,
            live: Live::Default,
        }
    }

    /// Sets the payload. A value that is not a JSON object stores `{}`.
    #[must_use]
    pub fn data(mut self, data: Value) -> Self {
        self.data = Some(match data {
            Value::Object(map) => map,
            _ => Map::new(),
        });
        self
    }

    /// Backdates the event (seed only).
    #[must_use]
    pub fn at(mut self, at: DateTime<Utc>) -> Self {
        self.at = Some(at);
        self
    }

    /// Broadcasts `change` instead of the default live event.
    #[must_use]
    pub fn live(mut self, change: LiveChange) -> Self {
        self.live = Live::Custom(change);
        self
    }

    /// Only persists (`live: false`).
    #[must_use]
    pub fn without_live(mut self) -> Self {
        self.live = Live::Off;
        self
    }
}

/// The process-wide events service. Cheap to clone; every clone shares the same buses.
///
/// Built once at startup with [`Events::start`] (Postgres relay) and registered on the
/// [`AppState`]; code that has the state calls [`Events::of`]. Tests may use [`Events::local`].
#[derive(Clone, Debug)]
pub struct Events {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    live: broadcast::Sender<PublishedEvent>,
    recorded: broadcast::Sender<domain_events::Model>,
    relay: Option<Relay>,
    listener: Mutex<Option<JoinHandle<()>>>,
    stop: watch::Sender<bool>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

/// Shared by every [`Events::of`] on a state without a registered instance.
static PROCESS_LOCAL: LazyLock<Events> = LazyLock::new(Events::local);

impl Events {
    /// An instance that delivers live events to this process only, as NestJS does while its
    /// listener is down.
    #[must_use]
    pub fn local() -> Self {
        Self::build(None)
    }

    /// An instance that relays live events through Postgres (`NOTIFY` / `LISTEN` on
    /// [`relay::LIVE_CHANNEL`]), so every API instance, not just the one that handled the
    /// request, pushes them to its connected browsers. The listener uses its own connection to
    /// `database_url` and reconnects with a backoff of 1 s doubling to 30 s; until it listens,
    /// events are delivered locally only. `db` sends the `NOTIFY`s.
    ///
    /// Must be called inside a Tokio runtime. Stop it with [`Events::shutdown`].
    #[must_use]
    pub fn start(db: DatabaseConnection, database_url: impl Into<String>) -> Self {
        let (notify_tx, notify_rx) = mpsc::unbounded_channel();
        let relay = Relay::new(notify_tx);
        let events = Self::build(Some(relay.clone()));
        let live = events.inner.live.clone();
        tokio::spawn(relay::notify_worker(db, notify_rx, live.clone()));
        let listener = tokio::spawn(relay::listen(
            database_url.into(),
            live,
            relay.listening(),
            events.inner.stop.subscribe(),
        ));
        if let Ok(mut slot) = events.inner.listener.lock() {
            *slot = Some(listener);
        }
        events
    }

    fn build(relay: Option<Relay>) -> Self {
        let (live, _) = broadcast::channel(LIVE_CAPACITY);
        let (recorded, _) = broadcast::channel(RECORDED_CAPACITY);
        let (stop, _) = watch::channel(false);
        Self { inner: Arc::new(Inner { live, recorded, relay, listener: Mutex::new(None), stop }) }
    }

    /// The instance registered on `state` at startup, else one shared process-local instance
    /// (so tests that build a bare state still see their own events).
    #[must_use]
    pub fn of(state: &AppState) -> Self {
        state.extension::<Self>().cloned().unwrap_or_else(|| PROCESS_LOCAL.clone())
    }

    /// Whether the Postgres listener is connected (always `false` for [`Events::local`]).
    #[must_use]
    pub fn is_listening(&self) -> bool {
        self.inner.relay.as_ref().is_some_and(Relay::is_listening)
    }

    /// Stops the listener and waits for it (`onModuleDestroy`). Later events are delivered
    /// locally only.
    pub async fn shutdown(&self) {
        let _ = self.inner.stop.send(true);
        let handle = self.inner.listener.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            let _ = handle.await;
        }
    }

    /// Every live event of every workspace (`stream$`); filter by `workspace_id`.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<PublishedEvent> {
        self.inner.live.subscribe()
    }

    /// Every domain event right after it was written (`recorded$`), except backdated seed
    /// events. Sent before the caller's transaction commits, as NestJS does. Used by outgoing
    /// webhooks, notifications and two-way sync.
    #[must_use]
    pub fn subscribe_recorded(&self) -> broadcast::Receiver<domain_events::Model> {
        self.inner.recorded.subscribe()
    }

    /// Appends a domain event through `conn` (pass the transaction to write atomically with the
    /// mutation) and broadcasts its live event, scoped by the subject.
    ///
    /// # Errors
    ///
    /// The insert's database error; nothing is broadcast then.
    pub async fn record<C: ConnectionTrait>(
        &self,
        conn: &C,
        input: RecordEvent,
    ) -> Result<domain_events::Model, DbErr> {
        let live = match input.live {
            Live::Default => Some(LiveChange::for_event(&input.kind, &input.subject)),
            Live::Off => None,
            Live::Custom(change) => Some(change),
        };
        let backdated = input.at.is_some();
        let at = to_millis(input.at.unwrap_or_else(Utc::now));
        let row = domain_events::ActiveModel {
            id: Set(uid("ev")),
            workspace_id: Set(input.workspace_id.clone()),
            at: Set(at.fixed_offset()),
            actor: Set(serde_json::to_value(&input.actor).unwrap_or(Value::Null)),
            r#type: Set(input.kind),
            subject: Set(serde_json::to_value(&input.subject).unwrap_or(Value::Null)),
            data: Set(Value::Object(input.data.unwrap_or_default())),
            legacy_workstream_key: Set(None),
        }
        .insert(conn)
        .await?;
        if !backdated {
            let _ = self.inner.recorded.send(row.clone());
        }
        if let Some(change) = live {
            self.publish_with(&input.workspace_id, change, None, Some(input.subject.into()));
        }
        Ok(row)
    }

    /// Broadcasts a live event to the workspace's streams. The request's `X-Client-Id`
    /// ([`trama_common::client_id`]) and the time are added.
    pub fn publish(&self, workspace_id: &str, change: LiveChange) {
        self.publish_with(workspace_id, change, None, None);
    }

    /// [`Events::publish`] for one person's streams only (notifications, favorites).
    pub fn publish_to_user(&self, workspace_id: &str, change: LiveChange, user_id: &str) {
        self.publish_with(workspace_id, change, Some(user_id.to_owned()), None);
    }

    /// [`Events::publish`] with every option: `user_id` limits it to one person's streams,
    /// `subject` names the record whose project scopes it (a comment's issue, for example).
    pub fn publish_with(
        &self,
        workspace_id: &str,
        change: LiveChange,
        user_id: Option<String>,
        subject: Option<LegacySubjectRef>,
    ) {
        let published = PublishedEvent {
            workspace_id: workspace_id.to_owned(),
            user_id,
            subject,
            event: LiveEvent {
                kind: change.kind,
                entity: change.entity,
                id: change.id,
                client_id: trama_common::client_id(),
                at: now_iso(),
            },
        };
        match &self.inner.relay {
            // The NOTIFY comes back through our own listener, so this instance's streams get it
            // exactly once.
            Some(relay) if relay.is_listening() => {
                if let Err(unsent) = relay.send(published) {
                    let _ = self.inner.live.send(*unsent);
                }
            }
            _ => {
                let _ = self.inner.live.send(published);
            }
        }
    }
}

/// `new Date()` precision: whole milliseconds.
fn to_millis(at: DateTime<Utc>) -> DateTime<Utc> {
    at.duration_trunc(TimeDelta::milliseconds(1)).unwrap_or(at)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use trama_contracts::common::SubjectType;

    use super::*;

    fn subject(kind: SubjectType, id: &str) -> SubjectRef {
        SubjectRef { kind, id: id.to_owned() }
    }

    #[test]
    fn maps_event_types_to_live_types() {
        let issue = subject(SubjectType::Issue, "in_1");
        assert_eq!(
            LiveChange::for_event("issue.created", &issue),
            LiveChange::created(LiveEventEntity::Issue, "in_1")
        );
        assert_eq!(LiveChange::for_event("issue.deleted", &issue).kind, LiveEventType::Deleted);
        assert_eq!(
            LiveChange::for_event("issue.status_changed", &issue).kind,
            LiveEventType::Updated
        );
        let ms = LiveChange::for_event("milestone.created", &subject(SubjectType::Milestone, "m"));
        assert_eq!(ms.entity, LiveEventEntity::Milestone);
    }

    #[test]
    fn published_events_have_the_nest_payload() {
        let published = PublishedEvent {
            workspace_id: "ws_1".into(),
            user_id: None,
            subject: Some(subject(SubjectType::Issue, "in_1").into()),
            event: LiveEvent {
                kind: LiveEventType::Created,
                entity: LiveEventEntity::Comment,
                id: "cm_1".into(),
                client_id: Some("tab".into()),
                at: "2026-01-01T00:00:00.000Z".into(),
            },
        };
        assert_eq!(
            serde_json::to_string(&published).unwrap(),
            r#"{"workspaceId":"ws_1","subject":{"type":"issue","id":"in_1"},"event":{"type":"created","entity":"comment","id":"cm_1","clientId":"tab","at":"2026-01-01T00:00:00.000Z"}}"#
        );
        // what a NestJS instance sends for a notification
        let nest: PublishedEvent = serde_json::from_value(json!({
            "workspaceId": "ws_1", "userId": "usr_1",
            "event": { "type": "created", "entity": "notification", "id": "nt_1", "at": "x" },
        }))
        .unwrap();
        assert_eq!(nest.user_id.as_deref(), Some("usr_1"));
        assert_eq!(nest.subject, None);
        assert_eq!(nest.event.client_id, None);
    }

    #[test]
    fn data_must_be_an_object() {
        let input = RecordEvent::new(
            "ws",
            ActorRef::system(),
            "issue.created",
            subject(SubjectType::Issue, "i"),
        );
        assert_eq!(input.clone().data(json!([1])).data, Some(Map::new()));
        assert_eq!(input.clone().data(json!({ "a": 1 })).data.unwrap()["a"], 1);
        assert_eq!(input.clone().without_live().live, Live::Off);
        assert_eq!(input.live, Live::Default);
    }

    #[test]
    fn truncates_to_milliseconds() {
        let at = DateTime::parse_from_rfc3339("2026-01-01T10:00:00.123456Z").unwrap().to_utc();
        assert_eq!(trama_core::time::to_iso(&to_millis(at)), "2026-01-01T10:00:00.123Z");
        assert_eq!(to_millis(at).timestamp_subsec_micros(), 123_000);
    }

    #[tokio::test]
    async fn publishes_locally_with_the_client_id() {
        let events = Events::local();
        let mut rx = events.subscribe();
        trama_common::request_context::scope(Some("tab-1".into()), async {
            events.publish_to_user(
                "ws_1",
                LiveChange::updated(LiveEventEntity::Notification, "read"),
                "usr_1",
            );
        })
        .await;
        let got = rx.recv().await.unwrap();
        assert_eq!(got.workspace_id, "ws_1");
        assert_eq!(got.user_id.as_deref(), Some("usr_1"));
        assert_eq!(got.event.client_id.as_deref(), Some("tab-1"));
        assert_eq!(got.event.at.len(), 24);
        assert!(!events.is_listening());
    }
}
