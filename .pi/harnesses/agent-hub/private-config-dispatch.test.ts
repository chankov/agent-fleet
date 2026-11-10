import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixture } from './private-config-fixtures.ts';
import { createActionExecutors } from './tools/action-executors.ts';
import { privateDeclarationHash } from './private-config-review.ts';
import { worktreeRevision } from './scope-gate.js';
import { createDispatchExecutor } from './tools/dispatch-execution.ts';
import { createNoProgressGuard } from './no-progress.ts';
import { createProcessState, applyProcessClassification, processPreEffectGate, evaluateProcessObligations, normalizeProcessState, noteProcessStage, processTaskIdentityConflicts } from './process-obligations.ts';
import { createAssertionsArtifactsContext } from './context/assertions-artifacts.ts';
import { runtimeTestRevision, instrumentBash } from './runtime-test-check.ts';
import { validateSpecialistResult } from './specialist-result.ts';

function dispatchFixture(t: any, scenario = 'pass') {
 const f = privateFixture(t); let processState = applyProcessClassification(createProcessState(), { risk: 'high', scope: 'wide', reason: 'fixture' }).state;
 let overlap = 0, active = 0, count = 0, launches = 0;
 const agents = new Map([['code-reviewer', { def: { name: 'code-reviewer', tools: 'read,bash' }, runCount: 1, lastBackend: 'native' }]]);
 const noProgress = createNoProgressGuard();
 const assertions = [{ id: 'A4', tag: 'test', text: 'private configuration current state', source: 'approved fixture', testCommand: 'fixture-offline-check', status: 'open' }];
 const d: any = {
  noProgress,
  state: {
   getTurnDispatchCount: () => count, setTurnDispatchCount: (v: number) => count = v, getTaskDispatchCount: () => count, setTaskDispatchCount: (v: number) => count = v,
   getTurnResearchCount: () => 0, setTurnResearchCount() {}, getTaskResearchCount: () => 0, setTaskResearchCount() {}, getTaskReviewRounds: () => 0, setTaskReviewRounds() {},
   getTaskTier: () => 'small', getTurnReport: () => ({ refusals: 0, dispatches: [] }), getSessionTotals: () => ({ refusals: 0, dispatches: 0 }),
   getTurnDispatchFingerprints: () => new Set(), getExternalBlockers: () => [], getExternalBlockerAcknowledged: () => false, getExternalBlockerRefusedOnce: () => false, setExternalBlockerRefusedOnce() {},
   isAskUserAvailable: () => true, getUserLanguage: () => 'English', getSessionDir: () => f.session, getAgentStates: () => agents, getAssertions: () => assertions, getResearchPersonas: () => [],
   getActiveWritableDispatches: () => active, setActiveWritableDispatches: (v: number) => active = v, getWritableOverlapCounter: () => overlap, setWritableOverlapCounter: (v: number) => overlap = v,
   getProcessState: () => processState, setProcessState: (v: any) => processState = v, persistProcessVerdict() {},
  },
  budget: { ensureTaskTier() {}, taskCounters: () => ({ dispatches: count, research: 0, reviewRounds: 0 }), taskActiveElapsedMs: () => 0, currentBudget: () => ({ agentTurnMs: 600000, recycleRuns: 3, delegation: false }), updateModeStatus() {} },
  artifacts: { ...createAssertionsArtifactsContext({ getAssertions: () => [], getSessionDir: () => f.session, getRunHistoryKeep: () => null, setStatus() {} }), loadInputArtifacts: () => [] },
  provisionalCapabilityRefusal: () => null, runReturnExtraction: async () => null, extractNeedsResearch: () => [], extractAskUserQuestions: () => [], contextPressure: () => false, displayName: (v: string) => v,
 };
 d.dispatchAgent = async (_agent: string, _task: string, _ctx: any, artifacts: any[], scope: string[], _watchdog: any, backend: string, _resume: any, contract: any) => {
  launches++; assert.deepEqual(artifacts, []); assert.deepEqual(scope, []); assert.equal(backend, 'native');
  const revision = runtimeTestRevision(f.cwd, '[]', JSON.stringify(contract.privateConfig));
  // Real observer hook; the inert operation replaces only shell execution, not receipts.
  const execute = instrumentBash((_cwd: any, opts: any) => ({ execute: async (_id: any, params: any) => { const r = await opts.operations.exec(params.command); return { content: [], details: { exitCode: r.exitCode } }; } }), { exec: async () => ({ exitCode: scenario === 'failed' ? 1 : scenario === 'unknown' ? null : 0 }) }, f.cwd, revision);
  const observed = await execute('check', { command: assertions[0].testCommand }, undefined, undefined);
  if (scenario === 'private-mutation') writeFileSync(f.file, JSON.stringify({ ...f.config, messageBudgetMs: 31000 }));
  if (scenario === 'helper-mutation') writeFileSync(join(f.cwd, f.source), '// changed ignored helper\n');
  if (scenario === 'source-mutation') writeFileSync(join(f.cwd, 'unexpected.md'), 'unexpected source mutation');
  if (scenario === 'overlap') overlap++;
  if (scenario === 'declaration') assertions[0].text += ' changed';
  if (scenario === 'generation') processState.runtimeReceipts!.generation = 'foreign';
  if (scenario === 'epoch') processState.runtimeReceipts!.epoch++;
  if (scenario === 'pending') processState.runtimeReceipts!.pending = [];
  if (scenario === 'backend') agents.get('code-reviewer')!.lastBackend = 'coms';
  if (scenario === 'reviewer') agents.get('code-reviewer')!.def.tools = 'read,bash,write';
  if (scenario === 'source-obligation') processState.changedFiles = ['unrelated.ts'];
  if (scenario === 'task') noProgress.reset();
  const report = validateSpecialistResult({ status: scenario === 'partial' ? 'partial' : 'completed', summary: 'Fixture semantic review', changed_files: [], assertions_proven: [], assertions_unproven: [], assertions_failed: scenario === 'assertion-failed' ? [{ id: 'A4', reason: 'not adequate' }] : [], tests_run: ['full scoped regression'], open_risks: [], requires_user_decision: scenario === 'question' ? ['Unresolved decision'] : [], evidence: [] }, f.cwd);
  const record: any = { ...observed.details.runtimeTest, startedAt: Date.now() - 1, finishedAt: Date.now() };
  if (scenario === 'stale') record.beforeRevision = 'a'.repeat(64);
  if (scenario === 'child-overlap') record.exclusive = false;
  return { output: scenario === 'reject' ? 'Verdict: REJECT' : 'Verdict: APPROVE\ntests_run: full scoped regression', exitCode: 0, elapsed: 1, dispatchId: 'private-fixture-' + launches,
   specialistResultTool: true, ...(scenario === 'missing-submission' ? {} : { specialistResult: report }),
   ...(scenario === 'missing-capture' ? {} : { lifecycle: { launched: true, closeSeen: true, runtimeCaptureIntegrity: scenario === 'tainted' ? 'tainted' : 'complete' } }),
   runtimeTests: scenario === 'no-checks' ? [] : [record] };
 };
 const params: any = { agent: 'code-reviewer', task: 'Review private configuration and verifier semantics', backend: 'native', review_mode: 'private-config-current-state', private_config_files: [f.file], verifier_sources: [f.source] };
 const use = () => ({ cwd: f.cwd, taskId: noProgress.taskId(), sessionDir: f.session, declarationHash: privateDeclarationHash(assertions as any), activeWriters: active, overlap });
 const prove = () => createActionExecutors({ ...d.state, artifacts: { ...d.artifacts, persistAssertions() {}, updateAssertionStatus() {}, evidencePathExists: () => true }, currentTaskId: () => noProgress.taskId(), currentRevision: () => worktreeRevision(f.cwd, []), privateProofUse: use } as any).executeUpdateAssertion('prove', { id: 'A4', status: 'proven', evidence: 'fixture-offline-check test passed (native receipt)' }, undefined, undefined, { cwd: f.cwd } as any);
 return { ...f, d, params, use, prove, state: () => processState, launches: () => launches, run: (patch = {}) => createDispatchExecutor(d)('private-' + launches, { ...params, ...patch }, undefined, undefined, { cwd: f.cwd } as any) };
}

