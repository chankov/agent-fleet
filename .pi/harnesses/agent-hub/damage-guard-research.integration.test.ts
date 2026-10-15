import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchRuntime } from './research/runtime.ts';
import { spawnPiAgentWithModelFallback } from './spawn.ts';
import { createDiscoveryOwners } from './file-discovery/owners.ts';

const deferred = () => {
 let resolve!: () => void;
 const promise = new Promise<void>(r => resolve = r);
 return { promise, resolve };
};
function fixture(t: any, overrides: any = {}) {
 const root = mkdtempSync(join(tmpdir(), 'd6-research-')), session = join(root, 'session');
 mkdirSync(session);
 writeFileSync(join(root, 'pi'), `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv;
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
const model=args[args.indexOf('--model')+1];
fs.appendFileSync(process.env.REPORT,JSON.stringify({model,prompt,cwd:process.cwd(),tools:args[args.indexOf('--tools')+1],extensions:args.filter((v,i)=>args[i-1]==='-e'),unsafe:Object.keys(process.env).filter(k=>k.startsWith('AF_D6')||k==='TYPESAFE_API_KEY'),discovery:!!process.env.AF_D9_ASSIGNMENT})+'\\n');
if(process.env.MODE==='timeout'){setInterval(()=>{},1000);return;}
if(process.env.MODE==='fallback'&&model==='fake/primary'){
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}}));process.exitCode=1;
}else console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'original research evidence'}],stopReason:'stop'}}));
});`, { mode: 0o755 });
 let states = new Map(), next = 1, sessionDir = session, launch = 'launch', allowed = true;
 const parent = { taskId: 'parent-task', inputRevision: 'original-parent-input' };
 const inputs: any[] = [], discoveryInputs: any[] = [];
 let opens = 0, inference = 0, validations = 0;
 // An injected assessment service is reachable only through an effect lease.
 const service = { assess() { inference++; return 'unavailable'; } };
 const registration = {
  tools: ['bash', 'write', 'edit'],
  validate: () => { validations++; return parent.inputRevision === 'original-parent-input'; },
  open() { opens++; service.assess(); throw Error('read-only research must never open an effect lease'); },
 };
 const env = { PATH: root + ':' + process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '', REPORT: join(root, 'report'), TYPESAFE_API_KEY: 'synthetic-key', AF_D6_ASSIGNMENT: 'forged', AF_D6_OTHER: 'forged' };
 const deps: any = {
  getResearchStates: () => states, setResearchStates: (s: any) => states = s,
  getNextResearchId: () => next, setNextResearchId: (n: number) => next = n,
  hubState: { getSessionDir: () => sessionDir }, launchIdentity: () => launch, researchAdmission: () => allowed,
  budget: { currentBudget: () => ({ agentTurnMs: 20000 }) },
  artifacts: { appendInputArtifacts: (p: string) => p + '\nINPUT_ARTIFACT original evidence' },
  executionHistory: { start: () => ({}), end() {} },
  providerSemaphore: { run: async (_m: string, fn: any) => fn() },
  getSafetyHarnessPath: () => 'synthetic-safety', getReconSearchTimeoutMs: () => 1000, getContextWindow: () => 10000,
  resolvedModel: () => 'fake/primary', resolvedThinking: () => 'off', resolveThinkingLevel: () => 'off',
  fallbackModelFor: () => 'fake/fallback', substitutedModel: (m: any) => m, modelWindowLookup: () => () => undefined,
  guardrailEnv: () => env, notifyProviderQueue() {},
  spawnPiAgentWithModelFallback,
  getProjectPolicyPaths: () => ['AGENTS.md'], getProjectDocsPaths: () => ['docs/ARCHITECTURE.md'],
  nativeResearchSystemPrompt: () => 'synthetic research policy', requireSafetyHarness: () => ({ ok: true, extensions: ['synthetic-safety'] }),
  shortModel: (m: string) => m, displayName: (s: string) => s,
  flushTimelineStore() {}, appendTimelineText() {}, appendTimelineEvent() {}, createTranscriptStore: () => ({ append() {} }),
  ...overrides,
 };
 const prepare = (input: any) => { inputs.push(input); return registration; };
 const runtime = createResearchRuntime(deps);
 const ctx: any = { cwd: root, ui: { notify() {} } };
 const state = runtime.createState({ name: 'research', description: '', tools: 'read,grep,find,ls,bash,write,edit', toolsExplicit: true, systemPrompt: '', file: '' }, false, 'fake/primary');
 const admission: any = { readScope: ['docs/a'], admit: () => true };
 t.after(() => { if (state.timer) clearInterval(state.timer); rmSync(root, { recursive: true, force: true }); });
 return { root, session, ctx, state, admission, runtime, deps, env, parent, inputs, discoveryInputs, registration, prepare,
  counts: () => ({ opens, inference, validations }),
  rows: () => existsSync(env.REPORT) ? readFileSync(env.REPORT, 'utf8').trim().split('\n').map(s => JSON.parse(s)) : [],
  invalidate(change: string, controller: AbortController) {
   if (change === 'launch') launch = 'other';
   if (change === 'session') sessionDir = session + 'other';
   if (change === 'registered') states.clear();
   if (change === 'dispatch') state.dispatchId = 'other';
   if (change === 'researchAdmission') allowed = false;
   if (change === 'requestAdmission') admission.admit = () => false;
   if (change === 'tools') state.def.tools = 'read';
   if (change === 'caps') state.def.toolsExplicit = false;
   if (change === 'scope') admission.readScope.push('wide');
   if (change === 'cwd') ctx.cwd += 'other';
   if (change === 'signal') controller.abort();
   if (change === 'operator') state.killedByOperator = true;
   if (change === 'revision') parent.inputRevision = 'new-parent-input';
  },
  spawn: (signal?: AbortSignal) => runtime.spawn(state, 'research prompt is NOT parent input', ctx, [], signal, admission),
 };
}

