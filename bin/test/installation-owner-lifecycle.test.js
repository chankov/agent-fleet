import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readState, writeState } from '../lib/state.js';
import { applyPlan, applyConfiguration, retryRuntimeRepairs } from '../lib/apply.js';
import { recoverTransaction, runTransaction, discardUnrecoverableTransaction } from '../lib/transaction.js';
import { runDoctor } from '../lib/doctor.js';

const cli = join(process.cwd(), 'bin/cli.js');
function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), 'fleet-owner-life-')), owner = join(root, 'child');
 t.after(() => rmSync(root, { recursive: true, force: true }));
 mkdirSync(join(root, '.ai')); mkdirSync(join(owner, '.ai'), { recursive: true }); mkdirSync(join(owner, '.pi'));
 symlinkSync(join(owner, '.pi'), join(root, '.pi'));
 writeFileSync(join(root, '.ai/agent-fleet.json'), '{"schemaVersion":1,"preset":"default","features":{},"installationOwner":"child"}');
 writeState(owner, { schemaVersion: 2, agent: 'pi', method: 'copy', sourceRoot: process.cwd(), packageVersion: 'before', items: {} });
 return { root, owner };
}
function fingerprint(root) {
 const result = [];
 function visit(dir) {
  for (const name of readdirSync(dir).sort()) {
   const path = join(dir, name), stat = lstatSync(path);
   result.push([path, stat.mode, stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? 'directory' : readFileSync(path).toString('base64')]);
   if (stat.isDirectory()) visit(path);
  }
 }
 visit(root); return result;
}

test('state reads resolve single owner and writes refuse aliases', t => {
 const { root, owner } = fixture(t);
 assert.equal(readState(root).packageVersion, 'before');
 const before = fingerprint(root);
 assert.throws(() => writeState(root, { schemaVersion: 2 }), /installation owner/);
 assert.deepEqual(fingerprint(root), before);
 writeState(owner, { schemaVersion: 2, packageVersion: 'after', items: {} });
 assert.equal(readState(root).packageVersion, 'after');
});

test('mutation boundaries refuse aliases before transaction or repair writes', async t => {
 const { root, owner } = fixture(t);
 writeFileSync(join(owner, '.ai/agent-fleet-transaction.json'), '{interrupted-owner-journal');
 const before = fingerprint(root);
 assert.throws(() => recoverTransaction(root), /installation owner/);
 assert.throws(() => discardUnrecoverableTransaction(root), /installation owner/);
 assert.throws(() => runTransaction({ workspace: root, plan: { workspace: root, verb: 'setup', actions: [] }, manifest: { items: [] }, commit: () => assert.fail('must not commit') }), /installation owner/);
 const result = applyPlan({ plan: { workspace: root, verb: 'setup', actions: [] }, manifest: { items: [] } });
 assert.match(result.failure.detail, /installation owner/);
 assert.throws(() => retryRuntimeRepairs({ workspace: root, manifest: { items: [] } }), /installation owner/);
 await assert.rejects(runDoctor({ workspace: root, sourceRoot: process.cwd(), apply: true }), /installation owner/);
 assert.deepEqual(fingerprint(root), before);
});

test('CLI alias mutations refuse even with force and an owner interrupted journal', t => {
 const { root, owner } = fixture(t);
 writeFileSync(join(owner, '.ai/agent-fleet-transaction.json'), '{owner-journal');
 const before = fingerprint(root);
 for (const args of [['setup', '--yes'], ['upgrade', '--yes'], ['uninstall', '--all', '--yes'], ['doctor', '--fix', '--force', '--yes'], ['setup', '--migrate-system1-config', '--yes']]) {
  const run = spawnSync(process.execPath, [cli, ...args, '--workspace', root], { encoding: 'utf8', env: { ...process.env, PI_OFFLINE: '1' } });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /installation owner/); assert.ok(run.stderr.includes(owner));
  assert.deepEqual(fingerprint(root), before, args.join(' '));
 }
});

test('offline owner upgrade, parent previews and local configure keep one ledger', t => {
 const { root, owner } = fixture(t);
 const run = (args, workspace = root) => spawnSync(process.execPath, [cli, ...args, '--workspace', workspace], { encoding: 'utf8', env: { ...process.env, PI_OFFLINE: '1' } });
 let result = run(['install', '--items', 'command:plan', '--yes'], owner);
 assert.equal(result.status, 0, result.stdout + result.stderr);
 result = run(['upgrade', '--yes'], owner);
 assert.equal(result.status, 0, result.stdout + result.stderr);
 assert.equal(readState(root).packageVersion, JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version);
 writeFileSync(join(root, '.ai/agent-fleet-state.json'), '{conflicting-parent-copy');
 result = run(['setup', '--dry-run', '--json']);
 assert.equal(result.status, 0, result.stdout + result.stderr);
 const preview = JSON.parse(result.stdout);
 assert.equal(preview.installation.status, 'shared');
 assert.equal(preview.installation.localStatePresent, true);
 assert.equal(preview.desired.installationOwner, 'child');
 result = run(['doctor', '--json']);
 assert.ok([0, 2].includes(result.status), result.stdout + result.stderr);
 const report = JSON.parse(result.stdout);
 assert.ok(report.findings.some(f => f.type === 'installation-owner' && f.issue.includes('may diverge')));
 result = run(['configure', '--rules', 'child/rules', '--yes']);
 assert.equal(result.status, 0, result.stdout + result.stderr);
 assert.equal(readFileSync(join(root, '.ai/agent-fleet-state.json'), 'utf8'), '{conflicting-parent-copy');
 assert.equal(readState(root).packageVersion, readState(owner).packageVersion);
});

test('configuration-only transaction remains local and leaves the owner ledger intact', t => {
 const { root, owner } = fixture(t);
 const state = readFileSync(join(owner, '.ai/agent-fleet-state.json'), 'utf8');
 const path = join(root, '.ai/agent-fleet-overrides.md');
 const expectedHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
 assert.equal(applyConfiguration({ workspace: root, overrides: { path, write: true, text: '## agent-hub\nrules: src/rules\n' }, expectedHash }).changed, true);
 assert.equal(readFileSync(join(owner, '.ai/agent-fleet-state.json'), 'utf8'), state);
 assert.equal(lstatSync(join(root, '.ai')).isDirectory(), true);
});
