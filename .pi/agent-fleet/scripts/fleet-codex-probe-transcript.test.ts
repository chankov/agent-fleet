import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,rmSync,renameSync,symlinkSync,linkSync,unlinkSync,chmodSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {CodexProbeTranscript,codexProbeReaderVersion,type ProbeCheckpoint} from './lib/codex-probe-transcript.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',N='33333333-3333-4333-8333-333333333333';
const signal=()=>new AbortController().signal;
const line=(v:unknown)=>JSON.stringify(v)+'\n';
const metadata=(id=A)=>line({type:'session_meta',payload:{id,cwd:'SYNTHETIC-NOT-REAL-TRANSCRIPT'}});
const message=(role='assistant',text='FLEET_PROBE_ACK '+N,phase='final_answer')=>({type:'response_item',payload:{type:'message',role,phase,content:[{type:'output_text',text}]}});
function fixture(t:any,timeoutMs=1000){
 const root=mkdtempSync(join(tmpdir(),'codex-rollout-fake-'));const dir=join(root,'sessions','2026','11','11');mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,'rollout-2026-11-11T12-00-00-'+A+'.jsonl');
 writeFileSync(path,metadata()+line(message('assistant','old private fixture text')),{mode:0o600});const reader=new CodexProbeTranscript({codexHome:root,timeoutMs,pollMs:2});
 t.after(async()=>{await reader.stop();rmSync(root,{recursive:true,force:true});});
 return {root,dir,path,reader,append:(record:unknown)=>appendFileSync(path,line(record))};
}

test('only a new assistant marker yields bounded metadata; user/tool/analysis/old records do not ACK',async t=>{
 const f=fixture(t);f.append(message());const token=await f.reader.checkpoint(f.path,A,signal());
 f.append(message('user'));f.append(message('tool'));f.append(message('assistant','FLEET_PROBE_ACK '+N,'analysis'));f.append({type:'event_msg',payload:{message:'FLEET_PROBE_ACK '+N}});
 const valid=message(),bytes=line(valid);setTimeout(()=>f.append(valid),5);
 const ack=await f.reader.waitForAck(token,N,signal());
 assert.deepEqual(ack,{source:'local_codex_rollout_jsonl',readerVersion:codexProbeReaderVersion,threadId:A,probeId:N,receiptId:'rollout:'+createHash('sha256').update(bytes.slice(0,-1)).digest('hex')});
 assert.equal('text'in ack,false);assert.equal('ready'in ack,false);assert.doesNotMatch(JSON.stringify(ack),/private fixture/);
 await assert.rejects(f.reader.waitForAck(token,N,signal()),/checkpoint_invalid/);
});

test('only terminal final_answer with one exact output text acknowledges; unknown phases and mixed content do not',async t=>{
 const f=fixture(t),token=await f.reader.checkpoint(f.path,A,signal());
 for(const phase of ['commentary','partial_answer','analysis','final','unknown',''])f.append(message('assistant','FLEET_PROBE_ACK '+N,phase));
 const absent=message();delete (absent.payload as {phase?:string}).phase;f.append(absent);
 f.append({...message(),payload:{...message().payload,phase:null}});
 for(const content of [
  [{type:'output_text',text:'FLEET_PROBE_ACK '+N},{type:'refusal',refusal:'not an exact ACK'}],
  [{type:'input_text',text:'ignored'},{type:'output_text',text:'FLEET_PROBE_ACK '+N}],
  [{type:'output_text',text:'FLEET_PROBE_ACK '+N+'\n'}],
  [{type:'output_text',text:' FLEET_PROBE_ACK '+N}],
  [{type:'output_text',text:'FLEET_PROBE_ACK '+N},{type:'output_text',text:''}],
 ])f.append({...message(),payload:{...message().payload,content}});
 const valid={...message(),fixtureLabel:'terminal-exact'};f.append(valid);
 const ack=await f.reader.waitForAck(token,N,signal());
 assert.equal(ack.receiptId,'rollout:'+createHash('sha256').update(line(valid).slice(0,-1)).digest('hex'));
});

test('preexisting marker alone cannot succeed and cancellation releases the checkpoint',async t=>{
 const f=fixture(t);f.append(message());const token=await f.reader.checkpoint(f.path,A,signal()),controller=new AbortController();
 const work=f.reader.waitForAck(token,N,controller.signal);setTimeout(()=>controller.abort(),10);
 await assert.rejects(work,/probe_reader_cancelled/);await assert.rejects(f.reader.waitForAck(token,N,signal()),/checkpoint_invalid/);
 const next=await f.reader.checkpoint(f.path,A,signal());await f.reader.close(next);
});

test('split UTF8/newline frames work without decoding partial code points',async t=>{
 const f=fixture(t),token=await f.reader.checkpoint(f.path,A,signal()),record={...message(),fixtureLabel:'€'};
 const bytes=Buffer.from(line(record)),cut=bytes.indexOf(Buffer.from('€'))+1;appendFileSync(f.path,bytes.subarray(0,cut));
 const work=f.reader.waitForAck(token,N,signal());setTimeout(()=>appendFileSync(f.path,bytes.subarray(cut)),5);
 assert.equal((await work).probeId,N);
});

