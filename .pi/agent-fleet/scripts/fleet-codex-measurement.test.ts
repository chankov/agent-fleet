import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,truncateSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {getEventListeners} from 'node:events';
import {measureDaemon,exportSchema,CodexMeasurementError,type DaemonMeasurement,type DaemonObservationRpc} from './lib/codex-measurement.ts';

const measured: DaemonMeasurement = {kind: 'initialize_version_observation', version: '0.167.1', socketEpoch: 'alias:1:/private/control.sock:2:3'};
const code = (expected: string) => (error: unknown) => error instanceof CodexMeasurementError && error.code === expected;
function rpc(ua?: unknown, epochs: unknown[] = [measured.socketEpoch, measured.socketEpoch]) {
 const userAgent = arguments.length === 0 ? 'Codex Desktop/0.167.1 (fixture; x86_64) dumb (client; 999)' : ua;
 const calls: string[] = [];
 const reader: DaemonObservationRpc = {
  socketEpoch: async signal => { assert.equal(signal.aborted, false); calls.push('epoch'); return epochs.shift(); },
  initialize: async (signal, expectedEpoch) => { assert.equal(signal.aborted, false); calls.push('initialize'); return {socketEpoch: expectedEpoch, result: {userAgent, clientInfo: {version: '999.0.0'}}}; },
 };
 return {reader, calls};
}

test('initialize version is bound to before/after epoch and never inferred from clientInfo', async () => {
 const {reader, calls} = rpc();
 assert.deepEqual(await measureDaemon(reader), measured);
 assert.deepEqual(calls, ['epoch','initialize','epoch']);
 const pre = rpc('Codex Desktop/0.167.0-alpha.3.2+build (fixture)');
 assert.equal((await measureDaemon(pre.reader)).version, '0.167.0-alpha.3.2+build');
 const unicodeEpoch='alias:1:/private/контрол.sock:2:3';
 assert.equal((await measureDaemon(rpc('Codex Desktop/0.167.1',[unicodeEpoch,unicodeEpoch]).reader)).socketEpoch,unicodeEpoch);
});

test('stable ambient before/after epochs cannot hide an initialize connection from another epoch', async () => {
 const r=rpc();
 r.reader.initialize=async (_signal, expectedEpoch) => { assert.equal(expectedEpoch,measured.socketEpoch); return {socketEpoch:'different-connection',result:{userAgent:'Codex Desktop/0.167.1'}}; };
 await assert.rejects(measureDaemon(r.reader),code('initialize_epoch_mismatch'));
 assert.deepEqual(r.calls,['epoch']);
});

test('measured Fleet originators expose the daemon build token, never terminal or SDK suffix versions',async()=>{
 for(const originator of ['agent_fleet_contract_observer','agent_fleet_queue_bridge']){
  const result=await measureDaemon(rpc(originator+'/0.169.0-alpha.11.1+build (Ubuntu 25.10.0; x86_64) herdr/0.9.5 ('+originator+'; 1)').reader);
  assert.equal(result.version,'0.169.0-alpha.11.1+build');assert.equal(result.socketEpoch,measured.socketEpoch);
 }
});

test('originator extensions and invalid first daemon token cannot fall back to a suffix version',async()=>{
 for(const ua of ['agent_fleet_contract_observer_extra/0.169.0','prefix agent_fleet_contract_observer/0.169.0','agent_fleet_queue_bridge/v0.169.0 Codex Desktop/0.169.0','agent_fleet_contract_observer/0.169.00 (client; 0.169.0)','agent_fleet_queue_bridge/0.169.0/extra','agent_fleet_queue_bridge/0.169.0\n']){
  await assert.rejects(measureDaemon(rpc(ua).reader),code('daemon_version_unavailable'));
 }
});

test('unknown/malformed UA and invalid/changing epochs do not yield measurement', async () => {
 for (const value of [undefined, null, 1, '', 'codex-cli 0.167.1', 'Other/0.167.1', 'prefix Codex Desktop/0.167.1', 'Codex Desktop/v0.167.1', 'Codex Desktop/0.167.01', 'Codex Desktop/0.167.1\n', 'x'.repeat(4097)]) {
  await assert.rejects(measureDaemon(rpc(value).reader), code('daemon_version_unavailable'));
 }
 await assert.rejects(measureDaemon(rpc('Codex Desktop/0.167.1', ['', '']).reader), code('invalid_socket_epoch'));
 await assert.rejects(measureDaemon(rpc('Codex Desktop/0.167.1', ['before','after']).reader), code('socket_epoch_changed'));
});

