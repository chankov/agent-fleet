import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RelayLatencyTrace,runLatencySeries,captureLatencyEmission} from './lib/fleet-codex-relay-latency.ts';
import {replyFleetEvent as rawReplyFleetEvent} from './lib/fleet-codex-event-reply.ts';
import {targetKey} from './lib/fleet-codex-instruction-store.ts';
import {LocalCodexMcp,McpFault} from './lib/fleet-codex-local-mcp.ts';
import {PermissionRelay} from '../../harnesses/agent-hub/permission-relay.ts';
import {createDamageApproval} from '../../harnesses/agent-hub/damage-guard-approval.ts';
import {createAccessApprovalRouter} from '../../harnesses/agent-hub/access-approval.ts';
import {requestAccessFromHub,readExemptionsFile,type AccessRequest} from '../../harnesses/lib/damage-control-shared.ts';
import {createDamageState} from '../../harnesses/agent-hub/damage-guard-state.ts';
const threadId='11111111-1111-4111-8111-111111111111';
function replyFleetEvent(event:any,target:any,reply:any,ports:any){return rawReplyFleetEvent(event,target,reply,{nativeIdentity:()=>({threadId,identityAssurance:'host_context_validated'}),...ports});}
const owner={project:'fixture',peer:'hub',sessionId:'session',startedAt:new Date().toISOString()};
const selector={project:owner.project,peer:owner.peer};
const input={command:'echo synthetic-permission-fixture'};
const action={taskId:'task-fixture',inputRevision:'r1',operation:'bash' as const,target:createHash('sha256').update(JSON.stringify(input)).digest('hex'),cwd:'/repo',actionId:'tool-call-fixture',owner:'hub',attempt:'attempt-fixture'};
const tick=()=>new Promise(r=>setImmediate(r));
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'permission-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const registryRoot=join(root,'registry'),policyRoot=join(root,'policy');
 await mkdir(join(registryRoot,'sockets'),{recursive:true,mode:0o700});
 let activeOwner={...owner},drop=false,decisions=0;let childRouter:ReturnType<typeof createAccessApprovalRouter>|undefined;const relay=new PermissionRelay(()=>activeOwner);
 const server=createServer(socket=>{let data='';socket.on('data',chunk=>{data+=chunk;if(!data.includes('\n'))return;const envelope=JSON.parse(data.split('\n')[0]);if(envelope.type==='access_request'){void childRouter?.handle(socket,envelope);return;}assert.equal(envelope.sender_session,'local-codex-permission');if(envelope.operation==='decide'){decisions++;if(drop){drop=false;socket.end=(()=>{socket.destroy();return socket;}) as any;}}if(!relay.handle(socket,envelope))socket.end();});});
 await new Promise<void>(r=>server.listen(join(registryRoot,'sockets',owner.sessionId+'.sock'),r));
 t.after(()=>{relay.reset();server.close();});
 const options={registryRoot,policyRoot,hostProfile:'fixture-native-host',principal:'fixture-owner',registryReader:async()=>({status:'complete' as const,partial:false,reasons:[],observedAt:new Date().toISOString(),entriesSeen:1,candidates:[{target:{...activeOwner},heartbeatAt:new Date().toISOString(),presence:'fresh' as const}]})};
 const service=new LocalCodexMcp(options);
 const call=(name:string,args:any)=>service.call(name,args,{threadId});
 async function binding(intent:string){const p:any=await call('fleet_binding_prepare',{intent,...selector});if(p.status==='already_bound')return p;await call('fleet_binding_commit',{proposalId:p.proposalId});return p;}
 await binding('enroll_read');
 return {root,relay,call,binding,options,setChildRouter:(router:ReturnType<typeof createAccessApprovalRouter>)=>{childRouter=router;},endpoint:join(registryRoot,'sockets',owner.sessionId+'.sock'),dropNextDecision:()=>{drop=true;},decisions:()=>decisions,changeOwner:()=>{activeOwner={...owner,sessionId:'new-session'};}};
}
async function waitSnapshot(call:any){for(let i=0;i<30;i++){const r=await call('fleet_permissions',{target:owner,operation:'list',snapshot:null});if(r.requests.length)return r.requests[0].snapshot;await tick();}throw Error('no pending permission');}

