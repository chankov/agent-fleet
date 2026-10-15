import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDamageOwners} from '../agent-hub/damage-guard-owners.ts';
import {createDamageBroker,authenticateDamageFrame} from '../agent-hub/damage-guard-broker.ts';
import {createDamageHubSession} from '../agent-hub/damage-guard-hub.ts';
import {normalizeSystem1Config} from '../lib/system1/config-v2.js';
import {createDamageClient} from './system1-client.ts';
const input={command:'echo hello'},pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function fixture(assess:any=async()=> 'no_hold',extra:any={}){
 const owners=createDamageOwners({current:()=>({session:'s',taskToken:'t',taskId:'task',inputRevision:'r'}),admit:()=>true});let calls=0;
 const broker=await createDamageBroker({authority:owners,assess:async(...args:any[])=>{calls++;return assess(...args);},...extra});const assignment=broker.register({owner:'child',tools:['bash'],cwd:process.cwd()});
 return {broker,assignment,calls:()=>calls,close:async()=>{await broker.close();owners.dispose();}};
}
async function malicious(reply:(row:any)=>string|Buffer,sign=true){
 const dir=await mkdtemp(join(tmpdir(),'af-d6-test-'));await chmod(dir,0o700);const path=join(dir,'s');
 const server=createServer(s=>{s.on('error',()=>{});s.once('data',b=>{let response=reply(JSON.parse(b.toString()));if(Buffer.isBuffer(response)){s.end(response);return;}if(sign)response=response.split('\n').map(line=>{try{return JSON.stringify(authenticateDamageFrame(JSON.parse(line),'a'.repeat(64)));}catch{return line;}}).join('\n');s.end(response);});});await new Promise<void>(r=>server.listen(path,r));await chmod(path,0o600);
 return {assignment:{path,capability:'a'.repeat(64)},close:async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}};
}
test('unassigned and invalid assignments never infer or construct a provider',async()=>{
 assert.equal((await createDamageClient().assess('bash',input)).outcome,'unavailable');for(const a of [{},{path:'https://remote',capability:'secret'},{path:'/invalid\0socket',capability:'a'.repeat(64)},{path:'/x',capability:'a'.repeat(64),extra:1}])assert.equal((await createDamageClient(a).assess('bash',input)).outcome,'indeterminate');
});
test('round trip authenticates exact owner input and fresh request identity',async()=>{
 const seen:any[]=[];const f=await fixture(async(i:any,e:any)=>{seen.push([i,e]);return 'no_hold';});const c=createDamageClient(f.assignment);try{const full={command:'echo original'};const p=c.assess('bash',full);full.command='mutated';assert.equal((await p).outcome,'no_hold');assert.equal((await c.assess('bash',input)).outcome,'no_hold');assert.equal(seen[0][1].input.command,'echo original');assert.notEqual(seen[0][1].toolCallId,seen[1][1].toolCallId);assert.notEqual(seen[0][0].owner,'hub');}finally{c.dispose();await f.close();}
});
test('client rejects malformed oversized duplicate foreign and out of order replies',async()=>{
 for(const reply of [(r:any)=>'{bad\n',(r:any)=>'x'.repeat(65537),(r:any)=>JSON.stringify({v:1,id:'foreign',outcome:'no_hold'})+'\n',(r:any)=>JSON.stringify({v:1,id:r.id,outcome:'granted'})+'\n',(r:any)=>{const s=JSON.stringify({v:1,id:r.id,outcome:'no_hold'})+'\n';return s+s;},(r:any)=>JSON.stringify({v:1,id:r.id,outcome:'no_hold',result:'SENTINEL'})+'\n',(r:any)=>Buffer.from([255,10])]){
  const f=await malicious(reply);try{assert.equal((await createDamageClient(f.assignment).assess('bash',input)).outcome,'indeterminate');}finally{await f.close();}
 }
});
test('transport delay reduces rather than restarts inference budget',async()=>{
 let remaining=0,aborted=false;
 const f=await fixture(async(_i:any,_e:any,c:any)=>{remaining=c.remainingMs;c.signal.addEventListener('abort',()=>aborted=true);await pause(75);return 'no_hold';},{technicalMs:100});try{assert.equal((await createDamageClient(f.assignment,{technicalMs:40}).assess('bash',input)).outcome,'indeterminate');await pause(80);assert.equal(f.calls(),1);assert.ok(remaining>0&&remaining<=40,`remaining ${remaining}`);assert.equal(aborted,true);}finally{await f.close();}
});
test('human wait is distinct from technical timeout',async()=>{
 const f=await fixture(async(_i:any,_e:any,c:any)=>{c.held();await pause(70);return 'granted';},{technicalMs:30,humanMs:150});try{assert.equal((await createDamageClient(f.assignment,{technicalMs:30,humanMs:150}).assess('bash',input)).outcome,'granted');}finally{await f.close();}
});
test('disconnect before held notification remains indeterminate not allow',async()=>{
 for(const reply of [()=>'',(r:any)=>JSON.stringify({v:1,id:r.id,outcome:'held'})+'\n']){const f=await malicious(reply,false);try{assert.equal((await createDamageClient(f.assignment).assess('bash',input)).outcome,'indeterminate');}finally{await f.close();}}
});
test('known hold survives reconnect off outage cancellation and revocation',async()=>{
 // Real F1 writes durable held state before cancellation. Fresh owner and client in
 // off/outage must consult it, independently of any client memory.
 const config={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{damageGuard:{mode:'active',remoteScopes:{commands:true},include:['docs']}}};
 const records:any[]=[];let calls=0;
 const session=(snapshot:any,service:any)=>createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config(snapshot),taskId:()=> 'task',append:(customType,data)=>records.push({customType,data}),entries:()=>records,canRead:()=>true,selected:true,childAuthority:{taskToken:()=> 'token',admit:()=>true},ask:async()=>({details:{cancelled:true}}),service});
 const first=session(config,{evaluate:async()=>{calls++;return {status:'ok',evaluation:{answers:[{questionId:'effect',type:'choice',value:'severe',uncertainty:{provenance:'provider'}},{questionId:'evidence',type:'choice',value:'sufficient',uncertainty:{provenance:'provider'}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}};}});first.accept('input');const original=first.registerOwner({owner:'first',tools:['bash'],cwd:process.cwd()});assert.equal((await original.call({toolName:'bash',toolCallId:'hold',input},{cwd:process.cwd(),revalidateBaseline:()=>true})).block,true);first.dispose();
 for(const config2 of [{...config,mode:'off'},config]){
  const resumed=session(config2,undefined),registered=new Map<any,any>();
  const broker=await createDamageBroker({authority:{register:(spec,parent)=>{const row=resumed.registerOwner(spec,parent);registered.set(row.identity,row);return row.identity;},validate:(i,t,c)=>!i.signal.aborted&&i.tools.includes(t)&&i.cwd===c?i:undefined,revoke:i=>registered.get(i).revoke()},assess:async(i,e)=>{const result=await registered.get(i).call(e,{cwd:i.cwd,revalidateBaseline:()=>true});return result.block?'blocked':'no_hold';}});
  const a=broker.register({owner:'fresh',tools:['bash'],cwd:process.cwd()});try{for(let n=0;n<2;n++)assert.equal((await createDamageClient(a).assess('bash',input)).outcome,'blocked');assert.equal(calls,1);}finally{await broker.close();resumed.dispose();}
 }
 const f=await fixture(async(_i:any,_e:any,c:any)=>{c.held();await pause(80);return 'granted';});const client=createDamageClient(f.assignment);const controller=new AbortController();const p=client.assess('bash',input,{signal:controller.signal});await pause(20);controller.abort();assert.equal((await p).outcome,'blocked');client.dispose();await f.close();
});
test('late allow after cancellation and replay never authorizes twice',async()=>{
 const f=await fixture(async()=>{await pause(60);return 'no_hold';});const client=createDamageClient(f.assignment);try{const p=client.assess('bash',input);await pause(10);client.dispose();assert.equal((await p).outcome,'cancelled');assert.equal((await client.assess('bash',input)).outcome,'cancelled');}finally{await f.close();}
});
test('missing off invalid root off unavailable key and D9 settings make zero D6 calls',async()=>{
 let calls=0;const base={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY'};
 const variants=[base,{...base,consumers:{damageGuard:{mode:'off'}}},{...base,consumers:{damageGuard:{mode:'invalid'}}},{...base,mode:'off',consumers:{damageGuard:{mode:'active'}}},{...base,consumers:{fileDiscovery:{mode:'active'}}}];
 for(const raw of [...variants,{...base,consumers:{damageGuard:{mode:'active',remoteScopes:{commands:true},include:['docs']}}}]){
  const missingService=!variants.includes(raw);const session=createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config(raw),taskId:()=> 'task',append:()=>{},entries:()=>[],canRead:()=>true,selected:true,childAuthority:{taskToken:()=> 't',admit:()=>true},ask:async()=>{throw Error('no approval');},service:missingService?undefined:{evaluate:async()=>{calls++;return {status:'unavailable',reason:'network'};}}});
  session.accept('input');const child=session.registerOwner({owner:'child',tools:['bash'],cwd:process.cwd()});assert.equal((await child.call({toolName:'bash',toolCallId:'test',input},{cwd:process.cwd(),revalidateBaseline:()=>true})).block,false);session.dispose();
 }assert.equal(calls,0);
});
test('unsafe or incomplete exact presentation cannot authorize',async()=>{
 const f=await fixture();try{assert.equal((await createDamageClient(f.assignment).assess('bash',{command:'x',extra:'sentinel'})).outcome,'indeterminate');assert.equal(f.calls(),0);}finally{await f.close();}
 let asks=0,evaluations=0;const session=createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{damageGuard:{mode:'active',remoteScopes:{commands:true},include:['docs']}}}),taskId:()=> 'task',append:()=>{},entries:()=>[],canRead:()=>true,selected:true,childAuthority:{taskToken:()=> 't',admit:()=>true},ask:async()=>{asks++;throw Error('must not ask');},service:{evaluate:async()=>{evaluations++;return {status:'ok',evaluation:{answers:[{questionId:'effect',type:'choice',value:'severe',uncertainty:{provenance:'provider'}},{questionId:'evidence',type:'choice',value:'sufficient',uncertainty:{provenance:'provider'}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}};}}});
 session.accept('input');const child=session.registerOwner({owner:'child',tools:['bash'],cwd:process.cwd()});try{for(const command of ['echo \\u001b','x'.repeat(9000)])assert.equal((await child.call({toolName:'bash',toolCallId:command.length.toString(),input:{command:command.replace('\\u001b','\u001b')}},{cwd:process.cwd(),revalidateBaseline:()=>true})).block,true);assert.equal(asks,0);assert.equal(evaluations,2);}finally{session.dispose();}
});
