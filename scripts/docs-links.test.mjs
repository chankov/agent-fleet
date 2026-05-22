import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('pi extension catalog does not link to ignored planning docs', async () => {
  const catalog = await readFile('docs/pi-extensions.md', 'utf-8');
  assert.doesNotMatch(catalog, /docs\/plans\//);
});
