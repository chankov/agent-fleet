import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseFileDiscoveryConfig} from '../../lib/system1/config-file-discovery.js';
import {createCommunicationStore} from '../system1-communication-store.ts';
import {createDiscoveryRuntime,canonicalHash,DISCOVERY_DEADLINE} from './runtime.ts';
import {FILE_DISCOVERY_LIMITS} from '../../lib/system1/config-file-discovery.js';
import {DISCOVERY_COUNTER,restoreDiscoveryCounter} from './state.ts';
const delay=(ms=20)=>new Promise(r=>setTimeout(r,ms));
const answer=(r:any):any=>({status:'ok',evaluation:{answers:r.questions.map((q:any)=>({questionId:q.id,type:q.type,uncertainty:{provenance:'provider'},...(q.type==='ordinal'?{value:0,levels:q.levels}:q.type==='choice'?{value:'implementation'}:{probabilityTrue:0.5})})),metadata:{}}});
function fixture(t:any,service:any,limits={}){
 const root=mkdtempSync(join(tmpdir(),'d9-runtime-'));mkdirSync(join(root,'docs'));for(const p of ['a','b','c'])writeFileSync(join(root,'docs',p),'same safe bytes');
 let context='task',permission='read-export-v1',read=true;const entries:any[]=[];
 const config=parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs'],limits});
 const runtime=createDiscoveryRuntime({root,sessionId:'s',config,service,context:()=>context,persist:s=>entries.push(s)});
 t.after(()=>{runtime.dispose();rmSync(root,{recursive:true,force:true});});
 const job=(owner='hub',paths=['docs/a'],extra={})=>({owner,paths,task:'rounding',query:'search',discoveryComplete:true,canDisplay:()=>true,canRead:()=>read,permissionIdentity:()=>permission,...extra});
 return {root,runtime,entries,job,setContext:(s:string)=>context=s,setPermission:(s:string)=>permission=s,setRead:(s:boolean)=>read=s};
}
test('full identity: workspace/path/hash/task/query/all question fields and current permission, cache with zero new calls',async t=>{
 let calls=0;const f=fixture(t,{evaluate:async(r:any)=>{calls++;return answer(r);}});
 await f.runtime.rank(f.job());assert.equal((await f.runtime.rank(f.job())).rows[0].status,'cached');assert.equal(calls,1);
 await f.runtime.rank(f.job('hub',['docs/b']));assert.equal(calls,2);
 for(const customQuestions of [
 [{id:'q',type:'predicate',instructions:'one',criteria:{true:'x',false:'y'}}],
 [{id:'q',type:'predicate',instructions:'two',criteria:{true:'x',false:'y'}}],
 [{id:'q',type:'predicate',instructions:'two',criteria:{true:'z',false:'y'}}],
 [{id:'q',type:'choice',instructions:'choose',options:{yes:null,other:null}}],
 [{id:'q',type:'choice',instructions:'choose',options:{yes:'different',other:null}}],
 [{id:'q',type:'ordinal',instructions:'order',levels:['low','high']}],
 [{id:'q',type:'ordinal',instructions:'order',levels:['high','low']}],
 ])await f.runtime.rank(f.job('hub',['docs/a'],{customQuestions}));
 assert.equal(calls,9);await f.runtime.rank(f.job('hub',['docs/a'],{task:'other'}));await f.runtime.rank(f.job('hub',['docs/a'],{query:'other'}));assert.equal(calls,11);
 writeFileSync(join(f.root,'docs/a'),'different');await f.runtime.rank(f.job());assert.equal(calls,12);
 f.setPermission('v2');await f.runtime.rank(f.job());assert.equal(calls,13);
 f.setRead(false);const denied=await f.runtime.rank(f.job());assert.equal(denied.rows[0].reason,'denied');assert.equal(denied.rows[0].hash,undefined);assert.equal(calls,13);
 assert.equal(canonicalHash({b:1,a:2}),canonicalHash({a:2,b:1}));assert.notEqual(canonicalHash(['a','b']),canonicalHash(['b','a']));
});
test('individual waiter cancellation does not stop dedup; final waiter abort stops shared work',async t=>{
 let calls=0,aborts=0;const pending:any[]=[];
 const f=fixture(t,{evaluate(r:any){calls++;r.signal.addEventListener('abort',()=>aborts++);return new Promise(resolve=>pending.push(()=>resolve(answer(r))));}});
 const a=new AbortController(),b=new AbortController();
 const one=f.runtime.rank(f.job('one',['docs/a'],{signal:a.signal}));const two=f.runtime.rank(f.job('two',['docs/a'],{signal:b.signal}));
 while(!calls)await delay();await delay(100);a.abort();assert.equal((await one).status,'cancelled');assert.equal(aborts,0);pending.shift()();assert.equal((await two).rows[0].status,'scored');assert.equal(calls,1);
 const c=new AbortController(),d=new AbortController();const three=f.runtime.rank(f.job('three',['docs/b'],{signal:c.signal}));const four=f.runtime.rank(f.job('four',['docs/b'],{signal:d.signal}));
 while(calls<2)await delay();await delay(100);c.abort();d.abort();await Promise.all([three,four]);assert.ok(aborts>=1);
});
test('shared concurrency, fair owners and queue bounds; auth stop and partial/all-failed',async t=>{
 let active=0,max=0;const order:string[]=[],pending:any[]=[];
 const f=fixture(t,{evaluate(r:any){active++;max=Math.max(active,max);order.push(r.state.source.path);return new Promise(resolve=>pending.push(()=>{active--;resolve(answer(r));}));}},{concurrency:1,maxQueuedJobs:2});
 const one=f.runtime.rank(f.job('A',['docs/a','docs/b']));while(!pending.length)await delay();
 const two=f.runtime.rank(f.job('B',['docs/c']));await delay(100);const three=f.runtime.rank(f.job('C',['docs/b']));await delay(100);
 const full=await f.runtime.rank(f.job('D'));assert.equal(full.rows[0].reason,'queue_full');
 pending.shift()();while(!pending.length)await delay();assert.equal(order[1],'docs/c');pending.shift()();while(!pending.length)await delay();pending.shift()();await Promise.all([one,two,three]);assert.equal(max,1);
 let calls=0;const auth=fixture(t,{evaluate:async()=>{calls++;return {status:'unavailable',reason:'auth'};}});
 assert.equal((await auth.runtime.rank(auth.job('A',['docs/a','docs/b']))).status,'unavailable');assert.equal(calls,1);assert.equal(auth.runtime.calls,1);
 let n=0;const partial=fixture(t,{evaluate:async(r:any)=>++n===1?answer(r):{status:'unavailable',reason:'rate_limit'}});
 assert.equal((await partial.runtime.rank(partial.job('A',['docs/a','docs/b']))).status,'partial');assert.equal(partial.runtime.calls,2);
});
test('durable reservations: failed calls count, corrupt/missing restore fail closed and max never resets',async t=>{
 const f=fixture(t,{evaluate:async()=>({status:'unavailable',reason:'timeout'})},{maxCallsPerSession:1});
 await f.runtime.rank(f.job());assert.equal(f.entries[0].calls,1);assert.equal((await f.runtime.rank(f.job('B',['docs/b']))).rows[0].reason,'budget_exhausted');
 assert.equal(restoreDiscoveryCounter([{type:'message',message:{role:'user'}}],'s'),null);
 assert.equal(restoreDiscoveryCounter([{type:DISCOVERY_COUNTER,data:{schema:DISCOVERY_COUNTER,sessionId:'s',calls:NaN}}],'s'),null);
 const restored=restoreDiscoveryCounter(f.entries.map(data=>({type:DISCOVERY_COUNTER,data})),'s');assert.equal(restored?.calls,1);
 let calls=0;for(const state of [restored,null]){
 const r=createDiscoveryRuntime({root:f.root,sessionId:'s',config:parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs'],limits:{maxCallsPerSession:1}}),service:{evaluate:async(r)=>{calls++;return answer(r);}},context:()=>'',persist:()=>{},restored:state});
 assert.equal((await r.rank(f.job())).rows[0].reason,state?'budget_exhausted':'counter_restore_ambiguous');r.dispose();}
 assert.equal(calls,0);
});
test('deterministic job deadline, task switch, dispose and late completion never publish or leave workers',async t=>{
 let fire!:()=>void,pending!:(value:any)=>void,request:any;
 const f=fixture(t,{evaluate(r:any){request=r;return new Promise(resolve=>pending=resolve);}});
 const clock={setTimeout:((fn:any)=>{fire=fn;return 1;}) as any,clearTimeout:(()=>{}) as any};
 const r=createDiscoveryRuntime({root:f.root,sessionId:'s',config:parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']}),context:()=>'',persist:()=>{},clock,service:{evaluate(r:any){request=r;return new Promise(resolve=>pending=resolve);}}});
 const job=r.rank(f.job());while(!pending)await delay();fire();assert.equal((await job).rows[0].reason,'deadline');pending(answer(request));r.dispose();
 pending=undefined as any;const switched=f.runtime.rank(f.job());while(!pending)await delay();f.setContext('new');pending(answer(request));assert.equal((await switched).rows[0].reason,'changed');
 pending=undefined as any;const disposed=f.runtime.rank(f.job());while(!pending)await delay();f.runtime.dispose();assert.equal((await disposed).status,'cancelled');pending(answer(request));await delay();assert.equal((await f.runtime.rank(f.job())).status,'cancelled');
});
test('N16 deterministic shared waiter rechecks its OWN current rights after await without cancelling another valid owner',async t=>{
 let complete!:(value:any)=>void,request:any,calls=0,started!:()=>void;
 const providerStarted=new Promise<void>(resolve=>started=resolve);
 const f=fixture(t,{evaluate(r:any){request=r;calls++;started();return new Promise(resolve=>complete=resolve);}});
 const first=f.runtime.rank(f.job('valid-owner'));await providerStarted;
 let rights=true,questionReads=0,joined!:()=>void;const waiterReady=new Promise<void>(resolve=>joined=resolve);
 const waiter=f.job('narrower-waiter',['docs/a'],{canRead:()=>rights,permissionIdentity:()=>rights?'read-export-v1':'revoked'});
 // score reads the questions after awaiting this waiter's source/current checks;
 // then synchronously attaches it to the existing work before this continuation.
 Object.defineProperty(waiter,'customQuestions',{get(){if(++questionReads===2)joined();return undefined;}});
 const second=f.runtime.rank(waiter);await waiterReady;
 assert.equal(calls,1);rights=false;complete(answer(request));
 const [valid,denied]=await Promise.all([first,second]);
 assert.equal(valid.rows[0].status,'scored');assert.equal(denied.rows[0].status,'unscored');assert.equal(denied.rows[0].reason,'changed');assert.equal(denied.rows[0].hash,undefined);assert.equal(calls,1);
 assert.equal((await f.runtime.rank(f.job('valid-owner'))).rows[0].status,'cached');
});

test('T11 actual runtime projects current complete/cache/partial/unavailable/cancelled metadata and actual-or-unknown usage; observer failure cannot change result',async t=>{
 const {createCommunicationStore}=await import('../system1-communication-store.ts');
 const store=createCommunicationStore();store.setEnabled(true);store.subscribe(()=>{throw Error('render');});
 const root=mkdtempSync(join(tmpdir(),'d9-observe-'));mkdirSync(join(root,'docs'));for(const p of ['a','b','c','d'])writeFileSync(join(root,'docs',p),'PRIVATE_BODY');
 let fail=false,hold=false,entered=false;
 const config=parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']});
 const runtime=createDiscoveryRuntime({root,sessionId:'s',config,context:()=> 't',persist(){},observe:m=>store.beginDiscovery(m),service:{async evaluate(r){entered=true;if(hold)await new Promise<void>(resolve=>r.signal!.addEventListener('abort',()=>resolve(),{once:true}));if(fail)return {status:'unavailable',reason:'timeout'};const result=answer(r);result.evaluation.metadata={attempts:2,usage:{inputTokens:4,outputTokens:3}};return result;}}});
 t.after(()=>{runtime.dispose();rmSync(root,{recursive:true,force:true});});
 const job=(paths:string[],extra={})=>({owner:'PRIVATE_OWNER',attempt:'PRIVATE_ATTEMPT',trigger:'native',paths,task:'PRIVATE_TASK',query:'PRIVATE_QUERY',discoveryComplete:true,canDisplay:()=>true,canRead:()=>true,permissionIdentity:()=> 'p',...extra});
 const first=await runtime.rank(job(['docs/a']));assert.equal(first.status,'complete');let pair=store.snapshot().at(-1)!;let meta=JSON.parse(pair.response!);assert.equal(pair.consumer,'fileDiscovery');assert.equal(meta.attempts,2);assert.deepEqual(meta.usage,{inputTokens:4,outputTokens:3});assert.equal(meta.counts.evaluated,1);assert.equal(JSON.parse(pair.request!).trigger,'native');
 await runtime.rank(job(['docs/a']));meta=JSON.parse(store.snapshot().at(-1)!.response!);assert.equal(meta.counts.cached,1);assert.equal(meta.logicalCalls,0);assert.equal(meta.usage,null);
 fail=true;assert.equal((await runtime.rank(job(['docs/a','docs/b']))).status,'partial');assert.equal(store.snapshot().at(-1)!.status,'partial');assert.equal((await runtime.rank(job(['docs/c']))).status,'unavailable');assert.equal(store.snapshot().at(-1)!.status,'unavailable');
 fail=false;hold=true;entered=false;const controller=new AbortController();const pending=runtime.rank(job(['docs/d'],{signal:controller.signal}));while(!entered)await delay();controller.abort();assert.equal((await pending).status,'cancelled');assert.equal(store.snapshot().at(-1)!.status,'cancelled');
 assert.ok(!JSON.stringify(store.snapshot()).includes('PRIVATE_'));assert.ok(!JSON.stringify(store.snapshot()).includes('docs/'));
 const throwing=createDiscoveryRuntime({root,sessionId:'s2',config,context:()=> 't',persist(){},observe(){throw Error('observer');},service:{evaluate:async r=>answer(r)}});assert.equal((await throwing.rank(job(['docs/a']))).status,'complete');throwing.dispose();
});
test('runtime deadline is unavailable with deadline rows, while explicit and preaborted cancellation stay cancelled',async t=>{
 assert.equal(FILE_DISCOVERY_LIMITS.jobTimeoutMs,20000);assert.equal(FILE_DISCOVERY_LIMITS.discoveryMs,1000);
 let entered!:()=>void,fire!:()=>void;const ready=new Promise<void>(r=>entered=r);
 const root=mkdtempSync(join(tmpdir(),'d9-runtime-cause-'));mkdirSync(join(root,'docs'));writeFileSync(join(root,'docs','a'),'safe cause bytes');
 const store=createCommunicationStore();store.setEnabled(true);
 const clock={setTimeout:((fn:any)=>{fire=fn;return 1;}) as any,clearTimeout:((()=>{}) as any)};
 const config=parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']});
 const runtime=createDiscoveryRuntime({root,sessionId:'s',config,context:()=>'task',persist(){},observe:m=>store.beginDiscovery(m),clock,service:{evaluate(){entered();return new Promise(()=>{});}}});
 t.after(()=>{runtime.dispose();rmSync(root,{recursive:true,force:true});});
 const job=(extra={})=>({owner:'hub',paths:['docs/a'],task:'rounding',query:'search',discoveryComplete:true,canDisplay:()=>true,canRead:()=>true,permissionIdentity:()=>'p',...extra});
 assert.equal(config.limits.jobTimeoutMs,20000);
 const pending=runtime.rank(job());
 assert.equal(await Promise.race([ready.then(()=>'entered'),pending.then(()=>'early')]),'entered');
 fire();const deadline=await pending;assert.equal(deadline.status,'unavailable');assert.equal(deadline.rows[0].reason,'deadline');assert.equal(deadline.rows.length,1);
 assert.equal(store.snapshot().at(-1)!.status,'unavailable');assert.equal(store.snapshot().length,1);
 const already=await runtime.rank(job({signal:AbortSignal.abort(DISCOVERY_DEADLINE)}));
 assert.equal(already.status,'unavailable');assert.equal(already.rows[0].reason,'deadline');
 const alreadyCancelled=await runtime.rank(job({signal:AbortSignal.abort()}));
 assert.equal(alreadyCancelled.status,'cancelled');assert.equal(alreadyCancelled.rows[0].reason,'cancelled');assert.equal(store.snapshot().at(-1)!.status,'cancelled');
 let seen=false;const caller=new AbortController();
 const explicitRuntime=createDiscoveryRuntime({root,sessionId:'s2',config,context:()=>'task',persist(){},observe:m=>store.beginDiscovery(m),service:{evaluate(){seen=true;return new Promise(()=>{});}}});
 t.after(()=>explicitRuntime.dispose());
 const explicit=explicitRuntime.rank(job({signal:caller.signal}));
 while(!seen)await delay();caller.abort();assert.equal((await explicit).status,'cancelled');assert.equal((await explicit).rows[0].reason,'cancelled');
 assert.ok(!JSON.stringify(store.snapshot()).includes('safe cause bytes'));
});
test('in-flight runtime deadline rewrites only cancellation rows, retains denied and scored rows, and does not fire a second cause',async t=>{
 let n=0,release=()=>{},entered!:()=>void;const ready=new Promise<void>(r=>entered=r);let fire!:()=>void;
 const root=mkdtempSync(join(tmpdir(),'d9-deadline-mix-'));mkdirSync(join(root,'docs'));for(const p of ['a','b','c'])writeFileSync(join(root,'docs',p),'safe cause bytes');
 const store=createCommunicationStore();store.setEnabled(true);
 const clock={setTimeout:((fn:any)=>{fire=fn;return 1;}) as any,clearTimeout:((()=>{}) as any)};
 const runtime=createDiscoveryRuntime({root,sessionId:'s',config:parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']}),context:()=>'task',persist(){},observe:m=>store.beginDiscovery(m),clock,service:{evaluate(r:any){n++;if(n===1)return answer(r);entered();return new Promise(resolve=>{release=()=>resolve(answer(r));});}}});
 t.after(()=>{runtime.dispose();rmSync(root,{recursive:true,force:true});});
 const job=(paths:string[],canRead:(full:string)=>boolean)=>({owner:'hub',paths,task:'rounding',query:'search',discoveryComplete:true,canDisplay:()=>true,canRead,permissionIdentity:()=>'p'});
 const mixed=runtime.rank(job(['docs/b','docs/c'],()=>true));
 assert.equal(await Promise.race([ready.then(()=>'entered'),mixed.then(()=>'early')]),'entered');
 fire();const partial=await mixed;assert.equal(partial.status,'partial');
 assert.equal(partial.rows.find((r:any)=>r.status==='scored')?.path,'docs/b');assert.equal(partial.rows.find((r:any)=>r.status==='unscored')?.reason,'deadline');
 assert.equal(store.snapshot().at(-1)!.status,'partial');assert.notEqual(store.snapshot().at(-1)!.status,'cancelled');
 release();
 const denied=await runtime.rank(job(['docs/a','docs/b'],full=>!full.endsWith('/docs/a')));
 if(!denied.rows.some((r:any)=>r.path==='docs/b'&&(r.status==='scored'||r.status==='cached')))throw Error('denied rows '+JSON.stringify(denied.rows));
 assert.equal(denied.rows.length,2);assert.ok(denied.rows.some((r:any)=>r.path==='docs/a'&&r.reason==='denied'&&r.hash===undefined));assert.ok(denied.rows.some((r:any)=>r.path==='docs/b'&&(r.status==='scored'||r.status==='cached')));
 assert.ok(!JSON.stringify(denied).includes('safe cause bytes'));
});
test('one deadline waiter and one explicit abort leave an independent shared waiter scored and the last waiter aborts shared work',async t=>{
 let calls=0,aborts=0,release=()=>{},entered!:()=>void,attached=0,joined!:()=>void;const ready=new Promise<void>(r=>entered=r),allAttached=new Promise<void>(r=>joined=r);
 const f=fixture(t,{evaluate(r:any){calls++;r.signal.addEventListener('abort',()=>aborts++);entered();return new Promise(resolve=>{release=()=>resolve(answer(r));});}});
 const track=(job:any)=>{let reads=0;Object.defineProperty(job,'customQuestions',{get(){if(++reads===2){attached++;if(attached===3)joined();}return [];}});return job;};
 const deadline=new AbortController(),cancel=new AbortController();
 const healthy=f.runtime.rank(track(f.job('healthy',['docs/a'])));
 const expired=f.runtime.rank(track(f.job('expired',['docs/a'],{signal:deadline.signal})));
 const aborted=f.runtime.rank(track(f.job('aborted',['docs/a'],{signal:cancel.signal})));
 assert.equal(await Promise.race([ready.then(()=>'entered'),healthy.then(()=>'early')]),'entered');
 await Promise.race([allAttached,new Promise((_,reject)=>setTimeout(()=>reject(Error('waiters did not attach')),3000))]);
 deadline.abort(DISCOVERY_DEADLINE);cancel.abort();
 const [expiredResult,abortedResult]=await Promise.all([expired,aborted]);
 assert.equal(aborts,0);assert.equal(calls,1);
 assert.equal(expiredResult.status,'unavailable');assert.equal(expiredResult.rows[0].reason,'deadline');assert.equal(expiredResult.rows.length,1);
 assert.equal(abortedResult.status,'cancelled');assert.equal(abortedResult.rows[0].reason,'cancelled');
 release();const kept=await healthy;
 assert.equal(kept.status,'complete');assert.equal(kept.rows[0].status,'scored');assert.equal(calls,1);
 entered=()=>{};const again=new Promise<void>(r=>entered=r);const last=new AbortController();
 const alone=f.runtime.rank(f.job('last',['docs/b'],{signal:last.signal}));
 assert.equal(await Promise.race([again.then(()=>'entered'),alone.then(()=>'early')]),'entered');
 last.abort();assert.equal((await alone).status,'cancelled');assert.ok(aborts>=1);release();await delay(20);assert.equal(calls,2);
});
