import test from 'node:test';
import assert from 'node:assert/strict';
import { handleObservationEnvelope } from './coms-observation.ts';
const owner={project:'fake',peer:'worker',sessionId:'fake-session',startedAt:'2026-01-01T00:00:00.000Z'};
const req={type:'observation_request',version:1,msg_id:'fake-request',sender_session:'fake-reader',sender_endpoint:'',operation:'snapshot',owner};
const row=(id:string,parentId:string|null,message:unknown)=>({id,parentId,type:'message',timestamp:owner.startedAt,message});
function invoke(envelope:Record<string,unknown>,entries:Record<string,unknown>={},leaf:string|null=null,options:{owner?:typeof owner;questionStatus?:string}={}) {
 let output='',reads=0;const source={getLeafId:()=>leaf,getEntry:(id:string)=>{reads++;return entries[id];}};
 const handled=handleObservationEnvelope({end:(s:string)=>{output=s;}},envelope,{owner:()=>options.owner??owner,session:()=>source,
 questions:()=>({status:options.questionStatus??'available',partial:false,questions:[],resolved:[],nextCursor:null}),now:()=>Date.parse(owner.startedAt)});
 return {handled,reads,result:output?JSON.parse(output):null};
}
test('projects only bounded assistant text/tool names, never thinking/user/tool results or arguments',()=>{
 const entries={a:row('a',null,{role:'user',content:'PRIVATE_USER'}),b:row('b','a',{role:'toolResult',content:[{type:'text',text:'PRIVATE_TOOL_RESULT'}]}),
 c:row('c','b',{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_THINKING'},{type:'text',text:'Working token=abcdef1234567890'},
 {type:'toolCall',name:'read',arguments:{path:'PRIVATE_PATH'}}],stopReason:'stop'})};
 const r=invoke(req,entries,'c');assert.equal(r.handled,true);assert.equal(r.result.status,'available');
 const text=JSON.stringify(r.result);for(const s of ['PRIVATE_USER','PRIVATE_TOOL_RESULT','PRIVATE_THINKING','PRIVATE_PATH','abcdef1234567890'])assert.equal(text.includes(s),false,s);
 assert.ok(r.result.transcript.entries.some((e:{kind:string})=>e.kind==='tool'));
 assert.ok(r.result.transcript.entries.some((e:{kind:string})=>e.kind==='turn_end'));
});
test('wrong owner rejected before any session reads',()=>{
 const r=invoke({...req,owner:{...owner,sessionId:'other'}});assert.equal(r.result.status,'stale');assert.equal(r.reads,0);assert.equal(r.result.transcript,undefined);
});
test('answer/send/cancel are not supported operations',()=>{
 for(const operation of ['answer','send','cancel']){const r=invoke({...req,operation});assert.equal(r.result.status,'unsupported');assert.equal(r.reads,0);}
});
test('bounded walk reports partial instead of whole transcript completion',()=>{
 const entries:Record<string,unknown>={};for(let i=0;i<300;i++)entries[String(i)]=row(String(i),i?String(i-1):null,{role:'assistant',content:[{type:'text',text:'step'}]});
 const r=invoke(req,entries,'299');assert.ok(r.reads<=256);assert.equal(r.result.transcript.partial,true);assert.ok(r.result.transcript.entries.length<=50);
});
test('missing/cyclic session branch does not pick another transcript',()=>{
 const missing=invoke(req,{},'absent');assert.equal(missing.result.transcript.status,'unavailable');
 const cycle=invoke(req,{a:row('a','a',{role:'assistant',content:[]})},'a');assert.equal(cycle.result.transcript.status,'unavailable');
});
test('unsupported question channel does not hide available transcript or claim zero pending',()=>{
 const r=invoke(req,{},null,{questionStatus:'unsupported'});assert.equal(r.result.transcript.status,'available');assert.equal(r.result.questionState.status,'unsupported');
});

test('unicode projection has a byte budget, huge text is withheld before redaction truncation',()=>{
 const entries:Record<string,unknown>={};for(let i=0;i<100;i++)entries[String(i)]=row(String(i),i?String(i-1):null,{role:'assistant',content:[{type:'text',text:'界'.repeat(2000)}]});
 const r=invoke(req,entries,'99');assert.ok(Buffer.byteLength(JSON.stringify(r.result))<=131072);assert.equal(r.result.transcript.status,'available');assert.equal(r.result.transcript.partial,true);
 const huge=invoke(req,{a:row('a',null,{role:'assistant',content:[{type:'text',text:'-----BEGIN PRIVATE KEY-----'+'X'.repeat(10000)}]})},'a');
 assert.equal(JSON.stringify(huge.result).includes('BEGIN PRIVATE KEY'),false);assert.equal(huge.result.transcript.partial,true);
});

