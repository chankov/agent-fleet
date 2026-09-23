import assert from 'node:assert/strict';
import test from 'node:test';
import { createNoProgressGuard, RECOVER_ENTRY } from './no-progress.ts';
import { parseRecoverArgs, runRecoverCommand } from './commands/recover.ts';
import { confirmRecoverAction } from './budget-recovery.ts';
import { renderNextInvocation, renderRecoverCommands } from './recover-policy.ts';
import { worktreeRevision } from './scope-gate.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ctx = (notices: string[]) => ({ui:{notify:(text:string) => notices.push(text)}}) as any;
const respond = (requestId: string, question: any) => ({ details:{runtimeAsk:{requestId},response:{kind:'selection',selections:[question.options[0]]}} });
test('both commands resolve the same settled attempt and one-use grant survives replay and task reset; no command executes', async () => {
 const entries: any[] = []; const guard = createNoProgressGuard((type,data) => entries.push({customType:type,data}));
 const ticket = guard.begin('contract','before','builder'); assert.equal(ticket.allowed,true);
 const failure = { dispatchId:'real-dispatch',reason:'lost delivery',category:'indeterminate' as const };
 guard.finish(ticket,'before',failure); guard.settle(ticket.operationId!,ticket.attemptId!,'runtime-exit:real-dispatch:1');
 const op = guard.byDispatch('real-dispatch')!; assert.equal(op.attempts[0].dispatchId,'real-dispatch');
 const parsed = parseRecoverArgs(`retry ${op.operationId} ${ticket.attemptId}`); assert.equal(parsed?.action,'retry');
 assert.equal(parseRecoverArgs(`retry ${op.operationId};bad ${ticket.attemptId}`),null);
 const notices: string[]=[]; let asks=0, runs=0;
 const approve=()=>confirmRecoverAction({taskId:guard.taskId(),operationId:op.operationId,attemptId:ticket.attemptId!,action:'retry',category:'indeterminate'},ctx(notices),{
 taskId:()=>guard.taskId(),language:()=> 'English',startWait:()=>{},endWait:()=>{},valid:()=>guard.canAuthorize(op.operationId,ticket.attemptId!),consume:(nonce)=>guard.authorizeIndeterminate(op.operationId,ticket.attemptId!,nonce),
 ask:async (id,q)=>{asks++; return respond(id,q);},
 });
 assert.equal(await approve(),true); assert.equal(await approve(),false); assert.equal(asks,1); assert.equal(runs,0);
 assert.match(notices.join(' '),/partial side effects.*duplicate/i);
 const restored=createNoProgressGuard(); restored.restore(entries); assert.equal(restored.inspect(op.operationId)?.indeterminateGrantUsed,true);
 restored.reset(); assert.equal(restored.canAuthorize(op.operationId,ticket.attemptId!),false);
 const next=restored.begin('contract','before','builder'); assert.equal(next.allowed,true);
 restored.finish(next,'before',{dispatchId:'successor',reason:'lost again',category:'indeterminate'});
 assert.equal(restored.canAuthorize(op.operationId,next.attemptId!),false);
 assert.ok(entries.every(row=>row.customType===RECOVER_ENTRY));
 guard.compact(entries);
 const compacted=createNoProgressGuard(); compacted.restore([entries.at(-1)]);
 assert.equal(compacted.inspect(op.operationId)?.indeterminateGrantUsed,true);
});

test('validated original invocation survives restoration and renders executable tool syntax; missing contracts never invent one',()=>{
 const rows:any[]=[]; const guard=createNoProgressGuard((type,data)=>rows.push({customType:type,data}));
 const ticket=guard.begin('contract','before','builder');
 const params={agent:'builder',task:'continue stage 2',scope:['src/file.ts'],deliverables:['src/file.ts']};
 assert.equal(guard.recordInvocation(ticket.operationId!,'contract',{tool:'dispatch_agent',params}),true);
 guard.finish(ticket,'before',{dispatchId:'failed-dispatch',reason:'failed',category:'indeterminate'});
 const restored=createNoProgressGuard(); restored.restore(rows);
 assert.equal(renderNextInvocation(restored,ticket.operationId!),`dispatch_agent(${JSON.stringify(params)})`);
 assert.match(renderRecoverCommands(restored,ticket.operationId!,ticket.attemptId!)!,/\/af-recover retry /);
 assert.equal(restored.recordInvocation(ticket.operationId!,'contract',{tool:'dispatch_agent',params}),false);
 assert.equal(renderNextInvocation(createNoProgressGuard(),ticket.operationId!),null);
});

