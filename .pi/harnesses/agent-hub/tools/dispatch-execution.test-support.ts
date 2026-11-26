import { createNoProgressGuard } from "../no-progress.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchExecutor } from "./dispatch-execution.ts";
import type { DispatchExecutionState, DispatchExecutorDeps } from "./dispatch-execution-types.ts";
import { applyProcessClassification,createProcessState,noteProcessStage } from "../process-obligations.ts";
import { revisionOf,revisionScopes,worktreeRevision } from "../scope-gate.js";

interface FixtureAgent {
	def: { name: string; tools: string };
	runCount: number;
	contextPct?: number;
	lastBackend: string | null;
}

export function prepareDeps(overrides: { agents?: string[]; research?: string[]; turn?: number; tools?: string } = {}) {
	let turn = overrides.turn ?? 0;
	let task = 0, activeWriters = 0, overlapCounter = 0;
	let processState = applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "test fixture" }).state;
	const agents = new Map<string, FixtureAgent>((overrides.agents ?? ["editor"]).map(name => [name.toLowerCase(), { def: { name, tools: overrides.tools ?? "read" }, runCount: 0, contextPct: 0, lastBackend: null }]));
	const turnReport = { refusals: 0, dispatches: [] as unknown[], research: 0, tier: "small" };
	const sessionTotals = { refusals: 0, dispatches: 0, research: 0, billed: 0, out: 0 };
	const writeRunArtifact: DispatchExecutorDeps["artifacts"]["writeRunArtifact"] = () => "/tmp/tool-result.md";
	return {
		noProgress: createNoProgressGuard(),
		state: {
			getTurnDispatchCount: () => turn,
			setTurnDispatchCount: (v: number) => { turn = v; },
			getTurnResearchCount: () => 0,
			setTurnResearchCount() {},
			getTaskDispatchCount: () => task,
			setTaskDispatchCount: (v: number) => { task = v; },
			getTaskResearchCount: () => 0,
			setTaskResearchCount() {},
			getTaskReviewRounds: () => 0,
			setTaskReviewRounds() {},
			getTaskTier: () => "small",
			getProcessState: () => processState,
			setProcessState: (value: any) => { processState = value; },
			persistProcessVerdict() {},
			getTurnReport: () => turnReport,
			getSessionTotals: () => sessionTotals,
			getTurnDispatchFingerprints: () => new Set<string>(),
			getExternalBlockers: () => [],
			getExternalBlockerAcknowledged: () => false,
			markExternalBlockersPending() {},
			getExternalBlockerMarker: () => "[[external-blocker:test]]",
			isAskUserAvailable: () => true,
			getUserLanguage: () => "English",
			getSessionDir: () => "/tmp",
			getAgentStates: () => agents,
			getAssertions: (): ReturnType<DispatchExecutionState["getAssertions"]> => [],
			getResearchPersonas: () => (overrides.research ?? ["researcher"]).map(name => ({ name })),
			getActiveWritableDispatches: () => activeWriters,
			setActiveWritableDispatches(v: number) { activeWriters = v; },
			getWritableOverlapCounter: () => overlapCounter,
			setWritableOverlapCounter(v: number) { overlapCounter = v; },
		},
		budget: {
			ensureTaskTier() {},
			taskCounters: () => ({ dispatches: task, research: 0, reviewRounds: 0 }),
			taskActiveElapsedMs: () => 0,
			currentBudget: () => ({ agentTurnMs: 600_000, recycleRuns: 3, delegation: false }),
			updateModeStatus() {},
		},
		artifacts: {
			writeRunArtifact,
			loadInputArtifacts: () => [],
		},
		research: {},
		provisionalCapabilityRefusal: () => null,
		diagnoseChangedTypeScript: undefined as DispatchExecutorDeps["diagnoseChangedTypeScript"],
		dispatchAgent: async () => ({ output: "", exitCode: 0, elapsed: 0 }),
		runReturnExtraction: async () => null,
		extractNeedsResearch: () => [],
		extractAskUserQuestions: () => [],
		contextPressure: () => false,
		displayName: (n: string) => n,
		_turn: () => turn,
		_task: () => task,
		_report: turnReport,
		_agents: agents,
		_setOverlap: (v: number) => { overlapCounter = v; },
	};
}

export function gitDiagnosticsFixture(t: any, git = true) {
 const cwd = mkdtempSync(join(tmpdir(), "dispatch-compiler-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const sessionDir = join(cwd, ".pi", "agent-sessions", "sessions", "test"); mkdirSync(sessionDir, { recursive: true }); mkdirSync(join(cwd, "src"));
 writeFileSync(join(cwd, "src", "api.ts"), "export const value = 1;\n"); writeFileSync(join(cwd, "README.md"), "fixture\n");
 if (git) {
  execFileSync("git", ["init"], { cwd, stdio: "ignore" }); execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd, stdio: "ignore" });
 }
 const d = prepareDeps({ tools: "read,write" }); d.state.getSessionDir = () => sessionDir;
 const assertions = [{ id: "A1", status: "open" }];
 return import("../context/assertions-artifacts.ts").then(({ createAssertionsArtifactsContext }) => {
  d.artifacts = createAssertionsArtifactsContext({ getSessionDir: () => sessionDir, getAssertions: () => assertions as any, getRunHistoryKeep: () => 2, setStatus() {} }) as any;
  (d._agents.get("editor") as any).lastBackend = "native";
  return { cwd, sessionDir, d, assertions };
 });
}

