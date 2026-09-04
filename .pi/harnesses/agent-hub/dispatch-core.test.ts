import assert from "node:assert/strict";
import test from "node:test";
import { createDispatchComs, createDispatchNative, createDispatchObservability, type ComsDispatchState, type DelegationObservableState, type NativeDispatchState } from "./dispatch-core.ts";

function comsDeps(overrides: Record<string, unknown> = {}) {
	let pending: any;
	return {
		getIdentity: () => ({ session_id: "hub" } as any),
		resolveTarget: () => ({ name: "builder", model: "peer-model", context_used_pct: 12 } as any),
		send: async () => {
			pending = {
				promise: Promise.resolve({ response: "peer reply" }),
				timer: null,
				resolve() {},
				reject() {},
				created_at: "now",
			};
			return { msg_id: "m1", target: "builder", target_session: "peer", hops: 0, promise: pending.promise };
		},
		getPendingReply: () => pending,
		deletePendingReply: () => { pending = undefined; },
		getSessionDir: () => "/tmp",
		getWatchdogJudgeModel: () => null,
		getResearcherModel: () => null,
		displayName: (name: string) => name,
		safeAgentKey: (name: string) => name,
		safePathWithin: (root: string, ...parts: string[]) => [root, ...parts].join("/"),
		appendInputArtifacts: (task: string) => task,
		appendDeclaredScope: (task: string) => task,
		buildRulesProtocol: () => "",
		buildDocsProtocol: () => "",
		updateWidget() {},
		spawnPiAgent: async () => ({ output: "", exitCode: 0 }),
		...overrides,
	} as any;
}

const extensionContext = { ui: { notify() {} }, model: null } as any;

test("coms dispatch preserves fallback refusal and successful reply mapping", async () => {
	const missing = createDispatchComs(comsDeps({ getIdentity: () => null, resolveTarget: () => null }));
	const missingState: ComsDispatchState = { def: { name: "builder" }, runCount: 1, contextPct: 0, lastWork: "" };
	assert.equal(await missing.dispatchViaComs(missingState, "task", "builder", 100, true, extensionContext, [], []), null);
	assert.match((await missing.dispatchViaComs(missingState, "task", "builder", 100, false, extensionContext, [], []))!.output, /fallback: none/);

	let deleted = false;
	const connected = createDispatchComs(comsDeps({ deletePendingReply: () => { deleted = true; } }));
	const state: ComsDispatchState = { def: { name: "builder" }, runCount: 2, contextPct: 0, lastWork: "" };
	const result = await connected.dispatchViaComs(state, "task", "builder", 100, false, extensionContext, [], []);
	assert.deepEqual(result, { output: "peer reply", exitCode: 0, elapsed: 0 });
	assert.equal(state.lastBackend, "coms");
	assert.equal(state.comsPeerModel, "peer-model");
	assert.equal(state.contextPct, 12);
	assert.equal(deleted, true);
});

function nativeState(): NativeDispatchState {
	return {
		def: { name: "builder", description: "Build", tools: "read", systemPrompt: "Builder prompt", file: "/agents/builder.md" },
		status: "idle",
		task: "",
		toolCount: 0,
		elapsed: 0,
		lastWork: "",
		contextPct: 0,
		contextTokens: 0,
		sessionFile: null,
		runCount: 0,
		runsSinceFresh: 0,
		timeline: [],
	};
}