test('pure high-risk wide private task can pass its assertion-prove process gate', async t => {
 const f = dispatchFixture(t), r: any = await f.run();
 assert.equal(r.details.privateConfigVerification?.status, 'accepted');
 assert.equal(r.details.processVerdict.path, 'private-config-current-state');
 assert.equal(r.details.processVerdict.obligations.acceptance.status, 'satisfied');
 assert.equal(r.details.processVerdict.obligations.review.status, 'satisfied');
 assert.equal(processPreEffectGate(f.state(), 'prove', '', undefined, f.use()), null);
 assert.equal((await f.prove() as any).details.status, 'proven');
 assert.equal(processPreEffectGate(f.state(), 'prove')?.reason, 'process_obligations_open', 'no live context fails closed');
});

test('fresh private native checks and independent review accept a configuration without inventing Git work', async t => {
 const f = dispatchFixture(t), r: any = await f.run();
 assert.equal(r.details.privateConfigVerification?.status, 'accepted', JSON.stringify(r));
 assert.equal(r.details.privateConfigVerification.origin, 'private-config-current-state');
 assert.equal(r.details.taskAccepted, false); assert.equal(r.details.changeResult.status, 'unchanged');
 assert.deepEqual(f.state().changedFiles, []);
 assert.equal(f.state().acceptance.evidenceRef, null); assert.equal(f.state().review.evidenceRef, null);
 const proof = readFileSync(r.details.privateConfigVerification.evidenceRef, 'utf8');
 assert.match(proof, /agent-fleet.private-config-verification\/v1/);
 assert.equal(proof.includes('loadedCatalog'), false); assert.equal(proof.includes(f.config.approval.binding.fleetOwner), false);
});

