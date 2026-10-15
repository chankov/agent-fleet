import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createDamageResultScreen,type DamageResultEvent} from './result-screen.ts';
import {parseDamageGuardConfig} from '../lib/system1/config-damage-guard.js';
import type {System1Result} from '../lib/system1/contracts.ts';
function assertOriginalStructured(view:any,original:any){if(typeof original==='string'){assert.ok(view.startsWith(original));assert.match(view,/Damage-Control result coverage:/);}else if(original!==undefined){assert.deepEqual(view.originalStructuredContent,original);assert.match(view.damageGuard.text,/Damage-Control result coverage:/);}else assert.equal(view,undefined);}
const response=(effect='severe',evidence='sufficient'):System1Result=>({status:'ok',evaluation:{answers:[{questionId:'effect',type:'choice',value:effect,uncertainty:{provenance:'provider'}},{questionId:'evidence',type:'choice',value:evidence,uncertainty:{provenance:'provider'}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}});
function fixture(t:any,text='Untrusted fixture source\nwith two lines\n'){
 const root=mkdtempSync(join(tmpdir(),'d6-result-'));mkdirSync(join(root,'docs'));const path=join(root,'docs','source.txt');writeFileSync(path,text);t.after(()=>rmSync(root,{recursive:true,force:true}));
 const event:DamageResultEvent={toolName:'read',toolCallId:'read',input:{path:'docs/source.txt'},content:[{type:'text',text}],structuredContent:text,isError:false,usage:{inputTokens:1,outputTokens:2}};
 return {root,path,text,event};
}
const config=parseDamageGuardConfig({mode:'active',remoteScopes:{results:true},include:['docs']});
for(const kind of ['read','bash','filesystem'])test(`complete authorized ${kind} source warns without replacing evidence`,async t=>{
 const f=fixture(t);let calls=0;
 const screen=createDamageResultScreen({root:f.root,config,context:()=> 'task/rev',canRead:()=>true,service:{evaluate:async(request)=>{calls++;assert.equal((request.state as any).scope,'results');return response();}}});
 let event=f.event;
 if(kind==='bash')event={...event,toolName:'bash',input:{command:'cat docs/source.txt'},structuredContent:{output:f.text,truncated:false,exit_code:0,wall_time_seconds:0}};
 if(kind==='filesystem'){
  const value={path:f.path,hash:createHash('sha256').update(f.text).digest('hex'),offset:0,content:f.text,contentBytes:Buffer.byteLength(f.text),totalBytes:Buffer.byteLength(f.text),nextHandle:null,truncated:false,untrusted:true,modelDelegated:false,contentEncoding:'utf8',exactBytesOnDisk:f.path};
  event={...event,toolName:'filesystem',input:{operation:'excerpt',path:'docs/source.txt'},content:[{type:'text',text:JSON.stringify(value)}],details:{result:value}};
 }
 const output=await screen.result(event,f.root);
 assert.equal(calls,1);assert.deepEqual(output.content.slice(0,event.content.length),event.content);assert.deepEqual(output.details,event.details);assertOriginalStructured(output.structuredContent,event.structuredContent);assert.equal(output.isError,event.isError);assert.deepEqual(output.usage,event.usage);
 assert.match(output.content.at(-1).text,/Untrusted Damage-Control advisory/);assert.match(output.content.at(-1).text,/"sourceTrusted":false/);screen.dispose();
});
for(const condition of ['offset','limit','image','multiblock','error','blocked-status','nonzero-exit','different-source','unknown-shell','structured-partial','secret','oversize','off','scope-off'])test(`result ${condition} has honest gap and zero inference`,async t=>{
 const f=fixture(t,condition==='secret'?'password = "OFFLINE_SENTINEL"':condition==='oversize'?'x'.repeat(20000):undefined);let calls=0;let event=f.event;
 if(condition==='offset')event={...event,input:{path:'docs/source.txt',offset:2}};
 if(condition==='limit')event={...event,input:{path:'docs/source.txt',limit:1}};
 if(condition==='image')event={...event,content:[{type:'image',data:'PUBLIC_FIXTURE'}]};
 if(condition==='multiblock')event={...event,content:[...event.content,{type:'text',text:'extra unknown source'}]};
 if(condition==='error')event={...event,isError:true,details:{exitCode:1,status:'error'}};
 if(condition==='blocked-status')event={...event,status:'blocked'} as any;
 if(condition==='nonzero-exit')event={...event,exit_code:1} as any;
 if(condition==='different-source')event={...event,content:[{type:'text',text:'other source'}],structuredContent:'other source'};
 if(condition==='unknown-shell')event={...event,toolName:'bash',input:{command:'cat docs/source.txt | head'},structuredContent:{output:f.text,truncated:false,exit_code:0}};
 if(condition==='structured-partial')event={...event,toolName:'bash',input:{command:'cat docs/source.txt'},structuredContent:{output:f.text,truncated:true,exit_code:0}};
 const selected=condition==='off'?parseDamageGuardConfig({mode:'off'}):condition==='scope-off'?parseDamageGuardConfig({mode:'active',include:['docs']}):config;
 const screen=createDamageResultScreen({root:f.root,config:selected,context:()=> 'task/rev',canRead:()=>true,service:{evaluate:async()=>{calls++;return response();}}});
 const output=await screen.result(event,f.root);assert.equal(calls,0);assert.deepEqual(output.content.slice(0,event.content.length),event.content);assertOriginalStructured(output.structuredContent,event.structuredContent);assert.deepEqual(output.details,event.details);assert.equal(output.isError,event.isError);assert.match(output.content.at(-1).text,/"status":"not_evaluated"/);assert.doesNotMatch(output.content.at(-1).text,/Untrusted Damage-Control advisory/);screen.dispose();
});
test('partial semantic judgment is a gap, not a speculative result warning',async t=>{
 const f=fixture(t),screen=createDamageResultScreen({root:f.root,config,context:()=> 'task/rev',canRead:()=>true,service:{evaluate:async()=>response('severe','partial')}});
 const output=await screen.result(f.event,f.root);assert.match(output.content.at(-1).text,/insufficient_evidence/);assert.doesNotMatch(output.content.at(-1).text,/Untrusted Damage-Control advisory/);screen.dispose();
});
