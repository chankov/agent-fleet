import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstructionBridge } from './lib/fleet-codex-instructions.ts';
import { AllowedSessionsStore } from './lib/fleet-codex-allowlist-store.ts';
const c = { hostProfile: 'fixture', principal: 'owner', threadId: '11111111-1111-4111-8111-111111111111' }, target = { project: 'fixture', peer: 'receiver', sessionId: 'session1', startedAt: '2026-01-01T00:00:00.000Z' }, args = { requestId: 'request1', target, instruction: 'fixture instruction' };
async function fixture(t: any) {
    const root = await mkdtemp(join(tmpdir(), 's6ai-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let sends = 0, reads = 0, mono = 0, before: (() => Promise<void>) | undefined, after: (() => Promise<void>) | undefined;
    const store = new AllowedSessionsStore(join(root, 'policy'), c);
    await store.initialize();
    const h = await store.enroll({ alias: 'fixture', target }, [target]);
    await store.grantSend(h, [target]);
    const options = { policyRoot: join(root, 'policy'), registryReader: async () => ({ status: 'complete' as const, partial: false, reasons: [], observedAt: target.startedAt, entriesSeen: 1, candidates: [{ target, heartbeatAt: target.startedAt, presence: 'fresh' as const }] }), now: () => Date.parse(target.startedAt), monotonic: () => mono, transport: { capability: async () => true, send: async (_t: any, _w: any, _s: any, o: any) => { sends++; await before?.(); await o.beforeWrite(); await after?.(); return { state: 'submitted' as const, detail: null, result: null, truncated: false }; }, receipt: async () => { reads++; return null; } } };
    const bridge = new InstructionBridge(options);
    return { root, bridge, options, store, sends: () => sends, reads: () => reads, advance: (n: number) => mono += n, before: (f: () => Promise<void>) => before = f, after: (f: () => Promise<void>) => after = f };
}
test('S6a sender exact preview/commit and duplicate history survives revoke and restart without delivery', async (t) => { const f = await fixture(t), p = await f.bridge.prepare(c, args); assert.equal(p.status, 'prepared'); assert.equal(p.instruction, args.instruction); const first = await f.bridge.commit(c, p.proposalId as string); assert.equal((first.receipt as any).state, 'submitted'); const state = await f.store.open(); await f.store.revoke('fixture', state.revision); const again = await new InstructionBridge(f.options).prepare(c, args); assert.equal(again.status, 'historical'); assert.equal(f.sends(), 1); assert.equal((again.receipt as any).wireId, (first.receipt as any).wireId); });
test('S6a request payload/epoch conflict is before transport, different chat cannot read or commit', async (t) => { const f = await fixture(t), p = await f.bridge.prepare(c, args); await f.bridge.commit(c, p.proposalId as string); for (const a of [{ ...args, instruction: 'different' }, { ...args, target: { ...target, sessionId: 'other' } }])
    await assert.rejects(() => f.bridge.prepare(c, a), { code: 'INTENT_CONFLICT' }); const b = { ...c, threadId: '22222222-2222-4222-8222-222222222222' }; await assert.rejects(() => f.bridge.commit(b, p.proposalId as string), { code: 'PROPOSAL_UNAVAILABLE' }); await assert.rejects(() => f.bridge.receipt(b, { requestId: args.requestId }), { code: 'INTENT_UNAVAILABLE' }); assert.equal(f.sends(), 1); });
test('S6a fresh revision and permission before write refuse revoke/regrant without another attempt', async (t) => { const f = await fixture(t), p = await f.bridge.prepare(c, args); f.before(async () => { const s = await f.store.open(); await f.store.revokeSend('fixture', s.revision); }); await assert.rejects(() => f.bridge.commit(c, p.proposalId as string)); const r = await f.bridge.receipt(c, { requestId: args.requestId }); assert.equal((r.receipt as any).attempted, false); assert.equal((await f.bridge.prepare(c, args)).status, 'historical'); assert.equal(f.sends(), 1); });
test('S6a expiry/restart and invalid whole input refuse before effects', async (t) => { const f = await fixture(t), p = await f.bridge.prepare(c, args); f.advance(300001); await assert.rejects(() => f.bridge.commit(c, p.proposalId as string), { code: 'PROPOSAL_UNAVAILABLE' }); await assert.rejects(() => new InstructionBridge(f.options).commit(c, p.proposalId as string), { code: 'PROPOSAL_UNAVAILABLE' }); await assert.rejects(() => f.bridge.prepare(c, { ...args, policyRoot: 'bad' }), { code: 'INVALID_ARGUMENTS' }); assert.equal(f.sends(), 0); });
test('S6a remote recovery requires current read, local history does not contact peer after revoke', async (t) => { const f = await fixture(t), p = await f.bridge.prepare(c, args); await f.bridge.commit(c, p.proposalId as string); const s = await f.store.open(); await f.store.revoke('fixture', s.revision); await f.bridge.receipt(c, { requestId: args.requestId }); await assert.rejects(() => f.bridge.receipt(c, { requestId: args.requestId, refresh: true })); assert.equal(f.reads(), 0); assert.equal(f.sends(), 1); });
test('S6a permission revoked during terminal arrival withholds source text from response and ledger', async (t) => {
    const f = await fixture(t);
    f.after(async () => { const s = await f.store.open(); await f.store.revoke('fixture', s.revision); });
    const bridge = new InstructionBridge({ ...f.options, transport: { ...f.options.transport, send: async (target, wire, text, o) => { await f.options.transport.send(target, wire, text, o); return { state: 'result', detail: null, result: 'PRIVATE_UNAUTHORIZED_TEXT', truncated: false }; } } });
    const p = await bridge.prepare(c, args), result = await bridge.commit(c, p.proposalId as string);
    assert.equal((result.receipt as any).state, 'unknown');
    assert.equal(JSON.stringify(result).includes('PRIVATE_UNAUTHORIZED_TEXT'), false);
    assert.equal(JSON.stringify(await bridge.receipt(c, { requestId: args.requestId })).includes('PRIVATE_UNAUTHORIZED_TEXT'), false);
    assert.equal((await bridge.prepare(c, args)).status, 'historical');
    assert.equal(f.sends(), 1);
});
