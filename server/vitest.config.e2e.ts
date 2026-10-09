import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://delta:delta@localhost:5434/trama_core_test';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // e2e files share one database: run them sequentially.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      SEED_DEMO: 'false',
      NODE_ENV: 'test',
      // e2e specs may call POST /api/admin/reset
      TRAMA_ENABLE_ADMIN_RESET: 'true',
    },
  },
});
