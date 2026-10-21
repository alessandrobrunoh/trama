import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile(new URL('../ngsw-config.json', import.meta.url), 'utf8'));
const shell = config.assetGroups.find((group) => group.name === 'shell');
const lazyChunks = config.assetGroups.find((group) => group.name === 'lazy-chunks');

assert.ok(shell, 'A shell asset group must prefetch offline-critical assets');
assert.equal(shell.installMode, 'prefetch');
assert.ok(shell.resources.files.includes('/index.html'));
assert.ok(shell.resources.files.includes('/*.css'));
assert.ok(!shell.resources.files.includes('/*.js'), 'The shell must not prefetch every JS chunk');
assert.ok(lazyChunks, 'A separate group must match route chunks');
assert.equal(lazyChunks.installMode, 'lazy');
assert.ok(lazyChunks.resources.files.includes('/*.js'));

console.log('PWA asset groups keep route JavaScript lazy and prefetch the offline shell.');
