import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,chmod,symlink,link,writeFile,readFile,readdir} from 'node:fs/promises';
import {existsSync,readdirSync,readFileSync,unlinkSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {physicalTempRoot} from '../../../bin/test/helpers/test-temp.js';
import {NativePresenceDirectory} from './lib/codex-native-presence.ts';
import {privateDirectory,readPrivateJson,writePrivateJson} from './lib/codex-bootstrap-files.ts';
const namespace={hostProfile:'desktop',principal:'synthetic-only',threadId:'11111111-1111-4111-8111-111111111111'};
const owner={project:'af-test',peer:'synthetic',sessionId:'33333333-3333-4333-8333-333333333333',startedAt:'2026-11-12T00:00:00.000Z'};
const observed={namespace,hostInstance:'22222222-2222-4222-8222-222222222222',protocolVersion:'2025-06-18',clientInfo:{name:'SYNTHETIC SDK NOT DESKTOP IDENTITY',version:'not-a-desktop-version'},catalog:[]};
async function fixture(t:any){const root=await mkdtemp(join(physicalTempRoot(),'af-presence-'));t.after(()=>rm(root,{recursive:true,force:true}));let now=1000000;const presence=new NativePresenceDirectory(join(root,'presence'),()=>now);return {root,presence,advance:(n:number)=>{now+=n;}};}

test('metadata is detached, private and has no inferred identity, catalog readiness, consent or rights',async t=>{
 const f=await fixture(t),input=structuredClone(observed),saved=await f.presence.publish(input);input.namespace.principal='changed';saved.observation.catalog.push('changed');
 const rows=await f.presence.list();assert.equal(rows.length,1);assert.equal(rows[0].fresh,true);assert.deepEqual(rows[0].observation,observed);assert.deepEqual(rows[0].observation.catalog,[]);
 assert.equal('identity'in rows[0],false);assert.equal('consent'in rows[0],false);assert.equal('rights'in rows[0],false);assert.equal('ready'in rows[0],false);
 assert.equal((await readdir(f.root)).join(','),'presence');await assert.rejects(f.presence.publish({...observed,identity:'host_context_validated'} as any),/native_presence_invalid/);
 f.advance(600000);assert.equal((await f.presence.list())[0].fresh,false);await assert.rejects(f.presence.requestAttach(rows[0],owner),/native_presence_stale/);
});

test('rendezvous targets one exact native instance and AF owner; request expiry/cancel cannot grant anything',async t=>{
 const f=await fixture(t),first=await f.presence.publish(observed),id=await f.presence.requestAttach({...first,fresh:true} as any,owner);
 assert.deepEqual(await f.presence.requests('44444444-4444-4444-8444-444444444444'),[]);const [entry]=await f.presence.requests(observed.hostInstance);assert.equal(entry.request.id,id);assert.deepEqual(entry.request.namespace,namespace);assert.deepEqual(entry.request.owner,owner);assert.equal('rights'in entry.request,false);
 await f.presence.cancelAttach(id);assert.deepEqual(await f.presence.requests(observed.hostInstance),[]);
 const newer=await f.presence.requestAttach(first,owner);f.advance(5000);assert.deepEqual(await f.presence.requests(observed.hostInstance),[]);assert.equal(existsSync(join(f.presence.root,'request-'+newer+'.json')),false);await f.presence.cancelAttach(newer);
});

test('a newer timestamp for the same observation is fine; identity/catalog drift is not silently retargeted',async t=>{
 const f=await fixture(t),old=await f.presence.publish(observed);f.advance(1);await f.presence.publish(observed);const id=await f.presence.requestAttach(old,owner);await f.presence.cancelAttach(id);
 await f.presence.publish({...observed,clientInfo:{...observed.clientInfo,name:'changed'}});await assert.rejects(f.presence.requestAttach(old,owner),/native_presence_changed/);
});

test('unsafe roots/files and malformed native record cannot become presence',async t=>{
 const f=await fixture(t),target=join(f.root,'target');await mkdir(target,{mode:0o700});await symlink(target,join(f.root,'alias'));await assert.rejects(new NativePresenceDirectory(join(f.root,'alias')).publish(observed),/unsafe/);assert.deepEqual(await readdir(target),[]);
 await f.presence.publish(observed);const file=join(f.presence.root,(await readdir(f.presence.root))[0]);await chmod(file,0o644);await assert.rejects(f.presence.list(),/unsafe/);await chmod(file,0o600);await writeFile(file,JSON.stringify({schema:'fleet-native-presence/v1',observation:{...observed,humanConfirmed:true},observedAt:1000000}));await assert.rejects(f.presence.list(),/native_presence_invalid/);
 const badClock=new NativePresenceDirectory(join(f.root,'bad-clock'),()=>NaN);await assert.rejects(badClock.publish(observed),/native_presence_clock/);assert.equal(existsSync(badClock.root),false);
});

test('attach handles are instance-local and consume/cancel never delete a replaced file',async t=>{
 const f=await fixture(t),record=await f.presence.publish(observed),id=await f.presence.requestAttach(record,owner),[entry]=await f.presence.requests(observed.hostInstance);
 const other=new NativePresenceDirectory(f.presence.root);await other.cancelAttach(id);assert.equal(existsSync(entry.path),true);await writeFile(entry.path,'{"foreign":"replacement"}\n');await assert.rejects(f.presence.cancelAttach(id),/native_presence_changed/);assert.equal((await readFile(entry.path,'utf8')).includes('replacement'),true);
});

test('bounded rendezvous capacity and raw inventory fail closed without another request publication',async t=>{
 const f=await fixture(t),record=await f.presence.publish(observed);for(let i=0;i<32;i++)await f.presence.requestAttach(record,owner);const before=await readdir(f.presence.root);await assert.rejects(f.presence.requestAttach(record,owner),/capacity/);assert.deepEqual(await readdir(f.presence.root),before);
 for(let i=0;i<129;i++)await writeFile(join(f.presence.root,'unrelated-'+i),'owned fixture');await assert.rejects(f.presence.list(),/native_presence_limit/);
});

test('private JSON publication detaches input, is atomic and checks explicit expected file identity',async t=>{
 const f=await fixture(t),dir=join(f.root,'data'),path=join(dir,'config.json');assert.equal(await readPrivateJson(path),null);await privateDirectory(dir,true);
 const input={value:1},pending=writePrivateJson(path,input,{expected:null});input.value=2;const identity=await pending;assert.deepEqual((await readPrivateJson(path))!.value,{value:1});
 await assert.rejects(writePrivateJson(path,{value:3},{expected:null}),/changed/);assert.deepEqual((await readPrivateJson(path))!.value,{value:1});const next=await writePrivateJson(path,{value:4},{expected:identity});assert.notEqual(next,identity);assert.deepEqual(await readdir(dir),['config.json']);
 await assert.rejects(writePrivateJson(join(dir,'invalid.json'),undefined),/invalid/);assert.equal(existsSync(join(dir,'invalid.json')),false);
});

test('pre-cancellation and pre-rename abort cannot publish or leave an owned temp file',async t=>{
 const f=await fixture(t),dir=join(f.root,'data'),path=join(dir,'config.json');await privateDirectory(dir,true);const controller=new AbortController();controller.abort();await assert.rejects(writePrivateJson(path,{x:1},{signal:controller.signal}),/cancelled/);assert.deepEqual(await readdir(dir),[]);
 const late=new AbortController();await assert.rejects(writePrivateJson(path,{x:2},{signal:late.signal,guard:()=>{if(readdirSync(dir).some(p=>p.includes('.tmp-')))late.abort();}}),/cancelled/);assert.deepEqual(await readdir(dir),[]);
});

test('post-publication failure remains unknown, never pretends rollback or repeats publication',async t=>{
 const f=await fixture(t),dir=join(f.root,'data'),path=join(dir,'config.json');await privateDirectory(dir,true);
 await assert.rejects(writePrivateJson(path,{x:1},{guard:()=>{if(existsSync(path))throw Error('synthetic lost final guard');}}),/publication_unknown/);assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{x:1});assert.deepEqual(await readdir(dir),['config.json']);
});

