import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPilotBudget, PILOT_LIMITS } from '../lib/task-triage-pilot-budget.ts';

const binding = { pilotHash: 'a'.repeat(64), corpusHash: 'b'.repeat(64), pricingHash: 'c'.repeat(64), maxAttemptMicrousd: 50000 };
function fixture(t: any) {
 const root = fs.mkdtempSync(join(tmpdir(), 'triage-pilot-budget-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 return join(root, 'ledger.ndjson');
}
function open(path: string, extra: Record<string, unknown> = {}) {
 return createPilotBudget({ ledgerPath: path, binding, ...extra });
}

test('pilot budget must be explicitly initialized and reserves durably before a synthetic attempt', t => {
 const path = fixture(t);
 assert.throws(() => open(path), /missing|ENOENT/);
 const budget = open(path, { create: true });
 assert.deepEqual(PILOT_LIMITS, { maxAttempts: 100, maxMicrousd: 5000000 });
 const attempt = budget.reserve('P01');
 const durable = fs.readFileSync(path, 'utf8');
 assert.match(durable, /"kind":"reserve"/);
 assert.equal(attempt.attempt, 1);
 assert.equal(budget.snapshot().reservedMicrousd, 50000);
 assert.throws(() => budget.reserve('P02'), /unresolved/i);
 budget.settle(attempt, 12000);
 assert.deepEqual(budget.snapshot(), { attempts: 1, chargedMicrousd: 12000, reservedMicrousd: 0, blocked: false });
 assert.deepEqual(open(path).snapshot(), budget.snapshot());
 assert.throws(() => open(path, { create: true }), /exists|initialize/);
});

test('physical attempt cap counts failures and retries across reopened ledgers', t => {
 const path = fixture(t);
 let budget = open(path, { create: true });
 for (let i = 0; i < 100; i++) {
  const attempt = budget.reserve('P01'); // repeated logical example, each physical retry counts
  budget.settle(attempt, 1);
  if (i === 49) budget = open(path);
 }
 assert.equal(budget.snapshot().attempts, 100);
 assert.throws(() => budget.reserve('P01'), /attempt.*cap/);
 assert.equal(open(path).snapshot().attempts, 100);
});

test('inclusive USD cap and insufficient next reservation refuse before an attempt', t => {
 const path = fixture(t), high = { ...binding, maxAttemptMicrousd: 3000000 };
 const budget = open(path, { create: true, binding: high });
 const first = budget.reserve('P01'); budget.settle(first, 3000000);
 const before = fs.readFileSync(path, 'utf8');
 assert.throws(() => budget.reserve('P02'), /USD.*cap/);
 assert.equal(fs.readFileSync(path, 'utf8'), before);
 const exactPath = fixture(t), exact = open(exactPath, { create: true, binding: { ...binding, maxAttemptMicrousd: 2500000 } });
 for (const id of ['P01', 'P02']) { const attempt = exact.reserve(id); exact.settle(attempt, 2500000); }
 assert.equal(exact.snapshot().chargedMicrousd, 5000000);
 assert.throws(() => exact.reserve('P03'), /USD.*cap/);
});

test('unknown spend or crash reservation remains charged conservatively and blocks reopen', t => {
 for (const settleUnknown of [false, true]) {
  const path = fixture(t), budget = open(path, { create: true });
  const attempt = budget.reserve('P01');
  if (settleUnknown) budget.settle(attempt, null);
  assert.equal(budget.snapshot().blocked, true);
  assert.equal(budget.snapshot().reservedMicrousd, 50000);
  assert.throws(() => budget.reserve('P02'), /unresolved|unknown/);
  assert.throws(() => open(path).reserve('P02'), /unresolved|unknown/);
 }
});

test('malformed, partial, wrong binding or ambiguous ledger never resets counters', t => {
 const path = fixture(t), budget = open(path, { create: true });
 const before = fs.readFileSync(path, 'utf8');
 for (const key of ['pilotHash', 'corpusHash', 'pricingHash']) {
  assert.throws(() => open(path, { binding: { ...binding, [key]: 'd'.repeat(64) } }), /binding/);
 }
 assert.throws(() => open(path, { binding: { ...binding, maxAttemptMicrousd: 1 } }), /binding/);
 assert.equal(fs.readFileSync(path, 'utf8'), before);
 fs.appendFileSync(path, '{"kind":"reserve"');
 assert.throws(() => budget.reserve('P01'), /partial|invalid/);
 assert.throws(() => open(path), /partial|invalid/);
 fs.writeFileSync(path, before + before); // duplicate header
 assert.throws(() => open(path), /invalid|ambiguous/);
});

test('same-process concurrent owners and stale or forged receipts cannot settle a different attempt', t => {
 const path = fixture(t), one = open(path, { create: true }), two = open(path);
 const receipt = one.reserve('P01');
 assert.throws(() => two.reserve('P02'), /unresolved/i);
 assert.throws(() => two.settle(receipt, 1), /receipt/);
 assert.throws(() => one.settle({ ...receipt }, 1), /receipt/);
 one.settle(receipt, 1);
 assert.throws(() => one.settle(receipt, 1), /receipt/);
 const later = two.reserve('P02'); two.settle(later, 1);
 assert.equal(one.snapshot().attempts, 2);
});

test('exclusive lock is not stolen, invalid costs/example IDs or cancellation do not append', t => {
 const path = fixture(t), budget = open(path, { create: true });
 const before = fs.readFileSync(path, 'utf8');
 fs.writeFileSync(path + '.lock', 'other owner');
 assert.throws(() => budget.reserve('P01'), /lock/);
 assert.equal(fs.readFileSync(path + '.lock', 'utf8'), 'other owner');
 fs.unlinkSync(path + '.lock');
 for (const id of ['P00', 'P41', 'P1', '/private', 'P01\n']) assert.throws(() => budget.reserve(id), /example/);
 const abort = new AbortController(); abort.abort();
 assert.throws(() => budget.reserve('P01', abort.signal), /cancel/);
 assert.equal(fs.readFileSync(path, 'utf8'), before);
 const attempt = budget.reserve('P01');
 for (const cost of [-1, 0.5, Infinity, 50001, undefined]) assert.throws(() => budget.settle(attempt, cost as any), /cost/);
 budget.settle(attempt, null);
});

test('missing or invalid worst-case USD cost cannot initialize a ledger', t => {
 for (const max of [undefined, null, 0, -1, 0.5, Infinity, 5000001]) {
  const path = fixture(t);
  assert.throws(() => open(path, { create: true, binding: { ...binding, maxAttemptMicrousd: max } }), /binding|cost/);
  assert.equal(fs.existsSync(path), false);
 }
});

test('symlinked leaf, linked parent, lock link and hardlink ledger are refused without external mutation', t => {
 const path = fixture(t), outside = fixture(t);
 fs.writeFileSync(outside, 'outside');
 fs.symlinkSync(outside, path);
 assert.throws(() => open(path), /symlink|unsafe/);
 assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
 fs.unlinkSync(path);
 open(path, { create: true });
 fs.symlinkSync(outside, path + '.lock');
 assert.throws(() => open(path).reserve('P01'), /symlink|unsafe|lock/);
 assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
 fs.unlinkSync(path + '.lock');
 fs.linkSync(path, path + '.copy');
 assert.throws(() => open(path), /link|unsafe/);
 const parentLink = path + '.parent'; fs.symlinkSync(join(path, '..'), parentLink);
 assert.throws(() => open(join(parentLink, 'new.ndjson'), { create: true }), /symlink|unsafe/);
});

test('separate process cannot reserve while a durable physical attempt is unresolved', t => {
 const path = fixture(t), budget = open(path, { create: true });
 const first = budget.reserve('P01');
 const moduleUrl = new URL('../lib/task-triage-pilot-budget.ts', import.meta.url).href;
 const script = `import {createPilotBudget} from ${JSON.stringify(moduleUrl)}; const budget = createPilotBudget({ledgerPath:${JSON.stringify(path)},binding:${JSON.stringify(binding)}}); try {budget.reserve('P02'); process.exitCode=2;} catch(error) {if(!/unresolved/i.test(error.message)) throw error; console.log('REFUSED_UNRESOLVED');}`;
 const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
  encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH!, HOME: tmpdir(), PI_OFFLINE: '1' },
 });
 assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /REFUSED_UNRESOLVED/);
 assert.equal(budget.snapshot().attempts, 1);
 budget.settle(first, 1);
});

