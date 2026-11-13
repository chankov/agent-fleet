import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,chmodSync,readdirSync,statSync,linkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import promises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {DesktopPreflightRegistry} from './lib/codex-desktop-preflight.ts';
const signal=()=>new AbortController().signal;
const observation={namespace:{hostProfile:'desktop',principal:'synthetic-only',threadId:'11111111-1111-4111-8111-111111111111'},hostInstance:'22222222-2222-4222-8222-222222222222',protocolVersion:'2025-06-18',clientInfo:{name:'SYNTHETIC-CLIENT-NOT-DESKTOP-IDENTITY',version:'client-sdk-version-is-not-desktop-version'},catalog:['synthetic_only']};
function fixture(t:any,confirm:ConstructorParameters<typeof DesktopPreflightRegistry>[0]['confirm']=async()=>true){
 const dir=mkdtempSync(join(tmpdir(),'af-proc-fake-')),proc=join(dir,'fake-proc'),processDir=join(proc,'123'),root=join(dir,'mappings'),exe=join(dir,'SYNTHETIC-NOT-EXECUTED');mkdirSync(processDir,{recursive:true,mode:0o700});writeFileSync(exe,'SYNTHETIC-BINARY-BYTES-NEVER-EXECUTED',{mode:0o700});
 const processStat=(ticks='55555')=>'123 (synthetic comm with ) spaces) '+['S',...Array(18).fill('0'),ticks,...Array(5).fill('0')].join(' ')+'\n';writeFileSync(join(processDir,'stat'),processStat(),{mode:0o600});symlinkSync(exe,join(processDir,'exe'));
 const registry=new DesktopPreflightRegistry({root,procRoot:proc,confirm}),options={desktopPid:123,desktopVersion:'0.167.0-alpha.3.2',socketPath:join(dir,'daemon.sock'),codexHome:join(dir,'codex-home')};
 t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,proc,processDir,root,exe,registry,options,processStat};
}

test('preflight captures actual owned fake PID/start/executable bytes only after native operator confirmation; raw clientInfo is not Desktop version',async t=>{
 let count=0;const f=fixture(t,async review=>{count++;assert.equal(review.desktopVersion,'0.167.0-alpha.3.2');assert.equal(review.observation.clientInfo!.version,'client-sdk-version-is-not-desktop-version');return true;});
 const record=await f.registry.capture(observation,f.options,signal());assert.equal(count,1);assert.equal(record.desktop.sha256,createHash('sha256').update(readFileSync(f.exe)).digest('hex'));assert.equal(record.desktop.startTicks,'55555');assert.equal(record.desktopVersion,f.options.desktopVersion);assert.equal(record.versionSource,'operator_observed_running_desktop_version');assert.equal('rights'in record,false);assert.equal('admission'in record,false);
 const files=readdirSync(f.root);assert.equal(files.length,1);assert.equal(statSync(join(f.root,files[0])).mode&0o777,0o600);assert.deepEqual(await f.registry.current(observation,signal()),record);
 const restarted=new DesktopPreflightRegistry({root:f.root,procRoot:f.proc,confirm:async()=>{throw Error('read never confirms');}});assert.deepEqual(await restarted.current(observation,signal()),record);
});

test('decline or non-boolean native response never creates mapping, namespace policy or grants',async t=>{
 for(const answer of [false,'true',null]){const f=fixture(t,async()=>answer as never);await assert.rejects(f.registry.capture(observation,f.options,signal()),/not_confirmed/);assert.equal(readdirSync(f.dir).includes('mappings'),false);assert.equal(await f.registry.current(observation,signal()),null);}
});

test('new PID start, executable bytes or write permissions invalidate saved identity facts without repair',async t=>{
 for(const action of ['start','bytes','mode']){
  const f=fixture(t);await f.registry.capture(observation,f.options,signal());
  if(action==='start')writeFileSync(join(f.processDir,'stat'),f.processStat('99999'));
  if(action==='bytes')writeFileSync(f.exe,'DIFFERENT-SYNTHETIC-BYTES');
  if(action==='mode')chmodSync(f.exe,0o777);
  assert.equal(await f.registry.current(observation,signal()),null);
 }
});