function nativeDeps(state: NativeDispatchState, overrides: Record<string, unknown> = {}) {
	const historyEntry: any = { kind: "agent", name: "Builder", startedAt: 1, endedAt: null, status: "running", parent: null };
	return {
		getAgentState: () => state,
		listAgentStates: () => [state],
		getSessionDir: () => "/tmp/agent-hub-native-test",
		getDispatchPolicy: () => ({ default: "native", grace_s: 0, substitutions: {} }),
		isComsReady: () => false,
		getIdentity: () => null,
		peersInScope: () => [],
		wasComsMissNotified: () => false,
		markComsMissNotified() {},
		getMonitorTurnId: () => null,
		startMonitorChild: () => undefined,
		finalizeMonitorChild() {},
		registerMonitorWaitOnly() {},
		registerMonitorProcess() {},
		appendMonitorOutput() {},
		getContextWindow: () => 100_000,
		currentBudget: () => ({ delegation: false, agentTurnMs: null }),
		bumpRecycle() {},
		bumpDriftStop() {},
		getSessionHealthIo: () => ({ existsSync: () => false, readFileSync: () => "", renameSync() {} }),
		getSafetyHarnessPath: () => "/safety.ts",
		getDelegateExtensionPath: () => null,
		getReconSearchTimeoutMs: () => 1000,
		getProjectDocsPaths: () => [],
		getUserLanguage: () => "English",
		getWatchdogSetting: () => "off",
		getWatchdogAgentOverride: () => undefined,
		getWorkMode: () => "operator",
		providerSemaphore: { run: async (_model: string, fn: () => Promise<unknown>) => fn() },
		executionHistory: { start: () => historyEntry, end: (entry: any, status: string) => { entry.status = status; } },
		displayName: (name: string) => name[0].toUpperCase() + name.slice(1),
		shortModel: (model: string) => model.split("/").pop()!,
		resolvedModel: () => "provider/model",
		resolvedThinking: () => "off",
		resolveThinkingLevel: () => "off",
		resolvedSubagentModel: (_persona: string, _role: string, model: string) => model,
		substitutedModel: (model: string | undefined) => model,
		modelWindowLookup: () => () => undefined,
		specialistProjectPolicyPaths: () => [],
		guardrailEnv: () => ({}),
		appendInputArtifacts: (task: string) => task,
		appendDeclaredScope: (task: string) => task,
		flushTimelineStore() {},
		appendTimelineText: (target: any, kind: "text" | "thinking", content: string) => target.timeline.push({ kind, title: kind, content, timestamp: 1 }),
		appendTimelineEvent: (target: any, event: any) => { target.timeline.push(event); return event; },
		createTranscriptStore: () => ({ append() {} }),
		updateWidget() {},
		startDelegationWatch() {},
		dispatchViaComs: async () => null,
		runDriftJudge: async () => null,
		notifyProviderQueue() {},
		spawnPiAgentWithModelFallback: async () => ({ output: "native reply", exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: "provider/model" }),
		...overrides,
	} as any;
}

test("native dispatch factory preserves coms routing and native completion", async () => {
	const comsState = nativeState();
	const coms = createDispatchNative(nativeDeps(comsState, {
		getDispatchPolicy: () => ({ default: "coms", grace_s: 0, substitutions: {} }),
		isComsReady: () => true,
		getIdentity: () => ({}),
		peersInScope: () => [{ name: "builder" }],
		dispatchViaComs: async (state: NativeDispatchState) => {
			state.lastBackend = "coms";
			return { output: "coms reply", exitCode: 0, elapsed: 0 };
		},
	}));
	const comsResult = await coms.dispatchAgent("builder", "task", extensionContext);
	assert.equal(comsResult.output, "coms reply");
	assert.equal(comsState.status, "done");
	assert.equal(comsState.lastBackend, "coms");

	const state = nativeState();
	const native = createDispatchNative(nativeDeps(state));
	const result = await native.dispatchAgent("builder", "task", extensionContext);
	assert.equal(result.output, "native reply");
	assert.equal(result.exitCode, 0);
	assert.equal(state.status, "done");
	assert.equal(state.lastBackend, "native");
	assert.equal(state.sessionFile, "/tmp/agent-hub-native-test/builder.json");
});

test("delegation observability preserves nesting, usage, timeline, and exit history", () => {
	let delegatedTokens = 0;
	const historyEnds: Array<{ status: string; endedAt: number }> = [];
	const state: DelegationObservableState = {
		def: { name: "builder" },
		delegations: new Map(),
		histEntry: { kind: "agent", name: "Builder", startedAt: 1, endedAt: null, status: "running", parent: null },
	};
	const observability = createDispatchObservability({
		getSessionDir: () => "/session",
		getDelegatedTokens: () => delegatedTokens,
		setDelegatedTokens: value => { delegatedTokens = value; },
		getWidgetContext: () => null,
		executionHistory: {
			start: (_kind, name, options) => ({ kind: "delegate", name, startedAt: options?.startedAt ?? 0, endedAt: null, status: "running", parent: options?.parent ?? null }),
			end: (_entry, status, endedAt) => { historyEnds.push({ status, endedAt: endedAt ?? 0 }); },
		},
		displayName: name => name.toUpperCase(),
		safeAgentKey: name => name,
		safePathWithin: (root, ...parts) => [root, ...parts].join("/"),
		createTranscriptStore: () => ({ append() {} } as any),
		appendTimelineText: (target, kind, delta) => { target.timeline.push({ kind, title: kind, content: delta, timestamp: 1 }); },
		appendTimelineEvent: (target, event) => { target.timeline.push(event); return event; },
		updateWidget() {},
	});

	observability.handleDelegationEvent(state, { t: "spawn", id: "quality-1", role: "verifier", model: "model", ts: 10 });
	observability.handleDelegationEvent(state, { t: "timeline", id: "quality-1", kind: "text", delta: "working" });
	observability.handleDelegationEvent(state, { t: "usage", id: "quality-1", input: 7, output: 3 });
	observability.handleDelegationEvent(state, { t: "exit", id: "quality-1", code: 0, elapsed: 25 });

	const child = state.delegations!.get("quality-1")!;
	assert.equal(child.parent, "root");
	assert.equal(child.histEntry?.parent, state.histEntry);
	assert.equal(child.lastWork, "working");
	assert.equal(child.tokens, 10);
	assert.equal(delegatedTokens, 10);
	assert.equal(child.status, "done");
	assert.deepEqual(historyEnds, [{ status: "done", endedAt: 35 }]);
});

