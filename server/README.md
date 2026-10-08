# Nabla API (NestJS + PostgreSQL)

Backend for Nabla, coordination for human + AI engineering teams. Routes: [API.md](./API.md). Internals and extension points: [ARCHITECTURE.md](./ARCHITECTURE.md).

```bash
npm install
npm run db:up        # docker compose: postgres:18 as delta-postgres on localhost:5434
npm run start:dev    # creates the `nabla` database if needed, runs migrations, seeds an empty DB, serves http://localhost:3000/api
npm test             # unit tests
npm run test:e2e     # e2e tests (database nabla_core_test, recreated on every run)
npm run lint
npm run build
```

Demo login (seeded): `demo@nabla.dev` / `nabla-demo`, workspace `acme`. See `.env.example` for configuration.