test('exact native context/host instance/clientInfo association must still match; facts never migrate by a thread alias',async t=>{
 const f=fixture(t);await f.registry.capture(observation,f.options,signal());
 for(const change of [{hostInstance:'33333333-3333-4333-8333-333333333333'},{clientInfo:{name:'another',version:'whatever'}},{namespace:{...observation.namespace,principal:'other'}}])assert.equal(await f.registry.current({...observation,...change},signal()),null);
});

test('capture rejects unknown or malformed observation fields before operator confirmation',async t=>{
 let prompts=0;const f=fixture(t,async()=>{prompts++;return true;});
 const invalid=[...['consent','ready','admission','humanConfirmed'].map(key=>({...observation,[key]:true})),
  {...observation,clientInfo:{...observation.clientInfo,humanConfirmed:true}},
  {...observation,namespace:{...observation.namespace,ready:true}},
  {...observation,hostInstance:'invalid'}, {...observation,catalog:['bad tool']},
  {...observation,catalog:['duplicate','duplicate']}, {...observation,protocolVersion:'invalid'}];
 for(const value of invalid)await assert.rejects(f.registry.capture(value,f.options,signal()),/inputs/);
 assert.equal(prompts,0);assert.equal(readdirSync(f.dir).includes('mappings'),false);
});

test('mapping rejects unknown top-level and nested authority fields without returning a current proof',async t=>{
 const f=fixture(t);await f.registry.capture(observation,f.options,signal());const path=join(f.root,readdirSync(f.root)[0]),original=JSON.parse(readFileSync(path,'utf8'));
 for(const key of ['consent','ready','admission','humanConfirmed'])for(const location of ['record','observation','desktop','clientInfo','namespace']){
  const value=structuredClone(original),target=location==='record'?value:location==='clientInfo'||location==='namespace'?value.observation[location]:value[location];target[key]=true;writeFileSync(path,JSON.stringify(value));
  assert.equal(await f.registry.current(observation,signal()),null,location+'.'+key);
 }
});

test('unsafe higher ancestors reject capture and current without repairing directories',async t=>{
 const f=fixture(t),parent=join(f.dir,'private');mkdirSync(parent,{mode:0o700});const root=join(parent,'mapping'),registry=new DesktopPreflightRegistry({root,procRoot:f.proc,confirm:async()=>true});
 await registry.capture(observation,f.options,signal());const before=readFileSync(join(root,readdirSync(root)[0]));chmodSync(f.dir,0o777);
 await assert.rejects(registry.capture(observation,f.options,signal()),/unsafe/);assert.equal(await registry.current(observation,signal()),null);
 assert.equal(statSync(f.dir).mode&0o777,0o777);assert.deepEqual(readFileSync(join(root,readdirSync(root)[0])),before);
});

test('capture never removes a replaced foreign staging file after failed publication',async t=>{
 const f=fixture(t),open=promises.open;let staging:string|undefined;
 t.mock.method(promises,'open',async(...args:Parameters<typeof open>)=>{const file=await open(...args);if(String(args[0]).startsWith(f.root+'/mapping-')&&String(args[0]).includes('.tmp-')){
  file.sync=async()=>{staging=String(args[0]);const {renameSync}=await import('node:fs');renameSync(staging,staging+'.owned');writeFileSync(staging,'foreign staged bytes',{mode:0o600});throw Error('synthetic staging failure');};
 }return file;});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await assert.rejects(f.registry.capture(observation,f.options,signal()));assert.ok(staging);assert.equal(readFileSync(staging!,'utf8'),'foreign staged bytes');assert.equal(readdirSync(f.root).some(name=>name.endsWith('.json')),false);
});

