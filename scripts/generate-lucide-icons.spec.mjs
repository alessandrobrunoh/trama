import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIconLiteral } from './generate-lucide-icons.mjs';

test('parses valid nested icon literals and alias data', () => {
  assert.deepEqual(
    parseIconLiteral("{ name: 'check', size: 24, node: [['path', { d: 'M0 0' }]], aliases: ['done'] }"),
    Object.assign(Object.create(null), {
      name: 'check',
      size: 24,
      node: [['path', Object.assign(Object.create(null), { d: 'M0 0' })]],
      aliases: ['done'],
    }),
  );
});

for (const source of [
  "{ name: 'x', size: 24, node: [], value: call() }",
  "{ name: 'x', size: 24, node: [], value: globalThis.process.exit() }",
  "{ name: 'x', size: 24, node: [], ...other }",
  "{ name: 'x', size: 24, node: [], get value() { return 1 } }",
  "{ name: 'x', size: 24, node: []",
  "{ name: 'x', size: 24 }",
]) {
  test(`rejects unsafe or malformed icon expression`, () => {
    assert.throws(() => parseIconLiteral(source));
  });
}

test('does not execute calls in rejected expressions', () => {
  globalThis.__lucideExecuted = false;
  assert.throws(() => parseIconLiteral(
    "{ name: 'x', size: 24, node: [], value: (globalThis.__lucideExecuted = true) }",
  ));
  assert.equal(globalThis.__lucideExecuted, false);
  delete globalThis.__lucideExecuted;
});
