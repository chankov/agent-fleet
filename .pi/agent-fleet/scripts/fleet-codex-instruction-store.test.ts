import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InstructionLedger, intentDigest } from './lib/fleet-codex-instruction-store.ts';
const a = { hostProfile: 'fixture', principal: 'owner', threadId: '11111111-1111-4111-8111-111111111111' }, b = { ...a, threadId: '22222222-2222-4222-8222-222222222222' };
const target = { project: 'fixture', peer: 'orchestrator', sessionId: 'session1', startedAt: '2026-01-01T00:00:00.000Z' }, intent = { requestId: 'request1', target, digest: intentDigest(target, 'UNSTORED_PRIVATE_INSTRUCTION') };
async function fixture(t: {
    after: (fn: () => Promise<void>) => void;
}, checkpoint?: (s: string) => void) { const root = await mkdtemp(join(tmpdir(), 's6a-ledger-')); t.after(() => rm(root, { recursive: true, force: true })); const dir = join(root, 'intents'); return { root, dir, store: new InstructionLedger(dir, { checkpoint }), file: async () => join(dir, (await readdir(dir)).find(f => f.endsWith('.json'))!) }; }
test('atomic private reserve precedes attempt and duplicate survives fresh instance', async (t) => {
    const f = await fixture(t);
    assert.equal(f.store.lookup(a, 'request1'), null);
    assert.deepEqual(await readdir(f.root), []);
    const first = f.store.reserve(a, intent);
    assert.equal(first.created, true);
    assert.equal(first.receipt.state, 'unknown');
    assert.equal(first.receipt.attempted, false);
    const again = new InstructionLedger(f.dir).reserve(a, intent);
    assert.equal(again.created, false);
    assert.deepEqual(again.receipt, first.receipt);
    assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(await f.file())).mode & 0o777, 0o600);
    assert.equal((await readFile(await f.file(), 'utf8')).includes('UNSTORED_PRIVATE_INSTRUCTION'), false);
});
test('requestId binds operation/exact epoch/payload, conflict never mutates state', async (t) => {
    const f = await fixture(t);
    const first = f.store.reserve(a, intent).receipt;
    for (const changed of [{ ...intent, digest: intentDigest(target, 'different') }, { ...intent, target: { ...target, sessionId: 'session2' } }, { ...intent, target: { ...target, project: 'other' } }])
        assert.throws(() => f.store.reserve(a, changed), { code: 'INTENT_CONFLICT' });
    assert.deepEqual(f.store.lookup(a, 'request1'), first);
    assert.notEqual(intentDigest(target, 'x'), intentDigest(target, 'x '));
});
test('native conversation isolation and namespaced wire IDs never share state', async (t) => {
    const f = await fixture(t);
    const x = f.store.reserve(a, intent).receipt, y = f.store.reserve(b, intent).receipt;
    assert.notEqual(x.wireId, y.wireId);
    assert.equal(x.requestId, y.requestId);
    assert.match(x.wireId, /^[a-f0-9]{64}$/);
    assert.equal(f.store.lookup({ ...a, principal: 'other' }, 'request1'), null);
});
test('one durable attempt cannot be released by restart or unknown state', async (t) => {
    const f = await fixture(t);
    f.store.reserve(a, intent);
    const attempted = f.store.markAttempt(a, 'request1');
    assert.equal(attempted.attempted, true);
    assert.equal(attempted.state, 'unknown');
    const fresh = new InstructionLedger(f.dir);
    assert.throws(() => fresh.markAttempt(a, 'request1'), { code: 'INTENT_ALREADY_ATTEMPTED' });
    assert.equal(fresh.reserve(a, intent).created, false);
});
test('terminal result wins over late ack/unknown and cannot become not_sent', async (t) => {
    const f = await fixture(t);
    f.store.reserve(a, intent);
    f.store.markAttempt(a, 'request1');
    f.store.record(a, 'request1', { state: 'submitted', detail: null, result: null, truncated: false });
    f.store.record(a, 'request1', { state: 'result', detail: null, result: 'actual result', truncated: false });
    const r = f.store.record(a, 'request1', { state: 'unknown', detail: 'timeout', result: null, truncated: false });
    assert.equal(r.state, 'result');
    assert.equal(r.result, 'actual result');
    assert.equal(f.store.record(a, 'request1', { state: 'not_sent', detail: 'late', result: null, truncated: false }).state, 'result');
});
test('pre-delivery refusal remains historical and does not permit another attempt', async (t) => {
    const f = await fixture(t);
    f.store.reserve(a, intent);
    f.store.record(a, 'request1', { state: 'not_sent', detail: 'NOT_ALLOWED', result: null, truncated: false });
    assert.throws(() => f.store.markAttempt(a, 'request1'), { code: 'INTENT_ALREADY_ATTEMPTED' });
    assert.equal(new InstructionLedger(f.dir).reserve(a, intent).created, false);
});
test('attempted unknown cannot be falsely recorded as never sent', async (t) => {
    const f = await fixture(t);
    f.store.reserve(a, intent);
    f.store.markAttempt(a, 'request1');
    const r = f.store.record(a, 'request1', { state: 'not_sent', detail: 'timeout', result: null, truncated: false });
    assert.equal(r.state, 'unknown');
    assert.equal(r.attempted, true);
});
test('corrupt/version/namespace/known-loss state refuses without healing', async (t) => {
    const f = await fixture(t);
    f.store.reserve(a, intent);
    const file = await f.file(), raw = JSON.parse(await readFile(file, 'utf8'));
    raw.namespace = b;
    await writeFile(file, JSON.stringify(raw));
    assert.throws(() => f.store.lookup(a, 'request1'), { code: 'INTENT_NAMESPACE_MISMATCH' });
    await writeFile(file, '{bad');
    assert.throws(() => f.store.lookup(a, 'request1'), { code: 'INTENT_STATE_INVALID' });
    assert.equal(await readFile(file, 'utf8'), '{bad');
    await writeFile(file, '{"version":99}');
    assert.throws(() => f.store.lookup(a, 'request1'), { code: 'INTENT_STATE_VERSION' });
    await rm(file);
    assert.throws(() => f.store.lookup(a, 'request1'), { code: 'INTENT_STATE_MISSING' });
});
test('existing lock and unsafe permissions are never stolen/healed', async (t) => {
    const f = await fixture(t);
    f.store.reserve(a, intent);
    const file = await f.file(), lock = file + '.lock';
    await writeFile(lock, 'OTHER_OWNER', { mode: 0o600 });
    assert.throws(() => f.store.markAttempt(a, 'request1'), { code: 'INTENT_BUSY' });
    assert.equal(await readFile(lock, 'utf8'), 'OTHER_OWNER');
    await rm(lock);
    await chmod(file, 0o644);
    assert.throws(() => f.store.lookup(a, 'request1'), { code: 'INTENT_UNSAFE_PATH' });
});
test('finite retained intents fail closed instead of evicting dedup/unknown outcomes', async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 256; i++)
        f.store.reserve(a, { ...intent, requestId: 'request' + i });
    assert.throws(() => f.store.reserve(a, { ...intent, requestId: 'overflow' }), { code: 'INTENT_LIMIT' });
    assert.equal(f.store.reserve(a, intent).created, false);
});
for (const stage of ['beforeRename', 'afterRename'])
    test('durability ' + stage + ' errors never authorize transport retry', async (t) => {
        let writes = 0;
        const f = await fixture(t, s => { if (s === stage) {
            writes++;
            throw Error('PRIVATE_IO_ERROR');
        } });
        assert.throws(() => f.store.reserve(a, intent), { code: stage === 'afterRename' ? 'INTENT_COMMIT_UNCERTAIN' : 'INTENT_IO_ERROR' });
        assert.equal(writes, 1);
        if (stage === 'beforeRename') {
            assert.throws(() => new InstructionLedger(f.dir).lookup(a, 'request1'), { code: 'INTENT_STATE_MISSING' });
            assert.throws(() => new InstructionLedger(f.dir).reserve(a, intent), { code: 'INTENT_STATE_MISSING' });
        }
        else {
            const receipt = new InstructionLedger(f.dir).lookup(a, 'request1');
            assert.equal(receipt?.attempted, false);
            assert.equal(new InstructionLedger(f.dir).reserve(a, intent).created, false);
        }
    });
