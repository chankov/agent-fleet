import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readState, writeState } from '../lib/state.js';
import { applyPlan, applyConfiguration, retryRuntimeRepairs } from '../lib/apply.js';
import { recoverTransaction, runTransaction, discardUnrecoverableTransaction } from '../lib/transaction.js';
import { runDoctor } from '../lib/doctor.js';
import { runVerify } from '../lib/verify.js';

const cli = join(process.cwd(), 'bin/cli.js');
function fixture(t, retired = true) {
 const root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-state-life-'))), child = join(root, 'child');
 t.after(() => rmSync(root, { recursive: true, force: true }));
 mkdirSync(join(root, '.ai')); mkdirSync(join(child, '.ai'), { recursive: true }); mkdirSync(join(child, '.pi'));
 writeState(child, { schemaVersion: 2, agent: 'pi', method: 'copy', sourceRoot: process.cwd(), packageVersion: 'child-before', items: {} });
 writeFileSync(join(root, '.ai/agent-fleet.json'), JSON.stringify({ schemaVersion: 1, preset: 'default', features: {}, ...(retired ? { installationOwner: 'child' } : {}) }));
 if (retired) symlinkSync(join(child, '.pi'), join(root, '.pi'));
 return { root, child };
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

test('a corrupt .ai/agent-fleet.json is reported as broken human configuration, not unreadable state', t => {
 const { root } = fixture(t, false);
 writeFileSync(join(root, '.ai/agent-fleet-state.json'), '{"schemaVersion":2,"items":{}}');
 writeFileSync(join(root, '.ai/agent-fleet.json'), '{"preset": "default",');
 assert.throws(() => readState(root), error => /\.ai\/agent-fleet\.json is not a JSON object/.test(error.message) && !/agent-fleet-state\.json is unreadable/.test(error.message));
});

test('retired owner state reads/writes refuse rather than adopt a child or local copy', t => {
 const { root, child } = fixture(t);
 writeFileSync(join(root, '.ai/agent-fleet-state.json'), '{"schemaVersion":2,"packageVersion":"parent-copy"}');
 const before = fingerprint(root);
 assert.throws(() => readState(root), /installationOwner is no longer supported/);
 assert.throws(() => writeState(root, { schemaVersion: 2 }), /installationOwner is no longer supported/);
 assert.equal(readState(child).packageVersion, 'child-before');
 assert.deepEqual(fingerprint(root), before);
});

test('all direct mutation boundaries refuse retired layouts before writes', async t => {
 const { root, child } = fixture(t);
 writeFileSync(join(child, '.ai/agent-fleet-transaction.json'), '{interrupted-child-journal');
 const before = fingerprint(root);
 const retired = /installationOwner is no longer supported/;
 assert.throws(() => recoverTransaction(root), retired);
 assert.throws(() => discardUnrecoverableTransaction(root), retired);
 assert.throws(() => runTransaction({ workspace: root, plan: { workspace: root, verb: 'setup', actions: [] }, manifest: { items: [] }, commit: () => assert.fail('must not commit') }), retired);
 const result = applyPlan({ plan: { workspace: root, verb: 'setup', actions: [] }, manifest: { items: [] } });
 assert.match(result.failure.detail, retired);
 assert.throws(() => retryRuntimeRepairs({ workspace: root, manifest: { items: [] } }), retired);
 await assert.rejects(runDoctor({ workspace: root, sourceRoot: process.cwd(), apply: true }), retired);
 assert.throws(() => applyConfiguration({ workspace: root, overrides: { path: join(root, '.ai/agent-fleet-overrides.md'), write: true, text: '## agent-hub\nrules: child/rules\n' }, expectedHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }), retired);
 assert.deepEqual(fingerprint(root), before);
});

test('CLI rejects retired layout for mutations and setup preview with no side effects', t => {
 const { root, child } = fixture(t);
 writeFileSync(join(child, '.ai/agent-fleet-transaction.json'), '{child-journal');
 const before = fingerprint(root);
 for (const args of [['setup', '--yes'], ['upgrade', '--yes'], ['uninstall', '--all', '--yes'], ['doctor', '--fix', '--force', '--yes'], ['setup', '--migrate-system1-config', '--yes'], ['configure', '--rules', 'child/rules', '--yes'], ['setup', '--dry-run', '--json']]) {
  const run = spawnSync(process.execPath, [cli, ...args, '--workspace', root], { encoding: 'utf8', env: { ...process.env, PI_OFFLINE: '1' } });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /installationOwner is no longer supported/);
  assert.deepEqual(fingerprint(root), before, args.join(' '));
 }
});

test('read-only doctor and verify diagnose retired configuration without exporting a child ledger', async t => {
 const { root } = fixture(t);
 const before = fingerprint(root);
 const findings = await runDoctor({ workspace: root, sourceRoot: process.cwd(), checkVisibility: () => ({ models: [] }), checkDependencies: () => ({ status: 0, stdout: '' }) });
 assert.ok(findings.some(f => f.type === 'installation-state' && f.issue.includes('installationOwner is no longer supported')));
 const report = await runVerify({ workspace: root, sourceRoot: process.cwd(), packageVersion: 'test', manifest: { items: [] }, agent: 'pi', includeDoctor: false });
 assert.ok(report.findings.some(f => f.type === 'installation-state' && f.issue.includes('installationOwner is no longer supported')));
 assert.equal(report.summary.problems > 0, true);
 assert.equal(JSON.stringify([findings, report]).includes('child-before'), false);
 assert.deepEqual(fingerprint(root), before);
});

test('standalone non-Git parent lifecycle and configure leave child Git repositories intact', t => {
 const { root, child } = fixture(t, false);
 const docs = join(root, 'docs'); mkdirSync(docs);
 for (const repo of [child, docs]) {
  const init = spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' }); assert.equal(init.status, 0, init.stderr);
  writeFileSync(join(repo, 'untracked.md'), '# Unrelated user file\n');
 }
 const childrenBefore = [fingerprint(child), fingerprint(docs)];
 const run = args => spawnSync(process.execPath, [cli, ...args, '--workspace', root], { encoding: 'utf8', env: { ...process.env, PI_OFFLINE: '1' } });
 let result = run(['install', '--items', 'command:plan', '--yes']);
 assert.equal(result.status, 0, result.stdout + result.stderr);
 result = run(['upgrade', '--yes']); assert.equal(result.status, 0, result.stdout + result.stderr);
 const parentState = readFileSync(join(root, '.ai/agent-fleet-state.json'), 'utf8');
 assert.equal(readState(root).packageVersion, JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version);
 result = run(['setup', '--dry-run', '--json']); assert.equal(result.status, 0, result.stdout + result.stderr);
 const preview = JSON.parse(result.stdout);
 assert.equal(preview.installation, undefined);
 assert.equal(preview.desired.installationOwner, undefined);
 result = run(['configure', '--rules', 'docs/.ai/rules', '--yes']); assert.equal(result.status, 0, result.stdout + result.stderr);
 assert.equal(readFileSync(join(root, '.ai/agent-fleet-state.json'), 'utf8'), parentState);
 assert.equal(lstatSync(join(root, '.pi')).isDirectory(), true);
 assert.deepEqual([fingerprint(child), fingerprint(docs)], childrenBefore);
});
