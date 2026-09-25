import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
const repo=fileURLToPath(new URL('../..',import.meta.url));
// The 12 shipped proactive runtime files (closure + manifest). Explicit so a
// new runtime file or a dropped .mjs worker fails loudly instead of drifting.
const expectedRuntimeFiles=['proactive-config.ts','proactive-evaluate.ts','proactive-feedback.ts','proactive-findings.ts','proactive-local.ts','proactive-observer.ts','proactive-rules.ts','proactive-runtime.ts','proactive-selection.ts','proactive-snapshot-worker.mjs','proactive-snapshot.ts','proactive-types.ts'];
const PACK_MAX_BUFFER=64*1024*1024;

function sha16(bytes){return createHash('sha256').update(bytes).digest('hex').slice(0,16);}

// Minimal clean env for installer/doctor/child runs: no provider keys, no
// remote/auth material may leak into the installed workspace or child env.
function scrubbedEnv(extra={}){
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR||tmpdir(),LANG:'C.UTF-8',...extra};
 for(const key of Object.keys(env)) if(/API_KEY|TOKEN|SECRET|AUTH/i.test(key)&&!(key in extra)) delete env[key];
 return env;
}
function assertNoRemoteKeys(env,label){
 for(const key of Object.keys(env)){
  if(/API_KEY|TOKEN|SECRET|AUTH/i.test(key)) assert.fail(`${label}: remote/auth env must not propagate: ${key}`);
 }
}

function packAndExtract(dir){
 const packed=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',dir],{cwd:repo,encoding:'utf8',maxBuffer:PACK_MAX_BUFFER,timeout:60000,env:scrubbedEnv()}));
 const files=new Set(packed[0].files.map(f=>f.path));
 const extracted=join(dir,'package');mkdirSync(extracted);
 execFileSync('tar',['-xzf',join(dir,packed[0].filename),'--strip-components=1','-C',extracted]);
 return {packed,files,extracted};
}

// Real installer path (B9): the extracted package's own bin/cli.js setup,
// non-interactive and offline, into a temp workspace — never a hand copy.
function realSetup(extracted,ws,args=[]){
 mkdirSync(ws,{recursive:true});
 const env=scrubbedEnv({PI_OFFLINE:'1'});
 assertNoRemoteKeys(env,'setup');
 const out=execFileSync(process.execPath,[join(extracted,'bin/cli.js'),'setup','--workspace',ws,'--preset','default','--features','none','--yes',...args],{encoding:'utf8',timeout:120000,env});
 return out;
}

