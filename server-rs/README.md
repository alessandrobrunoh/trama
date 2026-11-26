# Trama API (Rust)

The Rust replacement for the NestJS API in `server/`, built with Axum and SeaORM as a Cargo
workspace. It serves the same `/api` contract: the web app and the `trama` CLI must not notice
which server answered.

## Layout

| Crate | Path | Holds |
| --- | --- | --- |
| `trama-api` | `src/` | The binary: wires every module router under `/api`, the OpenAPI document, startup and shutdown |
| `trama-auth` | `crates/auth` | The access guard and route gates (`Routes`, `Gate`), sessions, API tokens and their limits, member access scoping, `/api/auth/*` |
| `trama-core` | `crates/core` | Config (every NestJS environment variable), Nest-compatible errors, ids, ISO dates, the `ApiJson` body extractor, HTTP layers, test databases |
| `trama-common` | `crates/common` | Secrets at rest, SSRF-safe outgoing HTTP, mail, rate limits, client address, `X-Client-Id` context, counters, reference checks |
| `trama-contracts` | `crates/contracts` | `contracts/domain.ts` in Rust: wire types, roles and capabilities, member access, settings, status and label catalogs |
| `trama-entities` | `crates/entities` | SeaORM entities, one module per table (generated, see `lib.rs`) |
| `trama-migration` | `crates/migration` | Schema migrations, starting from the NestJS baseline |
| `trama-system` | `crates/system` | `GET /api/health`, `GET /api/config` |
| `trama-uploads` | `crates/uploads` | File uploads: rules, storage, upload references (`retained`, `assert_attachable`, … for other crates), `/api/w/{slug}/uploads…` |

Each domain gets its own crate as it moves over (`users`, `members`, `invites`,
`workspaces`, `tasks`, `comments`, `projects`, `time`, …). A module crate exposes:

- `router() -> trama_auth::Routes`, every handler with its access `Gate`, merged in `routes()`
  in `src/lib.rs`;
- `ApiDoc`, its OpenAPI document, merged in `src/openapi.rs`;
- `schemas.rs` for request and response bodies (camelCase on the wire, dates via
  `trama_core::time::to_iso`), separate from the storage entities.

Module crates depend on `trama-core`, `trama-common`, `trama-contracts`, `trama-entities` and `trama-auth`, and on each other
only when a domain really needs another (`tasks` on `auth`, not the reverse). See `PORTING.md`.

## Running

```sh
cp .env.example .env          # PORT=3100 while NestJS still runs on 3000
cargo run                     # creates the database if missing, migrates, serves
```

Outside production the OpenAPI document is at `/api/openapi.json` and a reference at `/api/docs`.

## Database and the hand-over from NestJS

Both APIs use the same PostgreSQL database while routes move over. The first migration is a
baseline of the schema the NestJS migrations produce (`crates/migration/src/baseline.sql`):

- on a database NestJS has migrated, it records itself as applied and changes nothing;
- on an empty database, it creates the schema and TypeORM's bookkeeping, so NestJS skips its
  own migrations;
- on an older or unknown schema, it refuses to start.

Until NestJS stops running migrations, schema changes are written as TypeORM migrations; after
merging one, regenerate the baseline from a migrated database and bump
`LAST_TYPEORM_MIGRATION`:

```sh
scripts/dump-baseline.sh delta-postgres trama <LastMigrationName>
```

## Checks

```sh
cargo fmt --all --check
cargo clippy --all-targets --all-features   # clippy::all is denied, pedantic warns
cargo test --workspace
```

Database tests read only `TEST_DATABASE_URL` and create a throwaway `trama_rs_test_*` database
each, dropped afterwards; without the variable they are skipped.
