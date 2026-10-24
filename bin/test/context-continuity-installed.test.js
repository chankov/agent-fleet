import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {resolvePiTestRuntime} from './helpers/pi-runtime.js';
const root=fileURLToPath(new URL('../..',import.meta.url));
test('installed D7 package runs real CLI and common native adapter against fake provider without source-tree runtime imports',{timeout:120000},()=>{
 const runtime=resolvePiTestRuntime({root});
 const dir=mkdtempSync(join(tmpdir(),'d7-installed-'));
 try{
  const pack=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',dir],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024,timeout:60000}))[0];
  for(const file of ['context-continuity-child.ts','context-continuity-broker.ts','context-continuity-client.ts','context-continuity.ts','context-compaction-runtime.ts','context-compaction-monitor.ts','specialist-result.ts','specialist-result-receipt.ts','review-continuity.ts'])assert.ok(pack.files.some(f=>f.path===`.pi/harnesses/agent-hub/${file}`),file);
  assert.ok(pack.files.some(f=>f.path==='.pi/harnesses/lib/system1/config-context-compaction.js'));
  assert.ok(pack.files.some(f=>f.path==='.pi/harnesses/lib/context-compaction-policy.js'));
  const extracted=join(dir,'package');mkdirSync(extracted);execFileSync('tar',['-xzf',join(dir,pack.filename),'--strip-components=1','-C',extracted]);
  // Test-only fixtures, not runtime dependencies. Production imports resolve solely
  // inside the extracted tarball; no source-tree symlink or import is installed.
  const hub=join(extracted,'.pi/harnesses/agent-hub');
  copyFileSync(join(root,'.pi/harnesses/agent-hub/context-continuity-pi.integration.test.ts'),join(hub,'context-continuity-pi.integration.test.ts'));
  copyFileSync(join(root,'.pi/harnesses/agent-hub/specialist-result-pi.integration.test.ts'),join(hub,'specialist-result-pi.integration.test.ts'));
  mkdirSync(join(extracted,'bin/test/helpers'),{recursive:true});
  for(const helper of ['system1-no-network.js','pi-runtime.js'])copyFileSync(join(root,'bin/test/helpers',helper),join(extracted,'bin/test/helpers',helper));
  // The SDK is a third-party test dependency, not a Fleet runtime import from source.
  // Resolve it before HOME isolation; all Fleet extension paths remain in the tarball.
  const env={PATH:process.env.PATH,HOME:dir,CONTEXT_CONTINUITY_PI_RUNTIME:runtime.root,PI_OFFLINE:'1',NODE_OPTIONS:`--import=${join(extracted,'bin/test/helpers/system1-no-network.js')}`};
  const out=execFileSync(process.execPath,['--test',join(hub,'context-continuity-pi.integration.test.ts'),join(hub,'specialist-result-pi.integration.test.ts')],{cwd:extracted,env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  assert.match(out,/pass 16/);assert.match(out,/fail 0/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
