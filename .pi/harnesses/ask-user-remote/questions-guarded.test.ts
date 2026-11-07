// B2: synthetic channel/real latch; no Pi UI or live question creation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { QuestionChannel, handleQuestionEnvelope } from './questions.ts';
import { createRequire } from 'node:module';
// Existing pure JS arbiter has no declaration; load its actual runtime, never another test module.
const { raceAskUser } = createRequire(import.meta.url)('./race-core.js');
import type { Socket } from 'node:net';
import { questionDigest, answerDigest } from '../../agent-fleet/scripts/lib/fleet-codex-answer-transport.ts';
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
const hash='a'.repeat(64);
function setup(){const channel=new QuestionChannel(()=>owner);channel.enabled=true;const q=channel.open('TC1',{question:'Fixture question?',options:['Yes','No'],allowFreeform:false,allowComment:false})!;let offers=0;q.registerAnswer(()=>{offers++;q.onSettled({result:{}});return true;});return{channel,q,offers:()=>offers};}
function call(channel:QuestionChannel,fields:Record<string,unknown>){let out='';assert.equal(handleQuestionEnvelope(replySocket(value=>{out=value;}),{type:'question_request',version:2,msg_id:'fixture-rpc',owner,...fields},channel),true);return JSON.parse(out);}
function inspected(f:ReturnType<typeof setup>){const r=call(f.channel,{operation:'inspect',questionId:f.q.id,toolCallId:'TC1'});assert.equal(r.status,'pending');assert.equal(r.ready,true);assert.equal(r.questionDigest,questionDigest(r.question));return r;}
function action(f:ReturnType<typeof setup>,op:'answer'|'refusal'='answer') {const r=inspected(f),response=op==='answer'?{kind:'selection',selections:['Yes']}:null;return{operation:op,questionId:f.q.id,toolCallId:'TC1',questionDigest:r.questionDigest,actionDigest:answerDigest(op,owner,f.q.id,'TC1',r.questionDigest,response),wireId:hash,response};}
test('B2 inspect has exact capability and no offer; exact action+duplicate+receipt gives one winner',()=>{
 const f=setup(),a=action(f);assert.equal(f.offers(),0);const first=call(f.channel,{...a,msg_id:hash});assert.equal(first.status,'accepted');assert.equal(first.outcome,'answered');assert.equal(f.offers(),1);
 assert.deepEqual(call(f.channel,{...a,msg_id:hash}),first);assert.equal(f.offers(),1);
 const {response:_,...query}=a;const receipt=call(f.channel,{...query,operation:'receipt'});assert.equal(receipt.status,'accepted');assert.equal(receipt.wireId,hash);assert.equal('response'in receipt,false);
});
test('B2 exact owner/qid/toolCall/snapshot/payload guards precede offer',()=>{
 for(const change of [{owner:{...owner,project:'other'}},{owner:{...owner,peer:'other'}},{owner:{...owner,sessionId:'S2'}},{owner:{...owner,startedAt:'2026-01-02T00:00:00.000Z'}},{questionId:'wrong'},{toolCallId:'wrong'},{questionDigest:'b'.repeat(64)},{actionDigest:'c'.repeat(64)},{extra:true}]){const f=setup(),a=action(f);assert.notEqual(call(f.channel,{...a,...change,msg_id:hash}).status,'accepted');assert.equal(f.offers(),0);}
});
test('B2 illegal flags/duplicate options/ambiguous or oversized snapshots fail before offer',()=>{
 const f=setup(),a=action(f);for(const response of [{kind:'freeform',text:'not allowed'},{kind:'selection',selections:['Yes','No']},{kind:'selection',selections:['Yes'],comment:'not allowed'},{kind:'selection',selections:['bad']}]){assert.notEqual(call(f.channel,{...a,response,actionDigest:answerDigest('answer',owner,f.q.id,'TC1',a.questionDigest,response),msg_id:hash}).status,'accepted');}assert.equal(f.offers(),0);
 const q=f.channel.open('TC2',{question:'ambiguous',options:['dup','dup']})!;assert.notEqual(call(f.channel,{operation:'inspect',questionId:q.id,toolCallId:'TC2'}).status,'pending');
});
test('B2 guarded refusal uses the SAME actual first-answer latch, not Pi turn cancel',async()=>{
 const f=setup();let localResolve!:(v:unknown)=>void;const local=new Promise(r=>localResolve=r);let registered!:()=>void;const ready=new Promise<void>(r=>registered=r);
 const race=raceAskUser({runLocal:()=>local,registerAnswer:(offer:(v:unknown)=>boolean)=>{f.q.registerAnswer(offer);registered();},onSettled:f.q.onSettled});await ready;
 const a=action(f,'refusal'),r=call(f.channel,{...a,msg_id:hash});assert.equal(r.status,'accepted');assert.equal(r.outcome,'declined');localResolve({details:{response:'late'}});const won=await race;assert.equal(won.details.cancelled,true);
});
test('B2 local/legacy first wins; no guarded promotion of a v1 accepted receipt',()=>{
 const f=setup(),a=action(f);const legacy=call(f.channel,{version:1,operation:'answer',questionId:f.q.id,msg_id:hash,answer:{kind:'selection',selections:['Yes']}});assert.equal(legacy.status,'accepted');
 assert.notEqual(call(f.channel,{...a,msg_id:hash}).status,'accepted');assert.equal(f.offers(),1);
 const g=setup(),b=action(g);g.q.onSettled({result:{}});assert.equal(call(g.channel,{...b,msg_id:hash}).status,'late');
});
test('B2 disabled/reset/not-ready and lost volatile evidence do not offer or guess',()=>{
 const f=setup(),a=action(f);f.channel.enabled=false;assert.notEqual(call(f.channel,{...a,msg_id:hash}).status,'accepted');f.channel.enabled=true;f.channel.reset();assert.notEqual(call(f.channel,{...a,msg_id:hash}).status,'accepted');assert.equal(f.offers(),0);
 const g=setup(),{response:_,...b}=action(g),fresh=new QuestionChannel(()=>owner);fresh.enabled=true;assert.equal(call(fresh,{...b,operation:'receipt'}).status,'unknown');
});
test('B2 actual embedded AND standalone custom-envelope expressions reach guarded handler',()=>{
 for(const path of ['.pi/harnesses/agent-hub/index.ts','.pi/harnesses/coms/index.ts']){
  const source=readFileSync(path,'utf8'),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);const expressions:ts.Expression[]=[];
  function visit(n:ts.Node){if(ts.isPropertyAssignment(n)&&n.name.getText(ast)==='handleCustomEnvelope')expressions.push(n.initializer);ts.forEachChild(n,visit);}visit(ast);const expression=expressions[0];assert.ok(expression);
  assert.match(source,/import\s*\{[^}]*handleQuestionEnvelope[^}]*\}\s*from\s*['"][^'"]*questions/);assert.match(source,/registerQuestionPeer\(/);
  const js=ts.transpileModule('const callback='+expression.getText(ast)+';', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const f=setup();const callback=new Function('handleObservationEnvelope','handleInstructionReceipt','handleQuestionEnvelope','observationOwner','currentCtx','questionChannel','accessApprovalRouter','handlePermissionEnvelope','permissionRelay',js+';return callback;')(()=>false,()=>false,(s:Parameters<typeof handleQuestionEnvelope>[0],e:Record<string,unknown>)=>handleQuestionEnvelope(s,e,f.channel),()=>owner,null,f.channel,{handle:()=>{throw Error('wrong route');}},(_socket:unknown,envelope:any)=>{assert.equal(envelope.type,'question_request');return false;},undefined);
  let out='';assert.equal(callback({end:(s:string)=>out=s},{type:'question_request',version:2,msg_id:'inspect',owner,operation:'inspect',questionId:f.q.id,toolCallId:'TC1'}),true);assert.equal(JSON.parse(out).status,'pending');assert.equal(f.offers(),0);
 }
});
test('B2 bounded guarded window refuses new action without evicting winner proof or breaking v1',()=>{
 const channel=new QuestionChannel(()=>owner);channel.enabled=true;let offers=0;let first:Record<string,unknown>|undefined;
 for(let i=0;i<256;i++){const q=channel.open('TC'+i,{question:'Fixture '+i,options:[]})!;q.registerAnswer(()=>{offers++;q.onSettled({result:{}});return true;});const r=call(channel,{operation:'inspect',questionId:q.id,toolCallId:'TC'+i});assert.equal(r.status,'pending');const response={kind:'freeform',text:'fixture-only'},wire=i.toString(16).padStart(64,'0');const action={operation:'answer',questionId:q.id,toolCallId:'TC'+i,questionDigest:r.questionDigest,actionDigest:answerDigest('answer',owner,q.id,'TC'+i,r.questionDigest,response),wireId:wire,response,msg_id:wire};const proof=call(channel,action);assert.equal(proof.status,'accepted');if(i===0)first={...action};}
 const q=channel.open('overflow',{question:'overflow fixture',options:[]})!;q.registerAnswer(()=>{offers++;q.onSettled({result:{}});return true;});assert.equal(call(channel,{operation:'inspect',questionId:q.id,toolCallId:'overflow'}).status,'not_ready');
 const {response:_,...query}=first!;assert.equal(call(channel,{...query,operation:'receipt'}).status,'accepted');assert.equal(offers,256);
 assert.equal(call(channel,{version:1,operation:'answer',questionId:q.id,msg_id:'legacy-overflow',answer:{kind:'freeform',text:'legacy'}}).status,'accepted');assert.equal(offers,257);
});
test('B2 full redacted/oversized question is not addressable; no clipped option interpretation',()=>{
 const f=setup();for(const text of ['password=synthetic_fixture_secret','x'.repeat(15900)]){const q=f.channel.open('long',{question:text,options:[]});assert.ok(q);q.registerAnswer(()=>{throw Error('must not offer');});assert.notEqual(call(f.channel,{operation:'inspect',questionId:q.id,toolCallId:'long'}).status,'pending');}
});
test('B2 an inherited legacy shared-channel instance refuses v2 rather than crashing/rebinding',()=>{
 const f=setup();Object.defineProperty(f.channel,'guarded',{value:undefined});assert.equal(call(f.channel,{operation:'inspect',questionId:f.q.id,toolCallId:'TC1'}).status,'unsupported');assert.equal(f.offers(),0);
});
test('B2 actual local race winner makes later guarded answer late',async()=>{
 const f=setup(),a=action(f);let resolveLocal!:(v:unknown)=>void;const local=new Promise(r=>resolveLocal=r);let ready!:()=>void;const registered=new Promise<void>(r=>ready=r);
 const race=raceAskUser({runLocal:()=>local,registerAnswer:(offer:(v:unknown)=>boolean)=>{f.q.registerAnswer(offer);ready();},onSettled:f.q.onSettled});await registered;resolveLocal({details:{response:'fixture local'}});await race;assert.equal(call(f.channel,{...a,msg_id:hash}).status,'late');
});
test('B2 cached guarded receipts remain bound to original owner across epoch change',()=>{
 let current={...owner};const channel=new QuestionChannel(()=>current);channel.enabled=true;const q=channel.open('TC1',{question:'Fixture epoch',options:['Yes','No']})!;q.registerAnswer(()=>{q.onSettled({result:{}});return true;});const f={channel,q,offers:()=>0},a=action(f);assert.equal(call(channel,{...a,msg_id:hash}).status,'accepted');current={...owner,sessionId:'S2',startedAt:'2026-01-02T00:00:00.000Z'};const {response:_,...query}=a;assert.notEqual(call(channel,{...query,operation:'receipt',owner:current}).status,'accepted');
});
