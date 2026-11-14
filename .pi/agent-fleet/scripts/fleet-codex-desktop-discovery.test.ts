import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,chmodSync,statSync} from 'node:fs';
import {createServer} from 'node:net';
import {socketTempBase} from '../../../bin/test/helpers/test-temp.js';
import {join} from 'node:path';
import promises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {AutomaticDesktopDiscovery,readDesktopPackageVersion} from './lib/codex-desktop-discovery.ts';
function asar(version='26.1111.21308',name='openai-codex-electron'){
 const body=Buffer.from(JSON.stringify({name,version})),json=Buffer.from(JSON.stringify({files:{'package.json':{size:body.length,offset:'0'}}}));
 const header=Buffer.alloc(8+json.length);header.writeUInt32LE(json.length+4,0);header.writeUInt32LE(json.length,4);json.copy(header,8);const size=Buffer.alloc(8);size.writeUInt32LE(4,0);size.writeUInt32LE(header.length,4);return Buffer.concat([size,header,body]);
}
async function fixture(t:any){
 // A short prefix: the managed socket name is 64 bytes, and macOS sun_path holds 103.
 const root=mkdtempSync(join(socketTempBase(),'ad-')),procRoot=join(root,'proc'),desktopExecutable=join(root,'app','ChatGPT'),codexHome=join(root,'home'),socketRoot=join(root,'sockets');
 for(const p of [procRoot,join(root,'app','resources'),join(codexHome,'packages','standalone','releases','fixture','bin'),socketRoot])mkdirSync(p,{recursive:true,mode:0o700});
 writeFileSync(desktopExecutable,'FAKE DESKTOP, NEVER EXECUTED',{mode:0o700});const packagePath=join(root,'app','resources','app.asar');writeFileSync(packagePath,asar(),{mode:0o600});
 const binary=join(codexHome,'packages','standalone','releases','fixture','bin','codex');writeFileSync(binary,'FAKE CLI, NEVER EXECUTED',{mode:0o700});symlinkSync('releases/fixture',join(codexHome,'packages','standalone','current'));
 const addProcess=(pid:string,helper=false)=>{const p=join(procRoot,pid);mkdirSync(p,{mode:0o700});writeFileSync(join(p,'comm'),'ChatGPT\n');writeFileSync(join(p,'cmdline'),desktopExecutable+(helper?' --type=renderer':'')+'\0');symlinkSync(desktopExecutable,join(p,'exe'));};addProcess('123');addProcess('124',true);
 const socketPath=join(socketRoot,'a'.repeat(64)),server=createServer();await new Promise<void>(r=>server.listen(socketPath,r));chmodSync(socketPath,0o600);
 mkdirSync(join(procRoot,'net'));writeFileSync(join(procRoot,'net','unix'),'Num RefCount Protocol Flags Type St Inode Path\n0000: 00000002 00000000 00010000 0001 01 42 '+socketPath+'\n');
 const options={procRoot,desktopExecutable,codexHome,socketRoot,platform:'linux' as const};
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});});
 return {root,options,packagePath,binary,socketPath,addProcess,discover:()=>new AutomaticDesktopDiscovery(options).discover(new AbortController().signal)};
}
test('automatic Linux discovery returns one real main-process candidate and package version, never SDK/UA guesses',async t=>{
 const f=await fixture(t),facts=await f.discover();assert.equal(facts.desktopPid,123);assert.equal(facts.desktopVersion,'26.1111.21308');assert.equal(facts.codexHome,f.options.codexHome);assert.equal(facts.socketPath,f.socketPath);assert.equal(facts.binaryPath,f.binary);
});
test('multiple Desktop or listening daemon candidates fail closed instead of selecting the newest',async t=>{
 const f=await fixture(t);f.addProcess('125');await assert.rejects(f.discover(),/desktop_discovery_process_ambiguous/);
 rmSync(join(f.options.procRoot,'125'),{recursive:true});const path=join(f.options.socketRoot,'b'.repeat(64)),s=createServer();await new Promise<void>(r=>s.listen(path,r));chmodSync(path,0o600);t.after(()=>new Promise<void>(r=>s.close(()=>r())));
 writeFileSync(join(f.options.procRoot,'net','unix'),'0: 0 0 00010000 0001 01 42 '+f.socketPath+'\n0: 0 0 00010000 0001 01 43 '+path+'\n');await assert.rejects(f.discover(),/desktop_discovery_daemon_ambiguous/);
});
test('wrong/unsafe package version metadata is refused, never replaced by SDK or CLI versions',async t=>{
 const f=await fixture(t);for(const bytes of [asar('bad'),asar('1.2.3','other-app'),Buffer.from('not an ASAR')]){writeFileSync(f.packagePath,bytes);await assert.rejects(f.discover(),/desktop_discovery_/);}
 writeFileSync(f.packagePath,asar());chmodSync(f.packagePath,0o666);await assert.rejects(f.discover(),/desktop_discovery_/);
});
test('unsafe home/CLI, symlinked package, absent process/socket and unsupported platform do not trigger repair or start',async t=>{
 const f=await fixture(t);chmodSync(f.binary,0o777);await assert.rejects(f.discover(),/desktop_discovery_/);assert.equal(statSync(f.binary).mode&0o777,0o777);chmodSync(f.binary,0o700);
 chmodSync(f.options.codexHome,0o777);await assert.rejects(f.discover(),/desktop_discovery_/);chmodSync(f.options.codexHome,0o700);
 await assert.rejects(new AutomaticDesktopDiscovery({...f.options,platform:'darwin'}).discover(new AbortController().signal),/desktop_discovery_unsupported/);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(new AutomaticDesktopDiscovery(f.options).discover(cancelled.signal),/desktop_discovery_cancelled/);
 rmSync(join(f.options.procRoot,'123'),{recursive:true});await assert.rejects(f.discover(),/desktop_discovery_process_unavailable/);
});
test('bounded package reader returns version plus filesystem identity and refuses escape/overlarge headers',async t=>{
 const f=await fixture(t),seen=await readDesktopPackageVersion(f.options.desktopExecutable,new AbortController().signal);assert.equal(seen.version,'26.1111.21308');assert.equal(seen.path,f.packagePath);assert.ok(seen.fileIdentity);
 const bytes=Buffer.alloc(8);bytes.writeUInt32LE(4,0);bytes.writeUInt32LE(32*1024*1024,4);writeFileSync(f.packagePath,bytes);await assert.rejects(readDesktopPackageVersion(f.options.desktopExecutable,new AbortController().signal),/desktop_discovery_/);
});

