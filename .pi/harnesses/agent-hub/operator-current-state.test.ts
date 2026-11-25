import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureOperatorState,OperatorScopeObservationError,operatorStateChecksDiagnostic,operatorStateNextStep,operatorStateChecksPassed,operatorScopeSyntax,OPERATOR_SCOPE_MAX} from './operator-current-state.ts';
import {earlyOperatorScopeDiagnostic,formatScopeDiagnostic} from './scope-diagnostic.ts';
const candidate={origin:'operator-current-state' as const,revision:'current',paths:['a.ts'],historicalAttribution:'not_claimed' as const};
const requirements=[{id:'AF-MIN-CHANGE',tag:'test',status:'passed',evidenceRefs:['check']},{id:'A2',tag:'test',status:'passed',evidenceRefs:['check']},{id:'A1',tag:'manual',status:'unsupported'}];
const proof={candidate,revision:'current',sameTask:true,native:true,exclusive:true,verification:{requirements,checks:[{producer:'runtime',status:'passed',evidenceRef:'check',requirementIds:['AF-MIN-CHANGE','A2']}]}};
test('current-state automated proof leaves manual unsupported, never claims historical attribution',()=>{
 assert.equal(operatorStateChecksPassed(proof),true);assert.equal(requirements[2].status,'unsupported');assert.equal(candidate.historicalAttribution,'not_claimed');
});
test('reject stale/task/backend/overlap and missing/failed automated proof',()=>{
 for(const patch of [{revision:'other'},{sameTask:false},{native:false},{exclusive:false},{verification:{requirements:[]}},{verification:{requirements:requirements.map(r=>r.id==='A2'?{...r,status:'failed'}:r),checks:proof.verification.checks}}])assert.equal(operatorStateChecksPassed({...proof,...patch}),false);
});
test('passing words without runtime-produced evidence cannot close current state',()=>{
 assert.equal(operatorStateChecksPassed({...proof,verification:{requirements,checks:[]}}),false);
 assert.equal(operatorStateChecksPassed({...proof,verification:{requirements,checks:[{producer:'runtime',status:'passed',evidenceRef:'check',requirementIds:['AF-MIN-CHANGE']}]}}),false);
 assert.equal(operatorStateChecksPassed({...proof,verification:{requirements,checks:[{producer:'specialist',status:'passed',evidenceRef:'claim'}]}}),false);
});
test('scope capture uses observed Git-visible regular files, rejects ignored/clean/alias/glob/session output',t=>{
 const cwd=mkdtempSync(join(tmpdir(),'operator-state-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));writeFileSync(join(cwd,'a.ts'),'public');symlinkSync(join(cwd,'a.ts'),join(cwd,'alias.ts'));
 const snapshot={skipped:false,paths:new Set(['a.ts','alias.ts']),fingerprints:new Map([['a.ts','runtime-hash'],['alias.ts','link-hash']])};
 assert.deepEqual(captureOperatorState({scope:['a.ts'],cwd,snapshot,revision:'current'}),candidate);
 for(const scope of [[],['a.ts','a.ts'],['ignored.md'],['alias.ts'],['../a.ts'],['*.ts'],['.pi/agent-sessions/sessions/fake/session.json']])assert.throws(()=>captureOperatorState({scope,cwd,snapshot,revision:'current'}));
 assert.throws(()=>captureOperatorState({scope:['a.ts'],cwd,snapshot:{...snapshot,skipped:true},revision:'current'}));
 // A nested-repository snapshot is accepted only with complete coverage.
 assert.deepEqual(captureOperatorState({scope:['a.ts'],cwd,snapshot:{...snapshot,nested:true,gaps:[]},revision:'current'}),candidate);
 assert.throws(()=>captureOperatorState({scope:['a.ts'],cwd,snapshot:{...snapshot,nested:true,gaps:[{scope:'loose.md',reason:'no repository'}]},revision:'current'}),{message:'operator_state_scope_unavailable'});
});
test('operator observation gap names the declaration entry, not its path or a test coverage claim',t=>{
 const cwd=mkdtempSync(join(tmpdir(),'operator-state-gap-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 writeFileSync(join(cwd,'cli.ts'),'changed');
 const scope=['cli.ts','server/private-config.ts'];
 const snapshot={paths:new Set(['cli.ts','server-old/private-config.ts']),fingerprints:new Map([['cli.ts','hash'],['server-old/private-config.ts','hash']])};
 for(const [input,kind] of [[snapshot,'observation_gap'],[{...snapshot,paths:undefined},'unknown'],[{...snapshot,skipped:true},'unknown']] as const){
  assert.throws(()=>captureOperatorState({scope,cwd,snapshot:input,revision:'current'}),error=>{
   assert.ok(error instanceof OperatorScopeObservationError);
   assert.equal(error.diagnostic.kind,kind);
   assert.equal(error.diagnostic.checkedPaths,'unknown');
   const serialized=JSON.stringify(error.diagnostic);
   assert.doesNotMatch(serialized,/private-config|server-old|cli\.ts|hash/);
   if(kind==='observation_gap') assert.match(error.diagnostic.nextStep,/entry #2/);
   return true;
  });
 }
});
test('early registered scope gap displays only a safe prior task entry, never an omitted descendant',()=>{
 const label='packages/server', descendant=`${label}/private.ts`;
 const gap={taskId:'current',registered:[descendant],omitted:[descendant],declared:['packages/cli/entry.ts']};
 const prior={taskId:'current',entries:[label]};
 const diagnostic=earlyOperatorScopeDiagnostic({...gap,prior});
 assert.equal(diagnostic.kind,'omitted_task_entry');
 assert.match(formatScopeDiagnostic(diagnostic),/Actual checked paths are unknown.*`packages\/server`/);
 assert.doesNotMatch(JSON.stringify(diagnostic),/private\.ts/);
 for(const patch of [{prior:undefined},{prior:{...prior,taskId:'old'}},{prior:{...prior,entries:[`${label}/**`]}},{prior:{...prior,entries:[`${label}\n`] }},{registered:[`./${descendant}`]},{omitted:[`${label}-old/private.ts`]}]){
  const result=earlyOperatorScopeDiagnostic({...gap,prior,...patch});
  assert.equal(result.kind,'unknown');
  assert.doesNotMatch(JSON.stringify(result),/packages\/server|private\.ts/);
 }
});

test('scope syntax gate accepts up to OPERATOR_SCOPE_MAX=128 unique exact files and rejects 129',()=>{
 assert.equal(OPERATOR_SCOPE_MAX,128);
 const paths=Array.from({length:128},(_,i)=>`src/dir${i%8}/file${i}.ts`);
 assert.deepEqual(operatorScopeSyntax(paths),paths);
 assert.throws(()=>operatorScopeSyntax([...paths,'src/extra/file128.ts']),{message:'operator_state_invalid_scope'});
});
test('each refused current-state check names its exact qualifier; the passing proof names none',()=>{
 assert.equal(operatorStateChecksDiagnostic(proof),null);
 const cases:Array<[any,string]>=[
  [{sameTask:false},'not_same_task'],[{native:false},'not_native'],[{exclusive:false},'non_exclusive_capture'],
  [{revision:'unavailable'},'revision_unavailable'],[{revision:'other'},'revision_changed'],
  [{verification:{}},'no_runtime_requirements'],
  [{verification:{requirements:requirements.filter(r=>r.id!=='A2'),checks:proof.verification.checks}},'no_automated_requirement'],
  [{verification:{requirements:requirements.filter(r=>r.id!=='AF-MIN-CHANGE'),checks:proof.verification.checks}},'missing_min_change'],
  [{verification:{requirements:requirements.map(r=>r.id==='A2'?{...r,status:'failed'}:r),checks:proof.verification.checks}},'automated_not_passed:A2'],
  [{verification:{requirements,checks:[{producer:'runtime',status:'passed',evidenceRef:'check',requirementIds:['AF-MIN-CHANGE']}]}},'runtime_check_missing:A2'],
  [{verification:{requirements,checks:[{producer:'model',status:'passed',evidenceRef:'check',requirementIds:['AF-MIN-CHANGE','A2']}]}},'runtime_check_missing:AF-MIN-CHANGE,A2'],
 ];
 for(const [patch,reason] of cases){
  assert.equal(operatorStateChecksDiagnostic({...proof,...patch}),reason,JSON.stringify(patch));
  assert.equal(operatorStateChecksPassed({...proof,...patch}),false,'the boolean gate agrees with the diagnostic');
  assert.ok(operatorStateNextStep(reason).length>0);
 }
});