/** Stub stand-in for a launched native settlement. Production spawn always publishes parser-owned capture integrity (see the real-spawn tests below); a stub without it now fails closed at the parent, for fresh checks as well as receipt reuse. */
export const nativeCleanLifecycle={launched:true,closeSeen:true,runtimeCaptureIntegrity:'complete' as const};

export async function highRiskChangedFixture(t: any) {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 let process = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "sensitive boundary" }).state;
 process = { ...process, plan: { ...process.plan, evidenceRef: "plan:approved", revision: "approved" } };
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; }; d.state.persistProcessVerdict = () => {};
 d._agents.set("reviewer", { def: { name: "reviewer", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => ({ status: "completed", changedFiles: [...paths], attribution: "no_observed_overlap", uncoveredFiles: [], projects: [{ status: "passed", exitCode: 0, argv: ["node", "tsc"], diagnostics: [], changedFiles: [...paths] }] } as any);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "export const value = 9;\n"); return { output: "done", exitCode: 0, elapsed: 1, dispatchId: "high-build" }; };
 await createDispatchExecutor(d as any)("build", { agent: "editor", task: "high risk change" }, undefined, undefined, { cwd } as any);
 assert.equal(process.review.required, true); assert.ok(process.changedFiles.includes("src/api.ts"));
 return { cwd, d, process: () => process };
}

