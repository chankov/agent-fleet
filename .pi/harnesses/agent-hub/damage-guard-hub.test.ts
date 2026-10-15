import test from 'node:test';
import assert from 'node:assert/strict';
import {createDamageHubSession} from './damage-guard-hub.ts';
import {normalizeSystem1Config} from '../lib/system1/config-v2.js';
const root={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{damageGuard:{mode:'active',remoteScopes:{commands:true},include:['docs']}}};
test('Hub adapter consumes exact human denial, persists identity, and honors off durable denies',async()=>{
 const records:{customType:string;data:unknown}[]=[],append=(type:string,data:unknown)=>records.push({customType:type,data});let calls=0;
 const session=createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config(root),taskId:()=> 'task',append,entries:()=>records,canRead:()=>true,selected:true,ask:async(id)=>({details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Deny']}}}),service:{evaluate:async()=>{calls++;return {status:'ok',evaluation:{answers:[{questionId:'effect',type:'choice',value:'severe',uncertainty:{provenance:'provider'}},{questionId:'evidence',type:'choice',value:'sufficient',uncertainty:{provenance:'provider'}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}};}}});
 session.accept('user input');const event={toolName:'bash',toolCallId:'first',input:{command:'echo hello'}},ctx={cwd:process.cwd(),revalidateBaseline:()=>true};
 assert.equal((await session.call(event,ctx)).block,true);session.dispose();
 const resumed=createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config({...root,mode:'off'}),taskId:()=> 'task',append,entries:()=>records,canRead:()=>true,selected:false,ask:async()=>{throw Error('must not ask');}});
 assert.equal((await resumed.call({...event,toolCallId:'new'},ctx)).block,true);assert.equal(calls,1);resumed.dispose();
});
const severe=()=>({status:'ok' as const,evaluation:{answers:[{questionId:'effect',type:'choice' as const,value:'severe',uncertainty:{provenance:'provider' as const}},{questionId:'evidence',type:'choice' as const,value:'sufficient',uncertainty:{provenance:'provider' as const}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}});
const event={toolName:'bash',toolCallId:'first',input:{command:'echo hello'}},ctx={cwd:process.cwd(),revalidateBaseline:()=>true};
test('Hub off/missing consumer preserves standalone baseline without inference or identity synthesis',async()=>{
 let calls=0;const session=createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config({...root,consumers:{}}),taskId:()=> 'task',append:()=>{},entries:()=>[],canRead:()=>true,selected:true,ask:async()=>{throw Error('must not ask');},service:{evaluate:async()=>{calls++;return severe();}}});
 assert.equal((await session.call(event,ctx)).block,false);session.accept('input');assert.equal((await session.call(event,ctx)).block,false);assert.equal(calls,0);session.dispose();
});
test('Hub stale baseline after human Allow once never permits action',async()=>{
 let baseline=true;
 const session=createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config(root),taskId:()=> 'task',append:()=>{},entries:()=>[],canRead:()=>true,selected:true,ask:async(id)=>{baseline=false;return {details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Allow once']}}};},service:{evaluate:async()=>severe()}});
 session.accept('input');assert.equal((await session.call(event,{...ctx,revalidateBaseline:()=>baseline})).block,true);session.dispose();
});
test('Hub accepted-input persistence failure revokes old identity rather than retaining authority',async()=>{
 let fail=false,calls=0;const session=createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config(root),taskId:()=> 'task',append:()=>{if(fail)throw Error('disk');},entries:()=>[],canRead:()=>true,selected:true,ask:async()=>{throw Error('must not ask');},service:{evaluate:async()=>{calls++;return severe();}}});
 session.accept('first');fail=true;assert.throws(()=>session.accept('new'));assert.equal((await session.call(event,ctx)).block,true);assert.equal(calls,0);session.dispose();
});
test('Hub consumes correlated Allow once only with current baseline',async()=>{
 let asks=0;const session=createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config(root),taskId:()=> 'task',append:()=>{},entries:()=>[],canRead:()=>true,selected:true,ask:async(id)=>{asks++;return {details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Allow once']}}};},service:{evaluate:async()=>severe()}});
 session.accept('input');assert.equal((await session.call(event,ctx)).block,false);assert.equal(asks,1);session.dispose();
});
test('new authoritative task binds latest input before parent active-consent shortcut',async()=>{
 const records:{customType:string;data:unknown}[]=[],append=(type:string,data:unknown)=>records.push({customType:type,data});let task='old',calls=0;
 const session=createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config(root),taskId:()=>task,append,entries:()=>records,canRead:()=>true,selected:true,ask:async()=>{throw Error('must not ask');},service:{evaluate:async()=>{calls++;return {status:'unavailable',reason:'network'};}}});
 session.accept('accepted input');task='new';assert.equal((await session.call(event,ctx)).block,false);assert.equal(calls,1);assert.equal(records.filter(r=>r.customType==='damage-guard-input'&&(r.data as any).taskId==='new').length,1);session.dispose();
});
test('partial input-history loss/corruption cannot bypass intact denial in off/consumer-off/selected-false/outage modes',async()=>{
 const records:{customType:string;data:any}[]=[],append=(type:string,data:unknown)=>records.push({customType:type,data});
 const initial=createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config(root),taskId:()=> 'task',append,entries:()=>records,canRead:()=>true,selected:true,ask:async(id)=>({details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Deny']}}}),service:{evaluate:async()=>severe()}});
 initial.accept('old input');initial.accept('denied input');assert.equal((await initial.call(event,ctx)).block,true);initial.dispose();
 for(const history of ['intact','latest-missing','latest-corrupt','all-input-missing'])for(const mode of ['off','consumer-off','selected-false','outage']){
  let inputIndex=0,calls=0;const restored=structuredClone(records).filter(r=>r.customType!=='damage-guard-input'||(history!=='all-input-missing'&&(history!=='latest-missing'||++inputIndex!==2)));
  if(history==='latest-corrupt')restored.filter(r=>r.customType==='damage-guard-input')[1].data.revision='CORRUPTED';
  const snapshot=normalizeSystem1Config(mode==='off'?{...root,mode:'off'}:mode==='consumer-off'?{...root,consumers:{damageGuard:{mode:'off'}}}:root);
  const session=createDamageHubSession({root:process.cwd(),snapshot,taskId:()=> 'task',append:()=>{},entries:()=>restored,canRead:()=>true,selected:mode!=='selected-false',ask:async()=>{throw Error('must not ask');},service:{evaluate:async()=>{calls++;return {status:'unavailable',reason:'network'};}}});
  assert.equal((await session.call({...event,toolCallId:'retry'},ctx)).block,true,`${history}/${mode}`);assert.equal(calls,0,`${history}/${mode}`);
  session.accept('genuine new input');assert.equal((await session.call({...event,toolCallId:'new-revision'},ctx)).block,false,`${history}/${mode} genuine revision`);session.dispose();
 }
});

const childSession=(extra:Record<string,unknown>={})=>createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config(root),taskId:()=> 'task',append:()=>{},entries:()=>[],canRead:()=>true,selected:true,ask:async(id)=>({details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Deny']}}}),service:{evaluate:async()=>severe()},childAuthority:{taskToken:()=> 'token',admit:()=>true},...extra});
test('registered owner shares durable denial with parent and fresh owner off resume without inference',async()=>{
 const records:any[]=[];let calls=0;const session=childSession({append:(customType:string,data:unknown)=>records.push({customType,data}),entries:()=>records,service:{evaluate:async()=>{calls++;return severe();}}});session.accept('input');
 const child=session.registerOwner({owner:'specialist',tools:['bash'],cwd:process.cwd()});
 assert.equal((await child.call(event,ctx)).block,true);assert.equal((await session.call({...event,toolCallId:'parent'},ctx)).block,true);session.dispose();
 const resumed=childSession({snapshot:normalizeSystem1Config({...root,mode:'off'}),entries:()=>records,service:{evaluate:async()=>{calls++;return severe();}}});const fresh=resumed.registerOwner({owner:'specialist',tools:['bash'],cwd:process.cwd()});assert.notEqual(child.identity.attempt,fresh.identity.attempt);assert.equal((await fresh.call({...event,toolCallId:'retry'},ctx)).block,true);assert.equal(calls,1);resumed.dispose();
});
test('missing child authority rejects registration; child arguments cannot impersonate hub or widen scope',async()=>{
 const missing=childSession({childAuthority:undefined});missing.accept('input');assert.throws(()=>missing.registerOwner({owner:'child',tools:['bash'],cwd:process.cwd()}));missing.dispose();
 let calls=0;const session=childSession({service:{evaluate:async()=>{calls++;return severe();}}});session.accept('input');const child=session.registerOwner({owner:'child',tools:['write'],cwd:process.cwd()});assert.equal((await child.call({...event,owner:'hub'} as any,ctx)).block,true);assert.equal(calls,0);session.dispose();
});
test('registered admission changes, input changes and revocation during human wait never admit effects',async()=>{
 for(const change of ['admission','input','revocation','dispose','token']){
  let admitted=true,token='token',baselineChecks=0;let child:ReturnType<ReturnType<typeof createDamageHubSession>['registerOwner']>;
  const session=childSession({childAuthority:{taskToken:()=>token,admit:()=>admitted},ask:async(id:string)=>{if(change==='admission')admitted=false;if(change==='input')session.accept('different');if(change==='revocation')child.revoke();if(change==='dispose')session.dispose();if(change==='token')token='new';return {details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Allow once']}}};}});session.accept('input');child=session.registerOwner({owner:'child',tools:['bash'],cwd:process.cwd()});assert.equal((await child.call(event,{...ctx,revalidateBaseline:()=>{baselineChecks++;return true;}})).block,true,change);assert.ok(baselineChecks>0);session.dispose();
 }
});
test('registered scope and baseline reject before inference; valid child metadata never becomes hub',async()=>{
 let calls=0,seen='';const session=childSession({service:{evaluate:async(request:any)=>{calls++;seen=request.state.owner;return {status:'unavailable',reason:'network'};}}});session.accept('input');
 const child=session.registerOwner({owner:'research',tools:['bash'],cwd:process.cwd()});
 assert.equal((await child.call(event,{...ctx,cwd:'/'})).block,true);assert.equal((await child.call(event,{cwd:process.cwd()})).block,true);assert.equal((await child.call(event,{...ctx,revalidateBaseline:()=>false})).block,true);assert.equal(calls,0);
 assert.equal((await child.call({...event,owner:'hub',attempt:'forged'} as any,ctx)).block,false);assert.equal(seen,child.identity.owner);assert.notEqual(seen,'hub');session.dispose();
});
test('registered owners retain held recovery across off, missing, invalid, root-off and unavailable service without inference',async()=>{
 const records:any[]=[];const initial=childSession({append:(customType:string,data:unknown)=>records.push({customType,data}),ask:async()=>({details:{cancelled:true}})});initial.accept('input');
 const first=initial.registerOwner({owner:'child',tools:['bash'],cwd:process.cwd()});assert.equal((await first.call(event,ctx)).block,true);initial.dispose();
 for(const config of [{...root,mode:'off'},{...root,consumers:{}},{...root,consumers:{damageGuard:{mode:'off'}}},{...root,consumers:{damageGuard:{mode:'invalid'}}},root]){
  let calls=0;const resumed=childSession({snapshot:normalizeSystem1Config(config),entries:()=>records,service:undefined,ask:async()=>{calls++;return {details:{cancelled:true}};}});
  const child=resumed.registerOwner({owner:'child',tools:['bash'],cwd:process.cwd()});assert.equal((await child.call({...event,toolCallId:'new'},ctx)).block,true);assert.equal(calls,0);resumed.dispose();
 }
});
test('input revision change aborts outstanding child wait; revoked subtree leaves sibling authoritative',async()=>{
 let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});let aborted=false;
 const session=childSession({ask:async(_id:string,_q:unknown,signal:AbortSignal)=>{entered();return new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve({details:{cancelled:true}});},{once:true}));}});session.accept('input');
 const parent=session.registerOwner({owner:'child',tools:['bash'],cwd:process.cwd()}),child=session.registerOwner({owner:'nested',tools:['bash'],cwd:process.cwd()},parent.identity),sibling=session.registerOwner({owner:'sibling',tools:['bash'],cwd:process.cwd()});
 const pending=child.call(event,ctx);await waiting;parent.revoke();assert.equal((await pending).block,true);assert.equal(aborted,true);assert.equal(sibling.identity.signal.aborted,false);
 session.accept('new input');assert.equal(sibling.identity.signal.aborted,true);assert.equal((await sibling.call(event,ctx)).block,true);session.dispose();
});
test('input persistence failure aborts outstanding child approval and blocks all admission',{timeout:2000},async()=>{
 let fail=false,askSignal:AbortSignal|undefined,calls=0,asks=0,entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const session=childSession({append:()=>{if(fail)throw Error('disk');},service:{evaluate:async()=>{calls++;return severe();}},ask:async(_id:string,_q:unknown,signal:AbortSignal)=>{asks++;askSignal=signal;entered();return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({details:{cancelled:true}}),{once:true}));}});
 try{
  session.accept('input');const parent=session.registerOwner({owner:'child',tools:['bash'],cwd:process.cwd()}),child=session.registerOwner({owner:'nested',tools:['bash'],cwd:process.cwd()},parent.identity),sibling=session.registerOwner({owner:'sibling',tools:['bash'],cwd:process.cwd()});
  const pending=child.call(event,ctx);await waiting;fail=true;assert.throws(()=>session.accept('changed input'),/disk/);
  assert.equal(askSignal?.aborted,true);for(const owner of [parent,child,sibling])assert.equal(owner.identity.signal.aborted,true);
  assert.equal((await pending).block,true);assert.equal((await session.call(event,ctx)).block,true);
  for(const owner of [parent,child,sibling])assert.equal((await owner.call(event,ctx)).block,true);
  assert.throws(()=>session.registerOwner({owner:'new',tools:['bash'],cwd:process.cwd()}));assert.equal(session.armOverride(),false);assert.equal(calls,1);assert.equal(asks,1);
 }finally{session.dispose();}
});
test('registration without authoritative accepted input fails closed, while standalone off parent remains compatible',async()=>{
 const session=childSession({snapshot:normalizeSystem1Config({...root,mode:'off'})});
 assert.throws(()=>session.registerOwner({owner:'child',tools:['bash'],cwd:process.cwd()}));assert.equal((await session.call(event,{cwd:process.cwd()})).block,false);session.dispose();
});
test('F8 production preparation requires lifecycle start, retains admission and attenuates physical tools',async()=>{
 let admitted=true;const session=childSession();session.accept('input');
 const input={ownerId:'specialist',cwd:process.cwd(),tools:['read','bash'],admit:()=>admitted};
 assert.throws(()=>session.prepare(input));await session.start();
 const registration=session.prepare(input)!;assert.deepEqual(registration.tools,['read','bash']);
 const first=await registration.open({tools:['bash'],cwd:process.cwd()});assert.equal(first.validate(),true);
 const second=await registration.open({tools:['bash'],cwd:process.cwd()});assert.notEqual(first.assignment.capability,second.assignment.capability);
 assert.throws(()=>registration.open({tools:['bash','write'],cwd:process.cwd()}));
 assert.deepEqual(session.prepare({...input,tools:['read','find']})?.tools,['read']);
 admitted=false;assert.equal(first.validate(),false);assert.equal(first.identity.signal.aborted,true);
 assert.equal(second.validate(),false);await session.dispose();assert.equal(registration.validate(),false);
});
test('F8 revoked child blocked action cannot arm parent override',async()=>{
 const session=childSession();session.accept('input');const child=session.registerOwner({owner:'child',tools:['bash'],cwd:process.cwd()});
 await child.call(event,ctx);await child.call({...event,toolCallId:'blocked'},ctx);child.revoke();
 assert.equal(session.armOverride('blocked'),false);await session.dispose();
});
test('F8 initial denied action arms without retry but changed action and revision invalidate arming',async()=>{
 const session=childSession();session.accept('input');await session.call(event,ctx);assert.equal(session.armOverride('first'),true);
 await session.call({...event,toolCallId:'other',input:{command:'echo different'}},ctx);assert.equal(session.armOverride('first'),false);
 await session.call({...event,toolCallId:'retry'},ctx);assert.equal(session.armOverride('retry'),true);session.accept('different input');assert.equal(session.armOverride('retry'),false);await session.dispose();
});
test('F8 accepted input aborts outstanding parent wait and awaited shutdown settles it',{timeout:2000},async()=>{
 let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);let aborted=false;
 const session=childSession({ask:async(_id:string,_q:unknown,signal:AbortSignal)=>{entered();return new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve({details:{cancelled:true}});},{once:true}));}});session.accept('input');
 const pending=session.call(event,ctx);await waiting;session.accept('new input');assert.equal((await pending).block,true);assert.equal(aborted,true);await session.dispose();
});
