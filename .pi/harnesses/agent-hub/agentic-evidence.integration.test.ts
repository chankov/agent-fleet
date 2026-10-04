import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync,statSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgenticEvidence} from './agentic-evidence.ts';import {createAgenticRuntime} from './agentic-runtime.ts';import {parseAgenticConfig} from '../lib/system1/config-agentic.js';
test('completed failed test artifact is private, hash checked, bounded and selected explicitly',async()=>{
 const sessionDir=mkdtempSync(join(tmpdir(),'ask-integration-'));try{
 const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true,allowToolOutputs:true,limits:{maxRetainedBytes:20}});const evidence=createAgenticEvidence({config,sessionDir,sessionId:'s',context:()=> 't',canRead:()=>true});
 const event={toolName:'bash',toolCallId:'failed-test',content:[{type:'text',text:'assert failed'}],isError:true,details:{complete:true,exitCode:1}};const summary=evidence.capture(event,sessionDir)!;assert.ok(summary);assert.equal(summary.exitCode,1);
 const path=join(sessionDir,'artifacts/evidence/agentic',readdirSync(join(sessionDir,'artifacts/evidence/agentic'))[0]);assert.equal(statSync(path).mode&0o777,0o600);
 let calls=0;const r=createAgenticRuntime({config,sessionId:'s',context:()=> 't',persist(){},collect:input=>evidence.resolve(input.evidenceRefs!,new AbortController().signal),service:{evaluate:async req=>{calls++;assert.equal((req.state as any).sources[0].text,'assert failed');return {status:'cancelled'};}}});
 await r.evaluate({evidenceRefs:[summary.ref],questions:[{id:'q',type:'predicate',instructions:'Infrastructure failure?'}]});assert.equal(calls,1);
 writeFileSync(path,'tampered');await assert.rejects(evidence.resolve([summary.ref],new AbortController().signal),/source_changed/);
 assert.equal(evidence.capture({...event,content:[{type:'text',text:'x'.repeat(21)}]},sessionDir),null);evidence.dispose();
 }finally{rmSync(sessionDir,{recursive:true,force:true});}
});
