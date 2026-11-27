import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MANIFEST } from './manifest.js';

const HEALTH_TIMEOUT_MS = Number(
  process.env.PARITY_HEALTH_TIMEOUT_MS ?? 20_000,
);

/**
 * Guards of the parity run (before any spec loads):
 * 1. `PARITY_API_URL` is set — the run is black-box against a separately started API.
 * 2. Every `*.e2e-spec.ts` file in `server/test` is classified in the manifest, so new suites
 *    cannot silently run (or silently not run) against the Rust API.
 * 3. The remote API answers `GET /api/health`.
 */
export default async function setup(): Promise<void> {
  const url = process.env.PARITY_API_URL;
  if (!url)
    throw new Error(
      'PARITY_API_URL is not set. Either run `npm run parity` (it starts the Rust API for ' +
        'you) or start the Rust API yourself and run ' +
        '`PARITY_API_URL=http://127.0.0.1:4310 npm run test:parity` (see test/parity/README.md).',
    );

  const dir = fileURLToPath(new URL('..', import.meta.url));
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.e2e-spec.ts'))
    .sort();
  const listed = MANIFEST.map((m) => m.file).sort();
  const unclassified = files.filter((f) => !listed.includes(f));
  if (unclassified.length)
    throw new Error(
      `Unclassified e2e specs (add them to server/test/parity/manifest.ts):\n${unclassified.join('\n')}`,
    );
  const stale = listed.filter((f) => !files.includes(f));
  if (stale.length)
    throw new Error(
      `Manifest lists spec files that no longer exist:\n${stale.join('\n')}`,
    );

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/health`);
      if (res.ok) return;
      lastError = new Error(`GET ${url}/api/health answered ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `The API at ${url} is not healthy after ${HEALTH_TIMEOUT_MS} ms: ${String(lastError)}`,
  );
}