test('E5 local 20x5/30/60-second harness measures emission to real Pi consume, NEVER model SLO',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');
 const binding={id:'latency-binding',epoch:'latency-epoch',hostInstance:'fixture',threadId,fleetOwner:targetKey(owner)};
 for(const budget of [5000,30000,60000]){
  let current=action;const approval=createDamageApproval({state:createDamageState(()=>{}),current:()=>current,baseline:()=>true,relay:f.relay,audit(){},timeoutMs:budget,ask:async()=>{throw Error('fixture no UI');}});
  const report=await runLatencySeries({mode:'fixture_no_model',count:20,run:async index=>{
   current={...action,actionId:'latency-'+budget+'-'+index};const emission=captureLatencyEmission(),waiting=approval.request(current,input),snapshot=await waitSnapshot(f.call);
   const trace=new RelayLatencyTrace('latency-'+budget+'-'+index,snapshot.expiresAt,'fixture_no_model',emission);
   const event={id:'latency-'+budget+'-'+index,kind:'permission' as const,bindingId:binding.id,bindingEpoch:binding.epoch,fleetOwner:binding.fleetOwner,createdAt:emission.wallMs,deadline:snapshot.expiresAt,reference:'fleet:permission/'+snapshot.id};
   await replyFleetEvent(event,owner,{kind:'permission',decision:'allow_once',reason:'fixture task needs its exact harmless latency action'},{currentBinding:()=>binding,invoke:f.call});trace.mark('decision_returned');
   const grant=await waiting;if(grant.status!=='allowed'||!approval.consume(grant.grant,current))throw Error('fixture not applied');trace.mark('pi_applied');return trace.finish('applied');
  }});
  assert.equal(report.count,20);assert.equal(report.deadlineMisses,0);assert.equal(report.noModelSloEvidence,true);assert.equal(report.modelObservedMs,null);
  t.diagnostic(JSON.stringify({mode:'fixture_no_model',budgetMs:budget,count:report.count,piAppliedMs:report.piAppliedMs,deadlineMisses:report.deadlineMisses,scope:'authority_consumption_no_tool_completion_no_desktop_no_model'}));
 }
});

test('E4 synthetic host reply uses actual native tools/socket and reaches D6 consume once',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');
 const approval=createDamageApproval({state:createDamageState(()=>{}),current:()=>action,baseline:()=>true,relay:f.relay,audit(){},timeoutMs:3000,ask:async()=>{throw Error('fixture no human');}});
 const waiting=approval.request(action,input),snapshot=await waitSnapshot(f.call);
 const binding={id:'event-binding',epoch:'event-epoch',hostInstance:'fixture',threadId,fleetOwner:targetKey(owner)};
 const event={id:'event-reply',kind:'permission' as const,bindingId:binding.id,bindingEpoch:binding.epoch,fleetOwner:binding.fleetOwner,createdAt:Date.now(),deadline:snapshot.expiresAt,reference:'fleet:permission/'+snapshot.id};
 const result=await replyFleetEvent(event,owner,{kind:'permission',decision:'allow_once',reason:'synthetic task-fixture r1 requires this exact fixture action'},{currentBinding:()=>binding,invoke:f.call});
 assert.equal(result.status,'machine_decision_returned');assert.equal(result.humanConsent,false);assert.equal(result.piEffect,'not_established');
 const grant=await waiting;assert.equal(grant.status,'allowed');if(grant.status!=='allowed')throw Error('fixture grant missing');assert.equal(approval.consume(grant.grant,action),true);assert.equal(approval.consume(grant.grant,action),false);
});

