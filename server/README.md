# Trama API (NestJS + PostgreSQL)

Backend for Trama, coordination for human + AI engineering teams. Routes: [API.md](./API.md). Internals and extension points: [ARCHITECTURE.md](./ARCHITECTURE.md).

```bash
npm install
npm run db:up        # docker compose (dev override): postgres:18 as delta-postgres on localhost:5434
npm run start:dev    # creates the `trama` database if needed, runs migrations, seeds an empty DB, serves http://localhost:3000/api
npm test             # unit tests
npm run test:e2e     # e2e tests (database trama_core_test, recreated on every run)
npm run lint
npm run build
```

Demo login (seeded): `demo@trama.dev` / `trama-demo`, workspace `acme`. See `.env.example` for configuration.

## Upgrading from the Nabla name

Trama was called Nabla. Nothing you already run breaks:

- **Database name.** The default `DATABASE_URL` and the e2e database are now `trama` and `trama_core_test`. A local database named `nabla` is not renamed or touched; to keep using it, set `DATABASE_URL=postgres://delta:delta@localhost:5434/nabla` in `.env`. The e2e database is recreated on every run, so it can simply change.
- **Demo login.** A fresh seed uses `demo@trama.dev` / `trama-demo`. A database seeded earlier keeps `demo@nabla.dev` / `nabla-demo`.
- **Environment variables.** `NABLA_ENCRYPTION_KEY`, `NABLA_ALLOW_PRIVATE_WEBHOOKS` and `NABLA_WEBHOOK_RETRY_MS` are still read when their `TRAMA_ENCRYPTION_KEY`, `TRAMA_OUTBOUND_ALLOW_PRIVATE` and `TRAMA_WEBHOOK_RETRY_MS` counterparts are unset, and log a deprecation warning once.
- **API tokens.** New tokens start with `trm_`. Existing `nbl_` tokens keep authenticating.
- **Session cookie.** The cookie is now `trama_session`. A `nabla_session` cookie is still accepted until the session expires, and is cleared on the next login or logout.
- **Webhooks.** Deliveries carry `X-Trama-Event`, `X-Trama-Delivery` and `X-Trama-Signature`, plus the old `X-Nabla-*` headers with identical values.
- **Migration names.** `NablaBaseline1791387672836` keeps its name: TypeORM records applied migrations by name, so renaming it would run the baseline again on existing databases.
- **Dev-only key material.** The fixed development keys (`nabla-dev-only-integration-key`, `nabla-dev-only-secrets-key`) are hashed into AES keys. They are kept verbatim so values encrypted in development still decrypt.