test('successful successor clears restored guard failure instead of resurrecting the cancellation fence',()=>{
 const rows:any[]=[]; const guard=createNoProgressGuard((type,data)=>rows.push({customType:type,data}));
 const first=guard.begin('contract','before','builder'); guard.finish(first,'before',{dispatchId:'cancel-id',reason:'cancel',category:'operator_cancelled'});
 assert.equal(guard.authorize('cancel-id'),true);
 const second=guard.begin('contract','before','builder'); assert.equal(second.allowed,true); guard.finish(second,'after');
 const restored=createNoProgressGuard(); restored.restore(rows);
 assert.equal(restored.authorize('cancel-id'),false);
 assert.equal(restored.begin('contract','new revision','builder').allowed,true);
});

test('restoring corrupt history refuses replay and inspect remains detached',()=>{
 const rows:any[]=[]; const guard=createNoProgressGuard((type,data)=>rows.push({customType:type,data}));
 const ticket=guard.begin('contract','revision','builder'); guard.finish(ticket,'revision',{dispatchId:'physical-id',reason:'failure',category:'indeterminate'});
 const operation=guard.inspect(ticket.operationId!)!; operation.attempts[0].category='operator_cancelled';
 assert.equal(guard.inspect(ticket.operationId!)?.attempts[0].category,'indeterminate');
 assert.throws(()=>createNoProgressGuard().restore([...rows,{customType:RECOVER_ENTRY,data:{kind:'ledger',event:{type:'grant',operationId:ticket.operationId,attemptId:ticket.attemptId,nonce:'fake'}}}]));
});

test('stale, denied and simultaneous human asks do not consume a grant',async()=>{
 const notices:string[]=[]; let answer!: (value:unknown)=>void;
 const pending=new Promise(resolve=>{answer=resolve});
 const args={taskId:'task',operationId:'operation',attemptId:'attempt',action:'retry' as const,category:'indeterminate'};
 let consumed=0;
 const ports={taskId:()=> 'task',language:()=> 'English',startWait:()=>{},endWait:()=>{},valid:()=>true,consume:()=>{consumed++;return true},ask:async()=>pending};
 const first=confirmRecoverAction(args,ctx(notices),ports);
 assert.equal(await confirmRecoverAction(args,ctx(notices),ports),false);
 answer({details:{runtimeAsk:{requestId:'wrong'},response:{kind:'selection',selections:['Yes — authorize once']}}});
 assert.equal(await first,false); assert.equal(consumed,0);
});

function handlerDeps(guard: ReturnType<typeof createNoProgressGuard>, ask: RecoverAsk = approveAsk) {
 return {
  noProgress: guard,
  currentRevision: (cwd: string) => worktreeRevision(cwd, []),
  confirm: confirmRecoverAction,
  askPorts: (op: any, attempt: any, action: 'retry' | 'abandon') => ({
   taskId: () => guard.taskId(), language: () => 'English',
   ask, startWait: () => {}, endWait: () => {},
   valid: () => { const current = guard.inspect(op.operationId); return current?.attempts.at(-1)?.attemptId === attempt.attemptId && (action === 'abandon' ? !current.abandoned && guard.isIdle(op.executor) : guard.canAuthorize(op.operationId, attempt.attemptId)); },
   consume: (nonce: string) => action === 'abandon' ? guard.abandon(op.operationId, attempt.attemptId, nonce) : attempt.category === 'indeterminate' ? guard.authorizeIndeterminate(op.operationId, attempt.attemptId, nonce) : guard.authorize(attempt.dispatchId),
  }),
 };
}
type RecoverAsk = (id: string, q: any) => Promise<unknown>;
const approveAsk: RecoverAsk = async (id, q) => respond(id, q);
const denyAsk: RecoverAsk = async (id, q) => ({ details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:[q.options[1]]}} });

