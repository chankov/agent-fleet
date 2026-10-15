import test from 'node:test';
import assert from 'node:assert/strict';
import {createDamageOwners} from './damage-guard-owners.ts';
import {createDamageBroker,authenticateDamageFrame,decodeDamageFrame,damageAssessmentFrame} from './damage-guard-broker.ts';
import {createServer,connect} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDamageDescendantRegistration} from './damage-guard-descendant.ts';

test('F7 authenticated registration attenuates tools and canonical cwd, mints distinct siblings without inference',async()=>{
 let calls=0;const identities:any[]=[];
 const owners=createDamageOwners({current:()=>({session:'s',taskToken:'t',taskId:'task',inputRevision:'r'}),admit:()=>true});
 const broker=await createDamageBroker({authority:{...owners,register(spec,parent){const i=owners.register(spec,parent);identities.push(i);return i;}},assess:async()=>{calls++;return 'no_hold';}});
 try{
  const parent=broker.register({owner:'parent',tools:['bash','edit'],cwd:process.cwd()});
  const reg=createDamageDescendantRegistration(parent,{tools:['read','bash'],cwd:process.cwd(),admit:()=>true});
  const physical={tools:['bash'],cwd:process.cwd()},opening=reg.open(physical);physical.tools.push('write');
  const a=await opening,b=await reg.open({tools:['bash'],cwd:process.cwd()});
  assert.notEqual(a.assignment.capability,parent.capability);assert.notEqual(a.assignment.capability,b.assignment.capability);
  assert.notEqual(a.identity.attempt,b.identity.attempt);assert.deepEqual(a.identity.tools,['bash']);assert.equal(a.identity.cwd,identities[0].cwd);
  assert.equal(Object.hasOwn(a.identity,'taskId'),false);assert.equal(identities[1].taskId,'task');assert.equal(calls,0);
  a.revoke();a.revoke();await reg.close();assert.equal(identities[1].signal.aborted,true);assert.equal(identities[2].signal.aborted,true);assert.equal(identities[0].signal.aborted,false);
 }finally{await broker.close();owners.dispose();}
});
test('F7 stale Hub authority, escalation and widening cwd refuse registration; local admission is independent',async()=>{
 for(const field of ['session','taskToken','taskId','inputRevision','tools','cwd','admit','forged']){
  let current={session:'s',taskToken:'t',taskId:'task',inputRevision:'r'},allow=true;
  const owners=createDamageOwners({current:()=>current,admit:()=>true}),broker=await createDamageBroker({authority:owners,assess:async()=>{throw Error('no inference');}});
  try{
   let parent=broker.register({owner:'parent',tools:['bash'],cwd:process.cwd()});
   const reg=createDamageDescendantRegistration(field==='forged'?{...parent,capability:'0'.repeat(64)}:parent,{tools:['bash','write'],cwd:process.cwd(),admit:()=>allow});
   if(['session','taskToken','taskId','inputRevision'].includes(field))current={...current,[field]:'changed'};
   if(field==='admit')allow=false;
   await assert.rejects(reg.open({tools:field==='tools'?['write']:['bash'],cwd:field==='cwd'?'/':process.cwd()}));await reg.close();
  }finally{await broker.close();owners.dispose();}
 }
});

async function assess(a:any,id:string){return new Promise<any[]>(resolve=>{const s=connect(a.path);let text='';s.on('connect',()=>s.write(JSON.stringify(damageAssessmentFrame(a,id,'bash',{command:'synthetic'}))+'\n'));s.on('data',b=>text+=b);s.on('error',()=>{});s.on('close',()=>{resolve(text.trim()?text.trim().split('\n').map(s=>JSON.parse(s)):[]);});});}
test('F7 parent revocation fences registered descendants at real broker while unrelated sibling continues',async()=>{
 let calls=0;const ids:any[]=[],owners=createDamageOwners({current:()=>({session:'s',taskToken:'t',taskId:'task',inputRevision:'r'}),admit:()=>true});
 const broker=await createDamageBroker({authority:{...owners,register(spec,parent){const i=owners.register(spec,parent);ids.push(i);return i;}},assess:async()=>{calls++;return 'unavailable';}});
 try{
  const parent=broker.register({owner:'parent',tools:['bash'],cwd:process.cwd()}),sibling=broker.register({owner:'sibling',tools:['bash'],cwd:process.cwd()});
  const reg=createDamageDescendantRegistration(parent,{tools:['bash'],cwd:process.cwd(),admit:()=>true}),child=await reg.open({tools:['bash'],cwd:process.cwd()});
  owners.revoke(ids[0]);assert.equal(ids[2].signal.aborted,true);assert.equal((await assess(child.assignment,'late'))[0]?.outcome,'revoked');assert.equal(calls,0);
  assert.equal((await assess(sibling,'still_current'))[0]?.outcome,'unavailable');assert.equal(calls,1);await reg.close();
 }finally{await broker.close();owners.dispose();}
});

test('F7 bounded control authenticates exact reply, clean EOF and late cancellation cleanup without retry',async()=>{
 for(const mode of ['cancel','extra','wrong_id','forged_mac','parent','oversize','partial','no_eof','unavailable']){
  const dir=mkdtempSync(join(tmpdir(),'d6-control-')),path=join(dir,'s'),secret='a'.repeat(64),child='b'.repeat(64),c=new AbortController();let revokes=0,registrations=0;const sockets=new Set<any>();
  const server=createServer(socket=>{
   sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.once('data',bytes=>{
    const req=decodeDamageFrame(bytes.subarray(0,-1)) as any;
    if(req.op==='revoke_self'){revokes++;socket.end(JSON.stringify(authenticateDamageFrame({v:1,id:req.id,outcome:'revoked'},child))+'\n');return;}
    registrations++;
    const body:any={v:1,id:mode==='wrong_id'?'wrong':req.id,outcome:'registered',assignment:{path,capability:mode==='parent'?secret:child}};
    if(mode==='extra')body.unexpected=true;
    let response=JSON.stringify(authenticateDamageFrame(body,mode==='forged_mac'?child:secret))+'\n';
    if(mode==='oversize')response='x'.repeat(65537);if(mode==='partial')response='{';
    if(mode==='cancel'){c.abort();setTimeout(()=>socket.end(response),20);}else if(mode==='no_eof')socket.write(response);else socket.end(response);
   });
  });
  await new Promise<void>(r=>server.listen(path,r));
  const reg=createDamageDescendantRegistration({path:mode==='unavailable'?join(dir,'missing'):path,capability:secret},{tools:['bash'],cwd:process.cwd(),signal:c.signal,admit:()=>true});
  try{
   await assert.rejects(reg.open({tools:['bash'],cwd:process.cwd()}));await reg.close();
   assert.equal(registrations,mode==='unavailable'?0:1);assert.equal(revokes,mode==='cancel'||mode==='extra'?1:0);
  }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
 }
});
