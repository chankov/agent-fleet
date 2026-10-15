import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import net from 'node:net';
let sockets=0;
const connect=net.connect;
net.connect=((...args:any[])=>{sockets++;return (connect as any)(...args);}) as typeof net.connect;
syncBuiltinESMExports();
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDamageOwners} from '../agent-hub/damage-guard-owners.ts';
import {createDamageBroker} from '../agent-hub/damage-guard-broker.ts';
import {registerDamageGuard,assessDamageCall} from '../lib/damage-guard-port.ts';
import {sharedApprovalWait} from '../lib/approval-wait.ts';
registerHooks({resolve(s,c,n){return n(s==='@mariozechner/pi-coding-agent'?'@earendil-works/pi-coding-agent':s,c);}});
const {ExtensionRunner}=await import('@earendil-works/pi-coding-agent');
const {default:register}=await import('./index.ts');
const {createDamageChild}=await import('./system1-child.ts');
test.beforeEach(t=>{
 const keys=['AGENT_HUB_ASK_ENDPOINT','AGENT_HUB_EXEMPTIONS_FILE','AGENT_HUB_AGENT_ID'];
 const saved=keys.map(k=>process.env[k]);for(const k of keys)delete process.env[k];
 t.after(()=>keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];}));
});
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const event=(id='call'):any=>({toolName:'bash',toolCallId:id,input:{command:'echo fixture'}});
async function broker(t:any,assess:any=async()=> 'no_hold'){
 const owners=createDamageOwners({current:()=>({session:'s',taskToken:'t',taskId:'task',inputRevision:'r'}),admit:()=>true});let calls=0;
 const b=await createDamageBroker({authority:owners,assess:async(...args:any[])=>{calls++;return assess(...args);}});
 t.after(async()=>{await b.close();owners.dispose();});return {b,owners,assignment:b.register({owner:'child',tools:['bash','write','edit'],cwd:process.cwd()}),calls:()=>calls};
}
function fixture(t:any,assignment?:unknown,rules:any={}){
 const root=mkdtempSync(join(tmpdir(),'d6-child-'));mkdirSync(join(root,'.pi'));
 writeFileSync(join(root,'.pi','damage-control-rules.yaml'),JSON.stringify({bashToolPatterns:[],zeroAccessPaths:[],readOnlyPaths:[],noDeletePaths:[],...rules}));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const handlers=new Map<string,Function[]>(),commands=new Map<string,any>();
 const pi:any={on(n:string,h:Function){handlers.set(n,[...(handlers.get(n)??[]),h]);},registerCommand(n:string,c:any){commands.set(n,c);},appendEntry(){}};
 register(pi,{assignment});
 const runner:any=new ExtensionRunner([{path:'offline-child',handlers}] as any,{} as any,root,{} as any,{} as any);
 // Real SDK emission/awaiting with synthetic context avoids home config, UI and providers.
 const ctx:any={cwd:root,hasUI:false,ui:{notify(){},setStatus(){},select:async()=> 'Allow once',confirm:async()=>true}};
 runner.createContext=()=>ctx;
 t.after(async()=>runner.emit({type:'session_shutdown'}));
 return {runner,ctx,commands,start:()=>runner.emit({type:'session_start'}),call:(e:any)=>runner.emitToolCall(e)};
}
test('import and factory perform no IPC; installed SDK awaits startup before first assigned call',async t=>{
 assert.equal(sockets,0,'imports opened no sockets');
 const f=await broker(t);const before=sockets;const x=fixture(t,f.assignment);assert.equal(sockets,before);
 await x.start();assert.equal(sockets,before);assert.equal((await x.call(event())).block,false);assert.equal(f.calls(),1);assert.equal(sockets,before+1);
});
test('missing assignment preserves parent registration; malformed forged and revoked never authorize',async t=>{
 const cleanup=registerDamageGuard({call:async()=>({block:true,reason:'parent'})});t.after(cleanup);
 const x=fixture(t);await x.start();assert.equal((await x.call(event())).reason,'parent');await x.runner.emit({type:'session_shutdown'});assert.equal((await assessDamageCall(event(),{cwd:process.cwd()})).reason,'parent');
 const f=await broker(t);for(const assignment of [{}, {...f.assignment,capability:'a'.repeat(64)}]){
  const before=sockets,child=createDamageChild(assignment);assert.equal((await assessDamageCall(event(),{cwd:process.cwd(),revalidateBaseline:()=>true})).block,true);child.dispose();if(!Object.hasOwn(assignment,'path'))assert.equal(sockets,before);
 }
 await f.b.close();const child=createDamageChild(f.assignment);t.after(()=>child.dispose());assert.equal((await assessDamageCall(event(),{cwd:process.cwd(),revalidateBaseline:()=>true})).block,true);assert.equal(f.calls(),0);
});
test('baseline hard deny never assesses; all local allow branches remain baseline-first',async t=>{
 const f=await broker(t);const x=fixture(t,f.assignment,{bashToolPatterns:[{pattern:'DENY',reason:'hard'},{pattern:'ASK',reason:'confirm',ask:true}],zeroAccessPaths:['secret']});await x.start();
 assert.equal((await x.call({...event('deny'),input:{command:'DENY'}})).block,true);assert.equal(f.calls(),0);
 await x.call(event('normal'));await x.commands.get('af-allow').handler('secret session',x.ctx);await x.call({...event('exempt'),input:{command:'echo secret'}});
 await x.commands.get('af-revoke').handler('secret',x.ctx);x.ctx.hasUI=true;
 for(const choice of ['Allow once','Allow for this turn','Allow for this session']){x.ctx.ui.select=async()=>choice;await x.call({...event(choice),input:{command:'echo secret'}});await x.commands.get('af-revoke').handler('secret',x.ctx);}
 await x.call({...event('confirm'),input:{command:'ASK'}});assert.equal(f.calls(),6);
 await x.call({toolName:'read',toolCallId:'read',input:{path:'public'}});assert.equal(f.calls(),6);
});
test('assigned write and edit export exact tool input without local callback or child identity',async t=>{
 const seen:any[]=[];const f=await broker(t,async(_i:any,e:any)=>{seen.push(e);return 'no_hold';});const x=fixture(t,f.assignment);await x.start();
 for(const e of [{toolName:'write',toolCallId:'write',input:{path:'public',content:'fixture'}},{toolName:'edit',toolCallId:'edit',input:{path:'public',oldText:'fixture',newText:'new'}}]){
  assert.equal((await x.call(e)).block,false);const received=seen.at(-1);assert.equal(received.toolName,e.toolName);assert.deepEqual(received.input,e.input);assert.deepEqual(Object.keys(received).sort(),['input','toolCallId','toolName']);
 }
 assert.equal(f.calls(),2);
});
test('held headless concurrent requests use parent owner; duplicate observer cannot double admit',async t=>{
 let active=0,peak=0;
 const f=await broker(t,async(_i:any,_e:any,c:any)=>{c.held();return await sharedApprovalWait.run(async()=>{active++;peak=Math.max(peak,active);await pause(20);active--;return 'granted';},c.signal)??'cancelled';});const child=createDamageChild(f.assignment);t.after(()=>child.dispose());
 const ctx={cwd:process.cwd(),revalidateBaseline:()=>true};const e=event();const p=assessDamageCall(e,ctx);
 assert.equal((await assessDamageCall(e,ctx)).block,true);assert.deepEqual((await Promise.all([p,assessDamageCall(event('other'),ctx)])).map(r=>r.block),[false,false]);assert.equal(f.calls(),2);assert.equal(peak,1);
});
test('changed input cwd baseline and replacement block late outcomes; cleanup is identity safe',async t=>{
 for(const outcome of ['no_hold','granted'])for(const change of ['input','cwd','baseline','dispose','replacement']){
  let release:any;const ready=new Promise<void>(r=>release=r);let finish:any;const wait=new Promise<void>(r=>finish=r);
  const f=await broker(t,async(_i:any,_e:any,c:any)=>{if(outcome==='granted')c.held();release();await wait;return outcome;});const child=createDamageChild(f.assignment);t.after(()=>child.dispose());
  const e=event(),ctx={cwd:process.cwd(),revalidateBaseline:()=>true};const p=assessDamageCall(e,ctx);await ready;
  if(change==='input')e.input.command='changed';if(change==='cwd')ctx.cwd+='changed';if(change==='baseline')ctx.revalidateBaseline=()=>false;if(change==='dispose')child.dispose();
  let newer:any;if(change==='replacement'){child.dispose();newer=createDamageChild(f.assignment);t.after(()=>newer.dispose());}
  finish();assert.equal((await p).block,true,`${outcome}/${change}`);child.dispose();if(newer)assert.equal((await assessDamageCall(event('new'),{cwd:process.cwd(),revalidateBaseline:()=>true})).block,false);
 }
});
test('terminal outcome mapping is fail closed except authenticated no-hold unavailable and held grant',async t=>{
 for(const outcome of ['no_hold','unavailable','granted','blocked','cancelled','revoked','indeterminate']){
  const f=await broker(t,async(_i:any,_e:any,c:any)=>{if(outcome==='granted')c.held();return outcome;});const child=createDamageChild(f.assignment);t.after(()=>child.dispose());
  assert.equal((await assessDamageCall(event(),{cwd:process.cwd(),revalidateBaseline:()=>true})).block,!['no_hold','unavailable','granted'].includes(outcome),outcome);child.dispose();
 }
});
test('SDK cancelled before-switch retains adapter; shutdown and startup invalidate pending baseline and semantic waits',async t=>{
 let release:any;const ready=new Promise<void>(r=>release=r);let finish:any;const wait=new Promise<void>(r=>finish=r);
 const f=await broker(t,async()=>{release();await wait;return 'no_hold';});const x=fixture(t,f.assignment);await x.start();await x.runner.emit({type:'session_before_switch',reason:'new'});
 const p=x.call(event());await ready;await x.runner.emit({type:'session_shutdown'});finish();assert.equal((await p).block,true);
 await x.start();assert.equal((await x.call(event('fresh'))).block,false);
 let selectFinish:any;x.ctx.hasUI=true;x.ctx.ui.select=()=>new Promise(r=>selectFinish=r);
 // Separate synthetic path-policy startup; replacement during a baseline approval is blocked.
 const y=fixture(t,f.assignment,{zeroAccessPaths:['secret']});await y.start();y.ctx.hasUI=true;y.ctx.ui.select=x.ctx.ui.select;
 const pending=y.call({...event('once'),input:{command:'echo secret'}});await pause(5);await y.runner.emit({type:'session_shutdown'});selectFinish('Allow once');assert.equal((await pending).block,true);
});
test('registered exemption revocation and exact allow-once replay block after parent held approval',async t=>{
 let release:any;let ready=new Promise<void>(r=>release=r);let finish:any;let wait=new Promise<void>(r=>finish=r);
 const f=await broker(t,async(_i:any,_e:any,c:any)=>{c.held();release();await wait;return 'granted';});
 const x=fixture(t,f.assignment,{zeroAccessPaths:['secret']});await x.start();await x.commands.get('af-allow').handler('secret session',x.ctx);
 const p=x.call({...event('exemption'),input:{command:'echo secret'}});await ready;await x.commands.get('af-revoke').handler('secret',x.ctx);finish();assert.equal((await p).block,true);
 ready=new Promise<void>(r=>release=r);wait=new Promise<void>(r=>finish=r);x.ctx.hasUI=true;
 const e={...event('once'),input:{command:'echo secret'}};const once=x.call(e);await ready;finish();assert.equal((await once).block,false);assert.equal((await x.call(e)).block,true);assert.equal(f.calls(),2);
});
test('SDK overlapping and replacement startup cancels old work; repeated and stale cleanup preserve new owner',async t=>{
 let release:any;const ready=new Promise<void>(r=>release=r);let finish:any;const wait=new Promise<void>(r=>finish=r);
 const f=await broker(t,async()=>{release();await wait;return 'no_hold';});const x=fixture(t,f.assignment);
 await Promise.all([x.start(),x.start()]);const p=x.call(event());await ready;await x.start();finish();assert.equal((await p).block,true);assert.equal((await x.call(event('new'))).block,false);
 await x.runner.emit({type:'session_shutdown'});await x.runner.emit({type:'session_shutdown'});await x.start();assert.equal((await x.call(event('quit-restart'))).block,false);
 const old=createDamageChild(f.assignment),newer=createDamageChild(f.assignment);old.dispose();old.dispose();t.after(()=>newer.dispose());assert.equal((await assessDamageCall(event('owned'),{cwd:process.cwd(),revalidateBaseline:()=>true})).block,false);
});
test('assigned headless baseline escalation allows each branch through D6 exactly once',async t=>{
 const f=await broker(t);const root=mkdtempSync(join(tmpdir(),'d6-escalate-')),path=join(root,'s');let decision='allow_once',requests=0;
 const saved=process.env.AGENT_HUB_ASK_ENDPOINT;process.env.AGENT_HUB_ASK_ENDPOINT=path;
 const server=net.createServer(s=>{let buf='';s.on('data',chunk=>{buf+=chunk;if(!buf.includes('\n'))return;const row=JSON.parse(buf.split('\n')[0]);requests++;s.end(JSON.stringify({type:'access_decision',msg_id:row.msg_id,decision})+'\n');});});await new Promise<void>(r=>server.listen(path,r));
 try{
  const x=fixture(t,f.assignment,{zeroAccessPaths:['secret']});await x.start();
  x.ctx.ui.select=async()=>{throw Error('headless must not ask local UI');};
  for(const d of ['allow_once','allow_agent','allow_all']){decision=d;await x.commands.get('af-revoke').handler('secret',x.ctx);assert.equal((await x.call({...event(d),input:{command:'echo secret'}})).block,false);}
  assert.equal(requests,3);assert.equal(f.calls(),3);
 }finally{if(saved===undefined)delete process.env.AGENT_HUB_ASK_ENDPOINT;else process.env.AGENT_HUB_ASK_ENDPOINT=saved;await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
test('live owner revocation and lost responses before or after held never authorize',async t=>{
 for(const held of [false,true]){
  let release:any;const ready=new Promise<void>(r=>release=r);let finish:any;const wait=new Promise<void>(r=>finish=r);
  const f=await broker(t,async(_i:any,_e:any,c:any)=>{if(held)c.held();release();await wait;return held?'granted':'no_hold';});
  const child=createDamageChild(f.assignment);t.after(()=>child.dispose());const p=assessDamageCall(event(),{cwd:process.cwd(),revalidateBaseline:()=>true});await ready;f.owners.dispose();finish();assert.equal((await p).block,true);
  child.dispose();
 }
 // Clean EOF with no terminal response must fail both before and after held.
 const {authenticateDamageFrame}=await import('../agent-hub/damage-guard-broker.ts');
 for(const terminal of ['', 'held-only', 'unavailable', 'no_hold']){
  const held=terminal!=='';
  const root=mkdtempSync(join(tmpdir(),'d6-loss-')),path=join(root,'s');const capability='a'.repeat(64);
  const server=net.createServer(s=>{s.on('error',()=>{});s.once('data',b=>{const row=JSON.parse(b.toString());s.end(held?JSON.stringify(authenticateDamageFrame({v:1,id:row.id,outcome:'held'},capability))+'\n'+(terminal==='held-only'?'':JSON.stringify(authenticateDamageFrame({v:1,id:row.id,outcome:terminal},capability))+'\n'):'');});});
  await new Promise<void>(r=>server.listen(path,r));const child=createDamageChild({path,capability});
  try{assert.equal((await assessDamageCall(event(),{cwd:process.cwd(),revalidateBaseline:()=>true})).block,true);}finally{child.dispose();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
 }
});
test('F9 registered result hook captures without assignment and assigned adapter screens once per emission',async t=>{
 const {damageCaptureState,originalDamageResult}=await import('../lib/damage-result-evidence.ts');
 const unassigned=fixture(t);await unassigned.start();
 const raw:any={toolName:'read',toolCallId:'result',input:{path:'public'},content:[{type:'text',text:'original'}],structuredContent:'original'};
 // Runner clones events; the next hook observes the same emission-local capture.
 let captured:any;unassigned.runner.extensions[0].handlers.get('tool_result').push((e:any)=>{captured=originalDamageResult(e);assert.equal(damageCaptureState(e),'captured');});
 await unassigned.runner.emitToolResult(raw);assert.equal(captured.content[0].text,'original');
 const child=createDamageChild({});t.after(()=>child.dispose());
 assert.equal(typeof child.result,'function');
 const first=child.result(raw),second=child.result(raw);assert.equal(first,second);
 const view=await first;assert.match(view.content.at(-1).text,/transport_unavailable/);assert.equal(view.structuredContent.startsWith('original'),true);
});
