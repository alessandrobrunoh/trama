import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSeed } from '../src/database/seed/seed-data.js';
import { withDeterministicIds } from '../src/common/util.js';

// Keep fixture timestamps fixed so diffs are reproducible. The Rust loader rebases them
// relative to startup time; password hashes are deliberately generated only at runtime.
const fixtureTime = Date.UTC(2026, 0, 1);
const buildSeed = (mockHistory: boolean) => withDeterministicIds(() =>
  createSeed(fixtureTime, 'RUNTIME_PASSWORD_HASH', { mockHistory }),
);
function rewriteIds(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(rewriteIds);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewriteIds(child)]),
    );
  }
  return value;
}
function stripPasswordHashes(seed: ReturnType<typeof createSeed>) {
  const { users, ...data } = seed;
  return rewriteIds({
    ...data,
    users: users.map(({ passwordHash: _passwordHash, ...user }) => user),
  });
}
const fixture = {
  version: 1,
  fixtureTime: new Date(fixtureTime).toISOString(),
  data: stripPasswordHashes(buildSeed(true)),
  withoutMockHistory: stripPasswordHashes(buildSeed(false)),
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv[2] ?? `${repoRoot}/server-rs/fixtures/demo-seed-v1.json`);
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote canonical demo fixture to ${output}`);
