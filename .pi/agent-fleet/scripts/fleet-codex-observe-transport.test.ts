import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { createObservationReader } from './lib/fleet-codex-observe-transport.ts';
const target={project:'fake',peer:'worker',sessionId:'fake-session',startedAt:'2026-01-01T00:00:00.000Z'};
async function setup(t:{after:(f:()=>Promise<void>)=>void},respond?:(s:Socket,frame:Record<string,unknown>)=>void) {
 const root=await mkdtemp(join(tmpdir(),'fake-observation-'));await mkdir(join(root,'sockets'));t.after(()=>rm(root,{recursive:true,force:true}));
 let frames:Record<string,unknown>[]=[];
 if(respond){const server=createServer(s=>{let b='';s.on('error',()=>{});s.on('data',v=>{b+=v;if(!b.includes('\n'))return;const frame=JSON.parse(b.split('\n')[0]);frames.push(frame);respond(s,frame);});});
 await new Promise<void>((r,j)=>{server.once('error',j);server.listen(join(root,'sockets',target.sessionId+'.sock'),r);});t.after(()=>new Promise<void>(r=>server.close(()=>r())));}
 return {root,frames,read:createObservationReader({registryRoot:root,now:()=>Date.parse(target.startedAt)})};
}
const reply=(f:Record<string,unknown>,owner=target)=>({type:'observation_response',version:1,msg_id:f.msg_id,owner,status:'available',observedAt:target.startedAt,
 transcript:{status:'available',partial:false,reasons:[],entries:[{at:target.startedAt,kind:'assistant',text:'real projected text'}]},
 questionState:{status:'available',partial:false,reasons:[],questions:[],resolved:[],nextCursor:null}});
test('one addressed snapshot RPC only, explicit root and owner',async t=>{
 const f=await setup(t,(s,r)=>s.end(JSON.stringify(reply(r))+'\n'));const r=await f.read(target) as ReturnType<typeof reply>;
 assert.equal(r.transcript.entries[0].text,'real projected text');assert.equal(f.frames.length,1);
 assert.equal(f.frames[0].type,'observation_request');assert.equal(f.frames[0].operation,'snapshot');assert.deepEqual(f.frames[0].owner,target);
 assert.equal(Object.hasOwn(f.frames[0],'prompt'),false);assert.equal(Object.hasOwn(f.frames[0],'answer'),false);
});
test('wrong owner payload never escapes',async t=>{
 const f=await setup(t,(s,r)=>s.end(JSON.stringify({...reply(r,{...target,sessionId:'other'}),private:'SECRET'})+'\n'));
 const r=await f.read(target);assert.equal(JSON.stringify(r).includes('SECRET'),false);assert.match(JSON.stringify(r),/RPC_INVALID/);
});
test('old peer NACK is honest unsupported, not empty progress/questions',async t=>{
 const f=await setup(t,(s,r)=>s.end(JSON.stringify({type:'nack',msg_id:r.msg_id,reason:'unknown type'})+'\n'));
 assert.match(JSON.stringify(await f.read(target)),/RPC_UNSUPPORTED/);
});
test('missing socket reports unavailable without creating files',async t=>{
 const f=await setup(t);assert.match(JSON.stringify(await f.read(target)),/RPC_UNAVAILABLE/);
});
test('oversized response cannot be projected',async t=>{
 const f=await setup(t,(s)=>s.end('x'.repeat(131073)+'\n'));assert.match(JSON.stringify(await f.read(target)),/RPC_INVALID/);
});
test('symlink source socket and unsafe target ID rejected',async t=>{
 const f=await setup(t);await symlink('/tmp/not-a-real-observation-socket',join(f.root,'sockets',target.sessionId+'.sock'));
 assert.match(JSON.stringify(await f.read(target)),/UNSAFE_PATH/);
 assert.match(JSON.stringify(await f.read({...target,sessionId:'../escape'})),/UNSAFE_PATH/);
});

test('absolute read deadline cannot be extended by a trickling peer',async t=>{
 const f=await setup(t,s=>{
  const heartbeat=setInterval(()=>s.write(' '),75),end=setTimeout(()=>s.end(),1900);
  s.once('close',()=>{clearInterval(heartbeat);clearTimeout(end);});
 });
 const r=await f.read(target);assert.match(JSON.stringify(r),/RPC_UNAVAILABLE/);
});
