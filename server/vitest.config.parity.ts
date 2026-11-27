import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { PARITY_SPECS } from './test/parity/manifest.js';

// Dedicated disposable database; never the shared `trama_core_test` of the NestJS e2e suite.
// The Rust API (`npm run parity`) must be started against this same database.
const PARITY_DATABASE_URL =
  process.env.PARITY_DATABASE_URL ??
  'postgres://delta:delta@localhost:5435/trama_parity';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // Only the wire-level suites from the manifest: no provider-injection and no migration
    // specs. `test/parity/global-setup.ts` fails the run if the manifest is out of sync.
    include: PARITY_SPECS.map((file) => `test/${file}`),
    globalSetup: ['./test/parity/global-setup.ts'],
    // One shared Rust API and one shared database: run the files sequentially, like the e2e suite.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    env: {
      PARITY_API_URL: process.env.PARITY_API_URL ?? '',
      PARITY_DATABASE_URL,
      // Direct side-effect queries (`app.get(DataSource)`) hit the same disposable DB.
      DATABASE_URL: PARITY_DATABASE_URL,
      TEST_DATABASE_URL: PARITY_DATABASE_URL,
      NODE_ENV: 'test',
      SEED_DEMO: 'false',
      TRAMA_ENABLE_ADMIN_RESET: 'true',
    },
  },
});