test('daemon measurement timeout/cancel is bounded, signals cleanup, and never advances a cancelled callback chain', async () => {
 let calls = 0, observedSignal: AbortSignal | undefined;
 const reader: DaemonObservationRpc = {socketEpoch: () => 'epoch', initialize: signal => { calls++; observedSignal = signal; return new Promise(() => {}); }};
 await assert.rejects(measureDaemon(reader, {timeoutMs: 20}), code('measurement_timeout'));
 assert.equal(observedSignal?.aborted, true); assert.equal(calls, 1);
 let finish: ((value: {result: unknown; socketEpoch: string}) => void) | undefined, lateCalls = 0;
 const late = measureDaemon({socketEpoch: () => { lateCalls++; return 'epoch'; }, initialize: () => new Promise(resolve => { finish = resolve; })}, {timeoutMs: 20});
 await assert.rejects(late, code('measurement_timeout'));
 finish!({socketEpoch:'epoch',result:{userAgent: 'Codex Desktop/0.167.1'}}); await new Promise(resolve => setImmediate(resolve));
 assert.equal(lateCalls, 1, 'cancelled chain must not read an after-epoch later');
 const controller = new AbortController(); controller.abort();
 await assert.rejects(measureDaemon(reader, {signal: controller.signal}), code('measurement_cancelled')); assert.equal(calls, 1);
 await assert.rejects(measureDaemon({...reader, initialize: async () => { throw Error('private server detail'); }}), code('daemon_observation_failed'));
 for (const timeoutMs of [0, -1, NaN, 30001]) await assert.rejects(measureDaemon(reader, {timeoutMs}), code('invalid_timeout'));
});

test('overdue synchronous callbacks cannot win before the timeout timer gets an event-loop turn', async () => {
 for (const phase of ['before','initialize','after']) {
  let reads=0, initialized=0;
  const delay=()=>{const until=performance.now()+40;while(performance.now()<until){ /* keep timer queued */ }};
  const reader: DaemonObservationRpc={
   socketEpoch:()=>{reads++;if((phase==='before'&&reads===1)||(phase==='after'&&reads===2))delay();return 'epoch';},
   initialize:async (_signal,expectedEpoch)=>{initialized++;if(phase==='initialize')delay();return {socketEpoch:expectedEpoch,result:{userAgent:'Codex Desktop/0.167.1'}};},
  };
  await assert.rejects(measureDaemon(reader,{timeoutMs:10}),code('measurement_timeout'));
  if(phase==='before')assert.equal(initialized,0,'overdue first epoch cannot start initialize');
  if(phase==='initialize')assert.ok(reads<=1,'overdue initialize cannot start after-epoch');
 }
});

