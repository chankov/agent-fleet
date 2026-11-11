import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {makeResponseFixture,responseOwner} from './fixtures/response-fixture.ts';
import {responseHash} from '../../harnesses/lib/coms-response-read.ts';
async function stdioPage(t:any,f:Awaited<ReturnType<typeof makeResponseFixture>>,cursor?:string){
 const agents=join(f.registryRoot,'projects',responseOwner.project,'agents');await mkdir(agents,{recursive:true});await writeFile(join(agents,'fixture.json'),JSON.stringify({name:responseOwner.peer,session_id:responseOwner.sessionId,started_at:responseOwner.startedAt,heartbeat_at:new Date().toISOString()}));
 const child=spawn(process.execPath,[resolve('.pi/agent-fleet/scripts/fleet-codex-local-mcp.ts'),'--registry-root',f.registryRoot,'--policy-root',f.policyRoot,'--host-profile','fixture','--principal','fixture'],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 const exited=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});
 child.stdin.end([
  {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'resume-fixture',version:'1'}}},
  {jsonrpc:'2.0',method:'notifications/initialized'},
  {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'fleet_response_read',arguments:{...f.args,...(cursor?{cursor}:{})},_meta:f.meta}},
 ].map(x=>JSON.stringify(x)+'\n').join(''));
 assert.equal(await exited,0,err);assert.equal(err,'');const result=JSON.parse(out.trim().split('\n').at(-1)!).result;assert.equal(result.isError,false,JSON.stringify(result));return JSON.parse(result.content[0].text);
}
test('cursor continues in a new real STDIO MCP process while the same Fleet receiver survives',async t=>{
 const f=await makeResponseFixture(t);let p=await stdioPage(t,f),text=p.text;while(p.nextCursor){p=await stdioPage(t,f,p.nextCursor);text+=p.text;}assert.equal(text,f.text);assert.equal(p.sourceSha256,responseHash(text));assert.equal(p.totalBytes,Buffer.byteLength(text));assert.ok(text.endsWith('END_MARK'));
});
test('recreated native server, independent chat, source mutation and receiver shutdown',async t=>{
 const f=await makeResponseFixture(t),p:any=await f.call('fleet_response_read',f.args);f.restart();const again:any=await f.call('fleet_response_read',{...f.args,cursor:p.nextCursor});assert.equal(again.offsetBytes,p.nextOffsetBytes);
 const other={...f.meta,threadId:'22222222-2222-4222-8222-222222222222'},prep=await f.call('fleet_binding_prepare',{intent:'enroll_read',...f.selectors},other);await f.call('fleet_binding_commit',{proposalId:prep.proposalId},other);const count=f.reads();await assert.rejects(()=>f.call('fleet_response_read',{...f.args,cursor:p.nextCursor},other),{code:'INVALID_CURSOR'});assert.equal(f.reads(),count);
 f.entries.set('unrelated-new-answer',{id:'unrelated-new-answer',type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'WRONG ANSWER'}]}});const original:any=await f.call('fleet_response_read',f.args);assert.equal(original.text,p.text);
 f.entries.get('source').message.content[0].text+='mutation';await assert.rejects(()=>f.call('fleet_response_read',{...f.args,cursor:p.nextCursor}),{code:'SOURCE_CHANGED'});f.reader.clear();await assert.rejects(()=>f.call('fleet_response_read',f.args),{code:'SOURCE_UNAVAILABLE'});
});
test('revocation during real I/O withholds a successfully read page',async t=>{
 const f=await makeResponseFixture(t);f.intercept(async(s,e)=>{const p=await f.call('fleet_binding_prepare',{intent:'forget',...f.selectors});await f.call('fleet_binding_commit',{proposalId:p.proposalId});f.reader.handle(s,e,()=>responseOwner,f.manager);s.end();return true;});
 await assert.rejects(()=>f.call('fleet_response_read',f.args),{code:'NOT_ALLOWED'});assert.equal(f.reads(),1);
});
test('owner replacement is never an implicit retarget',async t=>{
 const f=await makeResponseFixture(t),p:any=await f.call('fleet_response_read',f.args);f.changeTarget();await assert.rejects(()=>f.call('fleet_response_read',{...f.args,cursor:p.nextCursor}));assert.equal(f.reads(),1);
});
test('controls cannot manufacture unredacted credential keys; JSON escaping stays bounded',async t=>{
 const f=await makeResponseFixture(t,'token\u0000=LEAK\n'+('"\\\t').repeat(4000)+'END_MARK');let c:string|undefined,text='';do{const p:any=await f.call('fleet_response_read',{...f.args,...(c?{cursor:c}:{})});text+=p.text;assert.ok(Buffer.byteLength(JSON.stringify(p))<16384);c=p.nextCursor??undefined;}while(c);assert.equal(text.includes('LEAK'),false);assert.ok(text.endsWith('END_MARK'));
});
test('size matrix reconstructs 256 KiB and exact 1 MiB over real MCP/COMS; over-limit is explicit',async t=>{
 for(const size of [0,8001,256*1024,1024*1024,1024*1024+1])await t.test('public bytes '+size,async t=>{
  const original=size?'x'.repeat(size-8)+'END_MARK':'',f=await makeResponseFixture(t,original);
  if(size>1024*1024){await assert.rejects(()=>f.call('fleet_response_read',f.args),{code:'RESPONSE_TOO_LARGE'});return;}
  let cursor:string|undefined,text='',offset=0;do{const p:any=await f.call('fleet_response_read',{...f.args,...(cursor?{cursor}:{})});assert.equal(p.offsetBytes,offset);offset=p.nextOffsetBytes;text+=p.text;cursor=p.nextCursor??undefined;if(!cursor){assert.equal(p.totalBytes,size);assert.equal(p.sourceSha256,responseHash(text));assert.equal(p.eof,true);}}while(cursor);
  assert.equal(text,original);assert.equal(offset,size);
 });
});
