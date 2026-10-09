#!/usr/bin/env node
/**
 * Prints the size of the initial bundle of a production build (`npm run build`) and exits non-zero
 * when it is over the limit, so regressions show up before the Angular budget (angular.json,
 * warning 1.75 MB, error 2 MB) fails a merge.
 *
 *   node scripts/check-bundle-size.mjs [--dist dist/trama/browser] [--limit 1750000] [--top 8]
 *
 * "Initial" is what Angular's budget counts: the scripts and stylesheets referenced by index.html plus
 * every chunk they import statically (dynamic `import()` chunks are lazy and not counted).
 * Default limit is the budget warning threshold (1.75 MB = 1,750,000 bytes).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const dist = resolve(root, option('dist', 'dist/trama/browser'));
const limit = Number(option('limit', 1_750_000));
const top = Number(option('top', 8));

const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`No build found at ${dist}. Run "npm run build" first.`);
  process.exit(2);
}

const html = readFileSync(indexPath, 'utf8');
const entries = [
  ...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g),
  ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g),
].map((m) => m[1]);

const seen = new Map();
function visit(file) {
  if (seen.has(file)) return;
  const path = join(dist, file);
  seen.set(file, statSync(path).size);
  if (!file.endsWith('.js')) return;
  const code = readFileSync(path, 'utf8');
  // Static imports/re-exports only: `from"./x.js"` and `import"./x.js"`; dynamic import("./x.js") is lazy.
  for (const m of code.matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g)) visit(m[1]);
}
entries.forEach(visit);

const total = [...seen.values()].reduce((sum, n) => sum + n, 0);
const kB = (n) => `${(n / 1000).toFixed(1)} kB`.padStart(10);
console.log('Initial bundle (raw bytes, as Angular budgets count them)');
for (const [file, size] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${kB(size)}  ${file}`);
}
if (seen.size > top) console.log(`           ... ${seen.size - top} smaller files`);
console.log(
  `${kB(total)}  total (${seen.size} files), limit ${kB(limit).trim()}, headroom ${kB(limit - total).trim()}`,
);

if (total > limit) {
  console.error(
    'Initial bundle is over the limit. Lazy-load what the shell does not need on first paint; new icons: node scripts/generate-lucide-icons.mjs.',
  );
  process.exit(1);
}
