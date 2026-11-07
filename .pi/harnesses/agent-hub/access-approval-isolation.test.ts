import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import test from 'node:test';
import {createAccessApprovalRouter} from './access-approval.ts';
import type {AccessRequest} from '../lib/damage-control-shared.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = (ms:number) => new Promise(resolve => setTimeout(resolve,ms));
function request(msg_id: string): AccessRequest {
 return {type:'access_request',msg_id,sender_session:'builder',sender_endpoint:'',hops:0,timestamp:new Date().toISOString(),agent:'builder',tool:'bash',rule:'protected delete',pattern:'.github/',category:'no_delete',invocation:'rm .github/a'};
}
function socket() {
 let output='';
 return Object.assign(new EventEmitter(), {write(chunk:string){output+=chunk;},end(){},output:()=>output});
}

test('disconnect of first coalesced requester does not cancel the live second requester', async () => {
 let answer!: (choice:string)=>void;
 let signal:AbortSignal|undefined;
 let asks=0;
 const router=createAccessApprovalRouter({
  getContext:()=>({hasUI:true,ui:{notify(){},select(_title,_options,settings){asks++;signal=settings.signal;return new Promise(resolve=>{answer=resolve;});}}}),
  getExemptionsFile:()=>undefined,appendLog(){},now:()=>new Date().toISOString(),
 });
 const first=socket(),second=socket();
 const a=router.handle(first,request('first'));
 await tick();
 const b=router.handle(second,request('second'));
 await tick();
 first.emit('close');
 const cancelled=signal?.aborted;
 answer('Allow once');
 await Promise.all([a,b]);
 assert.equal(cancelled,false);
 assert.equal(asks,1);
 assert.equal(first.output(),'');
 assert.equal(JSON.parse(second.output()).decision,'allow_once');
});

test('deadline bounds the shared dialog and late broad approval cannot persist', async () => {
 let answer!: (choice:string)=>void;
 let signal:AbortSignal|undefined;
 let timeout=0;
 const logs: unknown[]=[];
 const router=createAccessApprovalRouter({
  getContext:()=>({hasUI:true,ui:{notify(){},select(_title,_options,settings){timeout=settings.timeout;signal=settings.signal;return new Promise(resolve=>{answer=resolve;});}}}),
  getExemptionsFile:()=>undefined,appendLog(entry){logs.push(entry);},now:()=>new Date().toISOString(),
 });
 const first=socket();
 const a=router.handle(first,{...request('first'),category:'read_only',deadline:Date.now()+80});
 await tick();
 assert.ok(timeout>0 && timeout<=60_000);
 await sleep(100);
 await a;
 assert.equal(signal?.aborted,true);
 answer('Allow for all agents (this session)');
 await tick();
 assert.equal(JSON.parse(first.output()).outcome,'expired');
 assert.deepEqual(logs,[]);
});

test('expiry of the first requester leaves the second requester and shared dialog live', async () => {
 let answer!: (choice:string)=>void;let signal:AbortSignal|undefined;
 const router=createAccessApprovalRouter({
  getContext:()=>({hasUI:true,ui:{notify(){},select(_title,_options,settings){signal=settings.signal;return new Promise(resolve=>{answer=resolve;});}}}),
  getExemptionsFile:()=>undefined,appendLog(){},now:()=>new Date().toISOString(),
 });
 const first=socket(),second=socket();
 const a=router.handle(first,{...request('first'),deadline:Date.now()+50});await tick();
 const b=router.handle(second,{...request('second'),deadline:Date.now()+1000});await tick();
 await sleep(70);await a;
 assert.equal(signal?.aborted,false);
 answer('Allow once');await b;
 assert.equal(JSON.parse(second.output()).decision,'allow_once');
});

test('an early timer wake keeps the request pending until its original deadline', async t => {
 t.mock.timers.enable({apis:['setTimeout']});
 let now=1_000_000;
 t.mock.method(Date,'now',()=>now);
 let answer:((choice:string)=>void)|undefined;
 let signal:AbortSignal|undefined;
 const logs:unknown[]=[];
 const router=createAccessApprovalRouter({
  getContext:()=>({hasUI:true,ui:{notify(){},select(_title,_options,settings){signal=settings.signal;return new Promise(resolve=>{answer=resolve;});}}}),
  getExemptionsFile:()=>undefined,appendLog(entry){logs.push(entry);},now:()=>new Date().toISOString(),
 });
 t.after(()=>{answer?.('Allow for all agents (this session)');router.reset();});
 const first=socket(),deadline=now+80;
 const pending=router.handle(first,{...request('early-wake'),category:'read_only',deadline});
 await tick();
 // The timer clock can reach its wake while the wall clock is one ms earlier.
 now=deadline-1;
 t.mock.timers.tick(80);
 await tick();
 const beforeDeadline={output:first.output(),aborted:signal?.aborted};
 now=deadline;
 t.mock.timers.tick(1);
 await pending;
 answer?.('Allow for all agents (this session)');
 await tick();
 assert.deepEqual(beforeDeadline,{output:'',aborted:false});
 assert.equal(JSON.parse(first.output()).outcome,'expired');
 assert.deepEqual(logs,[]);
});

test('already expired request does not open a dialog', async () => {
 let asks=0;
 const router=createAccessApprovalRouter({
  getContext:()=>({hasUI:true,ui:{notify(){},async select(){asks++;return 'Allow once';}}}),
  getExemptionsFile:()=>undefined,appendLog(){},now:()=>new Date().toISOString(),
 });
 const first=socket();await router.handle(first,{...request('expired'),deadline:Date.now()-1});
 assert.equal(asks,0);
 assert.equal(JSON.parse(first.output()).decision,'deny');
});

