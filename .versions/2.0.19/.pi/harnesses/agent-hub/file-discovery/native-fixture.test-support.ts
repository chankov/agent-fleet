import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {configureDiscoveryHub,registerDiscoveryHub,prepareDiscoveryNative,resetDiscoveryHub,discoveryHubNativeChannel} from './hub.ts';
import {normalizeSystem1Config} from '../../lib/system1/config-v2.js';
import {createCommunicationStore} from '../system1-communication-store.ts';
import {parseFileDiscoveryConfig} from '../../lib/system1/config-file-discovery.js';
import {createDiscoveryRuntime} from './runtime.ts';
import {createDiscoveryOwners,discoveryAssignmentEnv} from './owners.ts';
import {createDiscoveryBroker} from './broker.ts';
export function nativeFixture(t:any,count=3,pageBytes=32768,limits={},extras:any={}) {
 const root=mkdtempSync(join(tmpdir(),'d9-native-')),session=join(root,'.pi','session');mkdirSync(session,{recursive:true});mkdirSync(join(root,'.ai'));mkdirSync(join(root,'docs'));
 writeFileSync(join(root,'.ai','agent-fleet.json'),JSON.stringify({features:{system1:true}}));
 const paths=Array.from({length:count},(_,i)=>`docs/file-${i}.ts`);for(const p of paths)writeFileSync(join(root,p),'safe native rounding code');
 const previous={AGENT_HUB_AGENT_ID:process.env.AGENT_HUB_AGENT_ID,AGENT_FLEET_AGENTIC_CHILD:process.env.AGENT_FLEET_AGENTIC_CHILD};delete process.env.AGENT_HUB_AGENT_ID;delete process.env.AGENT_FLEET_AGENTIC_CHILD;
 const hooks:Record<string,Function[]>={},entries:any[]=[];let taskId='task',calls=0;
 const pi:any={registerTool(){},on:(e:string,f:Function)=>(hooks[e]??=[]).push(f),appendEntry:(customType:string,data:any)=>entries.push({type:'custom',customType,data})};
 const ctx:any={cwd:root,model:{provider:'fake',id:'model'},ui:{notify(){}},sessionManager:{getSessionId:()=> 'session',getEntries:()=>entries}};
 const snapshot=structuredClone(normalizeSystem1Config({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{fileDiscovery:{mode:'active',remoteContextApproved:true,include:['docs'],limits:{resultPageBytes:pageBytes,...limits}}}}));snapshot.consumers.fileDiscovery.config.limits.discoveryMs=15000;
 const service={async evaluate(r:any){calls++;return {status:'ok',evaluation:{answers:r.questions.map((q:any)=>({questionId:q.id,type:q.type,uncertainty:{provenance:'provider'},...(q.type==='ordinal'?{value:0,levels:q.levels}:{value:'implementation'})})),metadata:{}}} as any;}};
 registerDiscoveryHub(pi);configureDiscoveryHub(pi,{snapshot,service,ctx,sessionDir:session,taskId:()=>taskId,...(extras.store?{communicationStore:extras.store}:{})});entries.push({type:'message',message:{role:'user',content:'parent rounding'}});
 const guard=pathToFileURL(resolve('bin/test/helpers/system1-no-network.js')).href;
 writeFileSync(join(root,'pi'),`#!/usr/bin/env node
(async()=>{
 await import(${JSON.stringify(guard)});process.env.PI_OFFLINE='1';
 const fs=require('node:fs'),url=require('node:url');const args=process.argv;
 let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
 fs.writeFileSync(args[args.indexOf('--session')+1],JSON.stringify({type:'session',version:3,id:'fixture'})+'\\n');
 const model=args[args.indexOf('--model')+1],extensions=args.filter((v,i)=>args[i-1]==='-e');
 const hooks={},api={on:(e,f)=>(hooks[e]??=[]).push(f),registerTool(){throw Error('D9 must not add tools');}};
 for(const path of extensions)if(path.endsWith('/file-discovery/child-extension.ts'))(await import(url.pathToFileURL(path).href)).default(api);
 const event={toolName:'find',input:{path:'docs',pattern:'*.ts'},toolCallId:'discovery',content:[{type:'text',text:${JSON.stringify(paths.map(p=>p.slice(5)).join('\n'))}}],details:{}};
 let result=event;for(const hook of hooks.tool_result??[]){const override=await hook(result,{cwd:process.cwd()});if(override)result={...result,...override};}
 let pageRows=0,next=result.details.fileDiscovery?.first,readPages=0;
 const {createReadTool}=await import(${JSON.stringify(pathToFileURL(resolve('node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href)});
 while(next){const pageResult=await createReadTool(process.cwd()).execute('page',{path:next.path},new AbortController().signal);const page=JSON.parse(pageResult.content[0].text);pageRows+=page.rows.length;readPages++;next=page.next;}
 const report={model,prompt,systemPrompt:args[args.indexOf('--system-prompt')+1],attempt:process.env.AF_D9_ATTEMPT_ID,keyAbsent:process.env.TYPESAFE_API_KEY==null,tools:args[args.indexOf('--tools')+1],resume:args.includes('-c'),original:result.content[0],advice:result.details.fileDiscovery,pageRows,readPages,registered:!!hooks.tool_result,modelStepAfterAdvice:!!result.details.fileDiscovery};
 fs.appendFileSync(process.env.REPORT,JSON.stringify(report)+'\\n');
 if(model==='fake/primary'){console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}}));process.exitCode=1;return;}
 console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'native complete'}}));
})().catch(e=>{console.error(e);process.exitCode=1;});
`,{mode:0o755});
 t.after(async()=>{await resetDiscoveryHub(pi);rmSync(root,{recursive:true,force:true});for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 return {root,session,pi,ctx,paths,hooks,service,store:extras.store,prepare:(input:any)=>prepareDiscoveryNative(pi,input),calls:()=>calls,rows:()=>readFileSync(join(root,'report'),'utf8').trim().split('\n').map(s=>JSON.parse(s)),env:{PATH:root+':'+process.env.PATH,REPORT:join(root,'report'),TYPESAFE_API_KEY:'never-child'},switchTask(){taskId='other';},channel:()=>discoveryHubNativeChannel(pi)};
}
function until<T>(promise:Promise<T>,ms=5000):Promise<T>{
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('barrier timeout')),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
/** Isolated child process so production child-extension env cannot race other tests. */
export async function createChildHookHarness(t:any,brokerLimits:Record<string,number>={}){
 const root=mkdtempSync(join(tmpdir(),'d9-child-hook-'));mkdirSync(join(root,'docs'));
 for(const name of ['a.ts','b.ts'])writeFileSync(join(root,'docs',name),'safe child bytes');
 const store=createCommunicationStore();store.setEnabled(true);let entered!:()=>void;let ready=new Promise<void>(r=>entered=r);let scheduled=0,fired=0,calls=0,ranks=0;
 const results:any[]=[],waiters:Array<(value:any)=>void>=[];let releaseEval:(value:any)=>void=()=>{};
 const evaluation=new Promise<any>(resolve=>{releaseEval=resolve;});
 const clock={setTimeout:((fn:any)=>{scheduled++;return scheduled;}) as any,clearTimeout:((()=>{}) as any)};
 const runtime=createDiscoveryRuntime({root,sessionId:'session',config:parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']}),service:{evaluate(){calls++;entered();return evaluation;}},context:()=>'task',persist(){},observe:m=>store.beginDiscovery(m),clock});
 const realRank=runtime.rank.bind(runtime);runtime.rank=async(job:any)=>{const result=await realRank(job);ranks++;const waiter=waiters.shift();if(waiter)waiter(result);else results.push(result);return result;};
 const owners=createDiscoveryOwners('session',()=>'task');const broker=await createDiscoveryBroker({root,runtime,owners,limits:brokerLimits});
 const lease=owners.register({taskId:'task',ownerId:'worker',attemptId:'attempt',cwd:root,task:'child rounding',query:'docs',effectiveTools:['find','read'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=>'v1'});
 const assignment=owners.assignment(lease,broker.endpoint);const children=new Set<any>();
 const script=join(root,'hook-runner.mjs');
 writeFileSync(script,`import {pathToFileURL} from 'node:url';
import {Socket} from 'node:net';
const realSetTimeout=globalThis.setTimeout;let clientTimerShortened=0;
globalThis.setTimeout=function(fn,ms,...args){
 const stack=String(new Error().stack||'');
 if(process.env.SHORTEN_CLIENT_TIMER==='1'&&ms===20000&&stack.includes('broker-client.ts')){clientTimerShortened++;return realSetTimeout(fn,Number(process.env.CLIENT_TIMER_MS||400),...args);}
 return realSetTimeout(fn,ms,...args);
};
const originalEnd=Socket.prototype.end;let injected=0;const fault=process.env.FAULT||'';
if(process.env.COUNT_TERMINAL==='1'||fault)Socket.prototype.end=function(chunk,...args){
 if(typeof chunk==='string'&&chunk.includes('"type":"rank_deadline"')){
  injected++;
  if(fault==='epipe'){this.destroy(Object.assign(new Error('injected terminal write failure'),{code:'EPIPE'}));return this;}
  if(fault==='end'){this.destroy();return this;}
  if(fault==='silent')return this;
 }
 return originalEnd.call(this,chunk,...args);
};
const mod=await import(pathToFileURL(process.env.EXTENSION).href);const hooks={};const events=[];
mod.default({on:(e,f)=>(hooks[e]??=[]).push((...a)=>{events.push(e);return f(...a);}),registerTool(){throw Error('D9 must not add tools');}});
const event=JSON.parse(process.env.EVENT);const pending=hooks.tool_result[0](event,{cwd:process.env.ROOT});
if(process.env.MODE==='switch'||process.env.MODE==='shutdown'){const name=process.env.MODE==='switch'?'session_before_switch':'session_shutdown';let buf='';process.stdin.on('data',c=>{buf+=c;if(buf.includes('abort'))for(const fn of hooks[name]??[])fn();});}
const result=await pending;const advice=result?.details?.fileDiscovery;
process.stdout.write(JSON.stringify({status:advice?.status,reason:advice?.reason??null,events,original:result?.content?.[0],extra:result?.content?.[1]?.text??null,injected,clientTimerShortened,fault})+'\\n');
`);
 t.after(async()=>{for(const child of children)child.kill('SIGKILL');runtime.dispose();await broker.close();rmSync(root,{recursive:true,force:true});});
 return {store,lease,owners,calls:()=>calls,ranks:()=>ranks,clock:()=>({scheduled,fired}),entered:()=>ready,releaseEval,nextRank(){if(results.length)return Promise.resolve(results.shift());return new Promise(resolve=>waiters.push(resolve));},async runHook(mode:'deadline'|'switch'|'shutdown'|'client-deadline'|'client-epipe'|'client-end'|'client-cleanup'){
  const clientTimer=mode.startsWith('client-');const fault=mode==='client-epipe'?'epipe':mode==='client-end'?'end':mode==='client-cleanup'?'silent':'';
  const child=spawn(process.execPath,['--import',resolve('bin/test/helpers/system1-no-network.js'),script],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...discoveryAssignmentEnv(assignment,root,['docs']),MODE:mode==='switch'||mode==='shutdown'?mode:'deadline',SHORTEN_CLIENT_TIMER:clientTimer?'1':'',CLIENT_TIMER_MS:'400',FAULT:fault,COUNT_TERMINAL:clientTimer?'1':'',ROOT:root,EXTENSION:resolve('.pi/harnesses/agent-hub/file-discovery/child-extension.ts'),EVENT:JSON.stringify({toolName:'find',input:{path:'docs',pattern:'*.ts'},toolCallId:'child-deadline',content:[{type:'text',text:'a.ts\nb.ts'}],details:{}})}});
  children.add(child);let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
  const exited=new Promise<number|null>(resolve=>child.once('exit',code=>resolve(code)));
  if(mode==='deadline'||mode.startsWith('client-'))child.stdin.end();else {const marker=await Promise.race([ready.then(()=>'entered'),exited.then(()=>'exit')]);if(marker!=='entered')throw Error('hook exited before service entry '+err+out);child.stdin.write('abort\n');child.stdin.end();}
  const code=await Promise.race([exited,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('child timeout out='+out+' err='+err+' calls='+calls+' ranks='+ranks)),12000))]);return {code,err,advice:JSON.parse(out.trim().split('\n').filter(Boolean).at(-1)!)};
 }};
}
