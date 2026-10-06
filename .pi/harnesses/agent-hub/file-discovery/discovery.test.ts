import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {parseFileDiscoveryConfig,FILE_DISCOVERY_LIMITS} from '../../lib/system1/config-file-discovery.js';import {discoverCandidates,discoverAndRank} from './discovery.ts';
const config=parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs','.pi/harnesses']});
function fixture(){const root=mkdtempSync(join(tmpdir(),'d9-discovery-'));for(const p of ['docs/sub','docs/node_modules','.pi/harnesses'])mkdirSync(join(root,p),{recursive:true});for(const [p,b] of Object.entries({'docs/a.ts':'a','docs/sub/b.ts':'b','docs/ignored.ts':'ignore','docs/node_modules/dependency.ts':'dep','.pi/harnesses/dot.ts':'dot','docs/key.pem':'secret'}))writeFileSync(join(root,p),b);writeFileSync(join(root,'.gitignore'),'ignored.ts\nnode_modules/\n');return root;}
// Test-local direct collector seam accommodates pinned Pi startup under host load.
// The public parser/default/max remain 1000 ms; production does not receive an override.
const TEST_DISCOVERY_MS=15000;
const fixtureConfig={...config,limits:{...config.limits,discoveryMs:TEST_DISCOVERY_MS}};
const base=(root:string)=>({root,config:fixtureConfig,signal:new AbortController().signal,canDiscover:()=>true});
test('actual Pi ignore-aware nested discovery, approved source dot root, canonical aliases/escape and cap',async()=>{
 const root=fixture();try{
  symlinkSync('/etc',join(root,'docs/escape'));symlinkSync(join(root,'docs/a.ts'),join(root,'docs/alias'));
  const found=await discoverCandidates({...base(root),patterns:['*.ts'],directories:['docs','.pi/harnesses']});assert.deepEqual(found.paths,['.pi/harnesses/dot.ts','docs/a.ts','docs/sub/b.ts']);assert.equal(found.discoveryComplete,true,JSON.stringify(found));
  const explicit=await discoverCandidates({...base(root),paths:['docs/a.ts','docs/./a.ts','docs/sub/../a.ts','docs/alias','../outside','docs/key.pem']});assert.deepEqual(explicit.paths,['docs/a.ts','docs/key.pem']);assert.equal(explicit.hidden,2);
  const denied=await discoverCandidates({...base(root),directories:['.'],patterns:['**']});assert.equal(denied.reason,'scope_denied');
  const shallow=await discoverCandidates({...base(root),directories:['docs'],patterns:['*.ts'],recursive:false});assert.deepEqual(shallow.paths,['docs/a.ts','docs/ignored.ts']);
  const capped=await discoverCandidates({...base(root),directories:['docs'],patterns:['*.ts'],config:{...config,limits:{...fixtureConfig.limits,maxCandidates:1}}});assert.equal(capped.paths.length,1);assert.equal(capped.discoveryComplete,false);assert.equal(capped.remaining,'unknown');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('paths, patterns and recursive directories use same real per-file pipeline; binary/large remain unscored',async()=>{
 const root=fixture();try{
  writeFileSync(join(root,'docs/binary'),Buffer.from([0]));writeFileSync(join(root,'docs/large'),'x'.repeat(65537));
  const opts={...base(root),task:'task',canDisplay:()=>true,service:{evaluate:async()=>({status:'unavailable' as const,reason:'network' as const})}};
  const explicit=await discoverAndRank({...opts,paths:['docs/a.ts','docs/sub/b.ts','docs/binary','docs/large']});
  const patterned=await discoverAndRank({...opts,patterns:['*.ts','binary','large'],directories:['docs']});
  assert.deepEqual(patterned.rows,explicit.rows);assert.equal(explicit.rows.find(r=>r.path==='docs/binary')?.reason,'denied');assert.equal(explicit.rows.find(r=>r.path==='docs/large')?.reason,'oversized');
  const recursive=await discoverAndRank({...opts,directories:['docs'],recursive:true});assert.deepEqual(recursive.rows,explicit.rows);
 }finally{rmSync(root,{recursive:true,force:true});}
});
function environment(values:Record<string,string>){const before=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);return ()=>{for(const [k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;};}
function alive(pid:number){try{process.kill(pid,0);if(process.platform==='linux'&&readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].startsWith('Z'))return false;return true;}catch{return false;}}
async function waitFor(check:()=>boolean){const until=Date.now()+TEST_DISCOVERY_MS;while(Date.now()<until){if(check())return;await new Promise(r=>setTimeout(r,20));}throw Error('wait_timeout');}
test('N3 least-privilege worker/fd environment; deadline and caller abort kill actual pinned Pi native traversal including SIGTERM-resistant fd',async()=>{
 const root=fixture();const agent=join(root,'agent');mkdirSync(join(agent,'bin'),{recursive:true});
 const pidFile=join(root,'pid');
 // Offline executable fixture, not a custom glob backend: the actual Pi default spawns it with real fd argv.
 // It visits a large tree with no matching output and deliberately resists SIGTERM to exercise group SIGKILL.
 writeFileSync(join(agent,'bin/fd'),`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');function publish(file,value){fs.writeFileSync(file+'.tmp',value);fs.renameSync(file+'.tmp',file);}process.on('SIGTERM',()=>{});publish(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,args:process.argv.slice(2),env:process.env}));const root=process.argv.at(-1);let visited=0;function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){visited++;if(e.isDirectory())walk(path.join(p,e.name));}}function scan(){walk(root);publish(${JSON.stringify(pidFile+'.visited')},String(visited));setImmediate(scan);}scan();`,{mode:0o700});
 for(let i=0;i<100;i++){const dir=join(root,'docs/tree',String(i));mkdirSync(dir,{recursive:true});for(let j=0;j<30;j++)writeFileSync(join(dir,`${j}.txt`),'no matches');}
 const restore=environment({PI_CODING_AGENT_DIR:agent,TYPESAFE_API_KEY:'parent-system1-secret',OPENAI_API_KEY:'parent-provider-secret',D9_CAPABILITY:'parent-capability',NODE_OPTIONS:'--no-warnings'});try{
  const start=Date.now();const timed=await discoverCandidates({...base(root),directories:['docs'],patterns:['*.never-match']});assert.equal(timed.reason,'deadline');assert.equal(timed.remaining,'unknown');assert.equal(timed.paths.length,0);assert.ok(Date.now()-start<TEST_DISCOVERY_MS+5000);
  const native=JSON.parse(readFileSync(pidFile,'utf8'));assert.deepEqual(Object.keys(native.env).sort(),['HOME','PATH','PI_CODING_AGENT_DIR','PI_OFFLINE'].sort());assert.equal(native.env.PI_OFFLINE,'1');assert.ok(native.args.includes('--glob'));assert.ok(native.args.includes('--max-results'));assert.ok(Number(readFileSync(pidFile+'.visited','utf8'))>3000);await waitFor(()=>!alive(native.pid));
  rmSync(pidFile);rmSync(pidFile+'.visited');const controller=new AbortController();const pending=discoverCandidates({...base(root),signal:controller.signal,directories:['docs'],patterns:['*.never-match']});
  try{await waitFor(()=>existsSync(pidFile+'.visited'));const pid=JSON.parse(readFileSync(pidFile,'utf8')).pid;assert.ok(Number(readFileSync(pidFile+'.visited','utf8'))>3000);controller.abort();const cancelled=await pending;assert.equal(cancelled.reason,'cancelled');assert.equal(cancelled.remaining,'unknown');await waitFor(()=>!alive(pid));}finally{controller.abort();await pending;}
 }finally{restore();rmSync(root,{recursive:true,force:true});}
});
test('G1 production default/max stay 1000 ms and total discovery deadline includes startup',async()=>{
 assert.equal(FILE_DISCOVERY_LIMITS.discoveryMs,1000);assert.equal(config.limits.discoveryMs,1000);
 assert.throws(()=>parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs'],limits:{discoveryMs:1001}}),/limits/);
 const root=fixture();try{
  let startupAborted=false,traversalStarted=false;
  const start=Date.now();const found=await discoverCandidates({...base(root),config,directories:['docs'],runFind:async({signal})=>{
   // A worker still starting must share the total deadline, not get a new traversal window.
   await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
   if(signal.aborted){startupAborted=true;return {ok:false,reason:'cancelled'};}
   traversalStarted=true;return {ok:true,result:{content:[]}};
  }});
  assert.ok(Date.now()-start>=900);assert.equal(startupAborted,true);assert.equal(traversalStarted,false);
  assert.equal(found.reason,'deadline');assert.equal(found.discoveryComplete,false);assert.equal(found.remaining,'unknown');assert.deepEqual(found.paths,[]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('G1 real worker deadline-before-start retains original explicit candidate fallback and never reports a complete scan',async()=>{
 const root=fixture(),agent=join(root,'agent'),marker=join(root,'fd-started');mkdirSync(join(agent,'bin'),{recursive:true});
 writeFileSync(join(agent,'bin/fd'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');`,{mode:0o700});
 const restore=environment({PI_CODING_AGENT_DIR:agent});try{
  const ranked=await discoverAndRank({...base(root),config:{...config,limits:{...config.limits,discoveryMs:1}},paths:['docs/a.ts'],directories:['docs'],patterns:['*.ts'],task:'task',canDisplay:()=>true,service:{evaluate:async()=>({status:'unavailable',reason:'network'})}});
  assert.equal(ranked.discovery.reason,'deadline');assert.equal(ranked.discovery.discoveryComplete,false);assert.equal(ranked.discovery.remaining,'unknown');assert.deepEqual(ranked.discovery.paths,['docs/a.ts']);
  assert.equal(ranked.rows.length,1);assert.equal(ranked.rows[0].path,'docs/a.ts');assert.equal(ranked.rows[0].status,'unscored');assert.equal(existsSync(marker),false);
 }finally{restore();rmSync(root,{recursive:true,force:true});}
});
test('missing executable is unavailable with no installer; off/pre-abort do not start work',async()=>{
 const root=fixture();const restore=environment({PI_CODING_AGENT_DIR:join(root,'empty-agent'),PATH:join(root,'empty-path')});try{
  const missing=await discoverCandidates({...base(root),directories:['docs'],patterns:['**']});assert.equal(missing.reason,'missing_executable');assert.equal(missing.discoveryComplete,false);
  const controller=new AbortController();controller.abort();let runs=0;const opts={...base(root),directories:['docs'],signal:controller.signal,runFind:async()=>{runs++;return {ok:false as const,reason:'unavailable'};}};
  assert.equal((await discoverCandidates(opts)).reason,'cancelled');assert.equal(runs,0);
  await discoverCandidates({...opts,config:{...config,mode:'off'}});assert.equal(runs,0);assert.equal(existsSync(join(root,'empty-agent')),false);
 }finally{restore();rmSync(root,{recursive:true,force:true});}
});
test('C1 finding 2 explicit displayable export refusals retain denied rows and nondisplayable/noncanonical paths contribute hidden counts',async()=>{
 const root=fixture();try{
  mkdirSync(join(root,'src'));writeFileSync(join(root,'src/outside.ts'),'body');writeFileSync(join(root,'docs/hidden.ts'),'body');symlinkSync(join(root,'docs/a.ts'),join(root,'docs/alias'));
  let calls=0;
  const ranked=await discoverAndRank({...base(root),paths:['docs/a.ts','docs/key.pem','src/outside.ts','docs/hidden.ts','docs/alias','../outside','docs/missing'],task:'task',canDiscover:p=>!p.endsWith('/hidden.ts'),canDisplay:()=>true,service:{evaluate:async()=>{calls++;return {status:'unavailable',reason:'network'};}}});
  assert.deepEqual(ranked.discovery.paths,['docs/a.ts','docs/key.pem','src/outside.ts']);assert.equal(ranked.discovery.discoveryComplete,true);assert.equal(ranked.discovery.hidden,4);assert.equal(ranked.hidden,4);assert.equal(calls,1);
  assert.equal(ranked.rows.length,3);for(const p of ['docs/key.pem','src/outside.ts'])assert.deepEqual(ranked.rows.find(r=>r.path===p),{path:p,status:'unscored',reason:'denied'});
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('N2 traversal export exclusions have an explicit aggregate without exposing excluded paths',async()=>{
 const root=fixture();try{
  const found=await discoverCandidates({...base(root),directories:['docs'],patterns:['**']});assert.equal(found.excluded,1);assert.ok(!found.paths.includes('docs/key.pem'));assert.equal(found.discoveryComplete,true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('N6 invalid requested directories report invalid_directory and do not prevent valid later scopes',async()=>{
 const root=fixture();try{
  for(const bad of ['docs/missing','docs/a.ts']){
   const found=await discoverCandidates({...base(root),directories:[bad,'docs/sub'],patterns:['*.ts']});assert.deepEqual(found.paths,['docs/sub/b.ts']);assert.equal(found.reason,'invalid_directory');assert.equal(found.discoveryComplete,false);assert.equal(found.remaining,'unknown');
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('N7 recursive false uses actual native Pi ls with immediate pattern filtering and never starts fd or visits descendants',async()=>{
 const root=fixture(),agent=join(root,'agent'),marker=join(root,'fd-started');mkdirSync(join(agent,'bin'),{recursive:true});
 writeFileSync(join(agent,'bin/fd'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.exit(1);`,{mode:0o700});
 const restore=environment({PI_CODING_AGENT_DIR:agent});try{
  writeFileSync(join(root,'docs/.dot.ts'),'dot');
  for(let i=0;i<10;i++)writeFileSync(join(root,'docs/sub',`${i}.ts`),'nested');
  const found=await discoverCandidates({...base(root),directories:['docs'],patterns:['*.ts'],recursive:false,config:{...config,limits:{...fixtureConfig.limits,maxCandidates:8}},runFind:async()=>{throw Error('recursive find must not run');}});
  assert.deepEqual(found.paths,['docs/.dot.ts','docs/a.ts','docs/ignored.ts']);assert.equal(found.discoveryComplete,true,JSON.stringify(found));assert.equal(existsSync(marker),false);
  let lsRuns=0;
  const injected=await discoverCandidates({...base(root),directories:['docs'],patterns:['a.*'],recursive:false,runLs:async({args})=>{lsRuns++;assert.equal(args.tool,'ls');return {ok:true,result:{content:[{type:'text',text:'a.ts\nignored.ts\nsub/'}]}};}});
  assert.deepEqual(injected.paths,['docs/a.ts']);assert.equal(lsRuns,1);
 }finally{restore();rmSync(root,{recursive:true,force:true});}
});

test('T12 N11 traversal metadata-hidden entries count consistently; N12 shallow slash pattern refuses explicitly before traversal',async()=>{
 const root=fixture();try{
  const found=await discoverCandidates({...base(root),directories:['docs'],patterns:['**'],canDiscover:p=>!p.endsWith('/a.ts')});assert.ok(found.hidden>=1);assert.ok(!found.paths.includes('docs/a.ts'));assert.equal(found.discoveryComplete,true);
  let runs=0;const invalid=await discoverCandidates({...base(root),directories:['docs'],patterns:['sub/*.ts'],recursive:false,runLs:async()=>{runs++;throw Error('must not run');}});assert.equal(invalid.reason,'invalid_pattern');assert.equal(invalid.discoveryComplete,false);assert.equal(invalid.remaining,'unknown');assert.equal(runs,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
