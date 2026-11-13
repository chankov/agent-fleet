import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {makeResponseFixture,responseThread} from './fixtures/response-fixture.ts';
import {responseHash} from '../../harnesses/lib/coms-response-read.ts';
import {McpProtocol,TOOLS} from './lib/fleet-codex-local-mcp.ts';
test('actual MCP protocol reconstructs full response over real Unix socket without retention',async t=>{
 const f=await makeResponseFixture(t),p=new McpProtocol(f.service());t.after(()=>p.close());await p.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}}});await p.handle({jsonrpc:'2.0',method:'notifications/initialized'});
 const policyFiles=await readdir(f.policyRoot),before=await Promise.all(policyFiles.map(n=>readFile(join(f.policyRoot,n),'utf8')));let cursor:string|undefined,text='',id=10,offset=0;
 do{const r:any=await p.handle({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:'fleet_response_read',arguments:{...f.args,...(cursor?{cursor}:{})},_meta:f.meta}});assert.equal(r.result.isError,false,JSON.stringify(r));const page=JSON.parse(r.result.content[0].text);assert.equal(page.offsetBytes,offset);offset=page.nextOffsetBytes;text+=page.text;cursor=page.nextCursor??undefined;if(!cursor){assert.equal(page.sourceSha256,responseHash(f.text));assert.equal(page.totalBytes,Buffer.byteLength(f.text));assert.equal(page.taskCompletion,'not_established');}}while(cursor);
 assert.equal(text,f.text);assert.deepEqual(await Promise.all(policyFiles.map(n=>readFile(join(f.policyRoot,n),'utf8'))),before);p.close();await new Promise(resolve=>setTimeout(resolve,20));const directories=(await readdir(f.root)).sort();assert.deepEqual(directories.filter(name=>name!=='policy.presence'),['policy','registry']);if(directories.includes('policy.presence'))assert.deepEqual(await readdir(f.policyRoot+'.presence'),[],'owned observation metadata is cleaned; no response content is retained');assert.equal(TOOLS.at(-1)?.name,'fleet_response_read');assert.equal(TOOLS.at(-1)?.annotations.readOnlyHint,false);
});
test('argument and identity spoofing is rejected before receiver I/O',async t=>{
 const f=await makeResponseFixture(t);for(const patch of [{path:'/etc/passwd'},{threadId:responseThread},{reference:'../../secret'},{cursor:'bad'},{cursor:null}])await assert.rejects(()=>f.call('fleet_response_read',{...f.args,...patch}));assert.equal(f.reads(),0);
 await assert.rejects(()=>f.call('fleet_response_read',f.args,{threadId:'22222222-2222-4222-8222-222222222222',sessionId:'host'}));assert.equal(f.reads(),0);
});
