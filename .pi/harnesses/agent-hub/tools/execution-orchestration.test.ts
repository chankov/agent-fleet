import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { preflightGate } from "./dispatch-execution.ts";

const tuiPackage = import.meta.resolve("@earendil-works/pi-tui");
registerHooks({ resolve(specifier, context, nextResolve) {
 if (specifier === "@mariozechner/pi-tui") return { url: tuiPackage, shortCircuit: true };
 return nextResolve(specifier, context);
} });
const { createHerdrExecutors } = await import("./herdr-executors.ts");
import { createProcessState } from "../process-obligations.ts";
import { applyTaskTriageAdditions } from "../task-triage-obligations.ts";

function dispatchDeps(overrides: Record<string, unknown> = {}): any {
	const blockers: Array<{ agent: string; what: string }> = [];
	let refused = false;
	return {
		state: {
			getExternalBlockers: () => blockers,
			getExternalBlockerAcknowledged: () => false,
			setExternalBlockerAcknowledged() {},
			getExternalBlockerRefusedOnce: () => refused,
			setExternalBlockerRefusedOnce: (value: boolean) => { refused = value; },
			isAskUserAvailable: () => true,
			getTaskTier: () => null,
		},
		...overrides,
	};
}

test("both Herdr spawn effects refuse an open transition, plan or unsupported confirmation before touching Herdr", async () => {
 const plan = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "task", evaluationId: "eval", inputRevision: "rev" });
 const action = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["irreversible_execution"] }, { taskId: "task", evaluationId: "eval", inputRevision: "rev" });
 for (const [state, block, expected] of [
  [createProcessState(), () => ({ reason: "task_transition_pending", message: "transition" }), "task_transition_pending"],
  [createProcessState(), () => ({ reason: "process_state_corrupt", message: "persistence failed" }), "process_state_corrupt"],
  [plan, () => null, "process_plan_open"],
  [action, () => null, "action_confirmation_unsupported"],
 ] as const) {
  let effects = 0;
  const tools = createHerdrExecutors({
   getProcessState: () => state, processBlock: block, provisionalCapabilityRefusal: () => null,
   isFleetReady: () => true, isComsReady: () => true, getIdentity: () => ({ project: "test" }),
   getCurrentContext: () => null, peersInScope: () => [], getComsPeerNames: () => [],
   herdr: { paneSplit: () => { effects++; throw Error("unexpected effect"); }, paneRead: async () => ({ read: { text: "read-only" } }) },
   readEnvFile: () => "", envFileExists: () => false, getLastPiSpawnAt: () => null,
   setLastPiSpawnAt() {}, recordSpawnedPeer() {},
  } as any);
  for (const name of ["executeHerdrSpawnPeer", "executeHerdrSpawnPane"] as const) {
   const result = await tools[name]("call", { name: "test", command: "echo hi" } as any, new AbortController().signal, () => {}, {} as any);
   assert.equal((result.details as any).reason, expected);
  }
  const read = await tools.executeHerdrReadPane("read", { pane_id: "p1" } as any, new AbortController().signal, () => {}, {} as any);
  assert.match(read.content[0].text, /read-only/);
  assert.equal(effects, 0);
 }
});

test("both Herdr spawn effects execute when the process gate permits them", async () => {
 const prevEnv = process.env.HERDR_ENV, prevPane = process.env.HERDR_PANE_ID;
 process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "hub:p1";
 let splits = 0, launches = 0;
 try {
  const tools = createHerdrExecutors({
   getProcessState: () => createProcessState(), processBlock: () => null,
   provisionalCapabilityRefusal: () => null,
   isFleetReady: () => true, isComsReady: () => true, getIdentity: () => ({ project: "test" }),
   getCurrentContext: () => ({ cwd: process.cwd() }), peersInScope: () => [], getComsPeerNames: () => ["probe-peer"],
   herdr: {
    paneSplit: async () => ({ pane: { pane_id: `hub:p${++splits + 1}` } }),
    paneRename: async () => {},
    paneRead: async () => ({ read: { text: "$ " } }),
    paneSendText: async () => { launches++; }, paneSendKeys: async () => {},
   },
   readEnvFile: () => "", envFileExists: () => false, getLastPiSpawnAt: () => null,
   setLastPiSpawnAt() {}, recordSpawnedPeer() {},
  } as any);
  const signal = new AbortController().signal;
  const pane = await tools.executeHerdrSpawnPane("pane", { name: "probe", command: "echo ready" } as any, signal, () => {}, {} as any);
  assert.equal((pane.details as any).pane_id, "hub:p2");
  const peer = await tools.executeHerdrSpawnPeer("peer", { name: "probe-peer", runner: "pi", no_persona: true } as any, signal, () => {}, {} as any);
  assert.equal((peer.details as any).peer_ready, true, peer.content[0].text);
  assert.equal(splits, 2); assert.equal(launches, 2);
 } finally {
  if (prevEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = prevEnv;
  if (prevPane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = prevPane;
 }
});

test("preflightGate preserves the external-blocker circuit breaker before persona policy", () => {
	const deps = dispatchDeps();
	deps.state.getExternalBlockers().push({ agent: "builder", what: "missing deployment credential" });
	const result = preflightGate(deps, "builder");
	assert.equal(result?.reason, "external_blocked");
	assert.match(result?.message ?? "", /missing deployment credential/);
	assert.equal(deps.state.getExternalBlockerRefusedOnce(), true);
});

test("orchestration routes all executor groups through explicit adapter ports", () => {
	const source = readFileSync(new URL("./execution-orchestration.ts", import.meta.url), "utf8");
	assert.match(source, /export interface DispatchExecutionContext/);
	assert.match(source, /dispatch: DispatchExecutorDeps/);
	assert.match(source, /actions: ActionExecutorDeps/);
	assert.match(source, /herdr: HerdrExecutorDeps/);
	assert.match(source, /createDispatchExecutor\(ctx\.dispatch\)/);
	assert.match(source, /\.\.\.createActionExecutors\(ctx\.actions\)/);
	assert.match(source, /\.\.\.createHerdrExecutors\(ctx\.herdr\)/);
});

test("writable-overlap counters have one composition owner and one executor mutation path", () => {
	const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	const execution = readFileSync(new URL("./dispatch-execution.ts", import.meta.url), "utf8");
	assert.equal((index.match(/let activeWritableDispatches/g) ?? []).length, 1);
	assert.equal((index.match(/let writableOverlapCounter/g) ?? []).length, 1);
	assert.equal((execution.match(/setActiveWritableDispatches/g) ?? []).length >= 2, true);
	assert.doesNotMatch(execution, /let activeWritableDispatches|let writableOverlapCounter/);
});