test('failed settlement persistence leaves a restart fence even if its bytes reached the file', t => {
 const path = fixture(t); open(path, { create: true });
 let failSync = false;
 const budget = open(path, { io: { ...fs, fsyncSync(fd: number) {
  if (failSync && fs.fstatSync(fd).ino === fs.lstatSync(path).ino) throw Error('synthetic settlement fsync');
  fs.fsyncSync(fd);
 } } });
 const attempt = budget.reserve('P01');
 failSync = true;
 assert.throws(() => budget.settle(attempt, 1), /fsync/);
 assert.match(fs.readFileSync(path, 'utf8'), /"kind":"settle"/, 'failure is after settlement bytes, not merely lock setup');
 assert.equal(fs.existsSync(path + '.lock'), true, 'failed settlement must retain an operator-inspection fence');
 const reopened = open(path);
 assert.equal(reopened.snapshot().blocked, true);
 assert.throws(() => reopened.reserve('P02'), /lock|persistence|blocked/);
 assert.equal(reopened.snapshot().attempts, 1);
});

test('persistence failure after reservation cannot return permission or erase reserved spend', t => {
 const path = fixture(t); open(path, { create: true });
 const budget = open(path, { io: { ...fs, fsyncSync(fd: number) {
  if (fs.fstatSync(fd).ino === fs.lstatSync(path).ino) throw Error('synthetic ledger fsync failure');
  fs.fsyncSync(fd);
 } } });
 assert.throws(() => budget.reserve('P01'), /fsync/);
 assert.match(fs.readFileSync(path, 'utf8'), /"kind":"reserve"/);
 assert.equal(open(path).snapshot().blocked, true);
 assert.equal(open(path).snapshot().reservedMicrousd, 50000);
 assert.throws(() => budget.reserve('P02'), /persistence|blocked/);
});
