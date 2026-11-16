import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectionHistory} from './lib/codex-connection-history.ts';
const namespace={hostProfile:'desktop',principal:'test',threadId:'11111111-1111-4111-8111-111111111111'};
const owner={project:'pt2',peer:'hub',sessionId:'epoch',startedAt:'2026-11-15T00:00:00Z'};
test('private history survives reload, stays bounded and contains no authority',async t=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-history-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const h=new ConnectionHistory(root);
 for(let i=0;i<23;i++)await h.record({namespace,owner,attemptId:String(i),stage:'prepared',at:i});
 const snapshot=await new ConnectionHistory(root).read(namespace);assert.equal(snapshot.status,'available');assert.equal(snapshot.attempts.length,20);assert.equal(snapshot.attempts[0].attemptId,'3');assert.equal(snapshot.scope,'historical_only');
 for(let i=0;i<35;i++)await h.record({namespace,owner,attemptId:'22',stage:'waiting_ack',at:30+i,deadline:200});
 assert.equal((await h.read(namespace)).attempts.at(-1)!.transitions.length,32);
});
test('history rejects raw reasons and reports corruption without overwriting it',async t=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-history-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const h=new ConnectionHistory(root);
 await h.record({namespace,owner,attemptId:'one',stage:'failed',at:1,reason:'secret /private/path'});
 assert.equal((await h.read(namespace)).attempts[0].transitions[0].reason,'diagnostic_redacted');
 writeFileSync(h.path(namespace),'{broken',{mode:0o600});assert.equal((await h.read(namespace)).status,'unavailable');
 await h.record({namespace,owner,attemptId:'two',stage:'prepared',at:2});assert.equal((await h.read(namespace)).status,'unavailable');
});