test('F6 independent D9 absent/off/on x D6 absent/off/on preserves read-only primary and fallback production launches', async t => {
 for (const mode of ['primary', 'fallback']) for (const d9 of ['absent', 'off', 'on']) for (const d6 of ['absent', 'off', 'on']) {
  let f: any;
  const owners = createDiscoveryOwners('s', () => 'parent-task'); t.after(() => owners.dispose());
  f = fixture(t, {
   ...(d6 === 'absent' ? {} : { prepareDamageGuard: (i: any) => d6 === 'off' ? null : f.prepare(i) }),
   ...(d9 === 'absent' ? {} : { prepareDiscovery: async (i: any) => {
    f.discoveryInputs.push(i);
    return d9 === 'off' ? null : { manifest: { readScope: i.scope }, current: () => true,
     registration: { owners, endpoint: '/synthetic/broker', owner: { taskId: 'parent-task', ownerId: i.ownerId, cwd: i.cwd, task: 'parent-task', query: 'docs', effectiveTools: i.tools, readRoots: [], exportRoots: [], canRead: () => false, canDisplay: () => false, permissionIdentity: () => 'p' } } };
   } }),
  });
  f.env.MODE = mode;
  const result = await f.spawn(); assert.equal(result.exitCode, 0, `${mode}/${d9}/${d6}: ${result.output}`);
  assert.equal(f.rows().length, mode === 'fallback' ? 2 : 1);
  for (const row of f.rows()) {
   assert.equal(row.tools, 'read,grep,find,ls'); assert.equal(row.cwd, f.root);
   assert.equal(row.extensions[0], 'synthetic-safety'); assert.deepEqual(row.unsafe, []);
   assert.match(row.prompt, /INPUT_ARTIFACT original evidence/);
   if (d9 === 'on') assert.match(row.prompt, /docs\/a/);
  }
  assert.equal(f.counts().opens, 0); assert.equal(f.counts().inference, 0); assert.equal(owners.size, 0);
  assert.deepEqual(f.parent, { taskId: 'parent-task', inputRevision: 'original-parent-input' });
  if (d6 === 'on') {
   assert.equal(f.inputs.length, 1); assert.equal(f.inputs[0].ownerId, result.dispatchId);
   assert.deepEqual(f.inputs[0].tools, ['read', 'grep', 'find', 'ls']); assert.deepEqual(f.inputs[0].readScope, ['docs/a']);
   for (const key of ['task', 'query', 'inputRevision', 'model', 'env']) assert.equal(f.inputs[0][key], undefined);
   assert.ok(Object.isFrozen(f.inputs[0])); assert.ok(Object.isFrozen(f.inputs[0].tools)); assert.ok(Object.isFrozen(f.inputs[0].readScope));
   assert.equal(f.inputs[0].admit(), false); // finalized child is no longer registered
   assert.ok(f.counts().validations > 0);
  }
 }
});