test('directory fsync failure after rename preserves publication unknown and the published mapping',async t=>{
 const f=fixture(t),open=promises.open;
 t.mock.method(promises,'open',async(...args:Parameters<typeof open>)=>{const file=await open(...args);if(args[0]===f.root)file.sync=async()=>{throw Error('synthetic directory sync failure');};return file;});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await assert.rejects(f.registry.capture(observation,f.options,signal()),/publication_unknown/);const names=readdirSync(f.root);assert.equal(names.length,1);assert.equal(JSON.parse(readFileSync(join(f.root,names[0]),'utf8')).schema,'fleet-desktop-native-mapping/v1');
});

test('identity facts do not equate current catalog with readiness; valid extras do not invalidate process mapping',async t=>{
 const f=fixture(t);await f.registry.capture(observation,f.options,signal());const changed={...observation,catalog:[...observation.catalog,'unused_extra']};const facts=await f.registry.current(changed,signal());assert.ok(facts);assert.equal(f.registry.currentNow(facts!,changed),true);assert.equal('ready'in facts!,false);assert.equal('admission'in facts!,false);
 assert.equal(f.registry.currentNow(structuredClone(facts!),changed),false);facts!.desktopVersion='0.0.0';assert.equal(f.registry.currentNow(facts!,changed),false);
});

test('unsafe mapping file mode, symlink or extra hardlink is rejected without edits',async t=>{
 for(const kind of ['mode','symlink','hardlink']){
  const f=fixture(t);await f.registry.capture(observation,f.options,signal());const path=join(f.root,readdirSync(f.root)[0]);
  if(kind==='mode')chmodSync(path,0o644);if(kind==='symlink'){const text=readFileSync(path);unlinkSync(path);const target=join(f.dir,'outside-mapping');writeFileSync(target,text,{mode:0o600});symlinkSync(target,path);}if(kind==='hardlink')linkSync(path,join(f.dir,'link'));
  assert.equal(await f.registry.current(observation,signal()),null);
 }
});

test('symlinked private root is rejected before any profile publication or unowned directory creation',async t=>{
 const f=fixture(t),outside=join(f.dir,'outside');mkdirSync(outside,{mode:0o700});symlinkSync(outside,f.root);
 await assert.rejects(f.registry.capture(observation,f.options,signal()),/root_unsafe/);assert.deepEqual(readdirSync(outside),[]);
});

test('operator callback and caller aliases cannot change the approved mapping; process changes during confirmation fail closed',async t=>{
 let mutate:()=>void=()=>{};
 const f=fixture(t,async review=>{(review.observation.namespace as {principal:string}).principal='mutated-review';(review as any).desktop.sha256='fake';mutate();return true;}),input=structuredClone(observation),options={...f.options};
 mutate=()=>{input.namespace.principal='mutated-caller';options.codexHome='/mutated';};const record=await f.registry.capture(input,options,signal());assert.deepEqual(record.observation,observation);assert.equal(record.codexHome,f.options.codexHome);
 const g=fixture(t,async()=>{writeFileSync(join(g.processDir,'stat'),g.processStat('77777'));return true;});await assert.rejects(g.registry.capture(observation,g.options,signal()),/changed/);assert.equal(readdirSync(g.dir).includes('mappings'),false);
});

test('malformed explicit Desktop version or PID, deleted/final-symlink executable and pre-cancellation do not prompt or capture',async t=>{
 let prompts=0;const f=fixture(t,async()=>{prompts++;return true;});
 for(const desktopVersion of ['','client-sdk-version','01.167.0'])await assert.rejects(f.registry.capture(observation,{...f.options,desktopVersion},signal()),/inputs/);
 for(const desktopPid of [0,-1,1.5,Number.MAX_SAFE_INTEGER])await assert.rejects(f.registry.capture(observation,{...f.options,desktopPid},signal()),/pid/);
 const controller=new AbortController();controller.abort();await assert.rejects(f.registry.capture(observation,f.options,controller.signal),/cancelled/);assert.equal(prompts,0);
 const target=join(f.dir,'symlink-target');writeFileSync(target,'SYNTHETIC',{mode:0o700});unlinkSync(f.exe);symlinkSync(target,f.exe);await assert.rejects(f.registry.capture(observation,f.options,signal()),/unsafe/);assert.equal(prompts,0);
});

