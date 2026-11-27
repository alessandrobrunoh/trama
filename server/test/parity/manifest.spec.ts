import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST, PARITY_SPECS } from './manifest.js';

/**
 * Keeps the parity manifest honest: every e2e spec file must be classified, no stale entries.
 * This runs in the normal unit suite (`npm test`), so a new spec cannot land unclassified.
 */
describe('parity manifest', () => {
  it('classifies every e2e spec file in server/test exactly once', async () => {
    const dir = fileURLToPath(new URL('..', import.meta.url));
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.e2e-spec.ts'))
      .sort();
    const listed = MANIFEST.map((m) => m.file).sort();
    expect(files).toEqual(listed);
  });

  it('lists only existing files as parity specs', async () => {
    const dir = fileURLToPath(new URL('..', import.meta.url));
    const files = new Set(
      (await readdir(dir)).filter((f) => f.endsWith('.e2e-spec.ts')),
    );
    for (const file of PARITY_SPECS) {
      expect(
        files.has(file),
        `${file} is marked parity but does not exist`,
      ).toBe(true);
    }
  });
});