for (const scenario of ['failed','unknown','no-checks','stale','private-mutation','helper-mutation','source-mutation','overlap','child-overlap','declaration','task','generation','epoch','pending','backend','reviewer','source-obligation','reject','partial','missing-submission','assertion-failed','question','tainted','missing-capture']) {
 test(`private review fails closed: ${scenario}`, async t => {
  const f=dispatchFixture(t,scenario), r:any=await f.run();
  assert.equal(r.details.privateConfigVerification?.status,'unproven',JSON.stringify(r));
  assert.equal(f.state().review.evidenceRef,null);
  assert.equal(f.state().acceptance.evidenceRef,null);
  assert.equal((await f.prove() as any).details.status, 'refused');
 });
}

test('private mode is explicit and never permits artifacts, Git scope, deliverables or unsupported assertions',async t=>{
 for(const patch of [{backend:'auto'},{backend:'coms'},{backend:undefined},{review_mode:'changes'},{scope:['.gitignore']},{deliverables:['out.md']},{artifacts:['private.json']},{scope_mode:'create'},{private_config_files:[]},{verifier_sources:[]}]) {
  const f=dispatchFixture(t),r:any=await f.run(patch);
  assert.equal(r.details.started,false,JSON.stringify(r));assert.equal(f.launches(),0);
 }
});

test('private mode requires independent read-only native reviewer and declarations',async t=>{
 for(const scenario of ['persona','write','no-bash','manual','ui','missing-command','unrelated-source']) {
  const f=dispatchFixture(t);
  if(scenario==='persona'){ const value=f.d.state.getAgentStates().get('code-reviewer');f.d.state.getAgentStates().set('builder',value);f.params.agent='builder'; }
  if(scenario==='write')f.d.state.getAgentStates().get('code-reviewer').def.tools='read,bash,write';
  if(scenario==='no-bash')f.d.state.getAgentStates().get('code-reviewer').def.tools='read';
  if(['manual','ui'].includes(scenario))f.d.state.getAssertions()[0].tag=scenario==='ui'?'runtime-ui':'manual';
  if(scenario==='missing-command')delete f.d.state.getAssertions()[0].testCommand;
  if(scenario==='unrelated-source')f.state().changedFiles=['unrelated.ts'];
  const r:any=await f.run();assert.equal(r.details.started,false,scenario+JSON.stringify(r));assert.equal(f.launches(),0);
 }
});

test('old observations cannot be replayed into a new private capture or reused as source review',async t=>{
 const f=dispatchFixture(t), launch=f.d.dispatchAgent;let cached:any;
 let attempts=0;f.d.dispatchAgent=async(...args:any[])=>({...((cached??=await launch(...args))),dispatchId:'replay-attempt-'+(++attempts)});
 const first:any=await f.run();assert.equal(first.details.privateConfigVerification.status,'accepted');
 const second:any=await f.run({task:'Repeat private verification with a fresh capture'});
 assert.equal(second.details.privateConfigVerification?.status,'unproven',JSON.stringify(second));
 assert.equal((await f.prove() as any).details.status, 'refused');
 assert.equal(f.state().review.evidenceRef,null);assert.deepEqual(f.state().changedFiles,[]);
});