test('invalid UTF8/JSON and oversized lines or record counts fail closed',async t=>{
 for(const bytes of [Buffer.from([0xc3,0x28,10]),Buffer.from('not-json\n'),Buffer.from(' '.repeat(65537)+'\n'),Buffer.from(line({type:'event_msg'}).repeat(4097))]){
  const f=fixture(t),token=await f.reader.checkpoint(f.path,A,signal());appendFileSync(f.path,bytes);
  await assert.rejects(f.reader.waitForAck(token,N,signal()),/probe_reader_(invalid_record|limit)/);
 }
});

test('path root, symlink, hardlink, modes and exact header thread are checked without writes',async t=>{
 const f=fixture(t),before=readFileSync(f.path);
 const link=join(f.dir,'rollout-link-'+A+'.jsonl');symlinkSync(f.path,link);await assert.rejects(f.reader.checkpoint(link,A,signal()),/probe_reader_/);
 const hard=join(f.dir,'hard');linkSync(f.path,hard);await assert.rejects(f.reader.checkpoint(f.path,A,signal()),/unsafe_file/);unlinkSync(hard);
 chmodSync(f.dir,0o777);await assert.rejects(f.reader.checkpoint(f.path,A,signal()),/unsafe_path/);chmodSync(f.dir,0o700);
 await assert.rejects(f.reader.checkpoint(f.path,B,signal()),/unsafe_path/);
 writeFileSync(f.path,metadata(B),{mode:0o600});await assert.rejects(f.reader.checkpoint(f.path,A,signal()),/thread_mismatch/);
 writeFileSync(f.path,before);const token=await f.reader.checkpoint(f.path,A,signal());await f.reader.close(token);assert.deepEqual(readFileSync(f.path),before);
 assert.throws(()=>new CodexProbeTranscript({codexHome:f.root+'/'}),/options_invalid/);
 await assert.rejects(f.reader.checkpoint(join(f.root,'outside-'+A+'.jsonl'),A,signal()),/unsafe_path/);
});

test('rotation, truncation and parent replacement cannot retarget a held checkpoint',async t=>{
 for(const action of ['rotate','truncate','parent']){
  const f=fixture(t),token=await f.reader.checkpoint(f.path,A,signal());
  if(action==='rotate'){renameSync(f.path,f.path+'.old');writeFileSync(f.path,metadata()+line(message()),{mode:0o600});}
  else if(action==='truncate')writeFileSync(f.path,'');
  else{renameSync(f.dir,f.dir+'.old');mkdirSync(f.dir,{mode:0o700});writeFileSync(f.path,metadata()+line(message()),{mode:0o600});}
  await assert.rejects(f.reader.waitForAck(token,N,signal()),/probe_reader_(changed|unsafe_file)/);
 }
});

test('checkpoint cancellation is retained even with a different wait signal; stop invalidates all handles',async t=>{
 const f=fixture(t),controller=new AbortController(),token=await f.reader.checkpoint(f.path,A,controller.signal);
 const work=f.reader.waitForAck(token,N,signal());controller.abort();await assert.rejects(work,/probe_reader_(cancelled|closed)/);
 const next=await f.reader.checkpoint(f.path,A,signal());const pending=f.reader.waitForAck(next,N,signal());await f.reader.stop();await assert.rejects(pending,/probe_reader_(cancelled|closed)/);
 await assert.rejects(f.reader.checkpoint(f.path,A,signal()),/cancelled/);
});

test('capacity is reserved before async open and forged/cross-reader handles never read',async t=>{
 const f=fixture(t),results=await Promise.allSettled(Array.from({length:20},()=>f.reader.checkpoint(f.path,A,signal())));
 const tokens=results.filter((r):r is PromiseFulfilledResult<ProbeCheckpoint>=>r.status==='fulfilled').map(r=>r.value);
 assert.equal(tokens.length,16);assert.equal(results.filter(r=>r.status==='rejected').length,4);
 await Promise.all(tokens.map(token=>f.reader.close(token)));
 const token=await f.reader.checkpoint(f.path,A,signal());
 await assert.rejects(f.reader.waitForAck(Object.freeze({kind:codexProbeReaderVersion}),N,signal()),/checkpoint_invalid/);
 const other=new CodexProbeTranscript({codexHome:f.root,timeoutMs:100});await assert.rejects(other.waitForAck(token,N,signal()),/checkpoint_invalid/);await other.stop();await f.reader.close(token);
});

test('stop while checkpoint opens are pending rejects every acquisition and later checkpoint',async t=>{
 const f=fixture(t),opening=Array.from({length:16},()=>f.reader.checkpoint(f.path,A,signal()));
 const stopped=f.reader.stop();
 const later=Array.from({length:16},()=>f.reader.checkpoint(f.path,A,signal()));
 const results=await Promise.allSettled([...opening,...later]);await stopped;
 assert.equal(results.filter(r=>r.status==='fulfilled').length,0);
 for(const result of results)if(result.status==='rejected')assert.match(result.reason.message,/probe_reader_(cancelled|unsafe_path)/);
 await assert.rejects(f.reader.checkpoint(f.path,A,signal()),/probe_reader_cancelled/);
});

