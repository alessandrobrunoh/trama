/**
 * Classification of every `server/test/*.e2e-spec.ts` file for the Rust parity harness.
 *
 * The parity harness runs the suites marked `parity` unchanged against a separately running
 * Rust API (`server-rs`), over HTTP. Files that cannot run black-box are listed here with the
 * reason, so uncovered behavior is visible instead of silently dropped. Do not move a file
 * into `parity` to make a failing run green: a spec only belongs there if it talks to the API
 * exclusively through `createTestApp()`'s HTTP server (supertest, `Client`, `TokenClient`,
 * optionally `app.get(DataSource)` for direct side-effect queries). See parity/README.md.
 *
 * `manifest.spec.ts` fails the unit suite when a spec file is missing here.
 */

export type ParityClassification =
  'parity' | 'provider-injection' | 'migration' | 'in-process-only';

export interface SpecClassification {
  /** File name inside `server/test`. */
  file: string;
  classification: ParityClassification;
  /** Why the file does or does not run against the Rust API. */
  note: string;
}

export const MANIFEST: SpecClassification[] = [
  // --- Runs against the Rust API unchanged (wire-level only) ---
  {
    file: 'access.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: cookie and token clients only.',
  },
  {
    file: 'artifacts-visibility.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: cookie clients only.',
  },
  {
    file: 'auth.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level; uses app.get(DataSource) to expire tokens/sessions directly in the parity DB.',
  },
  {
    file: 'events-visibility.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: reads event history and snapshots over HTTP.',
  },
  {
    file: 'favorites.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: cookie clients only.',
  },
  {
    file: 'guests.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: guest cookie clients only.',
  },
  {
    file: 'invites.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level; uses app.get(DataSource) to expire an invite directly in the parity DB.',
  },
  {
    file: 'issue-filters.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: query-string filter cases.',
  },
  {
    file: 'issues-subissues.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: issue tree cases.',
  },
  {
    file: 'milestones.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: milestone CRUD cases.',
  },
  {
    file: 'notifications.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: inbox and settings over HTTP; no in-process mailer inspection.',
  },
  {
    file: 'project-views-icon.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: project view icon cases.',
  },
  {
    file: 'project-updates.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: project update cases (cookie and token clients; events over /events).',
  },
  {
    file: 'projects.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: project CRUD cases.',
  },
  {
    file: 'projects-repositories.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: project/repository linking cases.',
  },
  {
    file: 'rbac.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: role and capability cases.',
  },
  {
    file: 'sharing.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: shared view cases (token clients).',
  },
  {
    file: 'task-artifacts.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: task artifact cases.',
  },
  {
    file: 'task-due-date.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: due-date cases.',
  },
  {
    file: 'task-thread-url.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: thread-url validation cases.',
  },
  {
    file: 'threads.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: thread sync, decisions, suggestions and estimate cases (cookie clients only).',
  },
  {
    file: 'token-permissions.e2e-spec.ts',
    classification: 'parity',
    note: 'Wire-level: API token scope cases.',
  },

  // --- Provider injection: mocks swapped into the in-process NestJS app ---
  {
    file: 'connection-ownership.e2e-spec.ts',
    classification: 'provider-injection',
    note: 'Builds its own NestJS module with overrideProvider(HttpClient) (mock GitHub) and reads ConnectionsService in-process.',
  },
  {
    file: 'external-identities.e2e-spec.ts',
    classification: 'provider-injection',
    note: 'overrideProvider(HttpClient) with a mock identity provider; reads ExternalIdentitiesService in-process.',
  },
  {
    file: 'outgoing-webhooks.e2e-spec.ts',
    classification: 'provider-injection',
    note: 'overrideProvider(HttpClient) to observe webhook deliveries.',
  },
  {
    file: 'routing-rules.e2e-spec.ts',
    classification: 'provider-injection',
    note: 'overrideProvider(HttpClient) with a mock GitHub.',
  },
  {
    file: 'push.e2e-spec.ts',
    classification: 'provider-injection',
    note: "Spies on the in-process web-push library (vi.spyOn(webpush, 'sendNotification')) and injects VAPID keys before app compile; a separate Rust process cannot be intercepted this way.",
  },

  // --- Migration: TypeORM data migrations, NestJS-owned until the hand-over ---
  {
    file: 'connection-ownership-migration.e2e-spec.ts',
    classification: 'migration',
    note: 'Runs TypeORM migrations directly; schema changes stay in the NestJS migration chain (see server-rs/README.md).',
  },
  {
    file: 'issue-first-migration.e2e-spec.ts',
    classification: 'migration',
    note: 'Runs TypeORM migrations directly; NestJS-owned until the hand-over.',
  },
  {
    file: 'milestones-migration.e2e-spec.ts',
    classification: 'migration',
    note: 'Runs TypeORM migrations directly; NestJS-owned until the hand-over.',
  },
  {
    file: 'remove-project-updates-documents-migration.e2e-spec.ts',
    classification: 'migration',
    note: 'Runs TypeORM migrations directly; NestJS-owned until the hand-over.',
  },
  {
    file: 'routing-rules-migration.e2e-spec.ts',
    classification: 'migration',
    note: 'Runs TypeORM migrations directly; NestJS-owned until the hand-over.',
  },

  // --- Wire-level behavior, but written against the in-process app surface ---
  {
    file: 'live-relay.e2e-spec.ts',
    classification: 'in-process-only',
    note: 'Starts two NestJS instances and asserts on in-process EventsService stream$ subscribers; the Postgres LISTEN relay itself is byte-compatible by design (see PORTING.md).',
  },
  {
    file: 'events-stream-visibility.e2e-spec.ts',
    classification: 'in-process-only',
    note: 'Binds an ephemeral port via app.listen(0) and reads server.address(); needs a harness that can point SSE fetches at the remote API to run against Rust.',
  },
];

/** Spec files that run unchanged against the Rust API. */
export const PARITY_SPECS: string[] = MANIFEST.filter(
  (m) => m.classification === 'parity',
).map((m) => m.file);