test('native MCP -> real Unix socket -> D6 one-use enforcement, separate approve, durable replay fence',async t=>{
 const f=await fixture(t);let current=action;const records:any[]=[];
 const approval=createDamageApproval({state:createDamageState(()=>{}),current:()=>current,baseline:()=>true,relay:f.relay,audit:r=>records.push(r),timeoutMs:3000,ask:async()=>{throw Error('fixture has no UI');}});
 const waiting=approval.request(action,input);
 const snapshot=await waitSnapshot(f.call);
 const detail:any=await f.call('fleet_permissions',{target:owner,operation:'inspect',snapshot});
 assert.match(detail.view.detail,/synthetic-permission-fixture/);assert.equal(detail.view.action.taskId,action.taskId);
 const args={requestId:'decision-1',snapshot,decision:'allow_once',reason:'Required to execute the synthetic fixture assigned in task-fixture r1'};
 await assert.rejects(f.call('fleet_permission_decide',args),(e:any)=>e instanceof McpFault&&e.code==='APPROVE_NOT_GRANTED');
 await f.binding('grant_send');
 await assert.rejects(f.call('fleet_permission_decide',args),(e:any)=>e.code==='APPROVE_NOT_GRANTED');
 const preview:any=await f.binding('grant_approve');assert.deepEqual(preview.proposedRights,['read','send','approve']);assert.equal(preview.policyFormatAfter,2);
 const result:any=await f.call('fleet_permission_decide',args);
 assert.equal(result.operation,'permission');assert.equal(result.humanProvenance,'not_human');assert.equal(result.reservation.result.status,'accepted_by_latch');
 const grant=await waiting;assert.equal(grant.status,'allowed');
 if(grant.status!=='allowed')throw Error('missing grant');
 let effects=0;
 for(let attempt=0;attempt<2;attempt++)if(approval.consume(grant.grant,action)){effects++;assert.equal(execFileSync('/bin/echo',['synthetic-permission-fixture'],{encoding:'utf8'}).trim(),'synthetic-permission-fixture');}
 assert.equal(effects,1);
 const receipt:any=await f.call('fleet_permissions',{target:owner,operation:'receipt',snapshot});assert.equal(receipt.effect,'consumed');assert.equal(receipt.state.source,'codex_machine');assert.equal(receipt.state.threadId,threadId);assert.equal(receipt.state.turnId,null);assert.ok(receipt.timings.appliedAt>=receipt.timings.decisionAt);assert.ok(receipt.timings.decisionAt>=receipt.timings.createdAt);
 assert.equal(records[0].source,'codex_machine');assert.equal(records[0].reason,undefined);assert.equal(records[0].reasonDigest,createHash('sha256').update(args.reason).digest('hex'));
 assert.deepEqual(await f.call('fleet_permission_decide',args),result);
 const restarted=new LocalCodexMcp(f.options);assert.deepEqual(await restarted.call('fleet_permission_decide',args,{threadId}),result);
 await assert.rejects(f.call('fleet_permission_decide',{...args,reason:'changed'}),(e:any)=>e.code==='INTENT_CONFLICT');
 const revoke:any=await f.binding('revoke_send');assert.deepEqual(revoke.proposedRights,['read','approve']);
 const raw:any=JSON.parse(await readFile(join(f.options.policyRoot,createHash('sha256').update(JSON.stringify([f.options.hostProfile,f.options.principal,threadId])).digest('hex')+'.json'),'utf8'));assert.equal(raw.version,2);
 current={...action,attempt:'different'};
});

test('machine cannot override a durable human denial, changed revision or expired latch',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');
 const state=createDamageState(()=>{});state.deny(action);
 const denied=createDamageApproval({state,current:()=>action,baseline:()=>true,relay:f.relay,timeoutMs:80,ask:async()=>({})});
 assert.equal((await denied.request(action,input)).status,'cancelled');
 const list:any=await f.call('fleet_permissions',{target:owner,operation:'list',snapshot:null});assert.deepEqual(list.requests,[]);
 let current=action;
 const stale=createDamageApproval({state:createDamageState(()=>{}),current:()=>current,baseline:()=>true,relay:f.relay,timeoutMs:80,ask:async()=>{throw Error('headless');}});
 const pending=stale.request(action,input);const snapshot=await waitSnapshot(f.call);current={...action,inputRevision:'r2'};
 await assert.rejects(f.call('fleet_permission_decide',{requestId:'stale-1',snapshot,decision:'allow_once',reason:'fixture reason'}),(e:any)=>e.code==='PERMISSION_NOT_PENDING');
 assert.equal((await pending).status,'cancelled');
});

