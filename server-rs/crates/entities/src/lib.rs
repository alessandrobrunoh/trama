//! SeaORM entities for every table of the Trama database, one module per table.
//!
//! Generated with `sea-orm-cli generate entity --ignore-tables migrations --with-serde none`
//! from a database built by `trama-migration`'s baseline. Hand edits:
//!
//! * `issues::Relation::SelfRef`: the generator mangles the composite
//!   `("workspaceId", "parentId") → ("workspaceId", "id")` foreign key.
//!
//! Entities are storage rows. API responses are separate types in each module crate, so the
//! wire format (camelCase, ISO dates) never depends on column names.

#![allow(missing_docs, clippy::pedantic)]

pub mod prelude;

pub mod agents;
pub mod api_token_usage;
pub mod api_tokens;
pub mod artifact_sources;
pub mod artifacts;
pub mod attention_state;
pub mod comments;
pub mod dependencies;
pub mod domain_events;
pub mod external_identities;
pub mod favorites;
pub mod import_jobs;
pub mod import_links;
pub mod integration_connections;
pub mod invites;
pub mod issues;
pub mod legacy_workstream_history;
pub mod memberships;
pub mod milestones;
pub mod notifications;
pub mod outgoing_webhook_deliveries;
pub mod outgoing_webhooks;
pub mod project_placements;
pub mod project_updates;
pub mod projects;
pub mod push_subscriptions;
pub mod routing_rule_items;
pub mod routing_rules;
pub mod saved_views;
pub mod sessions;
pub mod task_decisions;
pub mod task_thread_records;
pub mod time_entries;
pub mod tracker_credentials;
pub mod upload_references;
pub mod uploads;
pub mod users;
pub mod webhook_deliveries;
pub mod workspace_counters;
pub mod workspaces;
