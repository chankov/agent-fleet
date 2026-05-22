import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('coms-net server recipes use the checked Node runtime instead of undeclared tsx', async () => {
  const justfile = await readFile('justfile', 'utf-8');
  assert.doesNotMatch(justfile, /npx tsx scripts\/coms-net-server\.ts/);
  assert.match(justfile, /node --experimental-strip-types scripts\/coms-net-server\.ts/);
});

test('pi extension docs document the Node coms-net server runtime', async () => {
  const catalog = await readFile('docs/pi-extensions.md', 'utf-8');
  assert.doesNotMatch(catalog, /npx tsx scripts\/coms-net-server\.ts/);
  assert.match(catalog, /node --experimental-strip-types scripts\/coms-net-server\.ts/);
});
