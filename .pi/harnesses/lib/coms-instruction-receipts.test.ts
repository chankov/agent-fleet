import test from 'node:test';
import assert from 'node:assert/strict';
import { instructionReceipt, handleInstructionReceipt, validateInstructionTag } from './coms-instruction-receipts.ts';
const owner = { project: 'fixture', peer: 'receiver', sessionId: 'session1', startedAt: '2026-01-01T00:00:00.000Z' }, wire = 'a'.repeat(64);
const request = { type: 'instruction_receipt_request', msg_id: 'query1', version: 1, owner, wireId: wire, sender_session: 'fixture', sender_endpoint: '' };
function fixture() { const entries = new Map<string, any>(); let leaf: string | null = null; return { manager: { getLeafId: () => leaf, getEntry: (id: string) => entries.get(id) }, push(data: any) { const id = String(entries.size); entries.set(id, { id, parentId: leaf, type: 'custom', customType: 'coms-instruction-receipt', data }); leaf = id; } }; }
test('S6a tagged exact owner/version/payload is required; every owner dimension refuses', () => {
    assert.equal(validateInstructionTag({ instruction: { version: 1, owner }, msg_id: wire, prompt: 'hello' }, owner), true);
    for (const changed of [{}, { version: 2, owner }, { version: 1, owner: { ...owner, peer: 'other' } }, { version: 1, owner: { ...owner, project: 'other' } }, { version: 1, owner: { ...owner, sessionId: 'other' } }, { version: 1, owner: { ...owner, startedAt: '2026-01-02T00:00:00Z' } }])
        assert.throws(() => validateInstructionTag({ instruction: changed, msg_id: wire, prompt: 'hello' }, owner));
    assert.equal(validateInstructionTag({ prompt: 'legacy' }, owner), false);
    assert.throws(() => validateInstructionTag({ instruction: { version: 1, owner }, msg_id: wire, prompt: 'x'.repeat(16385) }, owner));
});
test('S6a terminal projection is actual bounded redacted plain text, no objects/tools/private key', () => {
    const r = instructionReceipt(owner, wire, 'token=SECRET ' + '😀'.repeat(5000), null);
    assert.ok(Buffer.byteLength(r.text!) <= 4096);
    assert.equal(r.text!.includes('SECRET'), false);
    assert.equal(r.truncated, true);
    assert.equal(instructionReceipt(owner, wire, { thinking: 'PRIVATE' }, null).text, null);
    assert.equal(instructionReceipt(owner, wire, '-----BEGIN PRIVATE KEY-----\nSECRET', null).text, '[REDACTED]');
    assert.equal(instructionReceipt(owner, wire, null, 'private provider details').text, null);
    assert.equal(instructionReceipt(owner, wire, null, 'private provider details').state, 'failed');
});
test('S6a exact-wire history only; unknown never guesses nearby assistant text', () => {
    const f = fixture();
    const r = instructionReceipt(owner, wire, 'done', null);
    f.push(r);
    let out: any;
    assert.equal(handleInstructionReceipt(request, { write: s => out = JSON.parse(s) }, () => owner, f.manager), true);
    assert.equal(out.receipt.text, 'done');
    handleInstructionReceipt({ ...request, wireId: 'b'.repeat(64) }, { write: s => out = JSON.parse(s) }, () => owner, f.manager);
    assert.equal(out.status, 'unknown');
    assert.equal(out.receipt, null);
});
test('S6a owner/invalid/unsupported/window/cycle/missing evidence stays unavailable', () => {
    const f = fixture();
    let out: any;
    const sink = { write: (s: string) => out = JSON.parse(s) };
    for (const q of [{ ...request, owner: { ...owner, sessionId: 'wrong' } }, { ...request, rawTranscript: true }, { ...request, version: 2 }]) {
        handleInstructionReceipt(q, sink, () => owner, f.manager);
        assert.notEqual(out.status, 'available');
        assert.equal(out.receipt, null);
    }
    f.push(instructionReceipt(owner, wire, 'old', null));
    for (let i = 0; i < 256; i++)
        f.push({ noise: i });
    handleInstructionReceipt(request, sink, () => owner, f.manager);
    assert.equal(out.status, 'unknown');
    handleInstructionReceipt(request, sink, () => owner, { getLeafId: () => null });
    assert.equal(out.status, 'unknown');
    handleInstructionReceipt(request, sink, () => owner, { getLeafId: () => 'cycle', getEntry: () => ({ id: 'cycle', parentId: 'cycle' }) });
    assert.equal(out.status, 'unknown');
});
test('S6a owner change during lookup withholds a found receipt', () => {
    const f = fixture();
    f.push(instructionReceipt(owner, wire, 'PRIVATE', null));
    let calls = 0, out: any;
    handleInstructionReceipt(request, { write: s => out = JSON.parse(s) }, () => ++calls === 1 ? owner : { ...owner, sessionId: 'new' }, f.manager);
    assert.equal(out.status, 'stale');
    assert.equal(out.receipt, null);
});
test('S6a branch movement or corrupted exact-wire evidence withholds history',()=>{
 const f=fixture();f.push(instructionReceipt(owner,wire,'PRIVATE',null));let out:any,reads=0;handleInstructionReceipt(request,{write:s=>out=JSON.parse(s)},()=>owner,{getLeafId:()=>++reads===1?'0':'new-branch',getEntry:f.manager.getEntry});assert.equal(out.status,'unknown');assert.equal(out.receipt,null);
 f.push({...instructionReceipt(owner,wire,'PRIVATE',null),text:'x'.repeat(4097)});handleInstructionReceipt(request,{write:s=>out=JSON.parse(s)},()=>owner,f.manager);assert.equal(out.status,'unknown');assert.equal(out.receipt,null);
});