test('lost ACK is durable unknown; receipt reconciliation sees consumed authority but decide never resends',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');
 const approval=createDamageApproval({state:createDamageState(()=>{}),current:()=>action,baseline:()=>true,relay:f.relay,timeoutMs:1000,ask:async()=>{throw Error('headless');}});
 const pending=approval.request(action,input);const snapshot=await waitSnapshot(f.call);f.dropNextDecision();
 const args={requestId:'lost-ack',snapshot,decision:'allow_once',reason:'Required for task-fixture synthetic test'};
 const receipt:any=await f.call('fleet_permission_decide',args);assert.equal(receipt.reservation.state,'unknown');assert.equal(receipt.reservation.attempted,true);
 const grant=await pending;assert.equal(grant.status,'allowed');if(grant.status==='allowed')assert.equal(approval.consume(grant.grant,action),true);
 const inspected:any=await f.call('fleet_permissions',{target:owner,operation:'receipt',snapshot});assert.equal(inspected.effect,'consumed');assert.equal(inspected.effectScope,'one_use_authority_not_tool_completion');
 const restarted=new LocalCodexMcp(f.options);assert.deepEqual(await restarted.call('fleet_permission_decide',args,{threadId}),receipt);assert.equal(f.decisions(),1);
 assert.deepEqual(await restarted.call('fleet_permission_receipt',{requestId:args.requestId},{threadId}),receipt);
 const foreign:any=await restarted.call('fleet_permission_receipt',{requestId:args.requestId},{threadId:'22222222-2222-4222-8222-222222222222'});assert.equal(foreign.status,'unknown');
 await f.binding('revoke_approve');assert.deepEqual(await f.call('fleet_permission_receipt',{requestId:args.requestId}),receipt);assert.equal(f.decisions(),1);
});

test('revocation preserves send, drops approve, and old grant cannot be consumed after original deadline',async t=>{
 const f=await fixture(t);await f.binding('grant_send');await f.binding('grant_approve');
 const approval=createDamageApproval({state:createDamageState(()=>{}),current:()=>action,baseline:()=>true,relay:f.relay,timeoutMs:500,ask:async()=>{throw Error('headless');}});
 const pending=approval.request(action,input);const snapshot=await waitSnapshot(f.call);
 const args={requestId:'expires-before-consume',snapshot,decision:'allow_once',reason:'Required for short-lived synthetic fixture'};
 await f.call('fleet_permission_decide',args);const grant=await pending;assert.equal(grant.status,'allowed');
 await new Promise(r=>setTimeout(r,Math.max(1,snapshot.expiresAt-Date.now()+10)));
 if(grant.status==='allowed')assert.equal(approval.consume(grant.grant,action),false);
 const receipt:any=await f.call('fleet_permissions',{target:owner,operation:'receipt',snapshot});assert.equal(receipt.effect,'not_applied');
 const revoke:any=await f.binding('revoke_approve');assert.deepEqual(revoke.proposedRights,['read','send']);
 const next={...action,attempt:'second',actionId:'second'};
 const other=createDamageApproval({state:createDamageState(()=>{}),current:()=>next,baseline:()=>true,relay:f.relay,timeoutMs:80,ask:async()=>{throw Error('headless');}});
 const waiting=other.request(next,input);const nextSnapshot=await waitSnapshot(f.call);
 await assert.rejects(f.call('fleet_permission_decide',{...args,requestId:'after-revoke',snapshot:nextSnapshot}),(e:any)=>e.code==='APPROVE_NOT_GRANTED');
 await waiting;
});

test('20 real local native/socket/enforcement probes measure transport latency, NOT Desktop/model latency',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');const durations:number[]=[];
 for(let i=0;i<20;i++){
  const current={...action,actionId:'latency-'+i,attempt:'latency-'+i};const start=performance.now();
  const approval=createDamageApproval({state:createDamageState(()=>{}),current:()=>current,baseline:()=>true,relay:f.relay,timeoutMs:5000,ask:async()=>{throw Error('headless');}});
  const pending=approval.request(current,input);const snapshot=await waitSnapshot(f.call);
  await f.call('fleet_permission_decide',{requestId:'latency-'+i,snapshot,decision:'allow_once',reason:'Synthetic fixture is explicitly necessary for task-fixture transport measurement'});
  const grant=await pending;assert.equal(grant.status,'allowed');if(grant.status==='allowed')assert.equal(approval.consume(grant.grant,current),true);
  durations.push(performance.now()-start);
 }
 durations.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({scope:'local_native_socket_enforcement_no_model',samples:20,p50ms:durations[9],p95ms:durations[18],maxMs:durations[19],misses:0}));
});