function automaticFixture(t:any){
 const f=fixture(t),body=Buffer.from(JSON.stringify({name:'openai-codex-electron',version:f.options.desktopVersion})),json=Buffer.from(JSON.stringify({files:{'package.json':{size:body.length,offset:'0'}}})),header=Buffer.alloc(8+json.length),size=Buffer.alloc(8);header.writeUInt32LE(json.length+4,0);header.writeUInt32LE(json.length,4);json.copy(header,8);size.writeUInt32LE(4,0);size.writeUInt32LE(header.length,4);mkdirSync(join(f.dir,'resources'),{mode:0o700});const pkg=join(f.dir,'resources','app.asar');writeFileSync(pkg,Buffer.concat([size,header,body]),{mode:0o600});return {...f,pkg};
}
test('automatic draft is local observation only: no current mapping or serializable proof before one genuine callback',async t=>{
 const f=automaticFixture(t),draft=await f.registry.observeAutomatic(observation,f.options,signal());assert.equal(readdirSync(f.dir).includes('mappings'),false);assert.equal(await f.registry.current(observation,signal()),null);assert.equal(f.registry.currentNow(draft,observation),false);assert.equal(f.registry.observedCurrentNow(draft,observation),true);assert.equal(f.registry.observedCurrentNow(structuredClone(draft),observation),false);
 let confirms=0;assert.equal(await f.registry.confirmAutomatic(draft,observation,async()=>{confirms++;return false;},signal()),null);assert.equal(confirms,1);assert.equal(readdirSync(f.dir).includes('mappings'),false);
 const current=await f.registry.confirmAutomatic(draft,observation,async()=>{confirms++;return true;},signal());assert.ok(current);assert.equal(confirms,2);assert.equal(f.registry.currentNow(current!,observation),true);assert.equal(f.registry.isAutomaticDraft(draft),false);assert.equal(f.registry.observedCurrentNow(draft,observation),false);
 const reopened=new DesktopPreflightRegistry({root:f.root,procRoot:f.proc,confirm:async()=>{throw Error('not another dialog');}});assert.ok(await reopened.current(observation,signal()));writeFileSync(f.pkg,Buffer.concat([readFileSync(f.pkg),Buffer.from('replaced package bytes')]));assert.equal(f.registry.currentNow(current!,observation),false);assert.equal(await reopened.current(observation,signal()),null);
});
test('automatic approval rechecks package/process/native scope before publication and never accepts a cloned draft',async t=>{
 const f=automaticFixture(t),draft=await f.registry.observeAutomatic(observation,f.options,signal());let calls=0;await assert.rejects(f.registry.confirmAutomatic(structuredClone(draft),observation,async()=>{calls++;return true;},signal()),/changed/);assert.equal(calls,0);
 await assert.rejects(f.registry.confirmAutomatic(draft,observation,async()=>{writeFileSync(join(f.processDir,'stat'),f.processStat('99999'));return true;},signal()),/changed/);assert.equal(readdirSync(f.dir).includes('mappings'),false);
});

test('cancellation in automatic approval and a stale full-scope guard never publish a mapping',async t=>{
 const f=automaticFixture(t),draft=await f.registry.observeAutomatic(observation,f.options,signal()),stop=new AbortController();
 assert.equal(await f.registry.confirmAutomatic(draft,observation,async()=>{stop.abort();return true;},stop.signal),null);assert.equal(readdirSync(f.dir).includes('mappings'),false);
 await assert.rejects(f.registry.confirmAutomatic(draft,observation,async()=>true,signal(),()=>{throw Error('synthetic_owner_changed');}),/synthetic_owner_changed/);assert.equal(readdirSync(f.dir).includes('mappings'),false);
});
