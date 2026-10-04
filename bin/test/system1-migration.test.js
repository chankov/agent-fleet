import test from 'node:test'; import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { planSystem1Migration, applySystem1Migration, migrateWatchdogOverride, SYSTEM1_MIGRATION_PATHS } from '../lib/system1-migration.js';
import { recoverTransaction, journalPath } from '../lib/transaction.js';
const provider={version:1,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY'};
// macOS temporary paths can contain system symlinks (/var -> /private/var).
// Canonicalize test roots without weakening migration path safety.
function fixture(t) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'system1-migrate-')));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'.ai'));
 const put=(path,value)=>writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value));
 put('.ai/system1.json',provider);put('.ai/proactive-review.json',{version:1,mode:'advisory',remoteContext:'selected-excerpts',include:['src/**'],maxEvaluationsPerSession:50});
 put('.ai/dispatch-triage.json',{version:1,mode:'advisory',remoteContextApproved:true,maxCalls:100,maxStateBytes:32000,maxTaskBytes:8000,maxRoleBytes:2000,orchestratorBeforeDispatch:true});
 put('.ai/task-triage.json',{version:1,mode:'experimental',remoteContextApproved:true,provider:provider.provider,model:provider.model,questionVersion:'task-triage/questions/v1',policyVersion:'task-triage/policy/v1',limits:{maxTaskBytes:40960,maxStateBytes:65536,maxCallsPerSession:100,timeoutMs:2000}});
 put('.ai/agent-fleet-overrides.md','# config\r\n\r\n## agent-hub\r\nwatchdog: on\r\nwatchdog-system1: active\r\nlanguage: bg\r\n\r\n## another\r\nwatchdog-system1: shadow\r\n');
 return {root,put};
}
const bytes=root=>Object.fromEntries(SYSTEM1_MIGRATION_PATHS.map(p=>[p,existsSync(join(root,p))?readFileSync(join(root,p)).toString('base64'):null]));
test('migration still refuses a linked workspace root without writing', t => {
 const {root}=fixture(t),before=bytes(root);
 const alias=join(root,'workspace-link');symlinkSync(root,alias,'dir');
 assert.throws(()=>planSystem1Migration(alias),/workspace root must not be a symlink/);
 assert.deepEqual(bytes(root),before);
 assert.ok(!existsSync(journalPath(root)));
});
test('read-only preview, golden preservation, protected durable backup and idempotence',t=>{
 const {root}=fixture(t),before=bytes(root),plan=planSystem1Migration(root);
 assert.deepEqual(bytes(root),before);assert.equal(plan.target.consumers.watchdog.mode,'active');
 assert.equal(plan.target.consumers.taskTriage.provider,undefined);assert.equal(plan.target.consumers.dispatchTriage.orchestratorBeforeDispatch,true);
 const result=applySystem1Migration(plan);assert.equal(result.status,'migrated');assert.ok(existsSync(join(root,result.backup)));
 for(const [p,data] of Object.entries(before)) assert.equal(readFileSync(join(root,result.backup,p)).toString('base64'),data);
 assert.equal(statSync(join(root,result.backup,'.ai/system1.json')).mode&0o777,0o600);
 assert.equal(spawnSync('git',['init','--quiet'],{cwd:root}).status,0);
 assert.equal(spawnSync('git',['check-ignore','--quiet',join(result.backup,'.ai/system1.json')],{cwd:root}).status,0,'retained configuration is ignored by normal git add');
 assert.equal(readFileSync(join(root,'.ai/agent-fleet-overrides.md'),'utf8'),'# config\r\n\r\n## agent-hub\r\nwatchdog: on\r\nlanguage: bg\r\n\r\n## another\r\nwatchdog-system1: shadow\r\n');
 assert.equal(planSystem1Migration(root).status,'noop');assert.equal(applySystem1Migration(planSystem1Migration(root)).status,'noop');
});
for(const failAt of ['after-journal','operation-0','operation-1','operation-2','operation-3','operation-4','after-commit']) test(`rollback at ${failAt}`,t=>{
 const {root}=fixture(t),before=bytes(root);assert.throws(()=>applySystem1Migration(planSystem1Migration(root),{failAt}));assert.deepEqual(bytes(root),before);assert.ok(!existsSync(journalPath(root)));
});
test('committed cleanup recovery keeps successful backup',t=>{const {root}=fixture(t),plan=planSystem1Migration(root);assert.throws(()=>applySystem1Migration(plan,{failAt:'after-durable-commit'}));recoverTransaction(root);assert.ok(existsSync(join(root,plan.backup)));assert.equal(planSystem1Migration(root).status,'noop');});
for (const invalid of ['original-mode', 'linked-backup', 'missing-backup']) test(`recovery refuses ${invalid} before removing current targets`, t => {
 const {root}=fixture(t),plan=planSystem1Migration(root);
 assert.throws(()=>applySystem1Migration(plan,{failAt:'after-durable-commit'}));
 const journal=JSON.parse(readFileSync(journalPath(root),'utf8'));
 journal.phase='applying';
 if(invalid==='original-mode')journal.originalModes['.ai/system1.json']='0644';
 else {
  const backupFile=join(root,journal.backup,'.ai/system1.json');
  rmSync(backupFile);
  if(invalid==='linked-backup')symlinkSync(join(root,'.ai/system1.json'),backupFile);
 }
 writeFileSync(journalPath(root),JSON.stringify(journal));
 const before=bytes(root);
 assert.throws(()=>recoverTransaction(root));
 assert.deepEqual(bytes(root),before);
 assert.ok(existsSync(journalPath(root)),'invalid recovery remains available for diagnosis');
});
test('fingerprints reject changed or newly appeared input',t=>{const {root,put}=fixture(t);const plan=planSystem1Migration(root);put('.ai/proactive-review.json',{version:1,mode:'off'});assert.throws(()=>applySystem1Migration(plan),/changed since preview/);});
for (const [heading, key] of [['agent-team','watchdog-system1'],['Agent-Hub','watchdog-system1'],['agent-hub','Watchdog-System1'],['AGENT-TEAM','WATCHDOG-SYSTEM1']]) test(`migration preserves legacy watchdog grammar ${heading}/${key}`, t => {
 const {root,put}=fixture(t);
 const before=`# exact\r\n## ${heading}\r\nwatchdog: on\r\n${key}: ShAdOw\r\nlanguage: bg\r\n## another\r\nWatchdog-System1: active\r\n`;
 put('.ai/agent-fleet-overrides.md',before);
 const plan=planSystem1Migration(root);
 assert.equal(plan.target.consumers.watchdog.mode,'shadow');
 applySystem1Migration(plan);
 assert.equal(readFileSync(join(root,'.ai/agent-fleet-overrides.md'),'utf8'),before.replace(`${key}: ShAdOw\r\n`,''));
});
test('duplicate watchdog keys across legacy aliases are refused without writes', t => {
 const {root,put}=fixture(t);
 put('.ai/agent-fleet-overrides.md','## Agent-Hub\nWatchdog-System1: shadow\n## agent-team\nwatchdog-system1: off\n');
 const before=bytes(root);
 assert.throws(()=>planSystem1Migration(root),/Duplicate overrides/);
 assert.deepEqual(bytes(root),before);
 assert.equal(migrateWatchdogOverride('## Agent-Hub\nlanguage: bg\n## agent-team\nWatchdog-System1: shadow\n').mode,'shadow');
});
test('tampering with a planned target is refused by digest before any write', t => {
 const {root}=fixture(t),plan=planSystem1Migration(root),before=bytes(root);
 plan.target.mode='off';
 assert.throws(()=>applySystem1Migration(plan),/digest mismatch/);
 assert.deepEqual(bytes(root),before);
});
test('clean v2 no-op still checks preview fingerprints', t => {
 const {root,put}=fixture(t);
 applySystem1Migration(planSystem1Migration(root));
 const noop=planSystem1Migration(root);
 put('.ai/proactive-review.json','{"version":1,"mode":"off"}');
 assert.throws(()=>applySystem1Migration(noop),/changed since preview/);
});
for(const kind of ['unknown','duplicate-json','duplicate-md','conflict','symlink','v2-leftovers']) test(`refuse ${kind} without writing`,t=>{
 const {root,put}=fixture(t);
 if(kind==='unknown')put('.ai/dispatch-triage.json',{version:1,unexpected:true});
 if(kind==='duplicate-json')put('.ai/system1.json','{"version":1,"version":1}');
 if(kind==='duplicate-md')put('.ai/agent-fleet-overrides.md','## agent-hub\nwatchdog-system1: active\nwatchdog-system1: off\n');
 if(kind==='conflict')put('.ai/task-triage.json',{version:1,provider:'other',model:provider.model});
 if(kind==='symlink'){rmSync(join(root,'.ai/system1.json'));symlinkSync('task-triage.json',join(root,'.ai/system1.json'));}
 if(kind==='v2-leftovers')put('.ai/system1.json',{...provider,version:2,consumers:{}});
 const before=bytes(root);assert.throws(()=>planSystem1Migration(root));assert.deepEqual(bytes(root),before);
});