const files = ['ClientRequest.json','ClientNotification.json','JSONRPCResponse.json','JSONRPCError.json','v1/InitializeResponse.json','v2/ThreadReadResponse.json','v2/ThreadLoadedListResponse.json','v2/ThreadQueueAddResponse.json','v2/ThreadQueueListResponse.json'];
function fixture(config: Record<string, unknown> = {}) {
 const root = mkdtempSync(join(tmpdir(), 'fleet-measure-test-')); chmodSync(root, 0o700);
 const binary = join(root, 'fake codex; literal'), log = join(root, 'log.jsonl'), external = join(root, 'external.json');
 writeFileSync(external, '{"untouched":true}', {mode: 0o600});
 const program = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const config=${JSON.stringify(config)},files=${JSON.stringify(files)},log=${JSON.stringify(log)},external=${JSON.stringify(external)};
const args=process.argv.slice(2),kind=args[0]==='--version'?'version':'export';
fs.appendFileSync(log,JSON.stringify({kind,args,cwd:process.cwd(),envKeys:Object.keys(process.env),home:process.env.HOME,codexHome:process.env.CODEX_HOME,sentinel:process.env.FLEET_SCHEMA_TEST_SENTINEL,mode:fs.statSync(process.cwd()).mode&511})+'\\n');
if(kind==='version'){
 if(args.length!==1)process.exit(67);
 if(config.changeBinary==='version')fs.appendFileSync(__filename,'\\n// binary changed');
 if(config.replaceSandbox){const old=process.cwd();fs.renameSync(old,${JSON.stringify(join(root,'moved-sandbox'))});fs.mkdirSync(old,{mode:448});fs.writeFileSync(path.join(old,'foreign-marker'),'keep');}
 if(config.versionExit)process.exit(7);
 if(config.versionNoise)process.stdout.write('x'.repeat(20000));else process.stdout.write(config.banner??('codex-cli '+(config.version??'0.167.1')+'\\n'));
}else{
 if(args.length!==5||args[0]!=='app-server'||args[1]!=='generate-json-schema'||args[2]!=='--experimental'||args[3]!=='--out')process.exit(68);
 if(config.exportExit)process.exit(8);
 if(config.hang){setInterval(()=>{},1000);return;}
 if(config.barrier){const gate=${JSON.stringify(join(root,'export-gate'))};while(!fs.existsSync(gate))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
 if(config.exportNoise){process.stderr.write('x'.repeat(20000));return;}
 const out=args[4];
 for(const file of files){const target=path.join(out,file);fs.mkdirSync(path.dirname(target),{recursive:true});if((config.missing&&file==='ClientRequest.json')||config.missingFile===file)continue;fs.writeFileSync(target,JSON.stringify({type:'object',fixture:file}));}
 const first=path.join(out,'ClientRequest.json');
 if(config.badJson)fs.writeFileSync(first,'{');
 if(config.scalar)fs.writeFileSync(first,'true');
 if(config.badUtf8)fs.writeFileSync(first,Buffer.from([255]));
 if(config.oversize)fs.truncateSync(first,17*1024*1024);
 if(config.symlink){fs.unlinkSync(first);fs.symlinkSync(external,first);}
 if(config.hardlink){fs.unlinkSync(first);fs.linkSync(external,first);}
 if(config.linkParent){fs.rmSync(path.join(out,'v1'),{recursive:true});fs.symlinkSync(${JSON.stringify(root)},path.join(out,'v1'));}
 if(config.changeBinary==='export')fs.appendFileSync(__filename,'\\n// binary changed');
 if(config.exposeSandbox)fs.chmodSync(process.cwd(),511);
}
`;
 writeFileSync(binary, program, {mode: 0o700});
 // The fixture appends while the test polls: a just-created log is briefly empty.
 return {root, binary, log, external, records: () => existsSync(log) ? readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [], cleanup: () => rmSync(root, {recursive: true, force: true})};
}
function removed(records: any[]) { for (const row of records) assert.equal(existsSync(row.cwd), false, 'owned export sandbox must be removed'); }

test('real fake executable exports exactly nine bounded docs with raw hashes, isolated environment, cleanup and literal spaced path', async () => {
 const f = fixture(); const previous = process.env.FLEET_SCHEMA_TEST_SENTINEL; process.env.FLEET_SCHEMA_TEST_SENTINEL = 'test-only-no-inheritance';
 try {
  const observed = await exportSchema(f.binary, measured);
  assert.equal(observed.kind, 'schema_export_observation'); assert.equal(observed.version, measured.version); assert.equal(observed.socketEpoch, measured.socketEpoch);
  assert.equal(observed.binarySha256, createHash('sha256').update(readFileSync(f.binary)).digest('hex')); assert.match(observed.binaryEpoch,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(observed.documents), files); assert.deepEqual(Object.keys(observed.sourceHashes), files);
  for (const file of files) assert.equal(observed.sourceHashes[file],createHash('sha256').update(JSON.stringify({type:'object',fixture:file})).digest('hex'));
  const rows = f.records(); assert.deepEqual(rows.map(row => row.kind), ['version','export']);
  for (const row of rows) {
   assert.equal(row.mode, 0o700); assert.equal(row.sentinel, undefined); assert.equal(row.home.startsWith(row.cwd+'/'), true); assert.equal(row.codexHome.startsWith(row.cwd+'/'), true);
   assert.deepEqual(row.envKeys.sort(), ['PATH','HOME','CODEX_HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','TERM','NO_COLOR'].sort());
  }
  removed(rows);
 } finally { if (previous === undefined) delete process.env.FLEET_SCHEMA_TEST_SENTINEL; else process.env.FLEET_SCHEMA_TEST_SENTINEL = previous; f.cleanup(); }
});

test('missing any profile envelope fails instead of silently returning the old six-root subset', async () => {
 for (const missingFile of ['ClientNotification.json','JSONRPCResponse.json','JSONRPCError.json']) {
  const f=fixture({missingFile});
  try {await assert.rejects(exportSchema(f.binary,measured),code('schema_export_failed'));removed(f.records());}
  finally {f.cleanup();}
 }
});

test('asynchronous export keeps original version/epoch and removes the original caller signal listener', async () => {
 const f=fixture({barrier:true}), original=new AbortController(), replacement=new AbortController();
 const input={...measured}, options={signal:original.signal,timeoutMs:5000};
 const job=exportSchema(f.binary,input,options); let failure:unknown;
 void job.catch(error=>{failure=error;});
 try {
  const until=performance.now()+3000;
  while(!f.records().some(row=>row.kind==='export')){
   if(failure!==undefined)throw failure;
   assert.ok(performance.now()<until,'fixture must reach export barrier');
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  input.version='0.999.0';input.socketEpoch='replacement-epoch';options.signal=replacement.signal;
  writeFileSync(join(f.root,'export-gate'),'continue',{mode:0o600});
  const observed=await job;
  assert.equal(observed.version,measured.version);assert.equal(observed.socketEpoch,measured.socketEpoch);
  assert.equal(getEventListeners(original.signal,'abort').length,0,'remove listener from captured signal, not mutable options');
  removed(f.records());
 } finally { original.abort();await job.catch(()=>{});f.cleanup(); }
});

test('cleanup must finish before the final deadline/caller publication fence', async context => {
 for(const cause of ['timeout','cancel']){
  const f=fixture(),controller=new AbortController();let checkedAfterCleanup=0;
  const clock=context.mock.method(performance,'now',()=>{
   const rows=f.records();
   if(rows.some(row=>row.kind==='export')&&!existsSync(rows[0].cwd)){
    checkedAfterCleanup++;
    if(cause==='cancel'&&!controller.signal.aborted)controller.abort();
    return cause==='timeout'?6000:0;
   }
   return 0;
  });
  try {
   await assert.rejects(exportSchema(f.binary,measured,{timeoutMs:5000,signal:controller.signal}),code(cause==='timeout'?'measurement_timeout':'measurement_cancelled'));
   assert.ok(checkedAfterCleanup>0);removed(f.records());
  } finally { clock.mock.restore();controller.abort();f.cleanup(); }
 }
});

test('CLI release/build mismatch or malformed banner stops BEFORE export and cleans sandbox', async () => {
 for (const config of [{version:'0.167.0'}, {version:'0.167.1+other'}, {banner:'codex-cli v0.167.1\n'}, {banner:'codex-cli 0.167.1\nextra\n'}]) {
  const f = fixture(config);
  try { await assert.rejects(exportSchema(f.binary, measured),code('export_version_mismatch')); assert.deepEqual(f.records().map(row=>row.kind),['version']); removed(f.records()); } finally { f.cleanup(); }
 }
});

test('binary replacement/modification during version or export invalidates the evidence', async () => {
 for (const changeBinary of ['version','export']) {
  const f = fixture({changeBinary});
  try { await assert.rejects(exportSchema(f.binary, measured),code('binary_changed')); if(changeBinary==='version') assert.deepEqual(f.records().map(row=>row.kind),['version']); removed(f.records()); } finally { f.cleanup(); }
 }
});

test('symlinked trusted executable resolves to stable bytes without using a PATH lookup', async () => {
 const f = fixture(), alias = join(f.root,'alias codex'); symlinkSync(f.binary,alias);
 try { const observed = await exportSchema(alias, measured); assert.equal(observed.binarySha256,createHash('sha256').update(readFileSync(f.binary)).digest('hex')); removed(f.records()); } finally { f.cleanup(); }
});

test('retargeting the binary symlink after version invalidates the selected executable', async () => {
 const f = fixture(), other = fixture(), alias = join(f.root,'alias'); symlinkSync(f.binary,alias);
 writeFileSync(f.binary,readFileSync(f.binary,'utf8').replace("if(args.length!==1)process.exit(67);",`if(args.length!==1)process.exit(67); fs.unlinkSync(${JSON.stringify(alias)}); fs.symlinkSync(${JSON.stringify(other.binary)},${JSON.stringify(alias)});`));
 try { await assert.rejects(exportSchema(alias,measured),code('binary_changed')); assert.deepEqual(f.records().map(row=>row.kind),['version']); assert.equal(other.records().length,0); removed(f.records()); } finally { f.cleanup(); other.cleanup(); }
});

test('private sandbox mode drift fails and replacement root is never deleted as owned cleanup', async () => {
 const exposed = fixture({exposeSandbox:true});
 try { await assert.rejects(exportSchema(exposed.binary,measured),code('unsafe_export_root')); removed(exposed.records()); } finally { exposed.cleanup(); }
 const replaced = fixture({replaceSandbox:true});
 try {
  await assert.rejects(exportSchema(replaced.binary,measured),code('unsafe_export_cleanup'));
  const old = replaced.records()[0].cwd; assert.equal(readFileSync(join(old,'foreign-marker'),'utf8'),'keep');
 } finally {
  // Only this fixture created the replacement root; production cleanup refused it.
  for(const row of replaced.records()) if(existsSync(join(row.cwd,'foreign-marker'))) rmSync(row.cwd,{recursive:true,force:true});
  replaced.cleanup();
 }
});

test('nonzero commands and oversized stdout/stderr fail without exposing output or retaining sandbox', async () => {
 for (const [config, expected] of [[{versionExit:true},'binary_command_failed'],[{exportExit:true},'binary_command_failed'],[{versionNoise:true},'command_output_limit'],[{exportNoise:true},'command_output_limit']] as const) {
  const f = fixture(config);
  try { await assert.rejects(exportSchema(f.binary, measured),code(expected)); removed(f.records()); } finally { f.cleanup(); }
 }
});

test('missing, malformed, nonobject, oversized and linked schema outputs are refused', async () => {
 for (const [config, expected] of [[{missing:true},'schema_export_failed'],[{badJson:true},'invalid_schema_document'],[{badUtf8:true},'invalid_schema_document'],[{scalar:true},'invalid_schema_document'],[{oversize:true},'schema_output_limit'],[{symlink:true},'unsafe_schema_output'],[{hardlink:true},'unsafe_schema_output'],[{linkParent:true},'unsafe_schema_output']] as const) {
  const f = fixture(config);
  try { await assert.rejects(exportSchema(f.binary, measured),code(expected)); assert.equal(readFileSync(f.external,'utf8'),'{"untouched":true}'); assert.equal(lstatSync(f.external).nlink,1); removed(f.records()); } finally { f.cleanup(); }
 }
});

test('hanging exporter is killed by timeout; pre-cancelled invocation executes nothing', async () => {
 const f = fixture({hang:true});
 try {
  await assert.rejects(exportSchema(f.binary,measured,{timeoutMs:1000}),code('measurement_timeout')); removed(f.records());
  const before=f.records().length, controller=new AbortController(); controller.abort();
  await assert.rejects(exportSchema(f.binary,measured,{signal:controller.signal}),code('measurement_cancelled')); assert.equal(f.records().length,before);
 } finally { f.cleanup(); }
});

test('active caller cancellation kills the export process group and cleans its sandbox', async () => {
 const f=fixture({hang:true}), controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),250);
 try { await assert.rejects(exportSchema(f.binary,measured,{signal:controller.signal}),code('measurement_cancelled')); removed(f.records()); } finally { clearTimeout(timer); f.cleanup(); }
});

test('relative or nonsticky writable temporary parents are refused before executing a binary', async () => {
 const f=fixture(), parent=join(f.root,'shared-temp'), previous=process.env.TMPDIR; mkdirSync(parent); chmodSync(parent,0o777);
 try {
  process.env.TMPDIR='relative-temp-must-not-be-created';
  await assert.rejects(exportSchema(f.binary,measured),code('unsafe_temp_parent'));
  process.env.TMPDIR=parent;
  await assert.rejects(exportSchema(f.binary,measured),code('unsafe_temp_parent'));
  assert.equal(f.records().length,0);
 } finally { if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous; f.cleanup(); }
});

test('trusted file mode does not authorize a writable physical binary or alias ancestor', async () => {
 for(const kind of ['binary-parent','alias-parent']){
  const f=fixture();
  try {
   let binary=f.binary;
   if(kind==='binary-parent')chmodSync(f.root,0o777);
   else {const parent=join(f.root,'shared');mkdirSync(parent);chmodSync(parent,0o777);binary=join(parent,'alias');symlinkSync(f.binary,binary);}
   await assert.rejects(exportSchema(binary,measured),code('unsafe_binary_parent'));
   assert.equal(f.records().length,0,'no version command through replaceable ancestors');
  } finally { f.cleanup(); }
 }
});

test('invalid measurements, relative path, writable/set-id or excessive binaries are refused before execution', async () => {
 const f = fixture();
 try {
  await assert.rejects(exportSchema('relative',measured),code('invalid_binary_path'));
  await assert.rejects(exportSchema(f.binary,{...measured,version:'v0.167.1'}),code('invalid_daemon_measurement'));
  await assert.rejects(exportSchema(f.binary,{...measured,socketEpoch:''}),code('invalid_daemon_measurement'));
  chmodSync(f.binary,0o722); await assert.rejects(exportSchema(f.binary,measured),code('unsafe_binary'));
  chmodSync(f.binary,0o4700); await assert.rejects(exportSchema(f.binary,measured),code('unsafe_binary'));
  chmodSync(f.binary,0o700); truncateSync(f.binary,513*1024*1024); await assert.rejects(exportSchema(f.binary,measured),code('binary_limit'));
  assert.equal(f.records().length,0);
 } finally { f.cleanup(); }
});
