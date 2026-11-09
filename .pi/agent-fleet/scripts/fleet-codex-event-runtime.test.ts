import {createComsPeer,sendEnvelope} from '../../harnesses/lib/coms-core.ts';import {ownerOf} from '../../harnesses/lib/coms-instruction-receipts.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {FleetCodexNotificationRuntime,notificationPreview,notificationConfigurationUnchanged} from './lib/fleet-codex-event-runtime.ts';import {desktopQueuePin} from './lib/codex-desktop-queue-host.ts';import {TOOLS} from './lib/fleet-codex-local-mcp.ts';import {targetKey} from './lib/fleet-codex-instruction-store.ts';
import {publishFleetSourceEvent,subscribeFleetSourceEvents,fleetSourceDigest} from '../../harnesses/lib/fleet-event-source.ts';import {QuestionChannel} from '../../harnesses/ask-user-remote/questions.ts';import {PermissionRelay} from '../../harnesses/agent-hub/permission-relay.ts';
const owner={project:'fixture',peer:'hub',sessionId:'session',startedAt:'2026-11-04T00:00:00Z'};
const binding={id:'fixture',epoch:'epoch',hostInstance:'fixture-host',threadId:'11111111-1111-4111-8111-111111111111',fleetOwner:targetKey(owner)};
const tick=()=>new Promise(r=>setTimeout(r,5));
function fixture(t:any){const root=mkdtempSync(join(tmpdir(),'event-runtime-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let sends=0,reconciles=0,lost=false;const delivered:any[]=[];
 const config={optedIn:true as const,stateRoot:join(root,'state'),socketPath:join(root,'unused.sock'),messageBudgetMs:30000,loadedCatalog:{tools:TOOLS.map(t=>({name:t.name})),identity:'host_context_validated',nodeVersion:'25.2.1',protocolVersion:'2025-06-18'},approval:{binding,target:owner,authorityRevision:1,confirmedUntil:Date.now()+60000,transportOrigin:'user_input' as const,mappingEvidence:'externally_confirmed_loaded_desktop' as const,daemonVersion:desktopQueuePin.daemon,desktopVersion:desktopQueuePin.desktop,addSchema:desktopQueuePin.addSchema,responseSchema:desktopQueuePin.responseSchema}};
 const host={async verify(){return true;},async deliverExternal(_b:any,e:any){sends++;delivered.push(e);if(lost)throw Error('lost ack');return {status:'queue_accepted' as const,submissionId:'submission',transportOrigin:'user_input' as const};},async reconcile(){reconciles++;return {status:'not_observed_in_queue',delivery:'not_established'};}};
 const make=(checkpoint?:(stage:string)=>void)=>new FleetCodexNotificationRuntime(config,()=>owner,host,checkpoint);const source={kind:'message' as const,owner,sourceId:'message',createdAt:Date.now(),deadline:null,contentDigest:fleetSourceDigest('fixture')};
 return {config,host,make,source,delivered,get sends(){return sends;},get reconciles(){return reconciles;},lose(){lost=true;}};
}
test('real question and permission producers plus message ingress feed the production bridge, references only',async t=>{
 const f=fixture(t),runtime=f.make();await runtime.start();t.after(()=>runtime.stop());
 publishFleetSourceEvent(f.source);
 const questions=new QuestionChannel(()=>owner);questions.enabled=true;t.after(()=>questions.reset());const q=questions.open('tool',{question:'fixture ordinary question'});assert.ok(q);q.registerAnswer(()=>true);
 const permissions=new PermissionRelay(()=>owner);t.after(()=>permissions.reset());const input={command:'echo fixture'};assert.ok(permissions.open({taskId:'task',inputRevision:'rev',actionId:'action',operation:'bash',target:createHash('sha256').update(JSON.stringify(input)).digest('hex'),cwd:'/tmp',owner:'hub',attempt:'attempt'},input,()=>true,Date.now()+30000));
 for(let i=0;i<100&&f.sends<3;i++)await tick();assert.equal(f.sends,3);assert.deepEqual(f.delivered.map(e=>e.kind),['message','question','permission']);assert.equal(JSON.stringify(f.delivered).includes('fixture ordinary question'),false);assert.equal(JSON.stringify(f.delivered).includes('echo fixture'),false);
 assert.equal(publishFleetSourceEvent(f.source).status,'durably_ingested');await tick();assert.equal(f.sends,3);
 assert.throws(()=>publishFleetSourceEvent({...f.source,contentDigest:fleetSourceDigest('changed')}),/ingress_unavailable/);
});
test('opaque question toolCallIds survive real producer admission, including composite and Unicode IDs',async t=>{
 const ids=['call_x|fc_y','call/x:y%2Fz',' инструмент 🧪 ','\ud800','\udc00','\uffff'.repeat(256)];
 for(let i=0;i<ids.length;i++)await t.test('opaque case '+i,async t=>{
  const f=fixture(t),runtime=f.make();await runtime.start();t.after(()=>runtime.stop());
  const questions=new QuestionChannel(()=>owner);questions.enabled=true;t.after(()=>questions.reset());
  const q=questions.open(ids[i],{question:'Opaque ID fixture, not a live human question'});assert.ok(q);q.registerAnswer(()=>true);
  for(let n=0;n<100&&f.sends<1;n++)await tick();assert.equal(f.sends,1);
  assert.equal(f.delivered[0].reference,'fleet:question:v2/'+q.id+'/'+Buffer.from(ids[i],'utf16le').toString('base64url'));
  assert.equal(JSON.stringify(f.delivered).includes('Opaque ID fixture'),false);
 });
});
test('invalid opaque toolCallIds still refuse admission before any host delivery',async t=>{
 const f=fixture(t),runtime=f.make();await runtime.start();t.after(()=>runtime.stop());
 const invalid=[undefined,null,'','a'.repeat(257),...Array.from({length:32},(_,i)=>'call'+String.fromCharCode(i)), 'call\u007f'];
 for(const toolCallId of invalid)assert.throws(()=>runtime.ingest({...f.source,kind:'question',toolCallId} as any),/notification_question_reference_incomplete/);
 await tick();assert.equal(f.sends,0);
});
test('versioned question references retain restart recovery and unknown/no-replay semantics',async t=>{
 const f=fixture(t),source={...f.source,kind:'question' as const,sourceId:'opaque-question',toolCallId:'call_x|fc_y'};
 const before=f.make();t.after(()=>before.stop());await before.start();before.ingest(source);before.stop();await tick();assert.equal(f.sends,0);
 f.lose();const recovered=f.make();t.after(()=>recovered.stop());await recovered.start();
 for(let n=0;n<100&&f.sends<1;n++)await tick();assert.equal(f.sends,1);recovered.stop();
 const restarted=f.make();await restarted.start();t.after(()=>restarted.stop());await tick();
 assert.equal(restarted.ingest(source).status,'historical');assert.equal(f.sends,1);assert.ok(f.reconciles>=1);
});
test('crash before send recovers committed ingress; lost ACK restart calls reconcile without replay even for empty queue',async t=>{
 const f=fixture(t),before=f.make();await before.start();t.after(()=>before.stop());before.ingest(f.source);before.stop();await tick();assert.equal(f.sends,0);
 const restarted=f.make();await restarted.start();t.after(()=>restarted.stop());for(let i=0;i<100&&f.sends<1;i++)await tick();assert.equal(f.sends,1);restarted.stop();
 f.lose();const live=f.make();await live.start();t.after(()=>live.stop());live.ingest({...f.source,sourceId:'lost'});for(let i=0;i<100&&f.sends<2;i++)await tick();await tick();live.stop();assert.equal(f.sends,2);
 const next=f.make();const result=await next.start();t.after(()=>next.stop());assert.equal(f.reconciles,1);assert.equal(f.sends,2);assert.ok(result.some((r:any)=>r.remote==='not_replayed'));
});
test('double restart and duplicate ingested event do not lose the committed pending admission',async t=>{
 const f=fixture(t),first=f.make();await first.start();first.ingest(f.source);first.stop();await tick();
 let hang=true;f.host.verify=async()=>hang?await new Promise<boolean>(()=>{}):true;
 const second=f.make();await second.start();assert.equal(publishFleetSourceEvent(f.source).status,'durably_ingested');second.stop();await tick();assert.equal(f.sends,0);
 hang=false;const third=f.make();await third.start();t.after(()=>third.stop());for(let i=0;i<100&&f.sends<1;i++)await tick();assert.equal(f.sends,1);
});
test('uncommitted payload is NEVER source-ACKed and only never-attempted admission can be safely filled',async t=>{
 const f=fixture(t);let writes=0;const crashed=f.make(stage=>{if(stage==='beforeRename'&&++writes===2)throw Error('fixture payload crash');});await crashed.start();
 assert.throws(()=>publishFleetSourceEvent(f.source),/ingress_unavailable/);assert.equal(f.sends,0);crashed.stop();
 const restored=f.make();const recovery=await restored.start();t.after(()=>restored.stop());assert.ok(recovery.some((r:any)=>r.reason==='payload_not_committed'));assert.equal(f.sends,0);
 assert.equal(publishFleetSourceEvent(f.source).status,'durably_ingested');for(let i=0;i<100&&f.sends<1;i++)await tick();assert.equal(f.sends,1);
});
test('edited private config revokes notification before ingress, preserving ordinary disabled source behavior',async t=>{
 const f=fixture(t),path=f.config.stateRoot+'.json';writeFileSync(path,JSON.stringify(f.config),{mode:0o600});
 const runtime=new FleetCodexNotificationRuntime(f.config,()=>notificationConfigurationUnchanged(path,f.config)?owner:null,f.host);await runtime.start();t.after(()=>runtime.stop());
 writeFileSync(path,JSON.stringify({...f.config,optedIn:false}));assert.equal(notificationConfigurationUnchanged(path,f.config),false);assert.equal(publishFleetSourceEvent(f.source).status,'disabled');await tick();assert.equal(f.sends,0);assert.equal(publishFleetSourceEvent(f.source).status,'disabled');
});

test('async/void sink cannot claim a synchronous durable source ACK',()=>{
 const off=subscribeFleetSourceEvents(owner,async()=>({status:'ingested',eventId:'future'}));try{assert.throws(()=>publishFleetSourceEvent({kind:'message',owner,sourceId:'source',createdAt:Date.now(),deadline:null,contentDigest:fleetSourceDigest('fixture')}),/ingress_unavailable/);}finally{off();}
});

test('actual COMS prompt is durably ingested before source ACK, without copying prompt body',async t=>{
 const f=fixture(t),previous=process.env.PI_COMS_DIR,herdr=process.env.HERDR_ENV;process.env.PI_COMS_DIR=join(f.config.stateRoot,'coms');process.env.HERDR_ENV='0';let peer:any,runtime:any;
 t.after(async()=>{runtime?.stop();await peer?.shutdown();if(previous===undefined)delete process.env.PI_COMS_DIR;else process.env.PI_COMS_DIR=previous;if(herdr===undefined)delete process.env.HERDR_ENV;else process.env.HERDR_ENV=herdr;});
 const ctx:any={cwd:tmpdir(),hasUI:false,getContextUsage:()=>null,sessionManager:{getLeafId:()=>null,getEntry:()=>undefined,getBranch:()=>[]},ui:{notify(){}}};
 peer=createComsPeer({pi:{getFlag:(name:string)=>name==='project'?'fixture':name==='name'?'orchestrator':undefined,getSessionName(){},appendEntry(){},sendMessage(){}} as any,getContext:()=>ctx});await peer.connect({ctx,defaultNamePrefix:'fixture',defaultPurpose:'fixture'});
 const actual=ownerOf(peer.identity),config={...f.config,approval:{...f.config.approval,target:actual,binding:{...binding,fleetOwner:targetKey(actual)}}};runtime=new FleetCodexNotificationRuntime(config,()=>actual,f.host);await runtime.start();
 await sendEnvelope(peer.identity.endpoint,{type:'prompt',msg_id:'fixture-message',prompt:'PRIVATE_FIXTURE_PROMPT',sender_session:'fixture',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()});
 for(let i=0;i<100&&f.sends<1;i++)await tick();assert.equal(f.sends,1);assert.equal(f.delivered[0].reference,'fleet:message/fixture-message');assert.equal(JSON.stringify(f.delivered).includes('PRIVATE_FIXTURE_PROMPT'),false);
});

test('21-tool host and second consumer are refused; no implicit startup, grants or broadcast',async t=>{
 const f=fixture(t),old={...f.config,loadedCatalog:{...f.config.loadedCatalog,tools:f.config.loadedCatalog.tools.slice(0,21)}};
 assert.equal(notificationPreview(old,owner).ready,false);assert.throws(()=>new FleetCodexNotificationRuntime(old,()=>owner,f.host),/not_ready/);assert.equal(f.sends,0);
 const first=f.make();await first.start();t.after(()=>first.stop());const second=f.make();assert.throws(()=>second.start(),/subscription_failed/);
});
