import test from 'node:test';
import assert from 'node:assert/strict';
import { privateFixture } from './private-config-fixtures.ts';
import { chmodSync, linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync, chownSync } from 'node:fs';
import { join } from 'node:path';
import { capturePrivateConfig, privateConfigRevision } from './private-config-current-state.ts';

test('valid explicit private configuration and ignored verifier produce metadata only', t => {
 const f = privateFixture(t);
 const captured = capturePrivateConfig(f.cwd, [f.file], [f.source]);
 assert.equal(captured.files.length, 1);
 assert.equal(captured.sources.length, 1);
 assert.match(captured.files[0].sha256, /^[a-f0-9]{64}$/);
 const exported = JSON.stringify(captured);
 assert.equal(exported.includes('loadedCatalog'), false);
 assert.equal(exported.includes(f.config.approval.binding.fleetOwner), false);
});

for (const scenario of ['arbitrary-root','relative','traversal','alias','glob','duplicate','overscope','symlink','ancestor-symlink','hardlink','directory','fifo','mode','execute-mode','owner','oversize','invalid-json','wrong-kind','not-opted-in','expired','catalog','unsafe-directory','unsafe-ancestor','wrong-thread','missing-helper','helper-group-write','helper-non-source','helper-symlink','helper-hardlink','helper-traversal','helper-oversize'] as const) {
 test(`unsafe private scope fails closed: ${scenario}`, async t => {
  const f = privateFixture(t); let files = [f.file], sources = [f.source];
  switch (scenario) {
   case 'arbitrary-root': { const outside = join(f.home, 'notification.json'); writeFileSync(outside, JSON.stringify(f.config), {mode:0o600}); files = [outside]; break; }
   case 'relative': files = ['notification.json']; break;
   case 'traversal': files = [f.folder + '/../fixture-owner/notification-fixture.json']; break;
   case 'alias': files = [f.folder + '//notification-fixture.json']; break;
   case 'glob': files = [f.folder + '/notification-*.json']; break;
   case 'duplicate': files.push(f.file); break;
   case 'overscope': files = Array.from({length:5},(_,i)=>join(f.folder,`notification-${i}.json`)); break;
   case 'symlink': renameSync(f.file, f.file+'.original'); symlinkSync(f.file+'.original', f.file); break;
   case 'ancestor-symlink': renameSync(f.folder, f.folder+'-real'); symlinkSync(f.folder+'-real', f.folder); break;
   case 'hardlink': linkSync(f.file, f.file+'.link'); break;
   case 'directory': rmSync(f.file); mkdirSync(f.file); break;
   case 'fifo': { rmSync(f.file); const {execFileSync}=await import('node:child_process'); execFileSync('mkfifo',[f.file]); break; }
   case 'mode': chmodSync(f.file,0o640); break;
   case 'execute-mode': chmodSync(f.file,0o700); break;
   case 'owner': { const root=await import('./private-config-current-state.ts'); const original=process.getuid; process.getuid=()=>123456; try {assert.throws(()=>root.capturePrivateConfig(f.cwd,files,sources),/^Error: private_config_invalid_or_changed$/);} finally {process.getuid=original;} return; }
   case 'oversize': writeFileSync(f.file,' '.repeat(65537)); break;
   case 'invalid-json': writeFileSync(f.file,'PRIVATE-SENTINEL malformed {'); break;
   case 'wrong-kind': writeFileSync(f.file,JSON.stringify({token:'PRIVATE-SENTINEL'})); break;
   case 'not-opted-in': writeFileSync(f.file,JSON.stringify({...f.config,optedIn:false})); break;
   case 'expired': writeFileSync(f.file,JSON.stringify({...f.config,approval:{...f.config.approval,confirmedUntil:1}})); break;
   case 'catalog': writeFileSync(f.file,JSON.stringify({...f.config,loadedCatalog:{}})); break;
   case 'unsafe-directory': chmodSync(f.folder,0o750); break;
   case 'unsafe-ancestor': chmodSync(join(f.home, '.local/state/agent-fleet'), 0o770); break;
   case 'wrong-thread': writeFileSync(f.file, JSON.stringify({ ...f.config, approval: { ...f.config.approval, binding: { ...f.config.approval.binding, threadId: '22222222-2222-4222-8222-222222222222' } } })); break;
   case 'helper-group-write': chmodSync(join(f.cwd, f.source), 0o660); break;
   case 'helper-non-source': sources = [f.source + '.json']; writeFileSync(join(f.cwd, sources[0]), '{}'); break;
   case 'missing-helper': sources=['missing.mjs']; break;
   case 'helper-symlink': renameSync(join(f.cwd,f.source),join(f.cwd,f.source+'.real')); symlinkSync(join(f.cwd,f.source+'.real'),join(f.cwd,f.source)); break;
   case 'helper-hardlink': linkSync(join(f.cwd,f.source),join(f.cwd,'helper-link')); break;
   case 'helper-traversal': sources=['../repo/'+f.source]; break;
   case 'helper-oversize': writeFileSync(join(f.cwd,f.source),'x'.repeat(1024*1024+1)); break;
  }
  assert.throws(()=>capturePrivateConfig(f.cwd,files,sources), /^Error: private_config_invalid_or_changed$/);
 });
}

test('bounded revisions bind private bytes, ignored helper bytes and capture identity', t => {
 const f=privateFixture(t), binding={files:[f.file],sources:[f.source],taskId:'task',sessionDir:f.session,declarationHash:'b'.repeat(64),captureId:'capture',generation:'generation',epoch:0};
 const revision=()=>privateConfigRevision(f.cwd,'a'.repeat(64),binding), before=revision();
 assert.match(before,/^[a-f0-9]{64}$/);
 binding.captureId='new-capture';assert.notEqual(revision(),before);binding.captureId='capture';
 writeFileSync(join(f.cwd,f.source),'/* ignored helper mutation */');assert.notEqual(revision(),before);
 const afterHelper=revision();writeFileSync(f.file,JSON.stringify({...f.config,messageBudgetMs:31000}));assert.notEqual(revision(),afterHelper);
 assert.equal(privateConfigRevision(f.cwd,'unavailable',binding),'unavailable');
});