test('concurrent duplicate decisions have at most one send; intermediate history is unknown, never not_sent',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');
 const approval=createDamageApproval({state:createDamageState(()=>{}),current:()=>action,baseline:()=>true,relay:f.relay,timeoutMs:1000,ask:async()=>{throw Error('headless');}});
 const pending=approval.request(action,input);const snapshot=await waitSnapshot(f.call);
 const args={requestId:'concurrent',snapshot,decision:'allow_once',reason:'Required synthetic task fixture'};
 const outcomes=await Promise.allSettled([f.call('fleet_permission_decide',args),f.call('fleet_permission_decide',args)]);
 for(const o of outcomes)if(o.status==='fulfilled')assert.notEqual(o.value.reservation.state,'not_sent');
 const grant=await pending;if(grant.status==='allowed')assert.equal(approval.consume(grant.grant,action),true);else assert.fail(grant.status);
 assert.equal(f.decisions(),1);
 const receipt:any=await f.call('fleet_permission_decide',args);assert.equal(receipt.reservation.state,'result');
});

test('unbound second native chat cannot inspect/decide; reset after winning decision invalidates the old grant',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');const other='22222222-2222-4222-8222-222222222222';
 const approval=createDamageApproval({state:createDamageState(()=>{}),current:()=>action,baseline:()=>true,relay:f.relay,timeoutMs:1000,ask:async()=>{throw Error('headless');}});
 const pending=approval.request(action,input);const snapshot=await waitSnapshot(f.call);
 const args={requestId:'reset-test',snapshot,decision:'allow_once',reason:'Required synthetic task fixture'};
 const second=new LocalCodexMcp(f.options);
 await assert.rejects(second.call('fleet_permission_decide',args,{threadId:other}));assert.equal(f.decisions(),0);
 await f.call('fleet_permission_decide',args);const grant=await pending;assert.equal(grant.status,'allowed');f.relay.reset();
 if(grant.status==='allowed')assert.equal(approval.consume(grant.grant,action),false);
 const receipt:any=await f.call('fleet_permissions',{target:owner,operation:'receipt',snapshot});assert.equal(receipt.status,'unknown');
});

test('legacy child synthetic protocol request -> native machine decision -> allow once only, with spawn epoch and no exemption',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');let epoch='spawn-1';const logs:any[]=[];
 f.setChildRouter(createAccessApprovalRouter({relay:f.relay,taskIdentity:()=>({taskId:action.taskId,inputRevision:action.inputRevision}),currentChild:r=>r.agent==='builder'&&r.accessEpoch===epoch,getContext:()=>null,getExemptionsFile:()=>null,appendLog:r=>logs.push(r),now:()=>new Date().toISOString()}));
 const exactAction={tool:'bash',cwd:'/repo',input:{command:'echo synthetic_child_protocol'},category:'no_delete',pattern:'protected-fixture/'};
 const req:AccessRequest={type:'access_request',msg_id:'child-request',sender_session:'builder',sender_endpoint:'',hops:0,timestamp:new Date().toISOString(),agent:'builder',tool:'bash',rule:'synthetic fixture no-delete',category:'no_delete',pattern:'protected-fixture/',invocation:'echo synthetic_child_protocol',accessEpoch:epoch,exactAction,actionDigest:createHash('sha256').update(JSON.stringify(exactAction)).digest('hex')};
 const waiting=requestAccessFromHub(f.endpoint,req,1500);const snapshot=await waitSnapshot(f.call);
 await f.call('fleet_permission_decide',{requestId:'child-approval',snapshot,decision:'allow_once',reason:'Synthetic child protocol action is necessary for the explicitly assigned task-fixture'});
 assert.equal(await waiting,'allow_once');assert.equal(logs[0].decisionSource,'codex_machine');assert.equal(logs[0].permissionOutcome.threadId,threadId);
 const receipt:any=await f.call('fleet_permissions',{target:owner,operation:'receipt',snapshot});assert.equal(receipt.effect,'response_queued_unconfirmed');
 epoch='spawn-2';assert.equal(await requestAccessFromHub(f.endpoint,{...req,msg_id:'stale-child'},200),'error');
 const list:any=await f.call('fleet_permissions',{target:owner,operation:'list',snapshot:null});assert.deepEqual(list.requests,[]);
});

