import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoverState } from './recover-state.ts';
import { reconcileTechnical } from './reconcile.ts';
import { createNoProgressGuard } from './no-progress.ts';
import { revisionOf, revisionScopes, worktreeRevision } from './scope-gate.js';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('independent current-revision partial review clears technical block, not acceptance or immutable failed execution', () => {
 const state = createRecoverState();
 const {operationId,attemptId} = state.start('task','contract','builder','dispatch')!;
 state.fail(operationId, attemptId, 'indeterminate');
 const input = { taskId:'task', operationId,attemptId, originalExecutor:'builder', currentRevision:'rev2', observedRevision:'rev2', changedScope:['/repo/partial.ts'],readback:[{path:'/repo/partial.ts',status:'read' as const,changed:true,retainedPath:'evidence/readback'}],concurrentWriters:false, reviewer:{taskId:'task',executor:'code-reviewer',revision:'rev2',completed:true,blockingFindings:0,coveredScope:['/repo/partial.ts'],edited:false,evidenceRef:'evidence/review'},openRequirements:['AF-MIN-CHANGE','A1'] };
 const result = reconcileTechnical(state,input);
 assert.equal(result.cleared,true);
 assert.equal(result.acceptance,'not_accepted');
 assert.deepEqual(result.openRequirements,['AF-MIN-CHANGE','A1']);
 assert.equal(state.inspect(operationId)!.attempts[0].category,'indeterminate');
 assert.equal(state.inspect(operationId)!.technical?.status,'cleared');
 assert.equal(reconcileTechnical(state,input).cleared,false, 'duplicate assessment refused');
});

test('production reconcile adapter retains failed delivery and open requirements after independent current review; stale, self and unsupported evidence refuse', t => {
 const cwd = mkdtempSync(join(tmpdir(),'af-reconcile-')); t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 execFileSync('git',['init','-q',cwd]);
 const path=join(cwd,'partial.ts'); writeFileSync(path,'partial result');
 const revision=worktreeRevision(cwd,[]), sha256=createHash('sha256').update('partial result').digest('hex');
 const rows:any[]=[]; const guard=createNoProgressGuard((type,data)=>rows.push({customType:type,data}));
 const failed=guard.begin('contract','before','builder'); guard.finish(failed,'before',{dispatchId:'failed-original',reason:'lost delivery',category:'verification_failed'});
 const original={dispatchId:'failed-original',taskId:guard.taskId(),executor:'builder',revision,changedScope:['partial.ts'],readback:[{path,status:'read' as const,changed:true,sha256,retainedPath:'evidence/original-readback'}],concurrentWriters:false,completed:false,blockingFindings:0,coveredScope:[],edited:false,evidenceRef:'evidence/failed',openRequirements:['AF-MIN-CHANGE','A3','review','plan']};
 assert.equal(guard.recordDispatchEvidence(original),true);
 const review={...original,dispatchId:'independent-review',executor:'reviewer',changedScope:[],readback:[],completed:true,coveredScope:['partial.ts'],evidenceRef:'evidence/independent-review',openRequirements:[],edited:false};
 const roots={cwd,sessionDir:cwd};
 assert.equal(guard.reconcile(failed.operationId!,failed.attemptId!,revision,roots).cleared,false);
 assert.equal(guard.recordDispatchEvidence({...review,dispatchId:'self-review',executor:'builder'}),true);
 assert.equal(guard.reconcile(failed.operationId!,failed.attemptId!,revision,roots).cleared,false);
 assert.equal(guard.recordDispatchEvidence(review),true);
 assert.equal(guard.reconcile(failed.operationId!,failed.attemptId!,'stale',roots).cleared,false);
 writeFileSync(path,'changed again'); assert.equal(guard.reconcile(failed.operationId!,failed.attemptId!,revision,roots).cleared,false);
 writeFileSync(path,'partial result');
 const result=guard.reconcile(failed.operationId!,failed.attemptId!,revision,roots);
 assert.equal(result.cleared,true); if (!result.cleared) return;
 assert.equal(result.acceptance,'not_accepted'); assert.equal(result.execution,'failed');
 assert.deepEqual(result.openRequirements,['AF-MIN-CHANGE','A3','review','plan']);
 assert.equal(guard.inspect(failed.operationId!)?.attempts[0].category,'verification_failed');
 const restored=createNoProgressGuard(); restored.restore(rows);
 assert.equal(restored.inspect(failed.operationId!)?.technical?.status,'cleared');
 assert.equal(restored.begin('contract','before','builder',[],revision).allowed,true,'technical clearance allows explicit continuation without acceptance');
});

