// Retirement regression: old feature requests must never install or grant anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {loadManifest} from '../lib/manifest.js';
import {resolveDesiredFeatures} from '../lib/features.js';
import {inspectDesiredRepair,applyDesiredRepair} from '../lib/repair-desired.js';

test('retired CLI feature is rejected before installation; native setup is not implied',t=>{
 const ws=mkdtempSync(join(tmpdir(),'fleet-retired-install-'));t.after(()=>rmSync(ws,{recursive:true,force:true}));
 const manifest=loadManifest(process.cwd());assert.equal(manifest.features['chatgpt-client'],undefined);
 assert.equal(manifest.items.some(i=>i.id==='companion:fleet-client-runtime'||i.id==='companion:fleet-client-skill'),false);
 assert.throws(()=>resolveDesiredFeatures(manifest,{features:['chatgpt-client']}),/retired feature "chatgpt-client"/);
 const r=spawnSync(process.execPath,[resolve('bin/cli.js'),'setup','--workspace',ws,'--features','chatgpt-client','--yes'],{encoding:'utf8'});
 assert.equal(r.status,1);assert.match(r.stderr,/retired feature "chatgpt-client"/);assert.equal(existsSync(join(ws,'.ai')),false);assert.equal(existsSync(join(ws,'.codex')),false);assert.equal(existsSync(join(ws,'.agents')),false);
});
for(const enabled of [false,true])test(`retired desired-state repair preserves original archives and requires separate native setup (${enabled})`,t=>{
 const ws=mkdtempSync(join(tmpdir(),'fleet-retired-repair-'));t.after(()=>rmSync(ws,{recursive:true,force:true}));mkdirSync(join(ws,'.ai'));mkdirSync(join(ws,'private-history'),{mode:0o700});
 const history=join(ws,'private-history','original.json.runtime'),raw='{"version":1,"receipts":[{"state":"unknown","wireId":"KEEP_ORIGINAL"}]}';writeFileSync(history,raw,{mode:0o600});
 const file=join(ws,'.ai/agent-fleet.json'),original=JSON.stringify({schemaVersion:1,preset:'default',features:{'chatgpt-client':enabled,browser:true}});writeFileSync(file,original);
 const proposal=inspectDesiredRepair(ws,loadManifest(process.cwd()));assert.deepEqual(proposal.removed,[{name:'chatgpt-client',value:enabled}]);assert.equal(readFileSync(file,'utf8'),original);
 const backup=applyDesiredRepair(proposal);assert.equal(readFileSync(backup,'utf8'),original);assert.deepEqual(JSON.parse(readFileSync(file,'utf8')).features,{browser:true});assert.equal(readFileSync(history,'utf8'),raw);assert.equal(existsSync(join(ws,'.codex')),false);assert.equal(existsSync(join(ws,'.agents')),false);assert.equal(inspectDesiredRepair(ws,loadManifest(process.cwd())),null);
});

test('active CLI executables, transport dependencies and legacy skill are absent',()=>{
 for(const path of ['.pi/agent-fleet/scripts/fleet-codex-client.ts','.pi/agent-fleet/scripts/fleet-codex-read.py','.pi/agent-fleet/scripts/lib/fleet-codex-session.ts','.pi/agent-fleet/scripts/lib/fleet-codex-operations.ts','.pi/agent-fleet/scripts/lib/fleet-codex-transport.ts','.pi/agent-fleet/scripts/lib/fleet-codex-catalog.ts','codex/fleet-session-client/SKILL.md','codex/fleet-session-client.zip'])assert.equal(existsSync(resolve(path)),false,path);
 for(const path of ['.pi/harnesses/lib/coms-core.ts','.pi/harnesses/coms/index.ts','.pi/harnesses/agent-hub/index.ts','.pi/harnesses/ask-user-remote/questions.ts','.pi/agent-fleet/hermes/plugins/agent-fleet-herdr/dashboard/activity.py','.pi/agent-fleet/hermes/plugins/agent-fleet-herdr/dashboard/herdr_source.py','.pi/agent-fleet/hermes/skills/hub-watchdog/scripts/watchdog_transport.py','.pi/agent-fleet/hermes/skills/hub-watchdog/scripts/watchdog_contract.py'])assert.equal(existsSync(resolve(path)),true,path);
});
