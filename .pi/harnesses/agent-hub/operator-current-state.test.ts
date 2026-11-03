import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureOperatorState,operatorStateChecksPassed,operatorScopeSyntax,OPERATOR_SCOPE_MAX} from './operator-current-state.ts';
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
});
test('scope syntax gate accepts up to OPERATOR_SCOPE_MAX=128 unique exact files and rejects 129',()=>{
 assert.equal(OPERATOR_SCOPE_MAX,128);
 const paths=Array.from({length:128},(_,i)=>`src/dir${i%8}/file${i}.ts`);
 assert.deepEqual(operatorScopeSyntax(paths),paths);
 assert.throws(()=>operatorScopeSyntax([...paths,'src/extra/file128.ts']),{message:'operator_state_invalid_scope'});
});