// D8 (2026-11-12): in a plain folder of nested repositories the root has no revision,
// so recovery compares over the basis the original dispatch recorded.
test('production reconcile in a nested repository compares over the original dispatch basis', t => {
 const cwd = mkdtempSync(join(tmpdir(),'af-reconcile-nested-')); t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const docs = join(cwd,'rin-docs'); mkdirSync(docs); execFileSync('git',['init','-q',docs]);
 writeFileSync(join(docs,'README.md'),'docs\n');
 execFileSync('git',['-C',docs,'-c','user.email=fixture@example.test','-c','user.name=Fixture','add','.']);
 execFileSync('git',['-C',docs,'-c','user.email=fixture@example.test','-c','user.name=Fixture','commit','-qm','base']);
 const path=join(docs,'partial.ts'); writeFileSync(path,'partial result');
 const basis=revisionScopes(cwd,['rin-docs/partial.ts']); assert.deepEqual(basis,['rin-docs']);
 const revision=revisionOf(cwd,basis), sha256=createHash('sha256').update('partial result').digest('hex');
 assert.equal(worktreeRevision(cwd,[]),'unavailable','the root itself has no revision');
 const guard=createNoProgressGuard(()=>{});
 const failed=guard.begin('contract','before','builder'); guard.finish(failed,'before',{dispatchId:'failed-original',reason:'lost delivery',category:'verification_failed'});
 const original={dispatchId:'failed-original',taskId:guard.taskId(),executor:'builder',revision,revisionScopes:basis,changedScope:['rin-docs/partial.ts'],readback:[{path,status:'read' as const,changed:true,sha256,retainedPath:'evidence/original-readback'}],concurrentWriters:false,completed:false,blockingFindings:0,coveredScope:[],edited:false,evidenceRef:'evidence/failed',openRequirements:['AF-MIN-CHANGE']};
 assert.equal(guard.recordDispatchEvidence(original),true);
 const roots={cwd,sessionDir:cwd};
 const current=(scopes:readonly string[])=>revisionOf(cwd,[...scopes]);
 assert.equal(guard.recordDispatchEvidence({...original,dispatchId:'other-basis-review',executor:'reviewer',revisionScopes:['rin-docs','ringithub'],changedScope:[],readback:[],completed:true,coveredScope:['rin-docs/partial.ts'],evidenceRef:'evidence/other',openRequirements:[]}),true);
 assert.equal(guard.reconcile(failed.operationId!,failed.attemptId!,current,roots).cleared,false,'a review over another basis is not this revision');
 assert.equal(guard.recordDispatchEvidence({...original,dispatchId:'independent-review',executor:'code-reviewer',changedScope:[],readback:[],completed:true,coveredScope:['rin-docs/partial.ts'],evidenceRef:'evidence/independent-review',openRequirements:[]}),true);
 assert.equal(guard.reconcile(failed.operationId!,failed.attemptId!,worktreeRevision(cwd,[]),roots).cleared,false,'the bare root revision never clears');
 const result=guard.reconcile(failed.operationId!,failed.attemptId!,current,roots);
 assert.equal(result.cleared,true,JSON.stringify(result));
});

test('self, stale, unsupported readback, ambiguous writers and missing T3 effects fail closed', () => {
 const state=createRecoverState(); const {operationId,attemptId}=state.start('task','contract','builder','dispatch')!; state.fail(operationId,attemptId,'tool_protocol_error');
 const base={taskId:'task',operationId,attemptId,originalExecutor:'builder',currentRevision:'r2',observedRevision:'r2',changedScope:['path'],readback:[{path:'path',status:'read' as const,changed:true,retainedPath:'snapshot'}],concurrentWriters:false,reviewer:{taskId:'task',executor:'reviewer',revision:'r2',completed:true,blockingFindings:0,coveredScope:['path'],edited:false,evidenceRef:'review'},openRequirements:['AF-MIN-CHANGE']};
 for(const variation of [{}, {effectsRef:'effects',observedRevision:'r1'}, {effectsRef:'effects',concurrentWriters:true}, {effectsRef:'effects',reviewer:{...base.reviewer,executor:'builder'}}, {effectsRef:'effects',readback:[{path:'path',status:'read' as const,changed:false,retainedPath:'snapshot'}]}, {effectsRef:'effects',reviewer:{...base.reviewer,revision:'r1'}}]) assert.equal(reconcileTechnical(state,{...base,...variation}).cleared,false);
 assert.equal(state.inspect(operationId)!.technical,undefined);
});