// layout 'nested': the workspace root is not a repository and the edited file lives in a
// nested one (rankedin: rin-docs/ and ringithub/ under a plain folder).
export async function operatorStateFixture(t:any,scenario='pass',layout:'single'|'nested'='single',scope=['a.ts']) {
 const cwd=mkdtempSync(join(tmpdir(),'operator-review-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 if(layout==='single'){execFileSync('git',['init','-q'],{cwd});writeFileSync(join(cwd,'a.ts'),'export const a=1;\n');}
 else {
  const docs=join(cwd,'rin-docs');mkdirSync(docs);execFileSync('git',['init','-q'],{cwd:docs});
  writeFileSync(join(docs,'prd.md'),'# PRD\n');writeFileSync(join(docs,'clean.md'),'unchanged\n');
  execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=Fixture','add','.'],{cwd:docs});
  execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=Fixture','commit','-qm','base'],{cwd:docs});
  writeFileSync(join(docs,'prd.md'),'# PRD\n\nEdited by the operator.\n');writeFileSync(join(cwd,'loose.md'),'not in any repository\n');
  const app=join(cwd,'ringithub');mkdirSync(app);execFileSync('git',['init','-q'],{cwd:app});writeFileSync(join(app,'app.ts'),'export const app=1;\n');
  execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=Fixture','add','.'],{cwd:app});
  execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=Fixture','commit','-qm','base'],{cwd:app});
 }
 const d=prepareDeps({agents:['reviewer'],tools:'read,bash'});d._agents.get('reviewer')!.lastBackend='native';
 Object.assign(d._agents.get('reviewer')!.def, { readOnly: true });
 const session=mkdtempSync(join(tmpdir(),'operator-session-'));t.after(()=>rmSync(session,{recursive:true,force:true}));d.state.getSessionDir=()=>session;
 const {createAssertionsArtifactsContext}=await import('../context/assertions-artifacts.ts');
 d.artifacts.writeRunArtifact=createAssertionsArtifactsContext({getAssertions:()=>[],getSessionDir:()=>session,getRunHistoryKeep:()=>null,setStatus:()=>{}}).writeRunArtifact;
 let state=applyProcessClassification(createProcessState(),{risk:'high',scope:'wide',reason:'fixture'}).state;
 state=noteProcessStage(state,'plan',{evidenceRef:'fixture:plan',revision:worktreeRevision(cwd,[])});
 d.state.getProcessState=()=>state;d.state.setProcessState=(value:any)=>{state=value;};
 const command='node --test candidate.test.js';
 d.state.getAssertions=()=>[{id:'A2',tag:'test',text:'candidate check',source:'fixture',testCommand:command,status:'open'},{id:'A1',tag:'manual',text:'relay recorded',source:'fixture',status:'open'}];
 d.dispatchAgent=async()=>{
  if(scenario==='modified')writeFileSync(join(cwd,'a.ts'),'export const a=2;\n');
  if(scenario==='overlap')d._setOverlap(1);
  // The child observes the basis the Hub passes in AGENT_FLEET_RUNTIME_TEST_SCOPES: the
  // whole repository at a root repository, each touched nested repository otherwise (D8).
  const revision=layout==='nested'?revisionOf(cwd,revisionScopes(cwd,scope)):worktreeRevision(cwd,[]);
  const {validateSpecialistResult}=await import('../specialist-result.ts');
  const submission=validateSpecialistResult({status:['partial','blocked'].includes(scenario)?scenario:'completed',summary:'Read-only current-state fixture',changed_files:[],assertions_proven:[],assertions_unproven:[],assertions_failed:scenario==='assertion-failed'?[{id:'A2',reason:'Unresolved assertion'}]:[],tests_run:['full scoped regression'],open_risks:[],requires_user_decision:scenario==='question'?['Choose behavior']:[],evidence:[]},cwd);
  return {output:scenario==='reject'?'**Verdict:** REJECT':'**Verdict:** APPROVE\ntests_run: full regression',exitCode:0,elapsed:1,dispatchId:'current-state',
   // Production native settlement always publishes parser-owned capture integrity; 'tainted' and 'no-integrity' model a lossy/absent capture.
   ...(scenario==='no-integrity'?{}:{lifecycle:{launched:true,closeSeen:true,runtimeCaptureIntegrity:scenario==='tainted'?'tainted' as const:'complete' as const}}),
   ...(scenario==='legacy'?{}:{specialistResultTool:true,...(scenario==='missing-submission'?{}:{specialistResult:submission})}),
   runtimeTests:scenario==='no-checks'?[]:[{command,exitCode:scenario==='failed'?1:0,beforeRevision:scenario==='stale'?'other':revision,afterRevision:revision}]};
 };
 return {cwd,d,state:()=>state,run:createDispatchExecutor(d as any)};
}

/**
 * Per-assignment fixture (plan task 4): a git workspace with two disjoint source
 * directories, the editor and a read-only reviewer, the Hub's writer registry and
 * instance cloning, and a gated stub run per dispatch that marks its agent running
 * the way the native backend does. Each run settles only when the test releases it.
 */
export function assignmentFixture(t: any) {
 const cwd = mkdtempSync(join(tmpdir(), "parallel-assignments-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 for (const dir of ["src/api", "src/client", "docs"]) mkdirSync(join(cwd, dir), { recursive: true });
 writeFileSync(join(cwd, "src", "api", "index.ts"), "export const api = 1;\n");
 writeFileSync(join(cwd, "src", "client", "index.ts"), "export const client = 1;\n");
 execFileSync("git", ["init", "-q"], { cwd }); execFileSync("git", ["add", "."], { cwd });
 execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd });
 const sessionDir = join(cwd, ".pi", "agent-sessions", "sessions", "test"); mkdirSync(sessionDir, { recursive: true });
 const d = prepareDeps({ agents: ["editor", "reviewer"] }); d.state.getSessionDir = () => sessionDir;
 const agents = d._agents as Map<string, any>;
 Object.assign(agents.get("editor")!, { status: "idle", lastBackend: "native" }); agents.get("editor")!.def.tools = "read,write,edit,bash";
 Object.assign(agents.get("reviewer")!, { status: "idle", lastBackend: "native" }); Object.assign(agents.get("reviewer")!.def, { tools: "read,grep,find,ls,bash", readOnly: true });
 const writers = new Map<number, { agent: string; scope: string[]; isolated: boolean }>(); let sequence = 0;
 const created: string[] = [];
 Object.assign(d.state, {
  getActiveWriters: () => [...writers.values()],
  getWriterGeneration: () => sequence,
  beginWriter: (entry: { agent: string; scope: string[]; isolated: boolean }) => { const id = ++sequence; writers.set(id, entry); return () => { writers.delete(id); }; },
  addAgentInstance: (base: string, instance: string) => {
   const state = agents.get(base); if (!state) return false;
   if (!agents.has(instance)) { agents.set(instance, { ...state, def: { ...state.def, name: instance }, status: "idle", runCount: 0 }); created.push(instance); }
   return true;
  },
 });
 const runs: Array<{ agent: string; task: string; scope: string[]; access: any; settle(exitCode?: number, edit?: string): void }> = [];
 d.dispatchAgent = (async (agent: string, task: string, _ctx: unknown, _artifacts: unknown, scope: string[], _watchdog: unknown, _backend: unknown, _resume: unknown, _contract: unknown, _revision: unknown, access: unknown) => {
  const state = agents.get(agent); state.status = "running";
  let settle!: (value: { exitCode: number; edit?: string }) => void;
  const gate = new Promise<{ exitCode: number; edit?: string }>(resolve => { settle = resolve; });
  const index = runs.push({ agent, task, scope, access, settle: (exitCode = 0, edit) => settle({ exitCode, edit }) });
  const { exitCode, edit } = await gate;
  if (edit) writeFileSync(join(cwd, edit), `// changed by ${agent}\n`);
  state.status = exitCode === 0 ? "done" : "error";
  return { output: exitCode === 0 ? "**Verdict:** APPROVE\ndone" : "failed", exitCode, elapsed: 1, dispatchId: `${agent}-run-${index}`, lifecycle: nativeCleanLifecycle };
 }) as any;
 return { cwd, d, agents, created, runs, writers: () => [...writers.values()], ctx: { cwd } as any };
}

/** Let queued microtasks and immediate callbacks run. */
export const settleTicks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