test('invalid roots/context/IDs and unbounded stored output fail before effects', async (t) => {
    const f = await fixture(t);
    assert.throws(() => new InstructionLedger('relative'), { code: 'INTENT_UNSAFE_PATH' });
    assert.throws(() => f.store.lookup({ ...a, threadId: '' }, 'x'), { code: 'INTENT_IDENTITY_INVALID' });
    assert.throws(() => f.store.reserve(a, { ...intent, requestId: '../bad' }), { code: 'INTENT_INVALID' });
    assert.deepEqual(await readdir(f.root), []);
    f.store.reserve(a, intent);
    f.store.markAttempt(a, 'request1');
    assert.throws(() => f.store.record(a, 'request1', { state: 'result', detail: null, result: 'x'.repeat(4097), truncated: false }), { code: 'INTENT_INVALID' });
});
test('fresh process refuses lost intent data instead of recreating an empty dedup ledger', async (t) => {
    const f = await fixture(t);
    f.store.reserve(a, intent);
    await rm(await f.file());
    const fresh = new InstructionLedger(f.dir);
    assert.throws(() => fresh.reserve(a, intent), { code: 'INTENT_STATE_MISSING' });
});
test('symlinked ancestor cannot redirect a private ledger', async (t) => {
    const f = await fixture(t);
    const { mkdir, symlink } = await import('node:fs/promises');
    await mkdir(join(f.root, 'real'), { mode: 0o700 });
    await symlink(join(f.root, 'real'), join(f.root, 'redirect'));
    const redirected = new InstructionLedger(join(f.root, 'redirect', 'intents'));
    assert.throws(() => redirected.reserve(a, intent), { code: 'INTENT_UNSAFE_PATH' });
});
test('killed real temp-filesystem writer leaves a non-stealable lock and unknown history', async (t) => {
    const f = await fixture(t);
    const { spawn } = await import('node:child_process');
    const code = `import{InstructionLedger}from ${JSON.stringify(new URL('./lib/fleet-codex-instruction-store.ts', import.meta.url).href)};import{writeSync}from'node:fs';const s=new InstructionLedger(${JSON.stringify(f.dir)},{checkpoint(stage){if(stage==='afterRename'){writeSync(1,'READY');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});s.reserve(${JSON.stringify(a)},${JSON.stringify(intent)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { child.kill('SIGKILL'); });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    let stderr = '';
    child.stderr.on('data', b => stderr += b);
    const ready = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.once('data', data => { try { assert.equal(String(data), 'READY'); resolve(); } catch (error) { reject(error); } });
    });
    await Promise.race([ready, exited.then(() => assert.fail('fixture exited before checkpoint: ' + stderr))]);
    child.kill('SIGKILL');
    await exited;
    const fresh = new InstructionLedger(f.dir);
    assert.equal(fresh.lookup(a, 'request1')?.state, 'unknown');
    assert.equal(fresh.lookup(a, 'request1')?.attempted, false);
    assert.throws(() => fresh.reserve(a, intent), { code: 'INTENT_BUSY' });
    assert.equal((await readdir(f.dir)).some(x => x.endsWith('.lock')), true);
});
test('pre-delivery not_sent is sticky against late unknown/ACK and cannot release an attempt', async t => {
    const f = await fixture(t);
    f.store.reserve(a, intent);
    f.store.record(a, 'request1', {state:'not_sent',detail:'NOT_ALLOWED',result:null,truncated:false});
    for (const state of ['unknown','submitted','queued'] as const) {
        const result = f.store.record(a, 'request1', {state,detail:'late',result:null,truncated:false});
        assert.equal(result.state, 'not_sent');
        assert.equal(result.attempted, false);
        assert.equal(result.detail, 'NOT_ALLOWED');
    }
    assert.throws(() => f.store.markAttempt(a, 'request1'), {code:'INTENT_ALREADY_ATTEMPTED'});
    const fresh = new InstructionLedger(f.dir);
    assert.equal(fresh.reserve(a, intent).created, false);
    assert.equal(fresh.lookup(a, 'request1')?.state, 'not_sent');
    assert.throws(() => fresh.markAttempt(a, 'request1'), {code:'INTENT_ALREADY_ATTEMPTED'});
});
