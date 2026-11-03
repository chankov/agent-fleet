import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { InstructionTransport } from './lib/fleet-codex-instruction-transport.ts';
import { instructionReceipt } from '../../harnesses/lib/coms-instruction-receipts.ts';
const target = { project: 'fixture', peer: 'receiver', sessionId: 'fake-session', startedAt: '2026-01-01T00:00:00.000Z' }, wire = 'd'.repeat(64);
async function fixture(t: any, mode = 'ack') {
    const root = await mkdtemp(join(tmpdir(), 's6at-'));
    await mkdir(join(root, 'sockets'));
    const endpoint = join(root, 'sockets', target.sessionId + '.sock'), events: string[] = [], sockets = new Set<any>();
    const server = createServer(s => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
        s.once('data', bytes => {
            const e = JSON.parse(bytes.toString());
            events.push(e.type);
            if (e.type === 'ping') {
                s.end(JSON.stringify({ type: 'pong', msg_id: e.msg_id, ...(mode === 'old' ? {} : { instruction: { version: 1, owner: mode === 'wrong' ? { ...target, sessionId: 'wrong' } : target } }) }) + '\n');
            }
            else if (e.type === 'prompt') {
                if (mode === 'drop') {
                    s.destroy();
                    return;
                }
                s.end(mode==='oversized-ack'?'x'.repeat(32769)+'\n':JSON.stringify({ type: 'ack', msg_id: mode==='wrong-wire'?'wrong':e.msg_id, instruction: { version: 1, owner: mode==='wrong-owner'?{...target,sessionId:'wrong'}:target, admission: 'submitted' } }) + '\n');
                if (mode === 'result') {
                    const r = createConnection(e.sender_endpoint);
                    r.on('error', () => { });
                    r.on('connect', () => r.end(JSON.stringify({ type: 'response', msg_id: wire, sender_session: target.sessionId, sender_endpoint: endpoint, instruction: { version: 1, owner: target, receipt: instructionReceipt(target, wire, 'actual done', null) } }) + '\n'));
                }
            }
            else if (e.type === 'instruction_receipt_request')
                s.end(JSON.stringify({ type: 'instruction_receipt_response', msg_id: e.msg_id, version: 1, owner: target, status: 'unknown', receipt: null }) + '\n');
        });
    });
    await new Promise<void>(r => server.listen(endpoint, r));
    t.after(async () => { for (const s of sockets)
        s.destroy(); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); });
    return { root, events, transport: new InstructionTransport({ registryRoot: root, timeoutMs: 80, resultWaitMs: 20 }) };
}
for (const mode of ['old', 'wrong'])
    test('S6a transport refuses ' + mode + ' capability before delivery', async (t) => { const f = await fixture(t, mode); let attempts = 0; const r = await f.transport.send(target, wire, 'fixture', { beforeWrite: async () => { attempts++; } }); assert.equal(r.state, 'not_sent'); assert.equal(attempts, 0); assert.deepEqual(f.events, ['ping']); });
test('S6a durable gate runs once before one prompt; submitted is not completion', async (t) => { const f = await fixture(t); const r = await f.transport.send(target, wire, 'fixture', { beforeWrite: async () => { f.events.push('durable'); } }); assert.equal(r.state, 'submitted'); assert.deepEqual(f.events, ['ping', 'durable', 'prompt']); assert.equal(r.result, null); });
test('S6a gate failure or pre-abort never writes a prompt', async (t) => { const f = await fixture(t); const r = await f.transport.send(target, wire, 'fixture', { beforeWrite: async () => { throw Error('PRIVATE'); } }); assert.equal(r.state, 'not_sent'); assert.equal(f.events.includes('prompt'), false); assert.equal(JSON.stringify(r).includes('PRIVATE'), false); const ac = new AbortController(); ac.abort(); assert.equal((await f.transport.send(target, wire, 'fixture', { beforeWrite: async () => assert.fail(), signal: ac.signal })).state, 'not_sent'); });
test('S6a dropped ACK after write remains unknown without retry', async (t) => { const f = await fixture(t, 'drop'); const r = await f.transport.send(target, wire, 'fixture', { beforeWrite: async () => { } }); assert.equal(r.state, 'unknown'); assert.equal(f.events.filter(e => e === 'prompt').length, 1); });
test('S6a correlated direct terminal result and exact read-only unknown lookup', async (t) => { const f = await fixture(t, 'result'); const r = await f.transport.send(target, wire, 'fixture', { beforeWrite: async () => { } }); assert.equal(r.state, 'result'); assert.equal(r.result, 'actual done'); assert.equal(await f.transport.receipt(target, wire), null); assert.equal(f.events.filter(e => e === 'prompt').length, 1); });
for(const mode of ['wrong-wire','wrong-owner','oversized-ack'])test('S6a '+mode+' is unknown after one write, never a retry',async t=>{const f=await fixture(t,mode);const r=await f.transport.send(target,wire,'fixture',{beforeWrite:async()=>{}});assert.equal(r.state,'unknown');assert.equal(f.events.filter(v=>v==='prompt').length,1);assert.equal(r.result,null);});
test('S6a timeout during guard cannot dispatch a late prompt',async t=>{const f=await fixture(t);let release!:()=>void;const gate=new Promise<void>(r=>release=r);const result=await f.transport.send(target,wire,'fixture',{beforeWrite:()=>gate});assert.equal(result.state,'not_sent');release();await new Promise(r=>setTimeout(r,10));assert.equal(f.events.includes('prompt'),false);});
test('S6a cancellation after ACK stops wait without pretending source cancellation or resend',async t=>{const f=await fixture(t),ac=new AbortController();const p=f.transport.send(target,wire,'fixture',{signal:ac.signal,beforeWrite:async()=>{setTimeout(()=>ac.abort(),5);}});const r=await p;assert.ok(['submitted','unknown'].includes(r.state));assert.equal(f.events.filter(v=>v==='prompt').length,1);assert.equal(r.result,null);});
