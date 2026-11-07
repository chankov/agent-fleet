import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {confirmTaskTriageAction,consumeActionGrant} from './task-triage-authorization.ts';
import {PermissionRelay,raceExactPermission,registerPermissionRelay,permissionRelayFor} from './permission-relay.ts';
const owner={project:'fixture',peer:'hub',sessionId:'session',startedAt:'2026-11-04T00:00:00Z'};
const input={command:'echo fixture'},action={taskId:'task',inputRevision:'revision',actionId:'call',operation:'bash' as const,target:createHash('sha256').update(JSON.stringify(input)).digest('hex'),cwd:'/tmp',owner:'hub',attempt:'attempt'};
const list=(relay:any)=>{let response:any;relay.handle({end(text:string){response=JSON.parse(text);}}, {type:'permission_request',version:1,msg_id:'list',owner,operation:'list',payload:{},sender_session:'fixture',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()});return response.requests;};
test('baseline/triage use one shared exact-action latch; machine winner never acquires human scope/memory',async()=>{
 assert.equal(permissionRelayFor(undefined),undefined);assert.equal(permissionRelayFor(null),undefined);
 const relay=new PermissionRelay(()=>owner);const bus={};registerPermissionRelay(bus,relay);assert.equal(permissionRelayFor(bus),relay);
 let humanResolve:any;const pending=raceExactPermission(relay,action,input,()=>true,Date.now()+2000,()=>new Promise(r=>{humanResolve=r;}),()=>{});
 const [row]=list(relay);assert.ok(row);
 const socket={end() {}};relay.handle(socket as any,{type:'permission_request',version:1,msg_id:'decide',owner,operation:'decide',payload:{snapshot:row.snapshot,decision:'allow_once',reason:'fixture exact necessity',principal:{actor:'codex_machine',bindingId:'fixture',bindingEpoch:'epoch',threadId:'thread',turnId:null,approve:true}},sender_session:'fixture',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()});
 const grant=await pending;assert.equal(grant?.source,'codex_machine');assert.equal(grant?.localValue,undefined);assert.equal(grant?.consume(),true);assert.equal(grant?.consume(),false);humanResolve({decision:'allow_once',value:'allow_session'});
});
test('real triage action uses the latch and persists an exact one-use grant, not a human waiver',async()=>{
 const relay=new PermissionRelay(()=>owner),input={path:'/tmp/fixture.txt',content:'fixture'};
 const bound={...action,operation:'write' as const,target:createHash('sha256').update(JSON.stringify(input)).digest('hex')};let persisted=0;
 const pending=confirmTaskTriageAction(bound,{relay,permissionAudit(){},taskId:()=>bound.taskId,inputRevision:()=>bound.inputRevision,ask:()=>new Promise(()=>{}),startWait(){},endWait(){}},{cwd:'/tmp',sessionManager:{getEntries:()=>[]}} as any,()=>{persisted++;return true;},undefined,{input,cwd:'/tmp'});
 const [row]=list(relay);assert.ok(row);
 relay.handle({end(){}} as any,{type:'permission_request',version:1,msg_id:'decide',owner,operation:'decide',payload:{snapshot:row.snapshot,decision:'allow_once',reason:'fixture action necessity',principal:{actor:'codex_machine',bindingId:'fixture',bindingEpoch:'epoch',threadId:'thread',turnId:null,approve:true}},sender_session:'fixture',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()});
 const grant=await pending;assert.ok(grant);assert.equal(persisted,1);assert.equal(consumeActionGrant(grant,bound),true);assert.equal(consumeActionGrant(grant,bound),false);
});

test('audit failure and changed input burn baseline/triage authority without becoming human denial',async()=>{
 for(const fail of ['audit','changed']){let current=true;const relay=new PermissionRelay(()=>owner);
 const result=await raceExactPermission(relay,action,input,()=>current,Date.now()+1000,async()=>({decision:'allow_once',value:'once'}),()=>{if(fail==='audit')throw Error('fixture audit');});
 if(fail==='audit')assert.equal(result,null);else{current=false;assert.equal(result?.consume(),false);current=true;assert.equal(result?.consume(),false);}}
});
