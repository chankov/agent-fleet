import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {screenDamagePayload} from '../lib/system1/payload-screen.ts';
import {parseDamageGuardConfig} from '../lib/system1/config-damage-guard.js';
import {damageActionHashes} from '../lib/damage-action-hash.ts';
import {createDamageOwners} from './damage-guard-owners.ts';
import {createDamageBroker, validDamageInput, damageControlFrame, damageAssessmentFrame} from './damage-guard-broker.ts';
const pause=(ms=15)=>new Promise(r=>setTimeout(r,ms));
async function fixture(assess:any=async()=> 'no_hold',limits:any={}){
 let calls=0;let revision='revision';
 const owners=createDamageOwners({current:()=>({session:'session',taskToken:'token',taskId:'task',inputRevision:revision}),admit:()=>true});
 const broker=await createDamageBroker({authority:owners,assess:async(...args:any[])=>{calls++;return assess(...args);},...limits});
 const assignment=broker.register({owner:'child',tools:['bash','write','edit'],cwd:process.cwd()});
 return {broker,assignment,owners,calls:()=>calls,stale:()=>{revision='new';},close:async()=>{await broker.close();owners.dispose();}};
}
function request(a:any,id='request'){return {v:1,id,capability:a.capability,op:'assess_damage',tool:'bash',input:{command:'echo hello'},deadline:performance.timeOrigin+performance.now()+2000};}
async function wire(a:any,data:any){if(!Buffer.isBuffer(data)){const {v,id,capability,op,...extra}=data;data=damageControlFrame({...a,capability},id,op,extra);}return new Promise<any[]>(resolve=>{const socket=connect(a.path);const replies:any[]=[];let text='';socket.on('connect',()=>socket.write(Buffer.isBuffer(data)?data:JSON.stringify(data)+'\n'));socket.on('data',b=>{text+=b;for(let n;(n=text.indexOf('\n'))>=0;){replies.push(JSON.parse(text.slice(0,n)));text=text.slice(n+1);}});socket.on('error',()=>{});socket.on('close',()=>resolve(replies));});}
test('auth rejects forged cross-owner stale revoked and replayed requests before assessment',async()=>{
 const f=await fixture();try{
  await wire(f.assignment,request({...f.assignment,capability:'forged'}));assert.equal(f.calls(),0);
  assert.equal((await wire(f.assignment,request(f.assignment)))[0].outcome,'no_hold');
  await wire(f.assignment,request(f.assignment));assert.equal(f.calls(),1);
  await wire(f.assignment,{...request(f.assignment,'cross'),owner:'hub'});assert.equal(f.calls(),1);
  f.stale();await wire(f.assignment,request(f.assignment,'stale'));assert.equal(f.calls(),1);
 }finally{await f.close();}
});
test('descendant controls attenuate authority without launch permission',async()=>{
 const f=await fixture();try{
  const response=(await wire(f.assignment,{v:1,id:'child',capability:f.assignment.capability,op:'register_descendant',tools:['write']}))[0];
  assert.equal(response.outcome,'registered');assert.deepEqual(Object.keys(response.assignment).sort(),['capability','path']);
  await wire(response.assignment,request(response.assignment));assert.equal(f.calls(),0);
  await wire(f.assignment,{v:1,id:'bad',capability:f.assignment.capability,op:'register_descendant',tools:['read']});assert.equal(f.calls(),0);
  await wire(f.assignment,{v:1,id:'revoke',capability:f.assignment.capability,op:'revoke_self'});
  await wire(response.assignment,{...request(response.assignment,'late'),tool:'write',input:{path:'x',content:'x'}});assert.equal(f.calls(),0);
 }finally{await f.close();}
});
test('schema rejects unknown operations fields and malformed tool input',async()=>{
 const f=await fixture();try{for(const extra of [{op:'result'},{deadline:1},{deadline:null},{deadline:'later'},{deadline:undefined},{cwd:'/'},{taskId:'other'},{input:{command:'x',secret:'x'}},{tool:'edit',input:{path:'x',edits:[{oldText:'',newText:'x'}]}}])await wire(f.assignment,{...request(f.assignment,'schema_'+Math.random().toString(36).slice(2)),...extra});assert.equal(f.calls(),0);assert.ok(validDamageInput('edit',{path:'x',edits:[{oldText:'a',newText:'b'}]}));}finally{await f.close();}
});
test('framing rejects fatal UTF8 partial oversize coalesced and late extra frames',async()=>{
 const f=await fixture(async(_i:any,_e:any,ctx:any)=>new Promise(r=>ctx.signal.addEventListener('abort',()=>r('no_hold'))),{technicalMs:60});try{
  for(const b of [Buffer.from([255,10]),Buffer.from('{'),Buffer.alloc(65537,120),Buffer.from(JSON.stringify(damageAssessmentFrame(f.assignment,'a','bash',{command:'echo hello'}))+'\n{}\n')])await wire(f.assignment,b);
  assert.equal(f.calls(),0);
  const socket=connect(f.assignment.path);let text='';socket.on('error',()=>{});socket.on('data',b=>text+=b);await new Promise<void>(r=>socket.once('connect',r));socket.write(JSON.stringify(damageAssessmentFrame(f.assignment,'late','bash',{command:'echo hello'}))+'\n');await pause();socket.write('{}\n');await new Promise(r=>socket.once('close',r));assert.ok(!text.includes('no_hold'));
 }finally{await f.close();}
});
test('byte boundaries distinguish 16KiB export from 64KiB IPC',async()=>{
 let exports=0;const config=parseDamageGuardConfig({mode:'active',remoteScopes:{commands:true},include:['docs']});
 const f=await fixture(async(_i:any,e:any)=>{const screened=await screenDamagePayload({kind:'command',input:e.input},{root:process.cwd(),config,canRead:()=>true});if(screened.status==='ready')exports++;return 'unavailable';});try{
  for(const length of [16000,17000])assert.equal((await wire(f.assignment,{...request(f.assignment,String(length)),input:{command:'é'.repeat(length/2)}}))[0].outcome,'unavailable');assert.equal(exports,1);assert.equal(f.calls(),2);
  const deadline=performance.timeOrigin+performance.now()+2000;
  const frame=(n:number,id:string)=>Buffer.from(JSON.stringify(damageAssessmentFrame(f.assignment,id,'bash',{command:'x'.repeat(n)},deadline))+'\n');
  const overhead=frame(0,'boundary').length;assert.equal(frame(65536-overhead,'boundary').length,65536);
  await wire(f.assignment,frame(65536-overhead,'boundary'));assert.equal(f.calls(),3);
  await wire(f.assignment,frame(65537-overhead,'boundary'));assert.equal(f.calls(),3);
  assert.notDeepEqual(damageActionHashes('bash',{command:'x'.repeat(17000)+'a'}),damageActionHashes('bash',{command:'x'.repeat(17000)+'b'}));
 }finally{await f.close();}
});
test('one technical deadline includes transport collection and assessment',async()=>{
 let remaining=0;const f=await fixture(async(_i:any,_e:any,c:any)=>{remaining=c.remainingMs;return 'no_hold';},{technicalMs:100});try{const s=connect(f.assignment.path);s.on('error',()=>{});s.resume();await new Promise<void>(r=>s.once('connect',r));s.write('{');await pause(40);s.write(JSON.stringify(damageAssessmentFrame(f.assignment,'request','bash',{command:'echo hello'})).slice(1)+'\n');await new Promise(r=>s.once('close',r));assert.ok(remaining>0&&remaining<85);}finally{await f.close();}
});
test('original deadline includes pre-admission delay and cannot extend parent budget',async()=>{
 let remaining=0,held=false;const f=await fixture(async(_i:any,_e:any,c:any)=>{remaining=c.remainingMs;await pause(60);held=c.held();return 'no_hold';},{technicalMs:150});try{
  // Deterministically model 100 ms already spent before broker admission.
  const originalStart=performance.timeOrigin+performance.now()-100;
  const reply=await wire(f.assignment,Buffer.from(JSON.stringify(damageAssessmentFrame(f.assignment,'delayed','bash',{command:'echo hello'},originalStart+150))+'\n'));
  assert.ok(remaining>0&&remaining<=50,`remaining ${remaining}`);assert.equal(reply[0].outcome,'indeterminate');await pause(30);assert.equal(held,false);
  await wire(f.assignment,Buffer.from(JSON.stringify(damageAssessmentFrame(f.assignment,'expired','bash',{command:'echo hello'},performance.timeOrigin+performance.now()-1))+'\n'));assert.equal(f.calls(),1);
 }finally{await f.close();}
 let capped=0;const g=await fixture(async(_i:any,_e:any,c:any)=>{capped=c.remainingMs;return 'no_hold';},{technicalMs:50});try{
  await wire(g.assignment,Buffer.from(JSON.stringify(damageAssessmentFrame(g.assignment,'extension','bash',{command:'echo hello'},performance.timeOrigin+performance.now()+600000))+'\n'));assert.ok(capped>0&&capped<=50);
 }finally{await g.close();}
});
test('held phase outlives technical deadline but not human expiry',async()=>{
 const f=await fixture(async(_i:any,_e:any,c:any)=>{c.held();await pause(70);return 'granted';},{technicalMs:30,humanMs:150});try{assert.deepEqual((await wire(f.assignment,request(f.assignment))).map(r=>r.outcome),['held','granted']);}finally{await f.close();}
 const g=await fixture(async(_i:any,_e:any,c:any)=>{c.held();await pause(70);return 'granted';},{technicalMs:30,humanMs:35});try{assert.deepEqual((await wire(g.assignment,request(g.assignment))).map(r=>r.outcome),['held','blocked']);}finally{await g.close();}
});
test('disconnect revoke close and late completion cannot release a hold',async()=>{
 for(const mode of ['disconnect','revoke','close']){let aborted=false;const f=await fixture(async(_i:any,_e:any,c:any)=>{c.held();c.signal.addEventListener('abort',()=>aborted=true);await pause(60);return 'no_hold';});const s=connect(f.assignment.path);s.on('error',()=>{});await new Promise<void>(r=>s.once('connect',r));s.write(JSON.stringify(damageAssessmentFrame(f.assignment,'request','bash',{command:'echo hello'}))+'\n');await new Promise(r=>s.once('data',r));if(mode==='disconnect')s.destroy();if(mode==='revoke')await wire(f.assignment,{v:1,id:'r',capability:f.assignment.capability,op:'revoke_self'});if(mode==='close')await f.broker.close();await pause();assert.equal(aborted,true);await f.close();}
});
test('diagnostics never echo sentinel input capability or provider extras',async()=>{
 const diagnostics:any[]=[];const f=await fixture(async()=>{throw Error('SENTINEL provider extras');},{diagnostic:(r:any)=>diagnostics.push(r)});try{await wire(f.assignment,{...request(f.assignment),input:{command:'SENTINEL'}});const text=JSON.stringify(diagnostics);assert.ok(!text.includes('SENTINEL'));assert.ok(!text.includes(f.assignment.capability));assert.deepEqual(diagnostics,[{event:'assessment_failed'}]);}finally{await f.close();}
});
test('bounded resources refuse overload without replay reopening',async()=>{
 const f=await fixture(undefined,{maxReplay:1,maxOwners:1});try{await wire(f.assignment,request(f.assignment));await wire(f.assignment,request(f.assignment,'new'));await wire(f.assignment,request(f.assignment));assert.equal(f.calls(),1);assert.throws(()=>f.broker.register({owner:'new',tools:['bash'],cwd:process.cwd()}));}finally{await f.close();}
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>release=r);
 const g=await fixture(async()=>{entered();await waiting;return 'no_hold';},{maxPending:1,technicalMs:100});try{
  const pending=wire(g.assignment,request(g.assignment,'pending'));await started;
  await wire(g.assignment,request(g.assignment,'overloaded'));assert.equal(g.calls(),1);
  release();await pending;await wire(g.assignment,request(g.assignment,'pending'));assert.equal(g.calls(),1);
 }finally{release();await g.close();}
 const h=await fixture(undefined,{maxConnections:1,technicalMs:50});let socket:any;try{
  socket=connect(h.assignment.path);socket.on('error',()=>{});socket.resume();await new Promise<void>(r=>socket.once('connect',r));socket.write('{');
  await wire(h.assignment,request(h.assignment));assert.equal(h.calls(),0);
  await new Promise(r=>socket.once('close',r));await wire(h.assignment,request(h.assignment,'after-expiry'));assert.equal(h.calls(),1);
 }finally{socket?.destroy();await h.close();}
});

