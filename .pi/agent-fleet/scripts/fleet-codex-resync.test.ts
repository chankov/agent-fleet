import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObservationBridge } from './lib/fleet-codex-observe.ts';
import { ObservationStore } from './lib/fleet-codex-observation-store.ts';
import { ResyncBridge } from './lib/fleet-codex-resync.ts';
import type { TargetEpoch } from './lib/fleet-codex-allowlist.ts';
const a = { hostProfile: 'fixture', principal: 'owner', threadId: '11111111-1111-4111-8111-111111111111' }, b = { ...a, threadId: '22222222-2222-4222-8222-222222222222' };
const target = { project: 'fixture', peer: 'orchestrator', sessionId: 'session1', startedAt: '2026-01-01T00:00:00.000Z' }, q = { project: target.project, peer: target.peer }, args = { targets: [q] };
const hash = (n: number) => n.toString(16).padStart(64, '0');
const event = (n: number) => ({ id: hash(100 + n), at: target.startedAt, kind: 'assistant', text: 'event' + n });
function source() { return { target, observedAt: target.startedAt, transcript: { status: 'available', partial: false, reasons: [], entries: [event(1), event(2)], window: { leaf: hash(2), ancestry: [hash(2), hash(1)], rootReached: true } }, questionState: { status: 'available', partial: false, reasons: [], questions: [] as unknown[], resolved: [], nextCursor: null } }; }
async function fixture(t: {
    after: (fn: () => Promise<void>) => void;
}) {
    const root = await mkdtemp(join(tmpdir(), 's5c-resync-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let raw = source(), denied = false, authCalls = 0, reads = 0, clock = 0, session = 'session1';
    let reader: ((t: TargetEpoch) => Promise<unknown>) | null = null, sleeper: ((ms: number, signal?: AbortSignal) => Promise<void>) | null = null;
    const authorization = { async checkAllowedReadTarget(_c: unknown, selectors: unknown) { authCalls++; if (denied)
            throw Object.assign(Error('NOT_ALLOWED'), { code: 'NOT_ALLOWED' }); const s = selectors as {
            project: string;
            peer: string;
        }; return { target: { ...target, project: s.project, peer: s.peer, sessionId: session } }; } };
    const observer = new ObservationBridge({ authorization, now: () => Date.parse(target.startedAt), reader: async (t) => { reads++; return reader ? reader(t) : structuredClone({ ...raw, target: t }); } }), store = new ObservationStore(join(root, 'state'));
    const options = { observer, authorization, store, clock: () => clock, sleep: async (ms: number, signal?: AbortSignal) => { if (sleeper)
            await sleeper(ms, signal); clock += ms; } };
    return { root, store, options, service: new ResyncBridge(options), raw: () => raw, setRaw: (v: ReturnType<typeof source>) => { raw = v; }, deny: () => { denied = true; }, epoch: (v: string) => { session = v; }, counts: () => ({ authCalls, reads }), reader: (fn: (t: TargetEpoch) => Promise<unknown>) => { reader = fn; }, sleep: (fn: (ms: number, s?: AbortSignal) => Promise<void>) => { sleeper = fn; } };
}
const first = (r: any) => r.results[0];
test('resync initial/append/unchanged cursors survive store and bridge reopening', async (t) => {
    const f = await fixture(t);
    let r = first(await f.service.resync(a, args));
    assert.equal(r.status, 'observed');
    assert.equal(r.cursor.status, 'initial');
    assert.deepEqual(r.events.map((e: any) => e.text), ['event1', 'event2']);
    const raw = f.raw();
    raw.transcript.entries.push(event(3));
    raw.transcript.window = { leaf: hash(3), ancestry: [hash(3), hash(2), hash(1)], rootReached: true };
    r = first(await f.service.resync(a, args));
    assert.equal(r.cursor.status, 'advanced');
    assert.deepEqual(r.events.map((e: any) => e.text), ['event3']);
    const reopened = new ResyncBridge({ ...f.options, store: new ObservationStore(join(f.root, 'state')) });
    r = first(await reopened.resync(a, args));
    assert.equal(r.cursor.status, 'unchanged');
    assert.deepEqual(r.events, []);
    assert.equal(r.observationOnly, true);
});
test('resync branch replacement and unreachable event anchors are explicit gaps', async (t) => {
    const f = await fixture(t);
    await f.service.resync(a, args);
    f.raw().transcript.window = { leaf: hash(4), ancestry: [hash(4), hash(1)], rootReached: true };
    f.raw().transcript.entries = [event(1), event(4)];
    let r = first(await f.service.resync(a, args));
    assert.equal(r.cursor.status, 'gap');
    assert.equal(r.cursor.reason, 'ANCHOR_UNREACHABLE');
    f.raw().transcript.window = { leaf: hash(5), ancestry: [hash(5), hash(4), hash(1)], rootReached: true };
    f.raw().transcript.entries = [event(5)];
    r = first(await f.service.resync(a, args));
    assert.equal(r.cursor.status, 'gap');
    assert.equal(r.cursor.reason, 'EVENT_WINDOW_GAP');
});
test('resync legacy metadata absence is unsupported, not invented continuity', async (t) => {
    const f = await fixture(t);
    const raw = f.raw() as any;
    delete raw.transcript.window;
    for (const e of raw.transcript.entries)
        delete e.id;
    const r = first(await f.service.resync(a, args));
    assert.equal(r.cursor.status, 'unsupported');
    assert.equal(r.gap, true);
    assert.equal(f.store.read(a, target).cursor?.lastEvent ?? null, null);
});
test('resync malformed metadata withholds transcript but preserves independent question state', async (t) => {
    const f = await fixture(t);
    await f.service.resync(a, args);
    const old = f.store.read(a, target).cursor!;
    (f.raw().transcript.window as any).ancestry = ['INVALID'];
    const r = first(await f.service.resync(a, args));
    assert.equal(r.transcript.status, 'unavailable');
    assert.equal(r.questions.status, 'available');
    assert.deepEqual(r.events, []);
    assert.equal(f.store.read(a, target).cursor!.lastEvent, old.lastEvent);
});
test('resync pending questions remain visible when seen and after restart; not delivery/answer', async (t) => {
    const f = await fixture(t);
    f.raw().questionState.questions = [{ id: 'question1', owner: target, toolCallId: 'opaque|call', question: 'Visible?', state: 'pending', createdAt: target.startedAt, expiresAt: null, options: [], allowMultiple: false, allowFreeform: true, allowComment: false }];
    let r = first(await f.service.resync(a, args));
    assert.deepEqual(r.questions.newQuestionIds, ['question1']);
    assert.equal(r.questions.pending.length, 1);
    r = first(await new ResyncBridge({ ...f.options, store: new ObservationStore(join(f.root, 'state')) }).resync(a, args));
    assert.deepEqual(r.questions.newQuestionIds, []);
    assert.equal(r.questions.pending.length, 1);
    assert.equal(r.questions.pendingCount, 1);
    assert.equal(r.questions.delivery, 'not_established');
});
test('resync cross-context/target and epoch resets never inherit another cursor', async (t) => {
    const f = await fixture(t);
    await f.service.resync(a, args);
    assert.equal(first(await f.service.resync(b, args)).cursor.status, 'initial');
    assert.equal(first(await f.service.resync(a, { targets: [{ ...q, project: 'other' }] })).cursor.status, 'initial');
    f.epoch('session2');
    const r = first(await f.service.resync(a, args));
    assert.equal(r.reset, 'epoch_changed');
    assert.equal(r.cursor.status, 'initial');
});
test('resync post-read denial releases no data and does not advance cursor', async (t) => {
    const f = await fixture(t);
    f.reader(async (selected) => { f.deny(); return { ...f.raw(), target: selected }; });
    const r = first(await f.service.resync(a, args));
    assert.equal(r.status, 'error');
    assert.equal(r.code, 'NOT_ALLOWED');
    assert.equal(r.dataReleased, false);
    assert.equal(f.store.read(a, target).cursor, null);
    assert.deepEqual(await readdir(f.root), []);
});
test('resync validates all selectors before authorization/I/O and forbids duplicate/extra input', async (t) => {
    const f = await fixture(t);
    for (const bad of [{ targets: [] }, { targets: [q, q] }, { targets: [q, { project: 'bad/path', peer: 'x' }] }, { targets: [q], threadId: a.threadId }, { targets: Array(5).fill(q) }])
        await assert.rejects(() => f.service.resync(a, bad), { code: 'INVALID_ARGUMENTS' });
    assert.deepEqual(f.counts(), { authCalls: 0, reads: 0 });
    assert.deepEqual(await readdir(f.root), []);
});
test('resync output cap and event truncation are explicit, source data stays bounded', async (t) => {
    const f = await fixture(t);
    f.raw().transcript.entries = Array.from({ length: 40 }, (_, i) => ({ ...event(i), text: '界'.repeat(1000) }));
    const r = first(await f.service.resync(a, args));
    assert.equal(r.gap, true);
    assert.equal(r.cursor.reason, 'OUTPUT_LIMIT');
    assert.ok(r.events.length <= 12);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 16384);
    assert.equal(r.completion, 'not_established');
});
test('resync target-local errors do not discard other authorized targets', async (t) => {
    const f = await fixture(t);
    const original = f.options.authorization.checkAllowedReadTarget;
    f.options.authorization.checkAllowedReadTarget = async (c, s) => { if ((s as any).project === 'denied')
        throw Object.assign(Error('NOT_ALLOWED'), { code: 'NOT_ALLOWED' }); return original(c, s); };
    const r = await f.service.resync(a, { targets: [{ ...q, project: 'denied' }, q] });
    assert.equal(r.results[0].status, 'error');
    assert.equal(r.results[1].status, 'observed');
    assert.equal(r.partial, true);
    assert.equal(r.nonAtomic, true);
});
test('watch bounded cadence terminates without background work or model calls', async (t) => {
    const f = await fixture(t), r = await f.service.watch(a, { ...args, durationSeconds: 5 });
    assert.equal(r.frames.length, 3);
    assert.equal(f.counts().reads, 3);
    assert.equal(r.idleWake, false);
    assert.equal(r.reason, 'duration');
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 98304);
});
test('watch invalid duration and extra fields refuse before I/O', async (t) => {
    const f = await fixture(t);
    for (const durationSeconds of [0, 11, 1.5, '2'])
        await assert.rejects(() => f.service.watch(a, { ...args, durationSeconds }), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(() => f.service.watch(a, { ...args, durationSeconds: 1, root: '/fake' }), { code: 'INVALID_ARGUMENTS' });
    assert.equal(f.counts().reads, 0);
});
test('watch cancellation during sleep discards frames, stops observer only', async (t) => {
    const f = await fixture(t), controller = new AbortController();
    f.sleep(async () => { controller.abort(); });
    await assert.rejects(() => f.service.watch(a, { ...args, durationSeconds: 5 }, controller.signal), { code: 'REQUEST_CANCELLED' });
    assert.equal(f.counts().reads, 1);
});
test('watch in-flight cancellation publishes nothing and never starts queued targets', async (t) => {
    const f = await fixture(t), controller = new AbortController();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => release = r), start = new Promise<void>(r => started = r);
    let active = 0, max = 0;
    f.reader(async (selected) => { active++; max = Math.max(max, active); if (active === 2)
        started(); await gate; active--; return { ...f.raw(), target: selected }; });
    const pending = f.service.watch(a, { targets: [q, { ...q, project: 'second' }, { ...q, project: 'third' }], durationSeconds: 5 }, controller.signal);
    await start;
    controller.abort();
    release();
    await assert.rejects(() => pending, { code: 'REQUEST_CANCELLED' });
    assert.equal(f.counts().reads, 2);
    assert.equal(max, 2);
});
test('watch max frames bounds a stalled injected clock and persists no daemon', async (t) => {
    const f = await fixture(t), service = new ResyncBridge({ ...f.options, clock: () => 0, sleep: async () => { } });
    const r = await service.watch(a, { ...args, durationSeconds: 10 });
    assert.ok(r.frames.length <= 6);
    assert.equal(r.reason, 'frame_limit');
});
test('resync two healthy concurrent targets commit independent cursors without local lock collision', async (t) => {
    const f = await fixture(t), r = await f.service.resync(a, { targets: [q, { ...q, project: 'other' }] });
    assert.deepEqual(r.results.map(x => x.status), ['observed', 'observed']);
    assert.equal(f.store.read(a, target).cursor!.revision, 1);
    assert.equal(f.store.read(a, { ...target, project: 'other' }).cursor!.revision, 1);
});
test('resync late post-commit denial withholds data without claiming metadata rollback', async (t) => {
    const f = await fixture(t), original = f.options.authorization.checkAllowedReadTarget;
    let calls = 0;
    f.options.authorization.checkAllowedReadTarget = async (c, s) => { if (++calls === 5)
        throw Object.assign(Error('NOT_ALLOWED'), { code: 'NOT_ALLOWED' }); return original(c, s); };
    const r = first(await f.service.resync(a, args));
    assert.equal(r.code, 'NOT_ALLOWED');
    assert.equal(r.dataReleased, false);
    assert.equal(f.store.read(a, target).cursor!.revision, 1);
});
test('watch output budget stops before starting another sample or committing hidden frame', async (t) => {
    const f = await fixture(t);
    f.raw().transcript.entries = Array.from({ length: 40 }, (_, i) => ({ ...event(i), text: '界'.repeat(1000) }));
    const r = await f.service.watch(a, { targets: [q, { ...q, project: 'two' }, { ...q, project: 'three' }, { ...q, project: 'four' }], durationSeconds: 10 });
    assert.equal(r.reason, 'output_budget');
    assert.equal(r.frames.length, 1);
    assert.equal(f.counts().reads, 4);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 98304);
});
test('resync partial question coverage stays an explicit question gap with unknown count', async (t) => {
    const f = await fixture(t);
    (f.raw().questionState as any).nextCursor = 'next-page';
    const r = first(await f.service.resync(a, args));
    assert.equal(r.questions.pendingCount, null);
    assert.equal(r.questions.partial, true);
    assert.equal(r.questions.gap, true);
    assert.equal(r.partial, true);
});
test('watch stops on uncertain cursor commit without automatic retry or hiding the error', async (t) => {
    const f = await fixture(t);
    let writes = 0;
    const store = new ObservationStore(join(f.root, 'uncertain'), { checkpoint(stage) { if (stage === 'afterRename') {
            writes++;
            throw Error('PRIVATE');
        } } });
    const r = await new ResyncBridge({ ...f.options, store }).watch(a, { ...args, durationSeconds: 10 });
    assert.equal(r.reason, 'cursor_error');
    assert.equal(r.frames.length, 1);
    assert.equal(writes, 1);
    assert.equal(first(r.frames[0]).code, 'CURSOR_COMMIT_UNCERTAIN');
});

test('resync preserves bounded resolved question observations without inventing an answer',async t=>{
 const f=await fixture(t);(f.raw().questionState as any).resolved=[{id:'question1',state:'answered',requestId:'known-wire'}];const r=first(await f.service.resync(a,args));
 assert.deepEqual(r.questions.resolved,[{id:'question1',state:'answered',requestId:'known-wire'}]);assert.equal(r.questions.delivery,'not_established');assert.equal(JSON.stringify(r).includes('answerText'),false);
});