test('complete profile routes to native despite live coms peer and resolves both auxiliary jobs locally',async()=>{
 const {setActiveProfile,PROFILE_ENV}=await import('./policy/profile-runtime.ts');
 const previous=process.env[PROFILE_ENV];
 setActiveProfile({name:'local',profile:{version:2,defaults:{model:'omlx/laguna',thinking:'off'},routing:'native',fallback:'none',services:{'return-extractor':{model:'omlx/qwen'}},'allowed-models':['omlx/laguna','omlx/qwen']}});
 try {
  let peers=0,spawns=0;const state=nativeState();
  const native=createDispatchNative(nativeDeps(state,{getDispatchPolicy:()=>({default:'coms',grace_s:0,substitutions:{}}),isComsReady:()=>true,getIdentity:()=>({}),peersInScope:()=>[{name:'builder'}],resolvedModel:()=> 'omlx/laguna',dispatchViaComs:async()=>{peers++;return null;},spawnPiAgentWithModelFallback:async(o:any,fallback:any)=>{spawns++;assert.equal(o.model,'omlx/laguna');assert.equal(fallback,undefined);return {output:'local',exitCode:0,stderr:''};}}));
  assert.equal((await native.dispatchAgent('builder','task',extensionContext)).exitCode,0);
  assert.equal(peers,0);assert.equal(spawns,1);
  const refused=await native.dispatchAgent('builder','task',extensionContext,[],[],undefined,'coms');
  assert.match(refused.output,/requires native/);assert.equal(spawns,1);assert.equal(peers,0);
  const models:string[]=[];
  const auxiliary=createDispatchComs(comsDeps({getWatchdogJudgeModel:()=> 'cloud/judge',spawnPiAgent:async(o:any)=>{models.push(o.model);assert.equal(o.thinking,'off');return {output:'',exitCode:0};}}));
  await auxiliary.runDriftJudge({agentLabel:'builder',agentKey:'builder',task:'test',scopeGlobs:[],hubOwnedGlobs:[],trail:[],violation:{rule:'test',detail:'test'}},extensionContext);
  await auxiliary.runReturnExtraction('/tmp/profile-report.md',[]);
  assert.deepEqual(models,['omlx/laguna','omlx/qwen']);
 }finally{if(previous===undefined)delete process.env[PROFILE_ENV];else process.env[PROFILE_ENV]=previous;}
});

test('local-duo serializes every declared child locally without project overrides or cloud fallback',async()=>{
 const {readFileSync}=await import('node:fs');
 const {scanAgentDirs,parseModelProfilesYaml}=await import('./config/agents.ts');
 const {createModelPolicy}=await import('./policy/models.ts');
 const {setActiveProfile,PROFILE_ENV}=await import('./policy/profile-runtime.ts');
 const defs=scanAgentDirs(process.cwd());const profile=parseModelProfilesYaml(readFileSync('.pi/agents/model-profiles.yaml','utf8'))['local-duo'] as any;
 const policy=createModelPolicy({getAllDefs:()=>defs,getActiveDef:n=>defs.find(d=>d.name===n),getResearchDefs:()=>[],refreshUi(){}});
 policy.applyProfile(profile);
 const previous=process.env[PROFILE_ENV];setActiveProfile({name:'local-duo',profile});
 let roles=0;
 try{
  for(const def of defs.filter(d=>d.subagents)){
   const state=nativeState();state.def=def;
   const run=createDispatchNative(nativeDeps(state,{resolvedModel:policy.resolvedModel,resolvedThinking:policy.resolvedThinking,resolvedSubagentModel:policy.resolvedSubagentModel,currentBudget:()=>({delegation:true,agentTurnMs:null}),getDelegateExtensionPath:()=> '/tmp/delegate.ts',spawnPiAgentWithModelFallback:async(opts:any,fallback:any)=>{
    assert.ok(profile['allowed-models'].includes(opts.model));assert.equal(fallback,undefined);
    const config=JSON.parse(opts.env.AGENT_HUB_DELEGATE_CONFIG);
    for(const entry of Object.values(config.roles) as any[]){roles++;assert.ok(profile['allowed-models'].includes(entry.model));assert.equal(entry.thinking,'off');assert.equal(entry.fallbackModel,undefined);}
    return {output:'local children configured',exitCode:0,stderr:''};
   }}));
   assert.equal((await run.dispatchAgent(def.name,'task',extensionContext)).exitCode,0);
  }
  assert.equal(roles,18);
 }finally{if(previous===undefined)delete process.env[PROFILE_ENV];else process.env[PROFILE_ENV]=previous;}
});