test('proof readback and last-moment helper mutation cannot close private review',async t=>{
 for(const scenario of ['hollow','foreign-kind','mutation']) {
  const f=dispatchFixture(t),writer=f.d.artifacts.writeRunArtifact;
  f.d.artifacts.writeRunArtifact=(...args:any[])=>{
   if(args[0]==='operator-state') {
    if(scenario==='hollow')args[2]='hollow';
    if(scenario==='foreign-kind')args[3]='returns';
    if(scenario==='mutation')writeFileSync(join(f.cwd,f.source),'// changed during proof write');
   }
   return writer(...args);
  };
  const r:any=await f.run();assert.equal(r.details.privateConfigVerification.status,'unproven',scenario+JSON.stringify(r));
 }
});

test('native transport preserves exact private capture through resume identity and observer environment',async t=>{
 const f=privateFixture(t);
 const {bindResume}=await import('./task-resume-contract.ts');
 const {runPreparedNative}=await import('./dispatch-native-spawn.ts');
 const {PRIVATE_CONFIG_ENV}=await import('./private-config-current-state.ts');
 const binding={files:[f.file],sources:[f.source],taskId:'fixture-task',sessionDir:f.session,declarationHash:'a'.repeat(64),captureId:'fresh',generation:'fixture-generation',epoch:0};
 const contract=bindResume({taskId:'fixture-task',instructions:'review',privateConfig:binding});
 assert.equal(bindResume({taskId:'fixture-task',instructions:'review',privateConfig:{...binding,captureId:'another'},previous:contract}).resumeAllowed,false);
 let seen:any;
 const run:any={
  nativeAdmitted:()=>true,dispatchId:'transport-fixture',key:'code-reviewer',agentKey:'code-reviewer',personaKey:'code-reviewer',resumeContract:contract,
  deps:{displayName:(v:string)=>v,guardrailEnv:()=>({}),notifyProviderQueue(){},getSessionDir:()=>f.session,
   getWatchdogAgentOverride:()=>undefined,getWatchdogSetting:()=> 'off',getWorkMode:()=> 'operator',
   providerSemaphore:{run:async(_model:string,fn:any)=>fn()},runDriftJudge:async()=>({status:'unavailable',reason:'fixture'}),createDriftMonitor:()=>({}),
   updateWidget(){},appendTimelineText(){},appendTimelineEvent(){},shortModel:(v:string)=>v,getReconSearchTimeoutMs:()=>1,
   spawnPiAgentWithModelFallback:async(opts:any)=>{seen=opts;return {output:'',exitCode:0,stderr:'',toolCallsStarted:0,modelUsed:'fake/model',lifecycle:{launched:true,closeSeen:true,runtimeCaptureIntegrity:'complete'}};},
  },
  state:{def:{name:'code-reviewer'},toolCount:0,timeline:[]},ctx:{cwd:f.cwd,ui:{notify(){}}},admittedCwd:f.cwd,
  watchdogParam:false,scopeGlobs:[],task:'review',model:'fake/model',effectiveTools:'read,bash',thinkingLevel:'off',replacementSystemPrompt:'',agentSessionFile:join(f.session,'native.json'),runPrompt:'review',extensions:['/fixture/runtime-test-check.ts'],turnBudget:{},resumeAllowed:false,sessionRecycled:false,sessionReset:null,
 };
 await runPreparedNative(run);
 assert.equal(seen.runtimeTestObserver,true);assert.equal(seen.env[PRIVATE_CONFIG_ENV],JSON.stringify(contract.privateConfig));
 assert.match(runtimeTestRevision(f.cwd,seen.env.AGENT_FLEET_RUNTIME_TEST_SCOPES,seen.env[PRIVATE_CONFIG_ENV])(),/^[a-f0-9]{64}$/);
 delete run.resumeContract;await runPreparedNative(run);assert.equal(seen.env[PRIVATE_CONFIG_ENV],'','old modes clear inherited context');
});

