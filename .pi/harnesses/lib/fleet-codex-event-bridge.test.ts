import test from 'node:test';
import assert from 'node:assert/strict';
import {FleetCodexEventBridge,type AddressedFleetEvent,type CodexEventBinding} from './fleet-codex-event-bridge.ts';
const binding:CodexEventBinding={id:'b1',epoch:'e1',hostInstance:'host',threadId:'desktop-test-chat',fleetOwner:'project/hub/session/start'};
const event=(id:string,kind:AddressedFleetEvent['kind']='message'):AddressedFleetEvent=>({id,kind,bindingId:'b1',bindingEpoch:'e1',fleetOwner:binding.fleetOwner,createdAt:Date.now(),deadline:Date.now()+1000,reference:'synthetic-reference-only'});
const tick=()=>new Promise(r=>setImmediate(r));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

test('all addressed event kinds drive only the bound thread without a scheduler or watch',async()=>{
 const delivered:string[]=[];const bridge=new FleetCodexEventBridge({verify:async b=>b.threadId===binding.threadId,deliverExternal:async(b,e)=>{delivered.push(b.threadId+':'+e.kind);return {status:'host_accepted',turnId:'fixture-turn'};}});
 bridge.bind(binding);bridge.bind({...binding,id:'other',threadId:'control-chat'});
 for(const kind of ['message','question','permission'] as const)bridge.accept(event(kind,kind));
 await tick();assert.deepEqual(delivered,['desktop-test-chat:message','desktop-test-chat:question','desktop-test-chat:permission']);
 assert.equal(bridge.receipt('message').status,'host_accepted');
 const duplicate=event('same');bridge.accept(duplicate);bridge.accept(duplicate);await tick();assert.equal(delivered.length,4);
 assert.equal(bridge.accept({...duplicate,reference:'changed'}).status,'conflict');
 assert.equal(bridge.accept({...event('stale'),bindingEpoch:'old'}).status,'stale');
});

test('unsupported Desktop proof cannot be replaced by a successful own app-server fixture',async()=>{
 let sends=0;const bridge=new FleetCodexEventBridge({verify:async()=>false,deliverExternal:async()=>{sends++;return {status:'host_accepted',turnId:'own-server'};}});
 bridge.bind(binding);bridge.accept(event('unsupported'));await tick();assert.equal(sends,0);assert.equal(bridge.receipt('unsupported').status,'unsupported');
});

test('ACK loss/duplicate never retries; rebound epoch does not inherit old response',async()=>{
 let sends=0,finish!:(v:any)=>void;
 const bridge=new FleetCodexEventBridge({verify:async()=>true,deliverExternal:async()=>{sends++;return new Promise(r=>{finish=r;});}});bridge.bind(binding);
 const first=event('loss');bridge.accept(first);await tick();bridge.bind({...binding,epoch:'e2'});finish({status:'host_accepted',turnId:'old-turn'});await tick();
 assert.equal(bridge.receipt('loss').status,'unknown');bridge.accept(first);await tick();assert.equal(sends,1);
});

test('queued expiry and hung host delivery are bounded by the original deadline',async()=>{
 let calls=0;
 const bridge=new FleetCodexEventBridge({verify:async()=>true,deliverExternal:async()=>{calls++;return new Promise(()=>{});}});bridge.bind(binding);
 bridge.accept({...event('hung'),deadline:Date.now()+35});bridge.accept({...event('queued'),deadline:Date.now()+20});
 await sleep(60);assert.equal(bridge.receipt('hung').status,'unknown');assert.equal(bridge.receipt('queued').status,'expired');assert.equal(calls,1);
});

test('unbind while verifying, stale owner and overflow refuse without broadcast',async()=>{
 let verify!:(v:boolean)=>void,calls=0;
 const bridge=new FleetCodexEventBridge({verify:async()=>new Promise(r=>{verify=r;}),deliverExternal:async()=>{calls++;return {status:'host_accepted',turnId:'t'};}},1);bridge.bind(binding);
 bridge.accept(event('first'));await tick();bridge.unbind(binding.id);verify(true);await tick();assert.equal(calls,0);assert.equal(bridge.receipt('first').status,'stale');
 bridge.bind(binding);assert.equal(bridge.accept(event('overflow')).status,'full');assert.equal(bridge.accept({...event('foreign'),fleetOwner:'other'}).status,'stale');
});