test('JSON reader refuses symlink, hardlink, unsafe mode, invalid UTF-8 and oversize without repair',async t=>{
 const f=await fixture(t),dir=join(f.root,'data'),path=join(dir,'config.json');await privateDirectory(dir,true);await writePrivateJson(path,{x:1});await symlink(path,join(dir,'alias.json'));await assert.rejects(readPrivateJson(join(dir,'alias.json')),/unsafe/);await link(path,join(dir,'hard.json'));await assert.rejects(readPrivateJson(path),/unsafe/);await rm(join(dir,'hard.json'));await chmod(path,0o644);await assert.rejects(readPrivateJson(path),/unsafe/);await chmod(path,0o600);await writeFile(path,Buffer.from([0xff]));await assert.rejects(readPrivateJson(path));await writeFile(path,'x'.repeat(32769));await assert.rejects(readPrivateJson(path),/unsafe/);
});

test('a replaced staging file is never published and foreign staging data is not cleaned up',async t=>{
 const f=await fixture(t),dir=join(f.root,'data'),path=join(dir,'config.json');await privateDirectory(dir,true);let staging:string|undefined;
 await assert.rejects(writePrivateJson(path,{x:1},{guard:()=>{const name=readdirSync(dir).find(p=>p.includes('.tmp-'));if(name&&!staging){staging=join(dir,name);unlinkSync(staging);writeFileSync(staging,'foreign',{mode:0o600});}}}),/changed|cleanup_unsafe|unsafe/);
 assert.equal(existsSync(path),false);assert.ok(staging);assert.equal(readFileSync(staging!,'utf8'),'foreign');
});