test('F6 deferred discovery, independent preparation and queue refuse stale admission and scope without leases', async t => {
 for (const phase of ['discovery', 'damage', 'queue']) for (const change of ['launch', 'session', 'registered', 'dispatch', 'researchAdmission', 'requestAdmission', 'tools', 'caps', 'scope', 'cwd', 'signal', 'operator', 'discovery', 'revision']) {
  const entered = deferred(), release = deferred(), controller = new AbortController(); let f: any, current = true;
  const wait = async () => { entered.resolve(); await release.promise; };
  f = fixture(t, {
   prepareDiscovery: async (i: any) => { f.discoveryInputs.push(i); if (phase === 'discovery') await wait(); return { manifest: {}, current: () => current && f.parent.inputRevision === 'original-parent-input' }; },
   prepareDamageGuard: async (i: any) => { f.inputs.push(i); if (phase === 'damage') await wait(); return f.registration; },
   providerSemaphore: { run: async (_m: string, fn: any) => { if (phase === 'queue') await wait(); return fn(); } },
  });
  const pending = f.spawn(controller.signal);
  try {
   assert.equal(await Promise.race([entered.promise.then(() => 'entered'), pending.then(() => 'finished')]), 'entered');
   if (change === 'discovery') current = false; else f.invalidate(change, controller);
   release.resolve(); const result = await pending;
   assert.notEqual(result.exitCode, 0, `${phase}/${change}`); assert.equal(f.rows().length, 0, `${phase}/${change}`);
   if (phase === 'discovery') assert.equal(f.inputs.length, 0);
   assert.deepEqual(f.discoveryInputs[0].scope, ['docs/a']);
   if (f.inputs.length) assert.deepEqual(f.inputs[0].readScope, ['docs/a']);
   assert.equal(f.counts().opens, 0); assert.equal(f.counts().inference, 0);
  } finally { release.resolve(); }
 }
});

test('F6 parent revision validator independently refuses during D6 or queue waits with D9 off', async t => {
 for (const phase of ['damage', 'queue']) {
  const entered = deferred(), release = deferred(); let f: any;
  f = fixture(t, {
   prepareDamageGuard: async (i: any) => { const r = f.prepare(i); if (phase === 'damage') { entered.resolve(); await release.promise; } return r; },
   providerSemaphore: { run: async (_m: string, fn: any) => { if (phase === 'queue') { entered.resolve(); await release.promise; } return fn(); } },
  });
  const pending = f.spawn();
  try {
   assert.equal(await Promise.race([entered.promise.then(() => 'entered'), pending.then(() => 'finished')]), 'entered');
   f.parent.inputRevision = 'changed'; release.resolve();
   assert.notEqual((await pending).exitCode, 0); assert.equal(f.rows().length, 0); assert.equal(f.counts().opens, 0);
  } finally { release.resolve(); }
 }
});

