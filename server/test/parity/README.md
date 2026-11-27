# Black-box parity harness (NestJS ↔ Rust)

Runs the wire-level e2e suites of `server/test` against the Rust API in `server-rs`, over real
HTTP, with the **same assertions** as the NestJS runs. It exists to surface migration gaps:
failures here are signal to fix the Rust port, never to weaken a spec.

The existing NestJS e2e suite is untouched: `npm run test:e2e` still starts in-process NestJS
apps, recreates `trama_core_test` and runs everything, including the suites below that cannot be
run black-box. Nothing here changes containers, cuts over Docker, or removes NestJS.

## Usage

One command from `server/` (Postgres from `docker-compose.yml` must be up, as for the e2e suite;
`cargo` on `PATH`):

```sh
npm run parity
```

This:

1. creates a **dedicated disposable database** (`trama_parity` by default). Managed mode
   accepts `trama_parity` or a `trama_parity_<suffix>` name and refuses to overwrite an
   existing database,
2. starts the Rust API with `cargo run` on port 4310 (`NODE_ENV=test`, `SEED_DEMO=false`,
   `TRAMA_ENABLE_ADMIN_RESET=true`; the server applies its own migrations),
3. runs vitest with `vitest.config.parity.ts`, where `createTestApp()` returns a
   [`RemoteApp`](./remote-app.ts) whose `getHttpServer()` is the Rust API's base URL — supertest
   accepts a URL, so `request(server)`, `Client` and `TokenClient` all hit the Rust API unchanged,
4. stops the Rust API and drops only the database it created, exiting with vitest's code.

To run against an API you started yourself (e.g. one under a debugger), skip the orchestration:

```sh
# terminal 1 — start the Rust API on the parity DB
cd ../server-rs
DATABASE_URL=postgres://delta:delta@localhost:5435/trama_parity \
  NODE_ENV=test SEED_DEMO=false TRAMA_ENABLE_ADMIN_RESET=true PORT=4310 cargo run

# terminal 2
cd ../server
PARITY_API_URL=http://127.0.0.1:4310 npm run test:parity
```

`npm run test:parity` health-checks `PARITY_API_URL` and verifies the manifest (below) before any
spec runs. You manage the database yourself in that mode.

Environment knobs (all optional): `PARITY_PORT` (4310), `PARITY_DATABASE_URL`
(`postgres://delta:delta@localhost:5435/trama_parity`), `PARITY_BOOT_TIMEOUT_MS` (300000),
`PARITY_HEALTH_TIMEOUT_MS` (20000).

## What runs against Rust, and what does not

Every `*.e2e-spec.ts` file is classified in [`manifest.ts`](./manifest.ts), which the parity
config includes and `manifest.spec.ts` (part of `npm test`) keeps in sync with the directory:
a new spec cannot land unclassified.

| Classification | Meaning | Files |
| --- | --- | --- |
| `parity` | Wire-level only: supertest/`Client`/`TokenClient` (plus `app.get(DataSource)` side-effect queries, which hit `trama_parity`). Runs unchanged against the Rust API. | 21 suites (see manifest) |
| `provider-injection` | Swaps providers into an in-process NestJS app (`overrideProvider(HttpClient)` mocks, `vi.spyOn(webpush, …)`). The mock lives in the Node process, so it cannot intercept a separate Rust process. Still covered by `npm run test:e2e`. | `connection-ownership`, `external-identities`, `outgoing-webhooks`, `routing-rules`, `push` |
| `migration` | TypeORM data migrations, executed directly on a throwaway database. Schema changes stay in the NestJS migration chain until the hand-over (see `server-rs/README.md`). | the five `*-migration` specs |
| `in-process-only` | Wire-level behavior, but written against the in-process app surface: `live-relay` asserts on `EventsService.stream$` of two NestJS instances (the Postgres relay it exercises is byte-compatible by design, see `PORTING.md`); `events-stream-visibility` binds its own ephemeral port with `app.listen(0)` and needs a remote-aware harness to run against Rust. | `live-relay`, `events-stream-visibility` |

### Uncovered behavior

As a result, behavior only exercised by the non-`parity` suites is **not** verified against the
Rust API today:

- outbound HTTP of integrations and webhooks (mocked via `HttpClient` overrides), external OAuth
  flows, GitHub-driven routing rules, and Web Push delivery (`push` spies on the Node library) —
  for those, parity is only enforced once equivalent Rust-side coverage exists or the suites are
  ported to a wire-observable form (e.g. a local mock HTTP server);
- the SSE stream surface (`/events/stream` framing, re-check and close-on-access-change) —
  `events-stream-visibility` needs a harness that can point its SSE `fetch` at the remote API;
  porting it is the natural next step;
- cross-instance event relay via Postgres `LISTEN`/`NOTIFY` (`live-relay`);
- TypeORM data migrations (by design, until the hand-over).

This list is documentation, not permission: do not reclassify a failing spec to make a run green.
A spec moves out of `parity` only if it genuinely cannot run black-box — and then the gap it
covered is named here. When a `parity` spec fails, fix the Rust API.

## How it works

- [`remote-app.ts`](./remote-app.ts) — `RemoteApp`, the `INestApplication` stand-in returned by
  `createTestApp()` when `PARITY_API_URL` is set. Unsupported members (`listen`, `get(Service)`,
  provider overrides) throw with a pointer to this README, so a misclassified spec fails loudly
  instead of passing vacuously. Without `PARITY_API_URL`, `createTestApp()` takes the original
  NestJS path byte-for-byte.
- [`manifest.ts`](./manifest.ts) — the classification, the parity include list's source of truth.
- [`global-setup.ts`](./global-setup.ts) — requires `PARITY_API_URL`, checks `/api/health`, and
  fails on unclassified or stale manifest entries.
- [`vitest.config.parity.ts`](../../vitest.config.parity.ts) — includes only the `parity` specs,
  sequentially (one shared API and database, like the NestJS suite), and points `DATABASE_URL` /
  `TEST_DATABASE_URL` at `trama_parity` for the direct side-effect queries.
- [`scripts/parity-run.mjs`](../../scripts/parity-run.mjs) — the `npm run parity` orchestrator.

## Checks

From `server/`: `npm run parity` (full harness), `npm run test:parity` (against a running API),
`npm test` (manifest guard), and the usual `npm run test:e2e` for the NestJS suites. From
`server-rs/`: `cargo fmt --all --check`, `cargo clippy --all-targets --all-features`,
`cargo test --workspace`.
