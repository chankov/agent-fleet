import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type {RegistryEntry} from './lib/coms-envelope.ts';
const root=fs.mkdtempSync('/tmp/fct-');
process.env.PI_COMS_DIR=root;
process.env.HERDR_SOCKET_PATH=path.join(root,'herdr.sock');
const {sendInstruction,exchange,requestQuestion,probeInstruction}=await import('./lib/fleet-codex-transport.ts');
const {readOneLine,makeEndpoint}=await import('./lib/coms-envelope.ts');
test('real socket transport verifies visible identity, ACK, reply owner and timeout',async t=>{
 fs.mkdirSync(path.join(root,'sockets'));
 const entry:RegistryEntry={session_id:'session-one',name:'hub',endpoint:makeEndpoint('session-one'),pid:process.pid,cwd:root,started_at:new Date().toISOString(),explicit:false,version:1,model:'test',purpose:'test',color:'blue'};
 let mode='reply';let prompts=0;
 const sockets=new Set<net.Socket>();
 const fake=async(socketPath:string,handler:(s:net.Socket,r:any)=>void)=>{
  const server=net.createServer(s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));void readOneLine(s).then(line=>handler(s,JSON.parse(line))).catch(()=>s.destroy());});
  await new Promise<void>(r=>server.listen(socketPath,r));return server;
 };
 const herdr=await fake(process.env.HERDR_SOCKET_PATH!, (s,r)=>s.end(JSON.stringify({id:r.id,result:{agents:[{pane_id:'pane',agent:'pi',tokens:{coms:'hub',proj:'af'}}]}})+'\n'));
 const pi=await fake(entry.endpoint,(s,r)=>{
  if(r.type==='question_request') {
   const q={id:'q1',toolCallId:'tool',owner:r.owner,question:'Language?',options:[{title:'BG'}],allowMultiple:false,allowFreeform:false,allowComment:false,createdAt:new Date().toISOString(),expiresAt:null,state:'pending'};
   if(mode==='alien-question')q.owner={...r.owner,sessionId:'alien'};
   if(mode==='malformed-question')(q as any).options=[{title:42}];
   s.end(JSON.stringify({type:'question_response',version:1,msg_id:r.msg_id,owner:r.owner,status:'available',questions:[q],resolved:[],partial:false,nextCursor:null})+'\n');return;
  }
  if(r.type==='ping'){s.end(JSON.stringify({type:'pong',msg_id:r.msg_id,agent_card:{name:'hub',pane_id:mode==='wrong-pane'?'alien':'pane',status:'working'}})+'\n');return;}
  prompts++;
  if(mode==='no-ack')return;
  s.end(JSON.stringify({type:mode==='nack'?'nack':'ack',msg_id:r.msg_id})+'\n');
  if(mode==='reply')void exchange(r.sender_endpoint,{type:'response',msg_id:r.msg_id,sender_session:entry.session_id,response:'BLUE'});
  if(mode==='wrong-reply')void exchange(r.sender_endpoint,{type:'response',msg_id:r.msg_id,sender_session:'alien',response:'RED'}).catch(()=>{});
 });
 t.after(()=>{for(const s of sockets)s.destroy();pi.close();herdr.close();fs.rmSync(root,{recursive:true,force:true});});
 assert.equal((await probeInstruction(entry,'af')).status,'available');assert.equal(prompts,0);
 mode='wrong-pane';assert.equal((await probeInstruction(entry,'af')).status,'unavailable');assert.equal(prompts,0);mode='reply';
 const states:string[]=[];
 assert.equal((await sendInstruction(entry,'af','pane','one','work',100,s=>states.push(s))).result,'BLUE');
 assert.deepEqual(states,['queued']);
 mode='nack';assert.equal((await sendInstruction(entry,'af','pane','two','work',100,()=>{})).state,'failed');
 mode='wrong-reply';assert.equal((await sendInstruction(entry,'af','pane','three','work',100,()=>{})).state,'queued');
 mode='wrong-pane';await assert.rejects(sendInstruction(entry,'af','pane','four','work',100,()=>{}),/identity/);
 assert.equal(prompts,3);
 mode='question';assert.equal((await requestQuestion(entry,'af',{operation:'list',msg_id:'ql1'})).questions?.length,1);
 mode='alien-question';await assert.rejects(requestQuestion(entry,'af',{operation:'list',msg_id:'ql2'}),/invalid question list/);
 mode='malformed-question';await assert.rejects(requestQuestion(entry,'af',{operation:'list',msg_id:'ql3'}),/invalid question list/);
 mode='no-ack';await assert.rejects(exchange(entry.endpoint,{type:'prompt',msg_id:'lost'},30),/timeout/);
});