test('one source failure does not erase independent verified data',()=>{
 let text='';const socket={end:(s:string)=>{text=s;}};
 handleObservationEnvelope(socket,req,{owner:()=>owner,session:()=>({getLeafId:()=>null,getEntry:()=>undefined}),questions:()=>{throw Error('PRIVATE');}});
 let r=JSON.parse(text);assert.equal(r.transcript.status,'available');assert.equal(r.questionState.status,'unavailable');assert.equal(text.includes('PRIVATE'),false);
 handleObservationEnvelope(socket,req,{owner:()=>owner,session:()=>({getLeafId:()=>{throw Error('PRIVATE');},getEntry:()=>undefined}),questions:()=>({status:'available',partial:false,questions:[],resolved:[],nextCursor:null})});
 r=JSON.parse(text);assert.equal(r.transcript.status,'unavailable');assert.equal(r.questionState.status,'available');
});

test('review regression: cap boundary and malformed/unknown blocks are explicit partial gaps',()=>{
 const run=(content:unknown[])=>invoke(req,{a:row('a',null,{role:'assistant',content})},'a').result.transcript;
 const boundary=run(Array.from({length:128},()=>({type:'thinking',thinking:'PRIVATE'})));
 assert.equal(boundary.partial,true);assert.ok(boundary.reasons.includes('ENTRY_LIMIT'));
 for(const block of [null,{type:'unknown'},{type:'text',text:123},{type:'toolCall',name:'invalid name'}]){
  const result=run([{type:'text',text:'visible'},block]);assert.equal(result.partial,true);assert.ok(result.reasons.includes('SOURCE_INVALID'));
 }
 const intentional=run([{type:'thinking',thinking:'PRIVATE'},{type:'text',text:'visible'}]);assert.equal(intentional.partial,false);
});

test('S5c stable opaque identities distinguish repeated entries and repeated blocks',()=>{
 const entries={a:row('a',null,{role:'assistant',content:[{type:'text',text:'same'},{type:'text',text:'same'}]}),b:row('b','a',{role:'assistant',content:[{type:'text',text:'same'}]})};
 const a=invoke(req,entries,'b').result.transcript,b=invoke(req,entries,'b').result.transcript;
 assert.deepEqual(a,b);assert.equal(new Set(a.entries.map((e:{id:string})=>e.id)).size,3);
 for(const e of a.entries)assert.match(e.id,/^[a-f0-9]{64}$/);assert.equal(a.window.ancestry.length,2);assert.equal(a.window.rootReached,true);assert.equal(a.window.leaf,a.window.ancestry[0]);
});
test('S5c lineage exposes append versus branch replacement without text-based guessing',()=>{
 const entries={a:row('a',null,{role:'assistant',content:[{type:'text',text:'one'}]}),b:row('b','a',{role:'assistant',content:[{type:'text',text:'two'}]}),c:row('c','a',{role:'assistant',content:[{type:'text',text:'two'}]})};
 const a=invoke(req,entries,'a').result.transcript,b=invoke(req,entries,'b').result.transcript,c=invoke(req,entries,'c').result.transcript;
 assert.ok(b.window.ancestry.includes(a.window.leaf));assert.equal(c.window.ancestry.includes(b.window.leaf),false);assert.notEqual(b.entries[1].id,c.entries[1].id);
});
test('S5c event identity binds exact owner and changed public projection',()=>{
 const entries={a:row('a',null,{role:'assistant',content:[{type:'text',text:'before'}]})},first=invoke(req,entries,'a').result.transcript;
 const other={...owner,sessionId:'different-session'};const second=invoke({...req,owner:other},entries,'a',{owner:other}).result.transcript;
 assert.notEqual(first.entries[0].id,second.entries[0].id);assert.notEqual(first.window.leaf,second.window.leaf);
 entries.a=row('a',null,{role:'assistant',content:[{type:'text',text:'after'}]});assert.notEqual(first.entries[0].id,invoke(req,entries,'a').result.transcript.entries[0].id);
});
test('S5c empty branch and bounded unreachable ancestry are explicit',()=>{
 assert.deepEqual(invoke(req).result.transcript.window,{leaf:null,ancestry:[],rootReached:true});
 const entries:Record<string,unknown>={};for(let i=0;i<300;i++)entries[String(i)]=row(String(i),i?String(i-1):null,{role:'user',content:'PRIVATE'});
 const r=invoke(req,entries,'299');assert.equal(r.result.transcript.window.rootReached,false);assert.equal(r.result.transcript.window.ancestry.length,256);assert.equal(r.result.transcript.partial,true);assert.ok(r.reads<=256);assert.equal(JSON.stringify(r.result).includes('PRIVATE'),false);
});
test('S5c metadata does not expose raw entry ids, thinking or tool arguments',()=>{
 const r=invoke(req,{'private-entry':row('private-entry',null,{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_THINKING'},{type:'toolCall',name:'read',arguments:{path:'PRIVATE_PATH'}}]})},'private-entry');
 for(const s of ['private-entry','PRIVATE_THINKING','PRIVATE_PATH'])assert.equal(JSON.stringify(r.result).includes(s),false);assert.match(r.result.transcript.window.leaf,/^[a-f0-9]{64}$/);
});