for(const choice of ['Allow once','Allow for all agents (this session)']){
 test('deadline crossed during audit refuses '+choice+' without persisting scope', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let now=1_000_000;
  t.mock.method(Date,'now',()=>now);
  const root=mkdtempSync(join(tmpdir(),'af-deadline-')),file=join(root,'exemptions.json');
  writeFileSync(file,'[]');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const deadline=now+80;
  const router=createAccessApprovalRouter({
   getContext:()=>({hasUI:true,ui:{notify(){},async select(){return choice;}}}),
   getExemptionsFile:()=>file,appendLog(){now=deadline+1;},now:()=>new Date().toISOString(),
  });
  t.after(()=>router.reset());
  const first=socket();
  await router.handle(first,{...request('audit-edge'),category:'read_only',deadline});
  const reply=JSON.parse(first.output());
  assert.deepEqual({decision:reply.decision,outcome:reply.outcome??null,exemptions:JSON.parse(readFileSync(file,'utf8'))},
   {decision:'deny',outcome:'expired',exemptions:[]});
 });
}

test('deadline crossed during final notification cannot send a late allow-once', async t => {
 t.mock.timers.enable({apis:['setTimeout']});
 let now=1_000_000;
 t.mock.method(Date,'now',()=>now);
 const deadline=now+80;
 const router=createAccessApprovalRouter({
  getContext:()=>({hasUI:true,ui:{notify(message){if(message.includes('Access granted'))now=deadline+1;},async select(){return 'Allow once';}}}),
  getExemptionsFile:()=>undefined,appendLog(){},now:()=>new Date().toISOString(),
 });
 t.after(()=>router.reset());
 const first=socket();
 await router.handle(first,{...request('response-edge'),deadline});
 const reply=JSON.parse(first.output());
 assert.deepEqual({decision:reply.decision,outcome:reply.outcome??null},{decision:'deny',outcome:'expired'});
});

for(const fireTimer of [true,false]){
 test('clock rollback cannot extend the original budget; timer fired='+fireTimer, async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let wall=1_000_000,elapsed=0;
  t.mock.method(Date,'now',()=>wall);
  t.mock.method(performance,'now',()=>elapsed);
  let answer:((choice:string)=>void)|undefined;
  const router=createAccessApprovalRouter({
   getContext:()=>({hasUI:true,ui:{notify(){},select(){return new Promise(resolve=>{answer=resolve;});}}}),
   getExemptionsFile:()=>undefined,appendLog(){},now:()=>new Date().toISOString(),
  });
  t.after(()=>{answer?.('Allow once');router.reset();});
  const first=socket();
  const pending=router.handle(first,{...request('rollback'),deadline:wall+80});
  await tick();
  wall-=100;elapsed=81;
  if(fireTimer)t.mock.timers.tick(80);
  await tick();
  answer?.('Allow once');await pending;
  const reply=JSON.parse(first.output());
  assert.deepEqual({decision:reply.decision,outcome:reply.outcome??null},{decision:'deny',outcome:'expired'});
 });
}

for(const fireTimer of [true,false]){
 test('rollback during startup keeps the first observed budget; timer fired='+fireTimer, async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const initialWall=1_000_000;
  let reads=0,elapsed=0;
  t.mock.method(Date,'now',()=>++reads===1?initialWall:initialWall-100);
  t.mock.method(performance,'now',()=>elapsed);
  let answer:((choice:string)=>void)|undefined,signal:AbortSignal|undefined;
  const router=createAccessApprovalRouter({
   getContext:()=>({hasUI:true,ui:{notify(){},select(_title,_options,settings){signal=settings.signal;return new Promise(resolve=>{answer=resolve;});}}}),
   getExemptionsFile:()=>undefined,appendLog(){},now:()=>new Date().toISOString(),
  });
  t.after(()=>{answer?.('Allow once');router.reset();});
  const first=socket();
  const pending=router.handle(first,{...request('startup-rollback'),deadline:initialWall+80});
  await tick();
  elapsed=81;
  if(fireTimer)t.mock.timers.tick(80);
  await tick();
  const expiredBeforeAnswer=signal?.aborted;
  answer?.('Allow once');await pending;
  const reply=JSON.parse(first.output());
  assert.deepEqual({decision:reply.decision,outcome:reply.outcome??null},{decision:'deny',outcome:'expired'});
  if(fireTimer)assert.equal(expiredBeforeAnswer,true);
 });
}

test('disconnect of all coalesced requesters aborts shared UI without caching a denial', async () => {
 let answer!: (choice:string)=>void;
 let signal:AbortSignal|undefined;
 let asks=0;
 const router=createAccessApprovalRouter({
  getContext:()=>({hasUI:true,ui:{notify(){},select(_title,_options,settings){asks++;signal=settings.signal;return new Promise(resolve=>{answer=resolve;});}}}),
  getExemptionsFile:()=>undefined,appendLog(){},now:()=>new Date().toISOString(),
 });
 const first=socket(),second=socket();
 const a=router.handle(first,request('first'));
 await tick();
 const b=router.handle(second,request('second'));
 await tick();
 first.emit('close');second.emit('close');
 assert.equal(signal?.aborted,true);
 answer('Deny (keep blocked)');
 await Promise.all([a,b]);
 const third=socket();
 const c=router.handle(third,request('third'));
 await tick();
 assert.equal(asks,2);
 answer('Allow once');await c;
 assert.equal(JSON.parse(third.output()).decision,'allow_once');
});