test('F6 every real fallback attempt fences authority even when D6 absent or read-only', async t => {
 for (const d6 of ['absent', 'present']) for (const change of ['unchanged', 'operator', 'scope', 'revision', 'signal']) {
  // Parent revision is available only through an independently supplied validator.
  if (d6 === 'absent' && change === 'revision') continue;
  let f: any; const controller = new AbortController();
  f = fixture(t, {
   ...(d6 === 'present' ? { prepareDamageGuard: (i: any) => f.prepare(i) } : {}),
   spawnPiAgentWithModelFallback: (opts: any, fallback: any, cb: any, policy: any) => spawnPiAgentWithModelFallback(opts, fallback, { ...cb, onModelFallback: (e: any) => { cb.onModelFallback?.(e); f.invalidate(change, controller); } }, policy),
  });
  f.env.MODE = 'fallback'; const result = await f.spawn(controller.signal);
  assert.equal(f.rows().length, change === 'unchanged' ? 2 : 1, `${d6}/${change}`);
  if (change === 'unchanged') assert.equal(result.exitCode, 0); else assert.notEqual(result.exitCode, 0);
  assert.equal(f.counts().opens, 0); assert.equal(f.counts().inference, 0);
 }
});

test('F6 supplied false or throwing validators fail closed for read-only research', async t => {
 for (const mode of ['false', 'throw']) {
  const f = fixture(t, { prepareDamageGuard: () => ({ tools: ['bash'], validate() { if (mode === 'throw') throw Error('synthetic refusal'); return false; }, open() { assert.fail('must not open'); } }) });
  assert.notEqual((await f.spawn()).exitCode, 0); assert.equal(f.rows().length, 0);
 }
});

test('F6 initial cancellation and safety refusal perform zero preparation or physical launch', async t => {
 for (const mode of ['operator', 'signal', 'safety']) {
  let prepared = 0;
  const f = fixture(t, { prepareDiscovery: () => { prepared++; return null; }, prepareDamageGuard: () => { prepared++; return null; }, ...(mode === 'safety' ? { requireSafetyHarness: () => ({ ok: false, error: 'synthetic safety refusal' }) } : {}) });
  const controller = new AbortController(); f.invalidate(mode, controller);
  const result = await f.spawn(controller.signal);
  assert.notEqual(result.exitCode, 0); assert.equal(prepared, 0); assert.equal(f.rows().length, 0);
  if (mode === 'operator') assert.equal(f.state.killedByOperator, true);
 }
});

test('F6 implicit research caps remain read-only and throwing admission checks refuse launch', async t => {
 for (const mode of ['implicit', 'research', 'request', 'discovery']) {
  let f: any;
  f = fixture(t, {
   prepareDamageGuard: (i: any) => f.prepare(i),
   ...(mode === 'research' ? { researchAdmission() { throw Error('synthetic authority unavailable'); } } : {}),
   ...(mode === 'discovery' ? { prepareDiscovery: async () => ({ manifest: {}, current() { throw Error('synthetic unavailable'); } }) } : {}),
  });
  if (mode === 'request') f.admission.admit = () => { throw Error('synthetic request unavailable'); };
  f.state.def.toolsExplicit = false;
  const result = await f.spawn();
  if (mode === 'implicit') {
   assert.equal(result.exitCode, 0); assert.equal(f.rows()[0].tools, 'read,grep,find,ls');
   assert.deepEqual(f.inputs[0].tools, ['read', 'grep', 'find', 'ls']);
  } else { assert.notEqual(result.exitCode, 0); assert.equal(f.rows().length, 0); assert.equal(f.inputs.length, 0); }
  assert.equal(f.counts().opens, 0); assert.equal(f.counts().inference, 0);
 }
});

test('F6 production turn timeout retains termination and finalization without effect leases', async t => {
 let f: any;
 f = fixture(t, { budget: { currentBudget: () => ({ agentTurnMs: 500 }) }, prepareDamageGuard: (i: any) => f.prepare(i) });
 f.env.MODE = 'timeout';
 const result = await f.spawn();
 assert.equal(result.termination?.reason, 'turn_timeout'); assert.notEqual(result.exitCode, 0);
 assert.equal(f.rows().length, 1); assert.equal(f.state.status, 'error'); assert.equal(f.state.timer, undefined);
 assert.equal(f.runtime.states().size, 0); assert.equal(f.counts().opens, 0); assert.equal(f.counts().inference, 0);
});