test('runRecoverCommand grant emits original-contract invocation once and refuses live pending duplicate decline', async () => {
 const guard = createNoProgressGuard();
 const ticket = guard.begin('contract','before','builder');
 const params={agent:'builder',task:'continue stage 2',scope:['src/file.ts']};
 assert.equal(guard.recordInvocation(ticket.operationId!,'contract',{tool:'dispatch_agent',params}),true);
 guard.finish(ticket,'before',{dispatchId:'real-dispatch',reason:'lost',category:'indeterminate'});
 const notices:string[]=[]; const ui=ctx(notices);
 await runRecoverCommand(`retry ${ticket.operationId} ${ticket.attemptId}`, ui, handlerDeps(guard));
 assert.match(notices.at(-1) ?? '', /Retry refused|Unknown, live or stale/);
 notices.length=0;
 await runRecoverCommand(`retry ${ticket.operationId} stale-attempt`, ui, handlerDeps(guard));
 assert.match(notices.at(-1) ?? '', /Unknown, live or stale/);
 notices.length=0;
 guard.settle(ticket.operationId!,ticket.attemptId!,'runtime-exit:real-dispatch:124');
 await runRecoverCommand(`retry ${ticket.operationId} ${ticket.attemptId}`, ui, handlerDeps(guard));
 const grant = notices.find(n => n.includes('One-use permission')) ?? '';
 assert.match(grant, /dispatch_agent\(/);
 assert.match(grant, /continue stage 2/);
 assert.doesNotMatch(grant, /Invoke the original dispatch contract/);
 assert.equal(guard.inspect(ticket.operationId!)?.indeterminateGrantUsed, true);
 notices.length=0;
 await runRecoverCommand(`retry ${ticket.operationId} ${ticket.attemptId}`, ui, handlerDeps(guard));
 assert.match(notices.join(' '), /Retry refused|Human approval denied/);
 notices.length=0;
 await runRecoverCommand(`retry ${ticket.operationId} ${ticket.attemptId}`, ui, handlerDeps(guard, denyAsk));
 assert.match(notices.join(' '), /Retry refused|Human approval denied/);
});

test('runRecoverCommand reconcile uses independent current-revision evidence and rejects self/stale', async t => {
 const cwd = mkdtempSync(join(tmpdir(),'af-recover-cmd-')); t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 execFileSync('git',['init','-q',cwd]);
 const path=join(cwd,'partial.ts'); writeFileSync(path,'partial result');
 const revision=worktreeRevision(cwd,[]), sha256=createHash('sha256').update('partial result').digest('hex');
 const guard=createNoProgressGuard();
 const failed=guard.begin('contract','before','builder');
 guard.finish(failed,'before',{dispatchId:'failed-original',reason:'lost',category:'verification_failed'});
 const original={dispatchId:'failed-original',taskId:guard.taskId(),executor:'builder',revision,changedScope:['partial.ts'],readback:[{path,status:'read' as const,changed:true,sha256,retainedPath:'evidence/original-readback'}],concurrentWriters:false,completed:false,blockingFindings:0,coveredScope:[],edited:false,evidenceRef:'evidence/failed',openRequirements:['AF-MIN-CHANGE','review','plan']};
 assert.equal(guard.recordDispatchEvidence(original),true);
 const review={...original,dispatchId:'independent-review',executor:'reviewer',changedScope:[],readback:[],completed:true,coveredScope:['partial.ts'],evidenceRef:'evidence/independent-review',openRequirements:[],edited:false};
 const notices:string[]=[]; const ui={...ctx(notices),cwd};
 await runRecoverCommand(`reconcile ${failed.operationId} ${failed.attemptId}`, ui, handlerDeps(guard));
 assert.match(notices.at(-1) ?? '', /"cleared":false/);
 assert.equal(guard.recordDispatchEvidence({...review,dispatchId:'self-review',executor:'builder'}),true);
 notices.length=0;
 await runRecoverCommand(`reconcile ${failed.operationId} ${failed.attemptId}`, ui, handlerDeps(guard));
 assert.match(notices.at(-1) ?? '', /"cleared":false/);
 assert.equal(guard.recordDispatchEvidence(review),true);
 const staleDeps={...handlerDeps(guard), currentRevision: () => 'stale'};
 notices.length=0;
 await runRecoverCommand(`reconcile ${failed.operationId} ${failed.attemptId}`, ui, staleDeps);
 assert.match(notices.at(-1) ?? '', /"cleared":false/);
 notices.length=0;
 await runRecoverCommand(`reconcile ${failed.operationId} ${failed.attemptId}`, ui, handlerDeps(guard));
 const body=JSON.parse(notices.at(-1)!);
 assert.equal(body.cleared,true);
 assert.equal(body.acceptance,'not_accepted');
 assert.equal(body.execution,'failed');
 assert.deepEqual(body.openRequirements,['AF-MIN-CHANGE','review','plan']);
 assert.match(body.nextCommands, /\/af-recover /);
});
