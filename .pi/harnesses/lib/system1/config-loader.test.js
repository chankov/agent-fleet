import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSystem1Snapshot, readSystem1Selected } from './config-loader.js';
const config = { version: 2, mode: 'off', provider: 'typesafe', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY', consumers: {} };
function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), 'system1-loader-'));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 mkdirSync(join(root, '.ai'));
 return root;
}
test('bounded descriptor loader handles missing, valid and duplicate documents', t => {
 const root = fixture(t), path = join(root, '.ai/system1.json');
 assert.equal(loadSystem1Snapshot(root).status, 'missing');
 writeFileSync(path, JSON.stringify(config));
 assert.equal(loadSystem1Snapshot(root).status, 'off');
 writeFileSync(path, '{"version":2,"version":2}');
 assert.equal(loadSystem1Snapshot(root).status, 'invalid');
 writeFileSync(path, ' '.repeat(1024 * 1024 + 1));
 assert.equal(loadSystem1Snapshot(root).status, 'invalid');
 writeFileSync(join(root, '.ai/agent-fleet.json'), JSON.stringify({ features: { system1: true } }));
 assert.equal(readSystem1Selected(root), true);
 writeFileSync(join(root, '.ai/agent-fleet.json'), ' '.repeat(1024 * 1024 + 1));
 assert.equal(readSystem1Selected(root), false);
});
for (const name of ['system1.json', 'agent-fleet.json']) test(`refuse linked or non-regular ${name}`, t => {
 const root = fixture(t), foreign = fixture(t);
 writeFileSync(join(foreign, name), JSON.stringify(name === 'system1.json' ? config : { features: { system1: true } }));
 symlinkSync(join(foreign, name), join(root, '.ai', name));
 assert.equal(loadSystem1Snapshot(root).status, name === 'system1.json' ? 'invalid' : 'missing');
 assert.equal(readSystem1Selected(root), false);
 rmSync(join(root, '.ai', name));
 symlinkSync(join(foreign, 'not-present'), join(root, '.ai', name));
 assert.equal(loadSystem1Snapshot(root).status, name === 'system1.json' ? 'invalid' : 'missing');
 assert.equal(readSystem1Selected(root), false);
 unlinkSync(join(root, '.ai', name));
 mkdirSync(join(root, '.ai', name));
 assert.equal(loadSystem1Snapshot(root).status, name === 'system1.json' ? 'invalid' : 'missing');
 assert.equal(readSystem1Selected(root), false);
});
test('refuse a linked .ai parent rather than reading a foreign workspace', t => {
 const root = fixture(t), foreign = fixture(t);
 writeFileSync(join(foreign, '.ai/system1.json'), JSON.stringify(config));
 writeFileSync(join(foreign, '.ai/agent-fleet.json'), JSON.stringify({ features: { system1: true } }));
 rmSync(join(root, '.ai'), { recursive: true });
 symlinkSync(join(foreign, '.ai'), join(root, '.ai'));
 assert.equal(loadSystem1Snapshot(root).status, 'invalid');
 assert.equal(readSystem1Selected(root), false);
});
