import test from 'node:test';
import assert from 'node:assert/strict';
import {rename,symlink,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {makeResponseFixture,responseOwner} from './fixtures/response-fixture.ts';
import {createResponseReader} from './lib/fleet-codex-response-transport.ts';
import {responseScope} from './lib/fleet-codex-response-read.ts';
import {responseThread} from './fixtures/response-fixture.ts';
const scope=responseScope({hostProfile:'fixture',principal:'fixture',threadId:responseThread});
test('unsupported, corrupt, oversized and truncated receiver frames are explicit',async t=>{
 const f=await makeResponseFixture(t);for(const mode of ['nack','json','oversize','partial','owner','extra']){
  f.intercept((s,e)=>{if(mode==='nack')s.write(JSON.stringify({type:'nack',msg_id:e.msg_id})+'\n');if(mode==='json')s.write('{bad}\n');if(mode==='oversize')s.write('x'.repeat(16385));if(mode==='partial')s.write('{');if(mode==='owner')s.write(JSON.stringify({type:'response_read_response',version:1,msg_id:e.msg_id,owner:{...responseOwner,sessionId:'other'},status:'error',code:'SOURCE_UNAVAILABLE'})+'\n');if(mode==='extra')s.write(JSON.stringify({type:'response_read_response',version:1,msg_id:e.msg_id,owner:responseOwner,status:'error',code:'SOURCE_UNAVAILABLE',text:'no'})+'\n');s.end();return true;});
  await assert.rejects(()=>f.call('fleet_response_read',f.args),(e:any)=>e.code===(mode==='nack'?'RPC_UNSUPPORTED':mode==='owner'?'TARGET_CHANGED':'RPC_INVALID'));
 }
});
test('symlink socket and directory traversal are rejected; cancellation sends no request',async t=>{
 const f=await makeResponseFixture(t),transport=createResponseReader({registryRoot:f.registryRoot}),path=join(f.registryRoot,'sockets',responseOwner.sessionId+'.sock');await rename(path,path+'.real');await symlink(path+'.real',path);
 await assert.rejects(()=>transport.read(responseOwner,{reference:f.reference,scope},async()=>{}),{code:'UNSAFE_PATH'});await unlink(path);await rename(path+'.real',path);
 await assert.rejects(()=>transport.read({...responseOwner,sessionId:'../bad'},{reference:f.reference,scope},async()=>{}),{code:'UNSAFE_PATH'});
 const controller=new AbortController();controller.abort();await assert.rejects(()=>transport.read(responseOwner,{reference:f.reference,scope},async()=>{},controller.signal),{code:'REQUEST_CANCELLED'});assert.equal(f.reads(),0);
});
