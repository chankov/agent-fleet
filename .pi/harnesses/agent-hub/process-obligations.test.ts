import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProcessClassification, createProcessState, evaluateProcessObligations, noteProcessStage, processPreEffectGate } from './process-obligations.ts';

for (const only of ['plan', 'acceptance', 'review'] as const) test(`${only} alone cannot close independent stages even at lower spend tier`, () => {
 const base = applyProcessClassification(createProcessState(), { risk: 'high', scope: 'wide', reason: 'wide work' }).state;
 const state = noteProcessStage(base, only, { evidenceRef: `${only}:evidence`, revision: 'current' });
 const verdict = evaluateProcessObligations(state, { writable: true, budgetTier: 'trivial', currentRevision: 'current' });
 assert.equal(verdict.accepted, false);
 for (const stage of ['plan', 'acceptance', 'review'] as const) assert.equal(verdict.obligations[stage].status, stage === 'plan' || stage === only ? 'satisfied' : 'open');
 assert.equal(processPreEffectGate(state, 'prove', '', 'current')?.reason, only === 'review' ? undefined : 'process_obligations_open');
});
test('an open review names the route that can close it, for operator edits and for registered changes', () => {
 const base = applyProcessClassification(createProcessState(), { risk: 'high', scope: 'wide', reason: 'operator edits' }).state;
 const operatorEdits = processPreEffectGate(base, 'prove', '', 'current')?.message ?? '';
 assert.match(operatorEdits, /open: review\./);
 assert.match(operatorEdits, /backend: native, review_mode: operator-current-state/);
 assert.match(operatorEdits, /raw coms_send is a message, not a review record/);
 const changed = noteProcessStage(base, 'acceptance', { evidenceRef: 'builder:evidence', revision: 'current', changedFiles: ['rin-docs/prd.md'] });
 const builderChange = processPreEffectGate(changed, 'prove', '', 'current')?.message ?? '';
 assert.match(builderChange, /dispatch_agent review that covers the task's changed files \(rin-docs\/prd\.md\)/);
 assert.doesNotMatch(builderChange, /operator-current-state/);
});
test('current verification and independent review are revision bound, plan is occurrence only', () => {
 let state = applyProcessClassification(createProcessState(), { risk: 'high', scope: 'wide', reason: 'wide work' }).state;
 for (const stage of ['plan', 'acceptance', 'review'] as const) state = noteProcessStage(state, stage, { evidenceRef: `${stage}:evidence`, revision: 'current' });
 assert.equal(evaluateProcessObligations(state, { writable: true, budgetTier: 'small', currentRevision: 'current' }).accepted, true);
 const stale = evaluateProcessObligations(state, { writable: true, budgetTier: 'project', currentRevision: 'changed' });
 assert.equal(stale.accepted, false); assert.equal(stale.obligations.plan.status, 'satisfied');
 assert.equal(stale.obligations.acceptance.status, 'open'); assert.equal(stale.obligations.review.status, 'open');
});

test('current-state origin is explicit, revision-bound and does not waive independent review',()=>{
 let state=applyProcessClassification(createProcessState(),{risk:'high',scope:'wide',reason:'operator state'}).state;
 state=noteProcessStage(state,'acceptance',{evidenceRef:'runtime:current-proof',revision:'current',changedFiles:['a.ts'],workOrigin:'operator-current-state'});
 let v=evaluateProcessObligations(state,{writable:true,budgetTier:'feature',currentRevision:'current',t2Accepted:false});
 assert.equal(v.path,'operator-current-state');assert.equal(v.accepted,false);assert.equal(v.obligations.review.status,'open');
 assert.ok(processPreEffectGate(state,'prove','','current'));
 state=noteProcessStage(state,'review',{evidenceRef:'review:current',revision:'current'});
 v=evaluateProcessObligations(state,{writable:true,budgetTier:'feature',currentRevision:'current',t2Accepted:false});assert.equal(v.accepted,true);
 assert.equal(evaluateProcessObligations(state,{writable:true,budgetTier:'feature',currentRevision:'later'}).accepted,false);
 state=noteProcessStage(state,'acceptance',{evidenceRef:'runtime:later-delta',revision:'later',changedFiles:['b.ts']});assert.equal(state.workOrigin,undefined);
});

test('runtime receipt journal anchors survive roundtrip; missing anchors, foreign files, scope/generation/session/epoch and crash overlap fail closed', async t => {
 const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import('node:fs');
 const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
 const { anchorRuntimeReceipt, beginReceiptCapture, normalizeRuntimeReceipts, receiptDeclarationHash, reusableRuntimeChecks } = await import('./runtime-receipts.ts');
 const { latestProcessState, processAuditRecord, normalizeProcessState } = await import('./process-obligations.ts');
 const sessionDir = mkdtempSync(join(tmpdir(), 'receipt-anchors-')); t.after(() => rmSync(sessionDir, {recursive:true,force:true}));
 mkdirSync(join(sessionDir, 'artifacts/evidence'), {recursive:true});
 const declarationHash = receiptDeclarationHash([{id:'A1',tag:'test',text:'exact',source:'user',testCommand:'exact'}], ['a.ts'], 'input');
 const first = beginReceiptCapture(undefined, {taskId:'task',sessionDir,scope:['a.ts'],declarationHash}, true);
 const evidenceRef=join(sessionDir,'artifacts/evidence/receipt.md'); writeFileSync(evidenceRef, 'runtime bytes');
 const check:any={producer:'runtime',taskId:'task',kind:'test',command:['exact'],exitCode:0,inspectedRevision:'a'.repeat(64),evidenceRef,requirementIds:['A1'],coverage:[{id:'A1',source:'user',text:'exact',criticalConditions:[]}]};
 const anchor=anchorRuntimeReceipt(first.capture,check,'native-origin','runtime bytes');
 const state={...createProcessState(),runtimeReceipts:{...first.state,pending:[],records:[anchor]}};
 const audit=processAuditRecord(state,evaluateProcessObligations(state,{writable:true,budgetTier:'small'}));
 const restored=latestProcessState([{customType:'agent-hub-process-state',data:JSON.parse(JSON.stringify(audit))}]);
 assert.deepEqual(restored.runtimeReceipts.records[0],anchor, 'original origin, revision and timestamps retained');
 const second=beginReceiptCapture(restored.runtimeReceipts,{taskId:'task',sessionDir,scope:['a.ts'],declarationHash},true);
 assert.equal(reusableRuntimeChecks(second.state,second.capture,'a'.repeat(64)).length,1);
 for(const change of [{taskId:'foreign'},{sessionDir:join(sessionDir,'foreign')},{generation:'new'},{epoch:99},{scope:['other.ts']},{declarationHash:'b'.repeat(64)}]) assert.deepEqual(reusableRuntimeChecks(second.state,{...second.capture,...change},'a'.repeat(64)),[]);
 assert.deepEqual(reusableRuntimeChecks(second.state,second.capture,'b'.repeat(64)),[]);
 assert.deepEqual(reusableRuntimeChecks(second.state,second.capture,'unavailable'),[]);
 const overlapped=beginReceiptCapture(second.state,{taskId:'task',sessionDir,scope:['a.ts'],declarationHash},true);
 assert.deepEqual(overlapped.state.records,[], 'unresolved capture after crash/concurrency invalidates history');
 assert.deepEqual(overlapped.state.pending,[overlapped.capture.captureId], 'idle admitted fresh capture cannot reuse crash history or retain a stale marker forever');
 for(const change of [{backend:'coms'},{originDispatchId:''},{evidenceHash:undefined},{capturedAt:undefined},{generation:'new'},{check:{...check,exitCode:null}}]) assert.throws(()=>normalizeRuntimeReceipts({...state.runtimeReceipts,records:[{...anchor,...change}]}), /Invalid/);
 assert.throws(()=>normalizeRuntimeReceipts({...state.runtimeReceipts,records:Array(65).fill(anchor)}),/Invalid/);
 assert.equal(normalizeProcessState(createProcessState()).runtimeReceipts,undefined,'legacy state does not synthesize receipts');
 assert.throws(()=>anchorRuntimeReceipt(first.capture,{...check,evidenceRef:join(sessionDir,'foreign.md')},'origin','runtime bytes'));
 const link=join(sessionDir,'artifacts/evidence/link.md'); symlinkSync(evidenceRef,link);
 assert.throws(()=>anchorRuntimeReceipt(first.capture,{...check,evidenceRef:link},'origin','runtime bytes'));
 writeFileSync(evidenceRef,'tampered bytes'); assert.deepEqual(reusableRuntimeChecks(second.state,second.capture,'a'.repeat(64)),[]);
});