test('P13b real installer setup installs all12 proactive runtime files, creates no auto config, preserves human fixture',{timeout:180000},t=>{
 const dir=mkdtempSync(join(tmpdir(),'proactive-installed-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const {packed,files,extracted}=packAndExtract(dir);
 for(const name of expectedRuntimeFiles)assert.ok(files.has('.pi/harnesses/agent-hub/'+name),'tarball ships '+name);
 assert.equal(files.has('.pi/harnesses/agent-hub/proactive-snapshot-worker.mjs'),true,'shipped .mjs worker');
 assert.ok(![...files].some(p=>p.includes('proactive-')&&p.includes('.test.')));
 assert.ok(![...files].some(p=>p.startsWith('.pi/agent-sessions/')||p.startsWith('.tmp-')));
 const ws=join(dir,'installed');
 realSetup(extracted,ws);
 const hub=join(ws,'.pi','harnesses','agent-hub');
 for(const name of expectedRuntimeFiles)assert.ok(existsSync(join(hub,name)),'installed '+name);
 assert.equal(existsSync(join(ws,'.ai','proactive-review.json')),false,'setup must not auto-create proactive review config');
 const fleetCfg=JSON.parse(readFileSync(join(ws,'.ai','agent-fleet.json'),'utf8'));
 assert.equal('proactive' in fleetCfg,false,'setup must not activate proactive config');
 // Pre-existing HUMAN-owned config must survive setup byte-identical.
 const humanPath=join(ws,'.ai','proactive-review.json');
 const humanBytes=Buffer.from(JSON.stringify({version:1,owner:'human',labels:[{turn:'t1',verdict:'false-alarm'}]},null,2)+'\n');
 mkdirSync(join(ws,'.ai'),{recursive:true});writeFileSync(humanPath,humanBytes);
 const before=sha16(readFileSync(humanPath));
 realSetup(extracted,ws);
 assert.equal(sha16(readFileSync(humanPath)),before,'re-setup preserves human fixture');
 const doctorEnv=scrubbedEnv({PI_OFFLINE:'1'});
 const doctor=spawnSync(process.execPath,[join(extracted,'bin/cli.js'),'doctor','--workspace',ws],{encoding:'utf8',timeout:60000,env:doctorEnv});
 assert.ok([0,2].includes(doctor.status),`readonly doctor exits 0 or findings(2), not crash: ${doctor.status} ${doctor.stderr}`);
 assert.equal(sha16(readFileSync(humanPath)),before,'readonly doctor preserves human fixture');
 const fix=spawnSync(process.execPath,[join(extracted,'bin/cli.js'),'doctor','--workspace',ws,'--fix'],{encoding:'utf8',timeout:60000,env:doctorEnv});
 assert.ok([0,2].includes(fix.status),`doctor --fix exits 0 or findings(2), not crash: ${fix.status} ${fix.stderr}`);
 assert.equal(sha16(readFileSync(humanPath)),before,'doctor --fix is non-destructive to human fixture');
});

test('P13b real installed observer/capture subprocess smoke on INSTALLED paths; repo-local Pi0.84.2 offline',{timeout:180000},t=>{
 const dir=mkdtempSync(join(tmpdir(),'proactive-smoke-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const {extracted}=packAndExtract(dir);
 const ws=join(dir,'installed');
 realSetup(extracted,ws);
 const installed=join(ws,'.pi','harnesses','agent-hub');
 assert.ok(installed.startsWith(ws)&&!installed.startsWith(repo),'smoke must load INSTALLED paths, never repo source');
 for(const name of expectedRuntimeFiles)assert.ok(existsSync(join(installed,name)),'installed '+name);
 // Materialize actual runtime dependencies offline from the local fixture tree.
 const depPkg=JSON.parse(readFileSync(join(ws,'.pi/harnesses/package.json'),'utf8'));
 for(const name of Object.keys(depPkg.dependencies??{})){const target=join(ws,'.pi/harnesses/node_modules',name);mkdirSync(join(ws,'.pi/harnesses/node_modules'),{recursive:true});execFileSync(process.execPath,['-e',`require('fs').cpSync(${JSON.stringify(join(repo,'node_modules',name))},${JSON.stringify(target)},{recursive:true})`]);}
 const importScript=`for(const name of ${JSON.stringify(expectedRuntimeFiles.filter(n=>n.endsWith('.ts')))}) await import('file://'+${JSON.stringify(installed)}+'/'+name);`;
 assert.ok(!importScript.includes(repo),'no fake success from source import');
 const smoke=spawnSync(process.execPath,['--import',join(repo,'bin/test/helpers/system1-no-network.js'),'--input-type=module','-e',importScript],{cwd:ws,encoding:'utf8',timeout:30000,env:scrubbedEnv({PI_OFFLINE:'1'})});
 assert.equal(smoke.status,0,smoke.stderr);
 writeFileSync(join(ws,'sample.md'),'before\n');mkdirSync(join(ws,'agent'));
 assert.equal(spawnSync('git',['init','-q',ws]).status,0);
 assert.equal(spawnSync('git',['-C',ws,'add','sample.md']).status,0);
 assert.equal(spawnSync('git',['-C',ws,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']).status,0);
 const provider=join(dir,'provider.ts');
 writeFileSync(provider,`import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
 export default function(pi){pi.registerProvider('installed-fixture',{name:'offline',baseUrl:'http://127.0.0.1',apiKey:'fixture',api:'installed-fixture-api',models:[{id:'m',name:'m',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:100}],streamSimple(model){const stream=createAssistantMessageEventStream();queueMicrotask(()=>{const msg={role:'assistant',content:[{type:'text',text:'installed captured text'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};stream.push({type:'start',partial:msg});stream.push({type:'text_start',contentIndex:0,partial:msg});stream.push({type:'text_delta',contentIndex:0,delta:'installed captured text',partial:msg});stream.push({type:'text_end',contentIndex:0,content:'installed captured text',partial:msg});stream.push({type:'done',reason:'stop',message:msg});stream.end();});return stream;}});}`);
 const pi=join(repo,'node_modules/.bin/pi');assert.match(spawnSync(pi,['--version'],{encoding:'utf8'}).stdout,/^0\.84\.2/);
 const assignment={root:ws,directory:join(ws,'attempt'),session:'installed',owner:'builder',attempt:'one',config:{version:1,mode:'shadow',remoteContext:'selected-excerpts',include:['sample.md'],maxEvaluationsPerSession:1},context:{task:{path:'task',revision:'fixture',hash:'a'.repeat(64)},rules:[],exceptions:[]}};
 const home=join(dir,'home');mkdirSync(home,{recursive:true});
 const env=scrubbedEnv({PATH:process.env.PATH,HOME:home,PI_CODING_AGENT_DIR:join(ws,'agent'),PI_OFFLINE:'1',TMPDIR:dir,NODE_OPTIONS:`--import=${join(repo,'bin/test/helpers/system1-no-network.js')}`,AGENT_HUB_PROACTIVE_OBSERVER:JSON.stringify(assignment)});
 assertNoRemoteKeys(env,'observer child');
 const observed=spawnSync(pi,['--print','--offline','--no-approve','--no-session','--no-extensions','--no-context-files','--no-skills','--no-prompt-templates','--no-tools','-e',provider,'-e',join(installed,'proactive-observer.ts'),'--model','installed-fixture/m','fixture'],{cwd:ws,env,encoding:'utf8',timeout:30000});
 assert.equal(observed.status,0,observed.stderr+' '+observed.stdout);
 const manifests=readdirSync(assignment.directory).filter(n=>/^turn-\d+\.json$/.test(n));assert.equal(manifests.length,1);
 const m=JSON.parse(readFileSync(join(assignment.directory,manifests[0]),'utf8'));assert.ok(m.snapshot,'installed subprocess must capture, not silent missing runtime');
 const snapshot=JSON.parse(readFileSync(join(assignment.directory,m.snapshot.path),'utf8'));assert.ok(snapshot.units.some(u=>u.kind==='text'&&u.after.text==='installed captured text'));
});

test('P13b Node18 extracted CLI --version/--help AND readonly doctor; missing Node18 is blocked, not skip',{timeout:180000},t=>{
 const dir=mkdtempSync(join(tmpdir(),'proactive-node18-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const nvm=join(process.env.NVM_DIR||join(homedir(),'.nvm'),'versions/node');
 const candidates=[process.env.AF_NODE18,'node18',...(existsSync(nvm)?readdirSync(nvm).filter(v=>v.startsWith('v18.')).map(v=>join(nvm,v,'bin/node')):[])].filter(Boolean);
 const node18=candidates.find(bin=>{const r=spawnSync(bin,['--version'],{encoding:'utf8'});return r.status===0&&r.stdout.startsWith('v18.');});
 assert.ok(node18,'Node18 runtime unavailable: set AF_NODE18; compatibility is unverified/BLOCKED, not skipped');
 const {extracted}=packAndExtract(dir);
 const cli=join(extracted,'bin/cli.js');
 assert.ok(cli.startsWith(dir),'Node18 check must run the EXTRACTED package CLI, not repo bin/cli.js');
 const ws=join(dir,'installed');
 realSetup(extracted,ws);
 for(const flag of ['--version','--help']){const r=spawnSync(node18,[cli,flag],{cwd:ws,encoding:'utf8',timeout:30000,env:scrubbedEnv({PI_OFFLINE:'1'})});assert.equal(r.status,0,`extracted CLI ${flag} under Node18: ${r.stderr}`);}
 const doctor=spawnSync(node18,[cli,'doctor','--workspace',ws],{cwd:ws,encoding:'utf8',timeout:60000,env:scrubbedEnv({PI_OFFLINE:'1'})});
 assert.ok([0,2].includes(doctor.status),`extracted doctor under Node18 exits 0 or findings(2), not crash: ${doctor.status} ${doctor.stderr}`);
 assert.ok((doctor.stdout+doctor.stderr).length>0,'doctor must report, not silently pass');
});