for (const mutation of ['private','helper','repository','task','generation','epoch','pending','declaration','source-obligation','source-stage','capture','receipt','receipt-file','reviewer-file','proof-file','concurrency','overlap','classification','session','missing-context']) {
 test(`accepted private closure is revalidated at actual assertion prove: ${mutation}`, async t => {
  const f = dispatchFixture(t), r: any = await f.run();
  assert.equal(r.details.privateConfigVerification.status, 'accepted');
  assert.equal((await f.prove() as any).details.status, 'proven');
  const state = f.state(), proof = state.privateVerification!;
  switch (mutation) {
   case 'private': writeFileSync(f.file, JSON.stringify({ ...f.config, messageBudgetMs: 31000 })); break;
   case 'helper': writeFileSync(join(f.cwd, f.source), '// mutated after acceptance'); break;
   case 'repository': writeFileSync(join(f.cwd, 'other.ts'), '// unrelated source'); break;
   case 'task': f.d.noProgress.reset(); break;
   case 'generation': state.runtimeReceipts!.generation = 'another-generation'; state.runtimeReceipts!.records = []; break;
   case 'epoch': state.runtimeReceipts!.epoch++; state.runtimeReceipts!.records = []; break;
   case 'pending': state.runtimeReceipts!.pending.push('new-capture'); break;
   case 'declaration': f.d.state.getAssertions()[0].testCommand += '-changed'; break;
   case 'source-obligation': state.changedFiles = ['unrelated.ts']; break;
   case 'source-stage': state.review = { required: true, evidenceRef: 'unrelated-review', revision: proof.revision }; state.changedFiles = ['source.ts']; break;
   case 'capture': proof.binding.captureId = 'foreign'; break;
   case 'receipt': state.runtimeReceipts!.records = []; break;
   case 'receipt-file': writeFileSync(proof.receipts[0].evidenceRef, 'tampered'); break;
   case 'reviewer-file': writeFileSync(proof.reviewer.evidenceRef, 'Verdict: REJECT'); break;
   case 'proof-file': writeFileSync(proof.evidenceRef, 'tampered'); break;
   case 'concurrency': f.d.state.setActiveWritableDispatches(1); break;
   case 'overlap': f.d.state.setWritableOverlapCounter(1); break;
   case 'classification': state.reassessments++; break;
   case 'session': proof.binding.sessionDir += '-foreign'; break;
   case 'missing-context': assert.ok(processPreEffectGate(state, 'prove')); return;
  }
  assert.equal((await f.prove() as any).details.status, 'refused');
  const verdict = evaluateProcessObligations(state, { writable: true, budgetTier: 'small', privateUse: f.use() });
  assert.equal(verdict.accepted, false);
  assert.notEqual(verdict.path, 'private-config-current-state');
 });
}

test('restored private proof requires live identity and a subsequent Git acceptance cannot inherit it', async t => {
 const f = dispatchFixture(t); await f.run();
 const restored = normalizeProcessState(JSON.parse(JSON.stringify(f.state())));
 assert.equal(evaluateProcessObligations(restored, { writable: true, budgetTier: 'small', privateUse: f.use() }).accepted, true);
 assert.equal(processTaskIdentityConflicts(restored, 'foreign-task'), true);
 assert.equal(processPreEffectGate(restored, 'prove')?.reason, 'process_obligations_open');
 const git = noteProcessStage(restored, 'acceptance', { evidenceRef: 'git-proof', revision: 'git-revision', changedFiles: ['source.ts'] });
 assert.equal(git.privateVerification, undefined); assert.equal(git.privateVerificationRequired, undefined);
 assert.equal(evaluateProcessObligations(git, { writable: true, budgetTier: 'small', currentRevision: 'git-revision', privateUse: f.use() }).obligations.review.status, 'open');
 const reviewed = noteProcessStage(git, 'review', { evidenceRef: 'git-review', revision: 'git-revision' });
 assert.equal(evaluateProcessObligations(reviewed, { writable: true, budgetTier: 'small', currentRevision: 'git-revision' }).accepted, true);
 assert.equal(evaluateProcessObligations(reviewed, { writable: true, budgetTier: 'small', currentRevision: 'git-revision' }).path, 'changed-task');
});

test('low-risk private failure cannot use the ordinary optional-review prove path', async t => {
 const f = dispatchFixture(t, 'failed');
 f.state().risk = 'low'; f.state().scope = 'small'; f.state().review.required = false;
 const r: any = await f.run(); assert.equal(r.details.privateConfigVerification.status, 'unproven');
 assert.equal((await f.prove() as any).details.status, 'refused');
});

test('private metadata cannot satisfy unrelated source additions or ordinary Git stages', async t => {
 const f = dispatchFixture(t); await f.run();
 const state = f.state();
 assert.deepEqual(state.reviews ?? [], []);
 assert.equal(evaluateProcessObligations(state, { writable: true, budgetTier: 'small' }).accepted, false);
 state.additions = [{ id: 'source-security', source: 'system1', taskId: f.use().taskId, evaluationId: 'eval', inputRevision: 'rev', policyVersion: 'v1', questionVersion: 'v1', provider: 'fixture', model: 'fixture', reason: 'security_change', status: 'active', waiverReason: null }];
 assert.equal((await f.prove() as any).details.status, 'refused');
 assert.equal(state.acceptance.evidenceRef, null); assert.equal(state.review.evidenceRef, null);
});
