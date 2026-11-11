import assert from 'node:assert/strict';
import test from 'node:test';
import {SessionResponseReader,responseReference,responseHash,validateResponsePage,RESPONSE_MAX_BYTES} from './coms-response-read.ts';
const owner={project:'af',peer:'orchestrator',sessionId:'session-1',startedAt:'2026-11-11T00:00:00.000Z'},wire='a'.repeat(64),scope=responseHash('native-chat');
export function responseFixture(text:string|any[],stopReason='stop',capacity=4096){
 const entries=new Map<string,any>();let leaf='answer';entries.set(leaf,{id:leaf,type:'message',message:{role:'assistant',stopReason,content:typeof text==='string'?[{type:'text',text}]:text}});
 const manager={getLeafId:()=>leaf,getEntry:(id:string)=>entries.get(id)},append=(kind:string,data:unknown)=>{const id='meta-'+entries.size;entries.set(id,{id,type:'custom',customType:kind,data:structuredClone(data)});leaf=id;};
 const reader=new SessionResponseReader(capacity),reference=responseReference(owner,wire);
 return {entries,reader,reference,manager,append,capture:()=>reader.capture(owner,wire,'answer',manager,append),read:(cursor?:string)=>reader.read(owner,reference,scope,cursor,manager)};
}
test('full Unicode text, all text blocks, exact bytes/digest and deterministic cursors',()=>{
 const expected='б🙂'.repeat(1300)+'\nEND_MARK',f=responseFixture([{type:'text',text:'б🙂'.repeat(1300)},{type:'thinking',thinking:'never disclose'},{type:'toolCall',arguments:{secret:'never'}},{type:'text',text:'END_MARK'}]);f.capture();let cursor:string|undefined,text='',offset=0;
 do{const p=f.read(cursor);validateResponsePage(p,owner,f.reference,scope,cursor);assert.equal(p.offsetBytes,offset);assert.ok(Buffer.byteLength(p.text)<=2048);assert.deepEqual(f.read(cursor),p);offset=p.nextOffsetBytes;text+=p.text;cursor=p.nextCursor??undefined;if(!cursor){assert.equal(p.sourceSha256,responseHash(expected));assert.equal(p.totalBytes,Buffer.byteLength(expected));assert.equal(p.eof,true);}}while(cursor);
 assert.equal(text,expected);assert.ok(!text.includes('never'));assert.ok(JSON.stringify([...f.entries.values()].filter(e=>e.type==='custom')).length<1000);
});
test('redaction precedes chunks and covers quoted credentials split across blocks and open keys',()=>{
 const f=responseFixture([{type:'text',text:'x'.repeat(2030)+' password="LEAK_A'},{type:'text',text:'LEAK_B"\npublic\n-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_LEAK'}]);f.capture();let text='',c:string|undefined;do{const p=f.read(c);text+=p.text;assert.equal(p.redacted,true);c=p.nextCursor??undefined;}while(c);assert.ok(!/LEAK|PRIVATE KEY/.test(text));assert.ok(text.includes('public'));assert.ok(text.includes('[REDACTED]'));
});
test('not-ready, unknown, unavailable source and capacity do not evict existing references',()=>{
 const f=responseFixture('ok','stop',1);f.reader.begin(owner,wire);assert.throws(()=>f.read(),/NOT_READY/);f.capture();assert.equal(f.read().text,'ok');assert.equal(f.reader.begin(owner,'b'.repeat(64)),false);assert.equal(f.read().text,'ok');assert.throws(()=>f.reader.read(owner,responseReference(owner,'b'.repeat(64)),scope,undefined,f.manager),/SOURCE_UNAVAILABLE/);f.entries.delete('answer');assert.throws(()=>f.read(),/SOURCE_UNAVAILABLE/);f.reader.clear();assert.throws(()=>f.read(),/SOURCE_UNAVAILABLE/);
});
test('mutation, forged pointers, foreign chats/targets and invalid byte offsets fail closed',()=>{
 const f=responseFixture('🙂'.repeat(2000));f.capture();const p=f.read(),raw=JSON.parse(Buffer.from(p.nextCursor!,'base64url').toString());
 for(const patch of [{scope:responseHash('other')},{reference:responseReference(owner,'b'.repeat(64))},{offset:1},{projectionVersion:'v2'},{target:{...owner,sessionId:'other'}}])assert.throws(()=>f.read(Buffer.from(JSON.stringify({...raw,...patch})).toString('base64url')),/INVALID_CURSOR/);
 f.entries.get('answer').message.content[0].text+='changed';assert.throws(()=>f.read(p.nextCursor!),/SOURCE_CHANGED/);
});
test('empty and failed final text stay distinct from task success',()=>{
 for(const reason of ['stop','aborted','error','max_tokens','refusal']){const f=responseFixture('',reason);f.capture();const p=f.read();assert.equal(p.text,'');assert.equal(p.eof,true);assert.equal(p.sourceState.state,reason==='stop'?'result':'failed');}
 const f=responseFixture('tool-only','toolUse');f.capture();assert.throws(()=>f.read(),/SOURCE_UNAVAILABLE/);
});
test('one MiB accepted; over-limit and malformed UTF16 are explicit failures',()=>{
 const f=responseFixture('a'.repeat(RESPONSE_MAX_BYTES));f.capture();assert.equal(f.read().totalBytes,RESPONSE_MAX_BYTES);
 const big=responseFixture('a'.repeat(RESPONSE_MAX_BYTES+1));big.capture();assert.throws(()=>big.read(),/RESPONSE_TOO_LARGE/);
 const invalid=responseFixture('\ud800');invalid.capture();assert.throws(()=>invalid.read(),/SOURCE_UNAVAILABLE/);
});
test('RPC enforces owner before/after I/O, strict envelope and no arbitrary path',()=>{
 const f=responseFixture('ok');f.capture();const request={type:'response_read_request',version:1,msg_id:'test',sender_session:'reader',sender_endpoint:'',owner,reference:f.reference,scope};let reply='';
 assert.equal(f.reader.handle({write:s=>reply=s},request,()=>owner,f.manager),true);assert.equal(JSON.parse(reply).page.text,'ok');
 f.reader.handle({write:s=>reply=s},{...request,path:'/etc/passwd'},()=>owner,f.manager);assert.equal(JSON.parse(reply).code,'INVALID_ARGUMENTS');let calls=0;f.reader.handle({write:s=>reply=s},request,()=>++calls===1?owner:{...owner,sessionId:'changed'},f.manager);assert.equal(JSON.parse(reply).code,'TARGET_CHANGED');assert.equal(JSON.parse(reply).page,undefined);
});
test('wire page validation rejects bad hashes, skipped/repeated offsets and malformed continuation',()=>{
 const f=responseFixture('x'.repeat(5000));f.capture();const p=f.read();for(const patch of [{text:p.text+'x'},{chunkSha256:'0'.repeat(64)},{nextOffsetBytes:0},{eof:true},{nextCursor:'garbage'},{unexpected:true}])assert.throws(()=>validateResponsePage({...p,...patch},owner,f.reference,scope),/RPC_INVALID/);
});