test('machine-capable child lane preserves an actual human agent-scope exemption, never relabels it machine',async t=>{
 const f=await fixture(t),file=join(f.root,'exemptions.json');
 f.setChildRouter(createAccessApprovalRouter({relay:f.relay,taskIdentity:()=>({taskId:action.taskId,inputRevision:action.inputRevision}),currentChild:()=>true,getContext:()=>({hasUI:true,ui:{notify(){},select:async()=> 'Allow for this agent (this session)'}}),getExemptionsFile:()=>file,appendLog(){},now:()=>new Date().toISOString()}));
 const exactAction={tool:'write',cwd:'/repo',input:{path:'fixture-protected/a',content:'synthetic'},category:'read_only',pattern:'fixture-protected/'};
 const req:AccessRequest={type:'access_request',msg_id:'human-scope',sender_session:'builder',sender_endpoint:'',hops:0,timestamp:new Date().toISOString(),agent:'builder',tool:'write',rule:'synthetic',category:'read_only',pattern:'fixture-protected/',invocation:'synthetic',accessEpoch:'spawn',exactAction,actionDigest:createHash('sha256').update(JSON.stringify(exactAction)).digest('hex')};
 assert.equal(await requestAccessFromHub(f.endpoint,req,1500),'allow_agent');
 assert.equal(readExemptionsFile(file)[0].agent,'builder');assert.equal(readExemptionsFile(file)[0].pattern,'fixture-protected/');
});

test('exemption file changed during pending child machine decision invalidates that exact request',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');const file=join(f.root,'exemptions.json');await writeFile(file,'[]');
 f.setChildRouter(createAccessApprovalRouter({relay:f.relay,taskIdentity:()=>({taskId:action.taskId,inputRevision:action.inputRevision}),currentChild:()=>true,getContext:()=>null,getExemptionsFile:()=>file,appendLog(){},now:()=>new Date().toISOString()}));
 const exactAction={tool:'write',cwd:'/repo',input:{path:'fixture-protected/a',content:'synthetic'},category:'read_only',pattern:'fixture-protected/'};
 const req:AccessRequest={type:'access_request',msg_id:'changed-scope',sender_session:'builder',sender_endpoint:'',hops:0,timestamp:new Date().toISOString(),agent:'builder',tool:'write',rule:'synthetic',category:'read_only',pattern:'fixture-protected/',invocation:'synthetic',accessEpoch:'spawn',exactAction,actionDigest:createHash('sha256').update(JSON.stringify(exactAction)).digest('hex')};
 const waiting=requestAccessFromHub(f.endpoint,req,180);const snapshot=await waitSnapshot(f.call);
 await writeFile(file,JSON.stringify([{pattern:'fixture-protected/',scope:'session',agent:'builder',grantedVia:'fixture'}]));
 await assert.rejects(f.call('fleet_permission_decide',{requestId:'scope-changed',snapshot,decision:'allow_once',reason:'Synthetic fixture'}),(e:any)=>e.code==='PERMISSION_NOT_PENDING');
 assert.notEqual(await waiting,'allow_once');assert.equal(f.decisions(),0);
});

test('full input changed after machine decision invalidates the original one-use grant',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');const mutable={...input};
 const approval=createDamageApproval({state:createDamageState(()=>{}),current:()=>action,baseline:()=>true,relay:f.relay,timeoutMs:1500,ask:async()=>{throw Error('headless');}});
 const pending=approval.request(action,mutable);const snapshot=await waitSnapshot(f.call);
 await f.call('fleet_permission_decide',{requestId:'mutated-input',snapshot,decision:'allow_once',reason:'Required original synthetic fixture'});const grant=await pending;assert.equal(grant.status,'allowed');
 mutable.command='echo different_synthetic_input';if(grant.status==='allowed')assert.equal(approval.consume(grant.grant,action),false);
 mutable.command=input.command;if(grant.status==='allowed')assert.equal(approval.consume(grant.grant,action),false); // stale token stays burned even after state reverts
 const receipt:any=await f.call('fleet_permissions',{target:owner,operation:'receipt',snapshot});assert.equal(receipt.effect,'not_applied');
});

test('failed decision audit never becomes one-use authority or a completion receipt',async t=>{
 const f=await fixture(t);await f.binding('grant_approve');
 const approval=createDamageApproval({state:createDamageState(()=>{}),current:()=>action,baseline:()=>true,relay:f.relay,audit:()=>{throw Error('fixture persistence failure');},timeoutMs:1000,ask:async()=>{throw Error('headless');}});
 const pending=approval.request(action,input);const snapshot=await waitSnapshot(f.call);
 const ack:any=await f.call('fleet_permission_decide',{requestId:'audit-failure',snapshot,decision:'allow_once',reason:'Required synthetic task fixture'});
 assert.equal(ack.completion,'not_established');assert.equal((await pending).status,'persistence_failed');
 const receipt:any=await f.call('fleet_permissions',{target:owner,operation:'receipt',snapshot});assert.equal(receipt.effect,'not_applied');
});
