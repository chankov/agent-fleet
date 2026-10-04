import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgenticEvidence} from './agentic-evidence.ts';import {parseAgenticConfig} from '../lib/system1/config-agentic.js';
const event={toolName:'bash',toolCallId:'call',content:[{type:'text',text:'test output'}],isError:false};
test('capture opt-in, deterministic eviction, task/session binding and current read policy',async()=>{
 const sessionDir=mkdtempSync(join(tmpdir(),'ask-evidence-'));try{
 const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true,allowToolOutputs:true,limits:{maxHandles:2}});let context='task',allowed=true;const base={sessionDir,sessionId:'s',context:()=>context,canRead:()=>allowed};
 for(const c of [undefined,{...config,allowToolOutputs:false},{...config,remoteContextApproved:false}])assert.equal(createAgenticEvidence({...base,config:c}).capture(event,sessionDir),null);
 const evidence=createAgenticEvidence({...base,config});const a=evidence.capture(event,sessionDir)!;assert.ok(a);assert.equal(evidence.readback(a.ref),'test output');
 assert.equal((await evidence.resolve([a.ref],new AbortController().signal)).sources.length,1);
 allowed=false;assert.throws(()=>evidence.readback(a.ref),/source_denied/);allowed=true;context='other';assert.throws(()=>evidence.readback(a.ref),/evidence_unavailable/);context='task';
 assert.throws(()=>createAgenticEvidence({...base,sessionId:'other',config}).readback(a.ref),/evidence_unavailable/);
 evidence.capture(event,sessionDir);evidence.capture(event,sessionDir);assert.equal(evidence.size,2);assert.throws(()=>evidence.readback(a.ref),/evidence_unavailable/);
 const partial=evidence.capture({...event,details:{truncation:{truncated:true}}},sessionDir)!;await assert.rejects(evidence.resolve([partial.ref],new AbortController().signal),/evidence_incomplete/);
 const unknown=evidence.capture({...event,isError:true},sessionDir)!;assert.equal(unknown.truncation,'unknown');assert.equal(unknown.exitCode,undefined);
 evidence.dispose();assert.equal(evidence.retainedBytes,0);
 }finally{rmSync(sessionDir,{recursive:true,force:true});}
});

test('readback page/target checks retain source-path and task policy, not just exact handle matching',()=>{
 const sessionDir=mkdtempSync(join(tmpdir(),'ask-readback-'));try{
 const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true,allowToolOutputs:true});let denied='',task='t';
 const evidence=createAgenticEvidence({config,sessionDir,sessionId:'s',context:()=> 'fixed',taskId:()=>task,canRead:p=>p!==denied});
 const source=join(sessionDir,'code');writeFileSync(source,'code');const summary=evidence.capture(event,sessionDir,[source])!;
 const decoded=JSON.parse(Buffer.from(summary.readbackHandle!.slice(3),'base64url').toString());const page='t5:'+Buffer.from(JSON.stringify({...decoded,offset:1})).toString('base64url');
 assert.equal(evidence.canReadHandle(page),true);denied=source;assert.equal(evidence.canReadHandle(page),false);assert.equal(evidence.canReadTarget(decoded.path),false);denied='';task='new';assert.equal(evidence.canReadHandle(page),false);task='t';
 evidence.dispose();assert.equal(evidence.canReadHandle(page),false);
 }finally{rmSync(sessionDir,{recursive:true,force:true});}
});
