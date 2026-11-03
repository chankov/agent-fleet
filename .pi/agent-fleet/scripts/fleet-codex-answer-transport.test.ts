// B3 transport: fake peers/owned temp sockets only, no environment or native probes.
import test from 'node:test';import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';import * as fs from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';
import { AnswerTransport, questionDigest, answerDigest, type QuestionBinding } from './lib/fleet-codex-answer-transport.ts';
import { QuestionChannel, handleQuestionEnvelope } from '../../harnesses/ask-user-remote/questions.ts';
function replySocket(write:(value:string)=>void):Pick<Socket,'end'>{
 function end(callback?:()=>void):Socket;
 function end(buffer:Uint8Array|string,callback?:()=>void):Socket;
 function end(str:Uint8Array|string,encoding?:BufferEncoding,callback?:()=>void):Socket;
 function end(data?:Uint8Array|string|(()=>void),encoding?:BufferEncoding|(()=>void),cb?:()=>void):Socket{
  if(typeof data==='string')write(data);else if(data instanceof Uint8Array)write(Buffer.from(data).toString('utf8'));
  const done=typeof data==='function'?data:typeof encoding==='function'?encoding:cb;done?.();return undefined as never;
 }
 return {end};
}
const owner={project:'fixture',peer:'orchestrator',sessionId:'S1',startedAt:'2026-01-01T00:00:00.000Z'};
async function fixture(fn:(f:{wire:AnswerTransport;qid:string;root:string;count:()=>number;offers:()=>number;set:(mode:string)=>void})=>Promise<void>){
 const root=fs.mkdtempSync(join(tmpdir(),'s6b-b3-'));fs.mkdirSync(join(root,'sockets'));let count=0,offers=0,mode='real';const sockets=new Set<Socket>();const channel=new QuestionChannel(()=>owner);channel.enabled=true;const q=channel.open('TC1',{question:'Fixture?',options:['Yes','No'],allowFreeform:false})!;q.registerAnswer(()=>{offers++;q.onSettled({result:{}});return true;});
 const server=createServer(s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));let b='';s.on('data',chunk=>{b+=chunk.toString();if(!b.includes('\n'))return;count++;const e=JSON.parse(b.split('\n')[0]);if(mode==='timeout')return;if(mode==='loss'&&e.operation==='answer'){s.destroy();return;}
  handleQuestionEnvelope(replySocket(value=>{let r=JSON.parse(value);if(mode==='owner')r.owner.sessionId='WRONG';if(mode==='version')r.version=1;if(mode==='id')r.msg_id='wrong';if(mode==='cap-order'&&r.capability)r.capability={version:2,name:'fleet_question_actions',receipt:'volatile_bounded',firstWinner:'pi_question_latch',expectedToolCallId:true};if(mode==='extra')r.unexpected='must not accept';s.end(mode==='oversize'?'x'.repeat(32769)+'\n':JSON.stringify(r)+'\n');}),e,channel);
 });});await new Promise<void>(r=>server.listen(join(root,'sockets','S1.sock'),r));
 try{await fn({wire:new AnswerTransport({registryRoot:root,timeoutMs:60}),qid:q.id,root,count:()=>count,offers:()=>offers,set:m=>mode=m});}finally{for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});}
}
const response={kind:'selection' as const,selections:['Yes']};
async function binding(f:Parameters<Parameters<typeof fixture>[0]>[0]):Promise<QuestionBinding>{const q=await f.wire.inspect(owner,f.qid,'TC1');const d=questionDigest(q);return{questionId:f.qid,toolCallId:'TC1',questionDigest:d,actionDigest:answerDigest('answer',owner,f.qid,'TC1',d,response),wireId:'a'.repeat(64),operation:'answer'};}
test('B3 real v2 inspect/send/receipt is correlated, one guarded mutation and one refresh',()=>fixture(async f=>{const b=await binding(f);let gate=0;const result=await f.wire.send(owner,b,response,{beforeWrite:async()=>{gate++;}});assert.equal(result.state,'accepted');assert.equal(gate,1);assert.equal(f.offers(),1);assert.equal((await f.wire.receipt(owner,b))?.state,'accepted');assert.equal(f.offers(),1);}));
test('B3 invalid binding refuses BEFORE any RPC/write gate',()=>fixture(async f=>{const b=await binding(f),before=f.count();let writes=0;await assert.rejects(()=>f.wire.send(owner,{...b,wireId:'bad'},response,{beforeWrite:async()=>{writes++;}}),/INVALID_ARGUMENTS/);assert.equal(f.count(),before);assert.equal(writes,0);assert.equal(f.offers(),0);}));
test('B3 capability objects are semantic strict shapes, not JSON key order',()=>fixture(async f=>{f.set('cap-order');assert.equal((await f.wire.inspect(owner,f.qid,'TC1')).id,f.qid);}));
for(const mode of ['owner','version','id','oversize','extra','timeout'])test('B3 rejects '+mode+' without a fallback or offer',()=>fixture(async f=>{f.set(mode);await assert.rejects(()=>f.wire.inspect(owner,f.qid,'TC1'));assert.equal(f.offers(),0);assert.equal(f.count(),1);}));
test('B3 before-write guard failure, cancellation and ACK loss never resend/cancel Pi',()=>fixture(async f=>{const b=await binding(f);await assert.rejects(()=>f.wire.send(owner,b,response,{beforeWrite:async()=>{throw Error('guard refused');}}));assert.equal(f.offers(),0);const abort=new AbortController();abort.abort();await assert.rejects(()=>f.wire.send(owner,b,response,{signal:abort.signal,beforeWrite:async()=>{throw Error('must not run');}}));f.set('loss');let gates=0;await assert.rejects(()=>f.wire.send(owner,b,response,{beforeWrite:async()=>{gates++;}}));assert.equal(gates,1);assert.equal(f.offers(),0);}));
