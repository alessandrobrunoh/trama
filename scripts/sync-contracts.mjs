// Copies contracts/domain.ts (source of truth) into the server and client trees.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'contracts/domain.ts');
const banner = '// GENERATED — copied from contracts/domain.ts by scripts/sync-contracts.mjs. Do not edit.\n';
const targets = ['server/src/contracts/domain.ts', 'src/app/core/contracts/domain.ts'];

const body = readFileSync(source, 'utf8');
for (const target of targets) {
  const path = join(root, target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, banner + body);
  console.log(`synced ${target}`);
}
