import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Socket} from 'node:net';
import {LocalCodexMcp,type LocalMcpOptions} from '../lib/fleet-codex-local-mcp.ts';
import {SessionResponseReader,responseReference} from '../../../harnesses/lib/coms-response-read.ts';
export const responseOwner={project:'fixture',peer:'orchestrator',sessionId:'response-fixture',startedAt:'2026-11-11T00:00:00.000Z'};
export const responseThread='11111111-1111-4111-8111-111111111111',responseWire='a'.repeat(64);
export async function makeResponseFixture(t:{after:(fn:()=>Promise<void>)=>void},text='б🙂'.repeat(1200)+'END_MARK',extra:Partial<LocalMcpOptions>={}){
 const root=await mkdtemp(join(tmpdir(),'afr-')),registryRoot=join(root,'registry'),policyRoot=join(root,'policy');await mkdir(join(registryRoot,'sockets'),{recursive:true});
 const entries=new Map<string,any>();let leaf='source';entries.set(leaf,{id:leaf,type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 const manager={getLeafId:()=>leaf,getEntry:(id:string)=>entries.get(id)},append=(customType:string,data:unknown)=>{leaf='meta-'+entries.size;entries.set(leaf,{id:leaf,type:'custom',customType,data:structuredClone(data)});};
 const reader=new SessionResponseReader();reader.capture(responseOwner,responseWire,'source',manager,append);const reference=responseReference(responseOwner,responseWire),sockets=new Set<Socket>();let reads=0;
 let intercept:((s:Socket,e:any)=>boolean|Promise<boolean>)|undefined;
 const server=createServer(s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));let b='';s.on('data',d=>{b+=d;const end=b.indexOf('\n');if(end<0)return;const e=JSON.parse(b.slice(0,end));reads++;void Promise.resolve(intercept?.(s,e)).then(handled=>{if(!handled){reader.handle(s,e,()=>responseOwner,manager);s.end();}}).catch(()=>s.destroy());});});
 await new Promise<void>(r=>server.listen(join(registryRoot,'sockets',responseOwner.sessionId+'.sock'),r));
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});});
 let target={...responseOwner};const options:LocalMcpOptions={registryRoot,policyRoot,hostProfile:'fixture',principal:'fixture',now:()=>Date.parse(responseOwner.startedAt),registryReader:async()=>({status:'complete',partial:false,reasons:[],observedAt:responseOwner.startedAt,entriesSeen:1,candidates:[{target:{...target},presence:'fresh',heartbeatAt:responseOwner.startedAt}]}),...extra};
 let service=new LocalCodexMcp(options);const meta={threadId:responseThread,sessionId:'fixture-host'},selectors={project:responseOwner.project,peer:responseOwner.peer};
 const call=(name:string,args:unknown,metadata:unknown=meta,signal?:AbortSignal)=>service.call(name,args,metadata,signal);
 const p=await call('fleet_binding_prepare',{intent:'enroll_read',...selectors});await call('fleet_binding_commit',{proposalId:p.proposalId});
 return {root,registryRoot,policyRoot,entries,manager,reader,reference,text,options,meta,selectors,call,service:()=>service,restart:()=>{service=new LocalCodexMcp(options);},changeTarget:()=>target={...responseOwner,sessionId:'replacement'},intercept:(fn:typeof intercept)=>intercept=fn,reads:()=>reads,args:{...selectors,reference}};
}
