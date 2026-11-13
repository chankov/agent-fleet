import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {PermissionTransport} from './lib/fleet-codex-permission-transport.ts';
import {LocalCodexMcp,TOOLS} from './lib/fleet-codex-local-mcp.ts';
import {AllowedSessionsStore} from './lib/fleet-codex-allowlist-store.ts';
import {FleetConnectionControl,connectionLines,connectionNamespaces} from '../../harnesses/lib/fleet-connection-control.ts';
import {FleetCodexNotificationRuntime,renewNotificationConfiguration,notificationConfigurationUnchanged,notificationPreview} from './lib/fleet-codex-event-runtime.ts';
import {desktopQueuePin,targetKey} from '../../harnesses/lib/fleet-notification-validation.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const target={project:'fixture',peer:'orchestrator',sessionId:'fixture-epoch',startedAt:'2026-11-01T00:00:00Z'};
const c={hostProfile:'fixture',principal:'fixture',threadId:A};
async function fixture(t:any){
 const root=mkdtempSync(join(tmpdir(),'fleet-connect-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let now=Date.now(),mono=0,renewals=0;
 const policy=join(root,'policy'),store=()=>new AllowedSessionsStore(policy,c,{now:()=>now});
 let current={...target},enabled=true,deadline=now+3600000,wireCalls=0;
 const control=new FleetConnectionControl({owner:()=>current,now:()=>now,session:()=>({status:()=>({threadId:A,enabled,expiresAt:deadline,reason:enabled?'active':'disabled'}),renewUntil:until=>{renewals++;deadline=until;return {enabled,expiresAt:deadline};}}),readRights:async namespace=>{try{const s=await new AllowedSessionsStore(policy,namespace,{now:()=>now}).open(),b=s.bindings.find(b=>b.target.sessionId===current.sessionId);return b?{rights:b.rights,status:b.status,expiresAt:b.expiresAt}:{rights:[],status:'not_connected'};}catch{return {rights:[],status:'not_connected'};}}});
 const service=()=>new LocalCodexMcp({registryRoot:join(root,'registry'),policyRoot:policy,hostProfile:c.hostProfile,principal:c.principal,now:()=>now,monotonic:()=>mono,registryReader:async()=>({status:'complete',partial:false,reasons:[],observedAt:new Date(now).toISOString(),entriesSeen:1,candidates:[{target:current,heartbeatAt:new Date(now).toISOString(),presence:'fresh'}]}),connectionTransport:{rpc:async (_target,f)=>{wireCalls++;const response=await control.request(f.operation as string,f.payload);assert.ok(response&&typeof response==='object'&&!Array.isArray(response));return response as Record<string,unknown>;}}});
 const mcp=service(),call=(name:string,args:any,threadId=A)=>mcp.call(name,args,{threadId});
 return {root,policy,store,call,control,service,now:()=>now,advance:(ms:number)=>{now+=ms;mono+=ms;},change:()=>{current={...target,sessionId:'changed'};},disable:()=>{enabled=false;},deadline:()=>deadline,renewals:()=>renewals,wireCalls:()=>wireCalls};
}
test('native new connection defaults to atomic 12h rights; all rights expire, independent of persistent state',async t=>{
 const f=await fixture(t),p=await f.call('fleet_connect_prepare',{target,rights:['read','send','approve'],notifications:false});assert.equal(p.rightsUntil,f.now()+12*3600000);
 assert.equal(readdirSync(f.root).length,0);await assert.rejects(()=>f.call('fleet_connect_commit',{proposalId:p.proposalId}),/QUIESCENT_WRITERS/);
 const r=await f.call('fleet_connect_commit',{proposalId:p.proposalId,quiescentWritersConfirmed:true});assert.equal(r.status,'committed');
 const s=await f.store().open();assert.deepEqual(s.bindings[0].rights,['read','send','approve']);assert.equal(s.bindings[0].expiresAt,p.rightsUntil);
 assert.deepEqual(await f.call('fleet_connect_commit',{proposalId:p.proposalId,quiescentWritersConfirmed:true}),r);
 assert.equal((await f.call('fleet_check_read',{project:target.project,peer:target.peer})).permission,'read');
 f.advance(12*3600000);for(const right of ['read','send','approve'] as const)await assert.rejects(async()=>{const store=f.store(),h=await store.resolve('fixture:orchestrator',[target]);return store.authorize(h,right,[target]);},/RIGHTS_EXPIRED/);
 assert.equal((await f.store().open()).bindings[0].rights.length,3);
});
test('exact current-chat renewal integrates native prepare/commit, one attempt, no rights migration',async t=>{
 const f=await fixture(t),s=f.store();await s.initialize();let h=await s.enroll({alias:'custom-alias',target},[target]);h=await s.grantSend(h,[target]);await s.grantApprove(h,[target]);
 const before=await s.open(),p=await f.call('fleet_connect_prepare',{target,desktopConfirmed:true});assert.equal(p.status,'prepared');assert.equal(p.rightsUntil,null);assert.deepEqual(p.eventKinds,['message','question','permission']);
 const r=await f.call('fleet_connect_commit',{proposalId:p.proposalId});assert.equal((r.notifications as any).status,'renewed');assert.equal(f.renewals(),1);assert.equal(f.deadline(),f.now()+12*3600000);
 assert.deepEqual(await s.open(),before);await f.call('fleet_connect_commit',{proposalId:p.proposalId});assert.equal(f.renewals(),1);
 assert.equal((await f.call('fleet_connection_status',{target})).delivery,'not_established_by_status');
});
test('no host mapping or Desktop confirmation: blocked with no grants or fallback',async t=>{
 const f=await fixture(t);assert.equal((await f.call('fleet_connect_prepare',{target})).reason,'loaded_desktop_confirmation_required');
 const p=await f.call('fleet_connect_prepare',{target,desktopConfirmed:true},B);assert.equal(p.status,'blocked');assert.equal(p.reason,'host_mapping_required');assert.equal(readdirSync(f.root).length,0);assert.equal(f.renewals(),0);
});
test('proposal context, changed owner, expiry, restart and spoofed identity fail closed',async t=>{
 const f=await fixture(t),p=await f.call('fleet_connect_prepare',{target,notifications:false});await assert.rejects(()=>f.call('fleet_connect_commit',{proposalId:p.proposalId,quiescentWritersConfirmed:true},B),/PROPOSAL_UNAVAILABLE/);
 await assert.rejects(()=>f.service().call('fleet_connect_commit',{proposalId:p.proposalId,quiescentWritersConfirmed:true},{threadId:A}),/PROPOSAL_UNAVAILABLE/);
 await assert.rejects(()=>f.call('fleet_connect_prepare',{target,threadId:B}),/INVALID_ARGUMENTS/);
 f.advance(300001);await assert.rejects(()=>f.call('fleet_connect_commit',{proposalId:p.proposalId,quiescentWritersConfirmed:true}),/PROPOSAL_UNAVAILABLE/);
 const next=await f.call('fleet_connect_prepare',{target,notifications:false});f.change();const result=await f.call('fleet_connect_commit',{proposalId:next.proposalId,quiescentWritersConfirmed:true});assert.equal(result.status,'failed_or_unknown');assert.equal(readdirSync(f.root).length,0);
});
test('existing rights cannot be silently removed or upgraded by connect',async t=>{
 const f=await fixture(t),s=f.store();await s.initialize();await s.enroll({alias:'existing',target},[target]);const before=await s.open();const p=await f.call('fleet_connect_prepare',{target,rights:['read','approve'],notifications:false});assert.equal(p.status,'blocked');assert.deepEqual(await s.open(),before);
 for(const rights of [[],['send'],['read','read'],['approve','read'],['read','unknown']])await assert.rejects(()=>f.call('fleet_connect_prepare',{target,rights,notifications:false}),/READ_REQUIRED/);
});
test('receiver rechecks revoked, expired and shorter rights at commit; no duplicate mutation',async t=>{
 let now=100000,until=now+3600000,rights:any={rights:['read'],status:'active'},count=0,deadline=now+10000;
 const port=new FleetConnectionControl({owner:()=>target,now:()=>now,readRights:async()=>rights,session:()=>({status:()=>({threadId:A,enabled:true,expiresAt:deadline,reason:'active'}),renewUntil:u=>{count++;deadline=u;return {};}})});
 for(const changed of [{rights:[],status:'active'},{rights:['read'],status:'active',expiresAt:now},{rights:['read'],status:'active',expiresAt:until-1}]){
  rights={rights:['read'],status:'active'};const p:any=await port.request('prepare',{namespace:c,until,desktopConfirmed:true});rights=changed;
  assert.equal((await port.request('commit',{namespace:c,proposalId:p.proposalId}) as any).status,'rejected');
 }
 assert.equal(count,0);rights={rights:['read'],status:'active'};const p:any=await port.request('prepare',{namespace:c,until,desktopConfirmed:true});await port.request('commit',{namespace:c,proposalId:p.proposalId});await port.request('commit',{namespace:c,proposalId:p.proposalId});assert.equal(count,1);
 const lines=connectionLines(port.rows(),now).join('\n');assert.match(lines,/read/);assert.match(lines,/delivery unverified/);
 now+=6000;assert.equal(port.rows()[0].rightsReason,'rights_not_freshly_observed');
});
test('receiver unknown renewal is not retried; restarted receiver cannot restore consent tokens',async()=>{
 let calls=0;const options={owner:()=>target,readRights:async()=>({rights:['read'],status:'active'}),session:()=>({status:()=>({threadId:A,enabled:true,expiresAt:Date.now()+10000,reason:'active'}),renewUntil:()=>{calls++;throw Error('uncertain');}})};
 // Stable expiry is a compare-and-swap input, not a rolling deadline.
 const deadline=Date.now()+10000;options.session=()=>({status:()=>({threadId:A,enabled:true,expiresAt:deadline,reason:'active'}),renewUntil:()=>{calls++;throw Error('uncertain');}});
 const control=new FleetConnectionControl(options),p:any=await control.request('prepare',{namespace:c,until:Date.now()+43200000,desktopConfirmed:true});
 assert.equal((await control.request('commit',{namespace:c,proposalId:p.proposalId}) as any).status,'unknown');await control.request('commit',{namespace:c,proposalId:p.proposalId});assert.equal(calls,1);
 assert.equal((await new FleetConnectionControl(options).request('commit',{namespace:c,proposalId:p.proposalId}) as any).status,'rejected');
});
test('atomic config renewal keeps runtime, epoch, journals and legacy catalog intact; no queue writes',async t=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-renew-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'config.json'),until=Date.now()+43200000;
 const config={optedIn:true as const,stateRoot:join(root,'events'),socketPath:join(root,'unused.sock'),messageBudgetMs:30000,loadedCatalog:{identity:'host_context_validated',protocolVersion:'2025-06-18',tools:TOOLS.slice(0,24).map(t=>({name:t.name}))},approval:{binding:{id:'fixture',epoch:'epoch',hostInstance:'fixture-host',threadId:A,fleetOwner:targetKey(target)},target,authorityRevision:1,confirmedUntil:Date.now()+3600000,transportOrigin:'user_input' as const,mappingEvidence:'externally_confirmed_loaded_desktop' as const,daemonVersion:desktopQueuePin.daemon,desktopVersion:desktopQueuePin.desktop,addSchema:desktopQueuePin.addSchema,responseSchema:desktopQueuePin.responseSchema}};
 writeFileSync(path,JSON.stringify(config),{mode:0o600});let sends=0;const runtime=new FleetCodexNotificationRuntime(config,()=>notificationConfigurationUnchanged(path,config)?target:null,{verify:async()=>true,deliverExternal:async()=>{sends++;throw Error('unexpected');},reconcile:async()=>({status:'unknown'})});await runtime.start();t.after(()=>runtime.stop());
 const before=structuredClone(config.approval.binding),files=readdirSync(root);runtime.renewUntil(until,()=>{const next=renewNotificationConfiguration(path,config,until);config.approval.confirmedUntil=next.approval.confirmedUntil;});
 assert.equal(runtime.status().enabled,true);assert.equal(runtime.status().expiresAt,until);assert.equal(sends,0);assert.deepEqual(config.approval.binding,before);assert.deepEqual(readdirSync(root),files);assert.equal(notificationPreview(config,target).ready,true);
 const bytes=readFileSync(path);assert.throws(()=>renewNotificationConfiguration(path,{...config,messageBudgetMs:30001},until+1));assert.deepEqual(readFileSync(path),bytes);
 runtime.stop();assert.equal(runtime.status().enabled,false);assert.throws(()=>runtime.renewUntil(until+1,()=>assert.fail('stopped')));
});
test('partial commit is explicit and never automatically repeats receiver mutation',async t=>{
 const f=await fixture(t),p=await f.call('fleet_connect_prepare',{target,desktopConfirmed:true});assert.equal(p.status,'prepared');f.disable();
 const result=await f.call('fleet_connect_commit',{proposalId:p.proposalId,quiescentWritersConfirmed:true});assert.equal(result.status,'partially_applied_or_unknown');assert.equal(result.rightsCommitted,true);assert.equal(f.renewals(),0);
 const calls=f.wireCalls();await f.call('fleet_connect_commit',{proposalId:p.proposalId,quiescentWritersConfirmed:true});assert.equal(f.wireCalls(),calls);
});
test('private bounded inventory survives process restart without treating metadata as grants',async t=>{
 const f=await fixture(t),s=f.store();await s.initialize();await s.enroll({alias:'fixture',target},[target]);assert.deepEqual(await connectionNamespaces(f.policy),[c]);
 const link=join(f.root,'policy-link');symlinkSync(f.policy,link);await assert.rejects(()=>connectionNamespaces(link),/unsafe_policy_root/);
 writeFileSync(join(f.policy,'a'.repeat(64)+'.json'),JSON.stringify({namespace:c}),{mode:0o600});assert.deepEqual(await connectionNamespaces(f.policy),[c]);
 const port=new FleetConnectionControl({owner:()=>target,session:()=>undefined,listNamespaces:()=>connectionNamespaces(f.policy),readRights:async()=>({rights:['read'],status:'active'})});await port.refresh();assert.equal(port.rows()[0].threadId,A);assert.equal(port.rows()[0].notifications.enabled,false);
});
test('connection RPC uses a real exact Unix socket, before-write guard and correlated owner response',async t=>{
 const root=mkdtempSync(join(tmpdir(),'fc-wire-')),registry=join(root,'reg');mkdirSync(join(registry,'sockets'),{recursive:true,mode:0o700});let renewals=0,frames=0;
 const deadline=Date.now()+10000,control=new FleetConnectionControl({owner:()=>target,readRights:async()=>({rights:['read'],status:'active'}),session:()=>({status:()=>({threadId:A,enabled:true,expiresAt:deadline,reason:'active'}),renewUntil:()=>{renewals++;return {enabled:true};}})});
 const server=createServer(socket=>{let buffer='';socket.on('data',chunk=>{buffer+=chunk;if(!buffer.includes('\n'))return;frames++;const message=JSON.parse(buffer.split('\n')[0]);assert.equal(message.type,'connection_request');assert.equal(control.handle(socket,message),true);});});
 await new Promise<void>(r=>server.listen(join(registry,'sockets',target.sessionId+'.sock'),r));t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});});
 const transport=new PermissionTransport({registryRoot:registry,channel:'connection'}),until=Date.now()+43200000;
 const p=await transport.rpc(target,{operation:'prepare',payload:{namespace:c,until,desktopConfirmed:true}});assert.equal(p.status,'prepared');
 await transport.rpc(target,{operation:'commit',payload:{namespace:c,proposalId:p.proposalId}});assert.equal(renewals,1);
 const before=frames;await assert.rejects(()=>transport.rpc(target,{operation:'status',payload:{namespace:c}},async()=>{throw Error('target changed');}),/target changed/);assert.equal(frames,before);
 const wrong=await transport.rpc(target,{operation:'status',payload:{namespace:{...c,threadId:B}}});assert.equal(wrong.status,'observed');assert.equal((wrong.notifications as any).enabled,false);
});