test('result client uses advisory-only authenticated reply and never an effect grant',async()=>{
 const {createDamageClient}=await import('../damage-control-continue/system1-client.ts');
 const metadata={version:1,status:'evaluated',coverage:'complete',reason:'severe_source_instructions',warning:true,sourceTrusted:false};
 let calls=0;const f=await fixture(undefined,{result:async(_owner:any,event:any,ctx:any)=>{calls++;assert.equal(event.toolName,'bash');assert.ok(ctx.remainingMs>0&&ctx.remainingMs<=2000);assert.equal(ctx.held,undefined);return metadata;}});
 const client=createDamageClient(f.assignment);try{
  const event={toolName:'bash',toolCallId:'result',input:{command:'cat docs/a'},content:[{type:'text',text:'body'}],structuredContent:{output:'body',exit_code:0,truncated:false}};
  assert.deepEqual(await client.result(event),metadata);assert.equal(calls,1);assert.equal(f.calls(),0);
  assert.equal((await client.result({...event,input:{command:'cat docs/a',secret:'SENTINEL'}})).status,'not_evaluated');assert.equal(calls,1);
  assert.equal((await client.result(event,{deadlineAt:performance.timeOrigin+performance.now()-1})).status,'not_evaluated');assert.equal(calls,1);
 }finally{client.dispose();await f.close();}
});
test('F9 result schema auth replay malformed frames and stale owners refuse without result evaluation',async()=>{
 let calls=0;const f=await fixture(undefined,{technicalMs:40,result:async()=>{calls++;return {version:1,status:'not_evaluated',coverage:'none',reason:'service_unavailable',warning:false,sourceTrusted:false};}});
 const evidence={toolName:'bash',input:{command:'cat docs/a'},content:[{type:'text',text:'body'}],structuredContent:{output:'body',exit_code:0,truncated:false}};
 const frame=(id:string,extra:any={})=>({v:1,id,capability:f.assignment.capability,op:'screen_result',deadline:performance.timeOrigin+performance.now()+2000,evidence,...extra});
 try{
  for(const [i,extra] of [{owner:'hub'},{cwd:'/'},{taskId:'forged'},{evidence:{...evidence,usage:{secret:'SENTINEL'}}},{evidence:{...evidence,input:{command:'cat docs/a',secret:'SENTINEL'}}},{deadline:1}].entries())await wire(f.assignment,frame('bad'+i,extra));
  const forged={...f.assignment,capability:'a'.repeat(64)};await wire(forged,{...frame('forged'),capability:forged.capability});assert.equal(calls,0);
  const valid=frame('once');assert.equal((await wire(f.assignment,valid))[0].result.reason,'service_unavailable');await wire(f.assignment,valid);assert.equal(calls,1);
  const encoded=JSON.stringify(damageControlFrame(f.assignment,'bytes','screen_result',{deadline:performance.timeOrigin+performance.now()+2000,evidence}));
  for(const bytes of [Buffer.from(encoded),Buffer.from(encoded+'\n{}\n'),Buffer.alloc(65537,120),Buffer.from([255,10])])await wire(f.assignment,bytes);assert.equal(calls,1);
  f.stale();await wire(f.assignment,frame('stale'));assert.equal(calls,1);assert.equal(f.calls(),0);
 }finally{await f.close();}
});
