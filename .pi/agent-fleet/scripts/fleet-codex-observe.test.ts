import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationBridge, type ObservationReader } from './lib/fleet-codex-observe.ts';
import type { TargetEpoch } from './lib/fleet-codex-allowlist.ts';
const target: TargetEpoch = { project:'fake',peer:'worker',sessionId:'fake-session',startedAt:'2026-01-01T00:00:00.000Z' };
const context = {hostProfile:'fake',principal:'fake',threadId:'11111111-1111-4111-8111-111111111111'};
const q={project:'fake',peer:'worker'};
function fixture() {
 let calls=0,reads=0;
 let authorize=async()=>{calls++;return {target:{...target}};};
 let read:ObservationReader=async t=>{reads++;return {target:t,observedAt:'2026-01-01T00:00:00.000Z',
 transcript:{status:'available',partial:false,reasons:[],entries:[{at:'2026-01-01T00:00:00.000Z',kind:'assistant',text:'public progress'}]},
 questionState:{status:'available',partial:false,reasons:[],questions:[],resolved:[],nextCursor:null}};};
 const bridge=new ObservationBridge({authorization:{checkAllowedReadTarget:async()=>authorize()},reader:t=>read(t),now:()=>Date.parse(target.startedAt)});
 return {bridge,calls:()=>calls,reads:()=>reads,setAuthorize:(v:typeof authorize)=>{authorize=v;},setReader:(v:ObservationReader)=>{read=v;}};
}
test('real source content remains independent from registry permission, no false completion',async()=>{
 const f=fixture(),r=await f.bridge.observe(context,q);
 assert.equal(f.calls(),2);assert.equal(f.reads(),1);
 assert.equal(r.transcript.status,'available');assert.equal(r.transcript.entries[0].text,'public progress');
 assert.equal(r.progress.completion,'not_established');assert.equal(r.questionState.status,'available');
 assert.equal(r.questionState.questions.length,0);assert.equal(r.partial,false);
});
test('not enrolled refuses before any source read',async()=>{
 const f=fixture();f.setAuthorize(async()=>{throw new Error('NOT_ALLOWED');});
 await assert.rejects(()=>f.bridge.observe(context,q));assert.equal(f.reads(),0);
});
for(const race of ['revoke','epoch'] as const)test('post-read '+race+' drops all source content',async()=>{
 const f=fixture();let n=0;
 f.setAuthorize(async()=>{n++;if(n===2&&race==='revoke')throw new Error('REVOKED');return {target:{...target,...(n===2?{sessionId:'new'}:{})}};});
 await assert.rejects(()=>f.bridge.observe(context,q));assert.equal(f.reads(),1);
});
test('missing transcript is honest gap, not idle or task done; questions can still be available',async()=>{
 const f=fixture();f.setReader(async t=>({target:t,observedAt:target.startedAt,transcript:{status:'unavailable',partial:true,reasons:['NO_MATCHING_TRANSCRIPT'],entries:[]},
 questionState:{status:'available',partial:false,reasons:[],questions:[],resolved:[],nextCursor:null}}));
 const r=await f.bridge.observe(context,q);assert.equal(r.partial,true);assert.equal(r.progress.status,'unavailable');assert.equal(r.progress.completion,'not_established');
 assert.equal(r.questionState.status,'available');
});
test('wrong source owner refuses; source errors never spill private payload',async()=>{
 const f=fixture();f.setReader(async()=>({target:{...target,peer:'stranger'}}));await assert.rejects(()=>f.bridge.observe(context,q));
 f.setReader(async()=>{throw new Error('PRIVATE_KEY_PAYLOAD');});const r=await f.bridge.observe(context,q);
 assert.equal(r.partial,true);assert.equal(JSON.stringify(r).includes('PRIVATE_KEY_PAYLOAD'),false);
 assert.equal(r.questionState.status,'unavailable');assert.equal(r.questionState.questions.length,0);
});

test('pending question owner must match exact authorized target and secret-bearing questions are withheld',async()=>{
 const f=fixture();const question={id:'fake-question',toolCallId:'fake-tool',question:'Choose',owner:{...target,peer:'other'},state:'pending',createdAt:target.startedAt,expiresAt:null,options:[],allowMultiple:false,allowFreeform:true,allowComment:false};
 const set=(q:unknown)=>f.setReader(async t=>({target:t,observedAt:target.startedAt,transcript:{status:'available',partial:false,reasons:[],entries:[]},questionState:{status:'available',partial:false,reasons:[],questions:[q],resolved:[],nextCursor:null}}));
 set(question);assert.equal((await f.bridge.observe(context,q)).questionState.status,'unavailable');
 set({...question,owner:target,question:'password=PRIVATE_CREDENTIAL'});const result=await f.bridge.observe(context,q);assert.equal(result.questionState.status,'unavailable');assert.equal(JSON.stringify(result).includes('PRIVATE_CREDENTIAL'),false);
});