test('symlinks at the Codex home or above it cannot redirect a checkpoint outside lexical ancestry',async t=>{
 const f=fixture(t),outer=mkdtempSync(join(tmpdir(),'codex-rollout-ancestor-fake-'));t.after(()=>rmSync(outer,{recursive:true,force:true}));
 const alias=join(outer,'alias');symlinkSync(f.root,alias);
 const nested=join(f.root,'nested'),dir=join(nested,'sessions');mkdirSync(dir,{recursive:true,mode:0o700});
 const filename='rollout-synthetic-'+A+'.jsonl';writeFileSync(join(dir,filename),metadata(),{mode:0o600});
 for(const [home,path] of [[alias,f.path.replace(f.root,alias)],[join(alias,'nested'),join(alias,'nested','sessions',filename)]]){
  const reader=new CodexProbeTranscript({codexHome:home});
  await assert.rejects(reader.checkpoint(path,A,signal()),/probe_reader_unsafe_path/);await reader.stop();
 }
});

test('partial baseline record is skipped and unrelated new directory links do not fabricate change',async t=>{
 const f=fixture(t);appendFileSync(f.path,'{"type":"event_msg","payload":');const token=await f.reader.checkpoint(f.path,A,signal());
 mkdirSync(join(f.root,'unrelated-new-directory'),{mode:0o700});appendFileSync(f.path,'{}}\n');f.append(message());
 assert.equal((await f.reader.waitForAck(token,N,signal())).probeId,N);
});


test('new chat and new day with Codex umask 0002 prepare read-only then secure exact paths for strict ACK',async t=>{
 const f=fixture(t);
 for(const part of ['sessions','sessions/2026','sessions/2026/11'])chmodSync(join(f.root,part),0o775);
 for(const day of ['14','15']){
  const dir=join(f.root,'sessions','2026','11',day);mkdirSync(dir,{recursive:true});chmodSync(dir,0o775);
  const path=join(dir,'rollout-new-'+A+'.jsonl');writeFileSync(path,metadata(),{mode:0o664});chmodSync(path,0o664);
  const unrelated=join(dir,'unrelated');writeFileSync(unrelated,'untouched',{mode:0o664});chmodSync(unrelated,0o664);
  await f.reader.checkCapability(path,A,signal());
  assert.equal(statSync(dir).mode&0o777,0o775);assert.equal(statSync(path).mode&0o777,0o664);
  await assert.rejects(f.reader.checkpoint(path,A,signal()),/unsafe_path/);
  await f.reader.securePermissions(path,A,signal(),()=>{});
  assert.equal(statSync(dir).mode&0o777,0o755);assert.equal(statSync(path).mode&0o777,0o644);
  assert.equal(statSync(unrelated).mode&0o777,0o664);assert.equal(readFileSync(path,'utf8'),metadata());
  const token=await f.reader.checkpoint(path,A,signal());appendFileSync(path,line(message()));
  assert.equal((await f.reader.waitForAck(token,N,signal())).probeId,N);
 }
});

test('automatic securing refuses world writes, symlinks, hardlinks, wrong thread and cancelled scope without repairs',async t=>{
 for(const kind of ['world-directory','world-file','symlink','hardlink','thread','cancel']){
  const f=fixture(t);chmodSync(f.dir,0o775);chmodSync(f.path,0o664);
  if(kind==='world-directory')chmodSync(f.dir,0o777);
  if(kind==='world-file')chmodSync(f.path,0o666);
  if(kind==='symlink'){renameSync(f.path,f.path+'.real');symlinkSync(f.path+'.real',f.path);}
  if(kind==='hardlink')linkSync(f.path,f.path+'.hard');
  if(kind==='thread')writeFileSync(f.path,metadata(B));
  await assert.rejects(f.reader.securePermissions(f.path,A,signal(),()=>{if(kind==='cancel')throw Error('scope_cancelled');}));
  assert.equal(statSync(f.dir).mode&0o777,kind==='world-directory'?0o777:0o775);
 }
});


test('permission drift after strict checkpoint and identity drift before securing never become ACK evidence',async t=>{
 const f=fixture(t),token=await f.reader.checkpoint(f.path,A,signal());chmodSync(f.path,0o664);f.append(message());
 await assert.rejects(f.reader.waitForAck(token,N,signal()),/unsafe_file/);
 chmodSync(f.dir,0o775);let calls=0;
 await assert.rejects(f.reader.securePermissions(f.path,A,signal(),()=>{
  if(++calls===2){renameSync(f.path,f.path+'.old');writeFileSync(f.path,metadata(),{mode:0o664});}
 }),/probe_reader_changed/);
 assert.equal(statSync(f.dir).mode&0o777,0o775);assert.equal(statSync(f.path).mode&0o777,0o664);
});
