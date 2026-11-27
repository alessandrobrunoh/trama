#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Black-box parity harness: runs the wire-level e2e suites of `server/test` against the Rust
 * API in `server-rs`, over real HTTP. See server/test/parity/README.md.
 *
 * What it owns, in order:
 *  1. a dedicated disposable database (`trama_parity`, created only if absent; never the shared
 *     `trama_core_test` of the NestJS e2e suite),
 *  2. the Rust API process (`cargo run`, NODE_ENV=test, migrations applied by the server itself),
 *  3. `vitest --config vitest.config.parity.ts` with `PARITY_API_URL` pointed at it,
 *  4. teardown: stop the Rust API, drop the database, exit with vitest's code.
 *
 * With `PARITY_API_URL` already set, it assumes the Rust API (or any API) is running and only
 * runs the vitest part, touching nothing else.
 */

const PORT = Number(process.env.PARITY_PORT ?? 4310);
const DATABASE_URL =
  process.env.PARITY_DATABASE_URL ??
  'postgres://delta:delta@localhost:5435/trama_parity';
// How long to wait for `cargo run` to build and boot the API (first builds are slow).
const BOOT_TIMEOUT_MS = Number(process.env.PARITY_BOOT_TIMEOUT_MS ?? 300_000);

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const rustDir = new URL('../../server-rs/', import.meta.url);

const log = (m) => console.log(`[parity] ${m}`);

function adminUrlOf(dbUrl) {
  const url = new URL(dbUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

async function createDatabase() {
  const dbName = decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1));
  if (dbName.length > 63 || !/^trama_parity(?:_[a-z0-9]+)*$/.test(dbName))
    throw new Error(
      'Managed parity mode requires a disposable database named trama_parity or trama_parity_<suffix>.',
    );
  const client = new pg.Client({ connectionString: adminUrlOf(DATABASE_URL) });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
  } finally {
    await client.end();
  }
  log(`created disposable database ${dbName}`);
}

async function dropDatabase() {
  const dbName = decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1));
  const client = new pg.Client({ connectionString: adminUrlOf(DATABASE_URL) });
  await client.connect();
  try {
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`,
    );
  } finally {
    await client.end();
  }
  log(`dropped database ${dbName}`);
}

function startRustApi() {
  log(`cargo run (port ${PORT}) — first builds can take a few minutes`);
  const child = spawn('cargo', ['run'], {
    cwd: fileURLToPath(rustDir),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL,
      NODE_ENV: 'test',
      SEED_DEMO: 'false',
      TRAMA_ENABLE_ADMIN_RESET: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[rust] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[rust] ${d}`));
  return child;
}

async function waitHealthy(baseUrl, child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Rust API exited before becoming healthy (${child.exitCode ?? child.signalCode})`);
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      lastError = new Error(`GET /api/health answered ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Rust API not healthy after ${BOOT_TIMEOUT_MS} ms: ${String(lastError)}`,
  );
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const killed = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.on('exit', () => {
      clearTimeout(killed);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function runVitest(baseUrl) {
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.config.parity.ts',
    ],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        PARITY_API_URL: baseUrl,
        PARITY_DATABASE_URL: DATABASE_URL,
      },
      stdio: 'inherit',
    },
  );
  return new Promise((resolve) =>
    child.on('exit', (code) => resolve(code ?? 1)),
  );
}

const externalUrl = process.env.PARITY_API_URL?.replace(/\/$/, '');
let child;
let ownsDatabase = false;
let exitCode = 1;

try {
  if (externalUrl) {
    log(`using the already-running API at ${externalUrl}`);
  } else {
    await createDatabase();
    ownsDatabase = true;
    child = startRustApi();
    await waitHealthy(`http://127.0.0.1:${PORT}`, child);
  }
  exitCode = await runVitest(externalUrl ?? `http://127.0.0.1:${PORT}`);
} catch (error) {
  console.error(
    `[parity] ${error instanceof Error ? error.message : String(error)}`,
  );
  exitCode = 1;
} finally {
  if (child) await stop(child);
  if (ownsDatabase) {
    try {
      await dropDatabase();
    } catch (error) {
      console.error(`[parity] teardown failed: ${String(error)}`);
    }
  }
}

process.exit(exitCode);