test('package symlinks and no listening socket cannot be used as automatic evidence',async t=>{
 const f=await fixture(t),outside=join(f.root,'other.asar');writeFileSync(outside,asar(),{mode:0o600});rmSync(f.packagePath);symlinkSync(outside,f.packagePath);await assert.rejects(f.discover(),/desktop_discovery_/);
 rmSync(f.packagePath);writeFileSync(f.packagePath,asar(),{mode:0o600});writeFileSync(join(f.options.procRoot,'net','unix'),'');await assert.rejects(f.discover(),/desktop_discovery_daemon_unavailable/);
});

test('bounded ASAR reader accepts a realistic five-MiB file catalog while still reading only package metadata',async t=>{
 const f=await fixture(t),body=Buffer.from(JSON.stringify({name:'openai-codex-electron',version:'26.1111.21308'})),json=Buffer.from(JSON.stringify({files:{'package.json':{size:body.length,offset:'0'}},fixtureCatalogPadding:'x'.repeat(5*1024*1024)})),header=Buffer.alloc(8+json.length),size=Buffer.alloc(8);header.writeUInt32LE(json.length+4,0);header.writeUInt32LE(json.length,4);json.copy(header,8);size.writeUInt32LE(4,0);size.writeUInt32LE(header.length,4);writeFileSync(f.packagePath,Buffer.concat([size,header,body]));
 const result=await f.discover();assert.equal(result.desktopVersion,'26.1111.21308');
});

test('proc socket inventory is read through short chunks until EOF, not mistaken for an absent daemon',async t=>{
 const f=await fixture(t),original=promises.open;
 t.mock.method(promises,'open',async(...args:Parameters<typeof original>)=>{const file=await original(...args);if(args[0]===join(f.options.procRoot,'net','unix')){const read=file.read.bind(file);file.read=((buffer:Buffer,offset:number,length:number,position:number|null)=>read(buffer,offset,Math.min(length,64),position)) as typeof file.read;}return file;});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 assert.equal((await f.discover()).socketPath,f.socketPath);
});
test('official home-owned managed socket selects its exact listener among multiple daemons, never recency',async t=>{
 const f=await fixture(t),path=join(f.options.socketRoot,'b'.repeat(64)),s=createServer();await new Promise<void>(r=>s.listen(path,r));chmodSync(path,0o600);t.after(()=>new Promise<void>(r=>s.close(()=>r())));
 writeFileSync(join(f.options.procRoot,'net','unix'),'0: 0 0 00010000 0001 01 42 '+f.socketPath+'\n0: 0 0 00010000 0001 01 43 '+path+'\n');
 const control=join(f.options.codexHome,'app-server-control');mkdirSync(control,{mode:0o700});const alias=join(control,'app-server-control.sock');symlinkSync(f.socketPath,alias);assert.equal((await f.discover()).socketPath,alias);
});
test('an invalid managed socket alias is refused rather than falling back to an unrelated listener',async t=>{
 const f=await fixture(t),control=join(f.options.codexHome,'app-server-control');mkdirSync(control,{mode:0o700});symlinkSync(f.binary,join(control,'app-server-control.sock'));await assert.rejects(f.discover(),/desktop_discovery_daemon_alias_unsafe/);
});
