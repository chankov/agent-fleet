import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationBridge } from './lib/fleet-codex-observe.ts';
import { OverviewBridge } from './lib/fleet-codex-overview.ts';
import { ReadonlyFleetError } from './lib/fleet-codex-readonly.ts';
const at='2026-01-01T00:00:00.000Z',A={threadId:'A'},B={threadId:'B'};
const targets=[{project:'one',peer:'worker'},{project:'two',peer:'worker'},{project:'three',peer:'other'},{project:'four',peer:'last'}];
function fixture() {
 let reads=0,active=0,peak=0,auth=0;const seen:string[]=[];
 const observation=new ObservationBridge({now:()=>Date.parse(at),authorization:{checkAllowedReadTarget:async(c,s)=>{
  auth++;const t=s as typeof targets[number];if((c as typeof A).threadId!=='A'||t.project==='denied')throw new ReadonlyFleetError('NOT_ALLOWED');
  return {target:{...t,sessionId:'fake-'+t.project,startedAt:at}};
 }},reader:async target=>{reads++;active++;peak=Math.max(peak,active);seen.push(target.project);await new Promise(r=>setTimeout(r,10));active--;
 return {target,observedAt:at,transcript:{status:'available',partial:false,reasons:[],entries:Array.from({length:8},()=>({at,kind:'assistant',text:target.project+' '+ 'x'.repeat(1990)}))},
 questionState:{status:'available',partial:false,reasons:[],questions:[],resolved:[],nextCursor:null}};
 }});
 return {bridge:new OverviewBridge(observation),reads:()=>reads,auth:()=>auth,peak:()=>peak,seen};
}
test('up to four explicit targets, two-at-a-time work, deterministic order and bounded summaries',async()=>{
 const f=fixture(),r=await f.bridge.overview(A,{targets});assert.equal(f.reads(),4);assert.equal(f.peak(),2);
 assert.deepEqual(r.results.map(x=>x.selectors),targets);assert.equal(r.completion,'not_established');
 for(const item of r.results){assert.equal(item.status,'observed');if(item.status!=='observed')continue;
  assert.equal(item.observation.scope,'overview_summary');assert.equal(item.observation.transcript.latest.length,3);
  assert.ok(item.observation.transcript.latest.every(e=>e.text.length<=256));assert.equal(item.observation.detailsTool,'fleet_observe');}
 assert.ok(Buffer.byteLength(JSON.stringify(r))<24000);
});
test('validate whole list before I/O: no empty/oversized/sparse/duplicate/implicit/extra fields',async()=>{
 for(const args of [{targets:[]},{targets:[...targets,targets[0]]},{targets:[targets[0],targets[0]]},{targets:[targets[0],{project:'bad'}]},
 {targets:[targets[0]],focus:'one'},{targets:[{...targets[0],rights:['read']}]},{targets:new Array(1)}]){
  const f=fixture();await assert.rejects(()=>f.bridge.overview(A,args),{code:'INVALID_ARGUMENTS'});assert.equal(f.auth(),0);assert.equal(f.reads(),0);
 }
});
test('per-target denials do not erase other projects or borrow their content',async()=>{
 const f=fixture(),r=await f.bridge.overview(A,{targets:[targets[0],{project:'denied',peer:'worker'},targets[1]]});
 assert.equal(r.partial,true);assert.equal(r.results[1].status,'error');assert.equal(f.reads(),2);
 assert.deepEqual(r.results.map(x=>x.selectors.project),['one','denied','two']);
});
test('another conversation has no rights and reads no source',async()=>{
 const f=fixture(),r=await f.bridge.overview(B,{targets});assert.equal(f.reads(),0);assert.ok(r.results.every(x=>x.status==='error'));
});
test('generic faults sanitized; post-read revocation drops content',async()=>{
 // A direct throwing observer tests that exception text is never returned.
 const faulty=new OverviewBridge({observe:async()=>{throw Error('PRIVATE_PASSWORD');}});
 const r=await faulty.overview(A,{targets:[targets[0]]});assert.equal(JSON.stringify(r).includes('PRIVATE_PASSWORD'),false);assert.equal(r.results[0].status,'error');
 let n=0;const source=new ObservationBridge({authorization:{checkAllowedReadTarget:async()=>{if(++n===2)throw new ReadonlyFleetError('NOT_ALLOWED');return {target:{...targets[0],sessionId:'fake',startedAt:at}};}},reader:async t=>({target:t,observedAt:at}),now:()=>Date.parse(at)});
 const revoked=await new OverviewBridge(source).overview(A,{targets:[targets[0]]});assert.equal(revoked.results[0].status,'error');
});
test('cancellation releases no collected source data',async()=>{
 const controller=new AbortController();const f=fixture();controller.abort();
 await assert.rejects(()=>f.bridge.overview(A,{targets},controller.signal),{code:'REQUEST_CANCELLED'});assert.equal(f.reads(),0);
});

test('mid-flight cancellation discards even completed summaries',async()=>{
 const f=fixture(),controller=new AbortController();const pending=f.bridge.overview(A,{targets},controller.signal);setTimeout(()=>controller.abort(),15);
 await assert.rejects(()=>pending,{code:'REQUEST_CANCELLED'});
});

test('serialized summary cap bounds metadata too, preserving other targets',async()=>{
 const f=fixture();
 const normal=new ObservationBridge({authorization:{checkAllowedReadTarget:async(_c,s)=>({target:{...(s as typeof targets[number]),sessionId:'fake',startedAt:at}})},now:()=>Date.parse(at),
 reader:async t=>({target:t,observedAt:at,transcript:{status:'available',partial:false,reasons:[],entries:[]},questionState:{status:'available',partial:false,reasons:[],questions:[],resolved:[],nextCursor:null}})});
 const bridge=new OverviewBridge({observe:async(c,s)=>{const r=await normal.observe(c,s);if((s as typeof targets[number]).project==='one')r.observedAt='x'.repeat(20000);return r;}});
 const r=await bridge.overview(A,{targets:targets.slice(0,2)});assert.equal(r.results[0].status,'error');assert.equal(r.results[1].status,'observed');
 assert.ok(Buffer.byteLength(JSON.stringify(r))<20000);assert.equal(f.reads(),0);
});
test('epoch change during source read cannot publish a target summary',async()=>{
 let calls=0;const source=new ObservationBridge({authorization:{checkAllowedReadTarget:async()=>({target:{...targets[0],sessionId:++calls===1?'old':'new',startedAt:at}})},
 reader:async t=>({target:t,observedAt:at}),now:()=>Date.parse(at)});
 const r=await new OverviewBridge(source).overview(A,{targets:[targets[0]]});assert.equal(r.results[0].status,'error');
 if(r.results[0].status==='error')assert.equal(r.results[0].code,'TARGET_CHANGED');
});
