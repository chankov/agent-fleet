import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalCodexMcp,TOOLS} from './lib/fleet-codex-local-mcp.ts';
import {InstructionTransport} from './lib/fleet-codex-instruction-transport.ts';
import {FleetCodexNotificationRuntime} from './lib/fleet-codex-event-runtime.ts';
import {desktopQueuePin,CodexDesktopQueueHost} from './lib/codex-desktop-queue-host.ts';
import {targetKey} from './lib/fleet-codex-instruction-store.ts';
import {responseHash} from '../../harnesses/lib/coms-response-read.ts';
import {handleInstructionReceipt,ownerOf} from '../../harnesses/lib/coms-instruction-receipts.ts';

test('native instruction → exact session pointer → production notification runtime → MCP full read; two queued instructions never mix',async t=>{
 const root=await mkdtemp(join(process.platform==='darwin'?'/tmp':tmpdir(),'afre-')),registryRoot=join(root,'registry'),previous=process.env.PI_COMS_DIR,oldHerdr=process.env.HERDR_ENV;process.env.PI_COMS_DIR=registryRoot;process.env.HERDR_ENV='0';
 const {createComsPeer}=await import('../../harnesses/lib/coms-core.ts');const branch:any[]=[];let seq=0;const delivered:string[]=[];
 const add=(e:any)=>{const row={...e,id:'entry-'+ ++seq,parentId:branch.at(-1)?.id??null};branch.push(row);return row;};
 const pi:any={getFlag:(flag:string)=>flag==='name'?'receiver':flag==='project'?'response-e2e':undefined,getSessionName:()=>undefined,appendEntry:(customType:string,data:unknown)=>add({type:'custom',customType,data}),sendMessage:(m:any)=>{delivered.push(m.details.msg_id);add({type:'custom_message',customType:m.customType,details:m.details});}};
 const ctx:any={cwd:root,model:{id:'fixture'},hasUI:false,getContextUsage:()=>null,sessionManager:{getBranch:()=>branch,getLeafId:()=>branch.at(-1)?.id??null,getEntry:(id:string)=>branch.find(e=>e.id===id)},ui:{notify(){},setWidget(){},setStatus(){}}};
 const peer=createComsPeer({pi,getContext:()=>ctx,instructionReceipts:true,handleCustomEnvelope:(socket,e)=>handleInstructionReceipt(e,socket,()=>peer.identity?ownerOf(peer.identity):null,ctx.sessionManager)});await peer.connect({ctx,defaultNamePrefix:'fixture',defaultPurpose:'local response test'});
 const owner={project:peer.identity!.project,peer:peer.identity!.name,sessionId:peer.identity!.session_id,startedAt:peer.identity!.started_at},threadId='11111111-1111-4111-8111-111111111111',meta={threadId,sessionId:'host-fixture'},selectors={project:owner.project,peer:owner.peer};
 const queue:any[]=[],binding={id:'response-fixture',epoch:'fixture-epoch',hostInstance:'fixture-host',threadId,fleetOwner:targetKey(owner)};
 const config={optedIn:true as const,stateRoot:join(root,'notifications'),socketPath:join(root,'unused.sock'),messageBudgetMs:30000,loadedCatalog:{tools:TOOLS.map(t=>({name:t.name})),identity:'host_context_validated',nodeVersion:process.versions.node,protocolVersion:'2025-06-18'},approval:{binding,target:owner,authorityRevision:1,confirmedUntil:Date.now()+60000,transportOrigin:'user_input' as const,mappingEvidence:'externally_confirmed_loaded_desktop' as const,daemonVersion:desktopQueuePin.daemon,desktopVersion:desktopQueuePin.desktop,addSchema:desktopQueuePin.addSchema,responseSchema:desktopQueuePin.responseSchema}};
 const host=new CodexDesktopQueueHost({stateRoot:join(root,'queue'),currentApproval:()=>config.approval,rpc:{async request(method:string,params:any,options:any){
  if(method==='thread/read')return {thread:{id:threadId,status:{type:'notLoaded'}}};
  assert.equal(method,'thread/queue/add');await options?.beforeWrite?.();const envelope=JSON.parse(params.input[0].text.split('\n')[1]);assert.equal(envelope.schema,'fleet-machine-event/v1');assert.equal(envelope.humanApproval,false);assert.deepEqual(envelope.fleetTarget,owner);queue.push(envelope);
  return {queuedSubmission:{id:'fixture-'+queue.length,clientUserMessageId:params.clientUserMessageId,input:structuredClone(params.input)}};
 }}});
 const runtime=new FleetCodexNotificationRuntime(config,()=>owner,host);await runtime.start();
 t.after(async()=>{runtime.stop();await peer.shutdown();if(previous===undefined)delete process.env.PI_COMS_DIR;else process.env.PI_COMS_DIR=previous;if(oldHerdr===undefined)delete process.env.HERDR_ENV;else process.env.HERDR_ENV=oldHerdr;await rm(root,{recursive:true,force:true});});
 const service=new LocalCodexMcp({registryRoot,policyRoot:join(root,'policy'),hostProfile:'fixture',principal:'fixture',instructionTransport:new InstructionTransport({registryRoot,resultWaitMs:0})});
 const call=(name:string,args:unknown)=>service.call(name,args,meta);
 for(const intent of ['enroll_read','grant_send']){const p=await call('fleet_binding_prepare',{intent,...selectors});await call('fleet_binding_commit',{proposalId:p.proposalId});}
 peer.setTurnState('working');const commits:any[]=[];
 for(let i=1;i<=2;i++){const p=await call('fleet_instruction_prepare',{target:owner,requestId:'response-'+i,instruction:'Produce fixture response '+i});commits.push(await call('fleet_instruction_commit',{proposalId:p.proposalId}));}
 assert.equal(delivered.length,0);assert.notEqual(commits[0].fullResponse.reference,commits[1].fullResponse.reference);await assert.rejects(()=>call('fleet_response_read',{...selectors,reference:commits[0].fullResponse.reference}),{code:'NOT_READY'});
 await peer.settleTurn(ctx);const originals=['FIRST б🙂'.repeat(1100)+'END_ONE','SECOND '.repeat(1200)+'END_TWO'];
 for(let i=0;i<2;i++){assert.equal(delivered.length,i+1);add({type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:originals[i]},{type:'thinking',thinking:'DO_NOT_DISCLOSE'}]}});await peer.settleTurn(ctx);}
 for(let n=0;n<300&&queue.filter(e=>e.reference.includes('response-v1-')).length<2;n++)await new Promise(r=>setTimeout(r,5));
 const ready=queue.filter(e=>e.reference.includes('response-v1-'));assert.equal(ready.length,2);assert.equal(queue.some(e=>JSON.stringify(e).includes('END_ONE')),false);assert.equal(JSON.stringify(queue).includes('DO_NOT_DISCLOSE'),false);
 for(let i=0;i<2;i++){
  const result:any=await call('fleet_instruction_receipt',{requestId:'response-'+(i+1),refresh:true});assert.equal(result.receipt.truncated,true);assert.ok(Buffer.byteLength(result.receipt.result)<=4096);assert.equal(result.fullResponse.reference,ready[i].reference);assert.deepEqual(result.fullResponse.target,owner);
  let cursor:string|undefined,text='';do{const p:any=await call('fleet_response_read',{...selectors,reference:ready[i].reference,...(cursor?{cursor}:{})});text+=p.text;cursor=p.nextCursor??undefined;if(!cursor){assert.equal(p.totalBytes,Buffer.byteLength(originals[i]));assert.equal(p.sourceSha256,responseHash(text));assert.equal(p.sourceState.state,'result');}}while(cursor);
  assert.equal(text,originals[i]);
 }
 const count=queue.length;await peer.settleTurn(ctx);await new Promise(r=>setTimeout(r,15));assert.equal(queue.length,count);assert.equal(delivered.length,2);
});
