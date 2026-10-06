import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createActionExecutors } from "./action-executors.ts";
import { applyProcessClassification, createProcessState } from "../process-obligations.ts";
import { applyTaskTriageAdditions } from "../task-triage-obligations.ts";
import { PROFILE_ENV, setActiveProfile } from "../policy/profile-runtime.ts";

const allowProfile: any = {
	version: 2,
	defaults: { model: "omlx/laguna", thinking: "off" },
	fallback: "none",
	routing: "native",
	"allowed-models": ["omlx/laguna", "omlx/qwen"],
};

function withProfile(profile: any | undefined, name: string, run: () => Promise<void>) {
	const previous = process.env[PROFILE_ENV];
	setActiveProfile(profile ? { name, profile } : undefined);
	return run().finally(() => {
		if (previous === undefined) delete process.env[PROFILE_ENV];
		else process.env[PROFILE_ENV] = previous;
	});
}

function comsDeps(overrides: Record<string, unknown> = {}) {
	let sent = 0;
	return {
		sent: () => sent,
		budget: {},
		artifacts: {},
		hubState: { getPendingHandoff: () => null, setPendingHandoff() {} },
		provisionalCapabilityRefusal: () => null,
		getTaskTier: () => "feature",
		setTaskTier() {},
		getTaskTierAssumed: () => false,
		setTaskTierAssumed() {},
		getTaskDispatchCount: () => 0,
		getTaskResearchCount: () => 0,
		getTurnReport: () => ({}),
		getAssertions: () => [],
		setAssertions() {},
		currentTaskId: () => "task-1",
		currentRevision: () => "rev-1",
		getAgentStates: () => new Map(),
		rosterAdd: () => ({ ok: true, message: "ok" }),
		rosterDrop: () => ({ ok: true, message: "ok" }),
		getIdentity: () => ({}),
		getComs: () => ({
			send: async ({ target }: { target: string }) => {
				sent++;
				return { msg_id: "m1", target, target_session: "s1", hops: 0 };
			},
		}),
		resolveTarget: (target: string) => ({ name: target, model: "omlx/qwen" }),
		appendMachineHandoffSections: (brief: string) => brief,
		markPeerAddressed() {},
		...overrides,
	};
}

test("coms_send refuses process transitions, open plans and unbound action confirmation before sending", async () => {
 await withProfile(allowProfile, "local-duo", async () => {
  const plan = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "task-1", evaluationId: "eval", inputRevision: "rev" });
  const action = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["irreversible_execution"] }, { taskId: "task-1", evaluationId: "eval", inputRevision: "rev" });
  for (const [depsOverride, reason] of [
   [{ processBlock: () => ({ reason: "task_transition_pending", message: "transition" }) }, "task_transition_pending"],
   [{ processBlock: () => ({ reason: "process_state_corrupt", message: "persistence failed" }) }, "process_state_corrupt"],
   [{ getProcessState: () => plan }, "process_plan_open"],
   [{ getProcessState: () => action }, "action_confirmation_unsupported"],
  ] as const) {
   const deps = comsDeps(depsOverride);
   const result = await createActionExecutors(deps as any).executeComsSend("1", { target: "test", prompt: "run migration" } as any, new AbortController().signal, () => {}, {} as any);
   assert.equal((result.details as any).reason, reason); assert.equal(deps.sent(), 0);
  }
 });
});

test("coms read operations remain available while effects are process-blocked", async () => {
 let reads = 0;
 const deps = comsDeps({
  processBlock: () => ({ reason: "task_transition_pending", message: "transition" }),
  getComs: () => ({
   scope: { includeExplicit: false },
   list: async () => { reads++; return { project: "test", agents: [], widenRequested: false }; },
   get: () => { reads++; return { status: "pending" }; },
   await: async () => { reads++; return { status: "complete", response: "ok" }; },
  }),
 });
 const tools = createActionExecutors(deps as any);
 assert.equal((await tools.executeComsList("list", {} as any, undefined, undefined, {} as any)).details?.project, "test");
 assert.match((await tools.executeComsGet("get", { msg_id: "m1" }, undefined, undefined, {} as any)).content[0].text, /pending/);
 assert.match((await tools.executeComsAwait("await", { msg_id: "m1" }, undefined, undefined, {} as any)).content[0].text, /ok/);
 assert.equal(reads, 3);
});

test("coms_send allows allowlisted peer model and refuses a foreign model without the blanket native text", async () => {
	await withProfile(allowProfile, "local-duo", async () => {
		const allowedDeps = comsDeps();
		const allowed = createActionExecutors(allowedDeps as any);
		const ok = await allowed.executeComsSend("1", { target: "test", prompt: "joke" } as any, new AbortController().signal, () => {}, {} as any);
		assert.match(ok.content[0].text, /coms_send → test/);
		assert.equal(allowedDeps.sent(), 1);

		const foreignDeps = comsDeps({ resolveTarget: () => ({ name: "claude", model: "anthropic/claude-opus-4-7" }) });
		const foreign = await createActionExecutors(foreignDeps as any).executeComsSend("1", { target: "claude", prompt: "joke" } as any, new AbortController().signal, () => {}, {} as any);
		assert.match(foreign.content[0].text, /refuses peer model "anthropic\/claude-opus-4-7"/);
		assert.doesNotMatch(foreign.content[0].text, /peer execution is disabled/);
		assert.equal(foreignDeps.sent(), 0);
		assert.equal((foreign as any).details.error, "model-profile-allowlist");
	});
});

test("coms_send without allowlist still uses the blanket native ban", async () => {
	const blanket: any = { version: 2, defaults: { model: "omlx/laguna", thinking: "off" }, fallback: "none", routing: "native" };
	await withProfile(blanket, "native-only", async () => {
		const deps = comsDeps();
		const result = await createActionExecutors(deps as any).executeComsSend("1", { target: "test", prompt: "joke" } as any, new AbortController().signal, () => {}, {} as any);
		assert.match(result.content[0].text, /peer execution is disabled/);
		assert.equal(deps.sent(), 0);
	});
});

test("coms_send with allowlist and missing target does not use the profile gate", async () => {
	await withProfile(allowProfile, "local-duo", async () => {
		let sendCalls = 0;
		const deps = comsDeps({
			resolveTarget: () => null,
			getComs: () => ({
				send: async () => {
					sendCalls++;
					throw new Error('Peer "ghost" not found in project "default". Live peers: (none)');
				},
			}),
		});
		await assert.rejects(
			() => createActionExecutors(deps as any).executeComsSend("1", { target: "ghost", prompt: "hi" } as any, new AbortController().signal, () => {}, {} as any),
			/not found/,
		);
		assert.equal(sendCalls, 1);
	});
});

test("assertion source, critical conditions, and current task revision bind through persistence", async () => {
 let assertions: any[] = [], persisted = 0;
 const deps = comsDeps({
  getAssertions: () => assertions, setAssertions: (value: any[]) => { assertions = value; },
  artifacts: { persistAssertions: () => { persisted++; }, updateAssertionStatus() {}, evidencePathExists: () => false, artifactsRoot: () => "/tmp/artifacts" },
  currentTaskId: () => "task-current", currentRevision: () => "revision-current",
  getProcessState: () => applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "fixture" }).state,
 });
 const actions = createActionExecutors(deps as any);
 await actions.executeSetAssertions("set", { assertions: [{ id: "A1", tag: "test", text: "UTC day", source: "user request", reference: "PLAN.md:42", critical_conditions: ["UTC calendar day"], test_command: "node --test utc.test.js" }] } as any, undefined, undefined, { ui: { notify() {} } } as any);
 await actions.executeUpdateAssertion("update", { id: "A1", status: "proven", evidence: "node --test acceptance.test.ts → 11/11 pass" }, undefined, undefined, {} as any);
 assert.equal(assertions[0].testCommand, "node --test utc.test.js"); assert.equal(assertions[0].source, "user request"); assert.equal(assertions[0].reference, "PLAN.md:42");
 assert.deepEqual(assertions[0].criticalConditions, ["UTC calendar day"]);
 assert.equal(assertions[0].evidenceTaskId, "task-current"); assert.equal(assertions[0].evidenceRevision, "revision-current");
 assert.equal(persisted, 2);
});

test("update_assertion cannot prove while risk or review obligations remain open", async () => {
 let assertions: any[] = [{ id: "A1", tag: "test", text: "gate", source: "user", status: "open" }];
 const deps = comsDeps({ getAssertions: () => assertions, setAssertions: (v: any[]) => { assertions = v; }, getProcessState: () => createProcessState(), artifacts: { persistAssertions() {}, updateAssertionStatus() {}, evidencePathExists: () => false, artifactsRoot: () => "/tmp/artifacts" } });
 const result = await createActionExecutors(deps as any).executeUpdateAssertion("u", { id: "A1", status: "proven", evidence: "test passed" } as any, undefined, undefined, {} as any);
 assert.equal((result.details as any).reason, "process_obligations_open"); assert.equal(assertions[0].status, "open");
});

test("set_task_tier requires explicit reasoned risk changes and persists process state independently of tier", async () => {
 let process: any = null; const persisted: any[] = [];
 const deps = comsDeps({
  getProcessState: () => process, setProcessState: (value: any) => { process = value; },
  persistProcessState: (value: any) => { persisted.push(value); },
  budget: { currentBudget: () => ({ maxDispatches: 2, maxResearch: 2 }), currentTaskBudget: () => ({ maxDispatches: 6, maxResearch: 6 }), updateModeStatus() {} },
 });
 const execute = createActionExecutors(deps as any).executeSetTaskTier;
 const missing = await execute("tier", { tier: "small", risk: "low", scope: "small" } as any, undefined, undefined, {} as any);
 assert.equal((missing.details as any).status, "error"); assert.match(missing.content[0].text, /reason/i);
 const set = await execute("tier", { tier: "small", risk: "high", scope: "small", reason: "security-sensitive change" } as any, undefined, undefined, {} as any);
 assert.equal((set.details as any).risk, "high"); assert.equal(process.review.required, true); assert.equal(persisted.length, 1);
 const lowerTier = await execute("tier", { tier: "trivial" } as any, undefined, undefined, {} as any);
 assert.equal((lowerTier.details as any).tier, "trivial"); assert.equal(process.review.required, true, "budget lowering cannot erase review");
});

test("S1 confirmation addition survives tier downgrade and requires human supersession before new-task reset", async () => {
 let process: any = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["irreversible_execution"] }, { taskId: "task-old", evaluationId: "eval", inputRevision: "input" });
 let resets = 0, approvals = 0;
 const deps = comsDeps({
  getProcessState: () => process, setProcessState: (s: any) => { process = s; }, persistProcessState() {},
  confirmTaskSupersession: async () => { approvals++; return false; },
  budget: { taskResetSnapshot: () => ({}), resetTaskWindow: () => { resets++; }, appendTaskResetEntry() {}, currentBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), currentTaskBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), updateModeStatus() {} },
 });
 const run = createActionExecutors(deps as any).executeSetTaskTier;
 const lower = await run("lower", { tier: "trivial" } as any, undefined, undefined, {} as any);
 assert.equal((lower.details as any).tier, "trivial"); assert.equal(process.additions.length, 1);
 const denied = await run("new", { tier: "small", reason: "different task", new_task: true } as any, undefined, undefined, {} as any);
 assert.equal((denied.details as any).reason, "task_supersession_not_authorized"); assert.equal(approvals, 1); assert.equal(resets, 0); assert.equal(process.additions.length, 1);
});

test("new-task reset clears prior acceptance assertions with the task window", async () => {
 let assertions: any[] = [{ id: "A1" }], reset = 0, persisted = 0;
 const deps = comsDeps({
  getAssertions: () => assertions, setAssertions: (value: any[]) => { assertions = value; },
  budget: { taskResetSnapshot: () => ({}), resetTaskWindow: () => { reset++; }, appendTaskResetEntry() {}, currentBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), currentTaskBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), updateModeStatus() {} },
  artifacts: { persistAssertions: () => { persisted++; } },
  confirmTaskSupersession: async () => true,
 });
 const result = await createActionExecutors(deps as any).executeSetTaskTier("tier", { tier: "small", new_task: true, reason: "different user task" } as any, undefined, undefined, {} as any);
 assert.match(result.content[0].text, /prior assertion ledger cleared/); assert.deepEqual(assertions, []); assert.equal(reset, 1); assert.equal(persisted, 1); assert.equal((result.details as any).newTask, true);
 assert.equal((result.details as any).risk, "unknown", "legacy new task defaults to unknown, never false low");
});

test("new task with open obligations fails closed without one-use operator grant", async () => {
 const actions = createActionExecutors(comsDeps({ budget: { currentBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), currentTaskBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), updateModeStatus() {} } }) as any);
 const result = await actions.executeSetTaskTier("n", { tier: "small", new_task: true, reason: "different work" } as any, undefined, undefined, {} as any);
 assert.equal((result.details as any).reason, "task_supersession_not_authorized");
});

test("new-task consumer passes exact old and reserved future ids then uses that id only for the successful reset", async () => {
 let process: any = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "bound" }).state;
 let granted: any = null; let reset = 0; let adopted: string | undefined;
 const deps = comsDeps({
  currentTaskId: () => "task-old",
  getProcessState: () => process, setProcessState: (value: any) => { process = value; }, persistProcessState() {},
  budget: { taskResetSnapshot: () => ({}), resetTaskWindow: () => { reset++; }, appendTaskResetEntry() {}, currentBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), currentTaskBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), updateModeStatus() {} },
  artifacts: { persistAssertions() {} },
  confirmTaskSupersession: async (input: any) => { granted = input; return true; },
  adoptReservedTaskId: (id: string, resetTask: () => void) => { adopted = id; resetTask(); },
 });
 const result = await createActionExecutors(deps as any).executeSetTaskTier("n", { tier: "small", new_task: true, reason: "different work" } as any, undefined, undefined, {} as any);
 assert.equal(granted.oldTaskId, "task-old");
 assert.equal(granted.reason, "different work");
 assert.match(granted.newTaskId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
 assert.doesNotMatch(granted.newTaskId, /^pending:/);
 assert.equal(adopted, granted.newTaskId);
 assert.equal((result.details as any).newTaskId, granted.newTaskId);
 assert.equal(reset, 1); assert.equal((result.details as any).newTask, true); assert.equal(process.risk, "unknown");
});

test("new-task adoption retains pending assessment at the reserved identity and refuses failed binding", async () => {
 for (const fails of [false, true]) {
  let process: any = createProcessState(), adopted = "", resets = 0;
  const deps = comsDeps({
   getProcessState: () => process, setProcessState: (value: any) => { process = value; }, persistProcessState() {},
   confirmTaskSupersession: async () => true,
   adoptTaskTriage: async (id: string, newTask: boolean) => {
    assert.equal(newTask, true); adopted = id;
    if (fails) throw new Error("persistence failed");
    return applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["security_change"] }, { taskId: id, evaluationId: "eval", inputRevision: "revision" });
   },
   budget: { taskResetSnapshot: () => ({}), resetTaskWindow: () => { resets++; }, appendTaskResetEntry() {}, currentBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), currentTaskBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), updateModeStatus() {} },
   artifacts: { persistAssertions() {} },
   adoptReservedTaskId: (_id: string, reset: () => void) => reset(),
  });
  const result = await createActionExecutors(deps as any).executeSetTaskTier("new", { tier: "small", new_task: true, reason: "different task" } as any, undefined, undefined, {} as any);
  assert.ok(adopted);
  assert.equal(resets, fails ? 0 : 1);
  assert.equal(process.additions?.length ?? 0, fails ? 0 : 1);
  if (fails) assert.equal((result.details as any).reason, "task_triage_persistence");
  else {
   assert.equal(process.additions[0].taskId, adopted);
   assert.deepEqual((result.details as any).process, process, "tool result exposes the adopted process state, not the pre-adoption classification");
  }
 }
});

test("invalid new-task inputs never ask, consume, arm, reset, or mutate the old task", async () => {
 for (const params of [
  { tier: "invalid", risk: "low", scope: "small", reason: "different work" },
  { tier: "small", risk: "medium", scope: "small", reason: "different work" },
  { tier: "small", risk: "low", scope: "small", reason: "" },
 ]) {
  const original = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "bound" }).state;
  let process: any = original, confirms = 0, resets = 0, armed = 0;
  const deps = comsDeps({
   getProcessState: () => process, setProcessState: (value: any) => { process = value; }, persistProcessState() {},
   budget: { taskResetSnapshot: () => ({}), resetTaskWindow: () => { resets++; }, appendTaskResetEntry() {}, currentBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), currentTaskBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), updateModeStatus() {} },
   confirmTaskSupersession: async () => { confirms++; return true; },
   adoptReservedTaskId: (_id: string, resetTask: () => void) => { armed++; resetTask(); },
  });
  const result = await createActionExecutors(deps as any).executeSetTaskTier("n", { ...params, new_task: true } as any, undefined, undefined, {} as any);
  assert.equal((result.details as any).status, "error");
  assert.equal(confirms, 0); assert.equal(armed, 0); assert.equal(resets, 0); assert.equal(process, original);
 }
});

test("cancelled or exceptional supersession cannot arm a later unrelated reset", async () => {
 for (const [throws, confirmTaskSupersession] of [
  [false, async () => false],
  [true, async () => { throw new Error("ask failed"); }],
 ] as const) {
  const original = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "bound" }).state;
  let process: any = original, adopted: string | undefined, resets = 0;
  const deps = comsDeps({
   getProcessState: () => process, setProcessState: (value: any) => { process = value; }, persistProcessState() {},
   budget: { resetTaskWindow: () => { resets++; }, currentBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), currentTaskBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), updateModeStatus() {} },
   confirmTaskSupersession,
   adoptReservedTaskId: (id: string, resetTask: () => void) => { adopted = id; resetTask(); },
  });
  const call = () => createActionExecutors(deps as any).executeSetTaskTier("n", { tier: "small", risk: "low", scope: "small", new_task: true, reason: "different work" } as any, undefined, undefined, {} as any);
  if (throws) await assert.rejects(call, /ask failed/);
  else assert.equal(((await call()).details as any).reason, "task_supersession_not_authorized");
  assert.equal(adopted, undefined); assert.equal(resets, 0); assert.equal(process, original);
 }
});

test("denied supersession leaves original task and open obligations intact", async () => {
 let process: any = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "bound" }).state;
 let reset = 0; let adopted: string | undefined;
 const deps = comsDeps({
  currentTaskId: () => "task-old",
  getProcessState: () => process, setProcessState: (value: any) => { process = value; }, persistProcessState() {},
  budget: { resetTaskWindow: () => { reset++; }, currentBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), currentTaskBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), updateModeStatus() {} },
  confirmTaskSupersession: async () => false,
  adoptReservedTaskId: (id: string) => { adopted = id; },
 });
 const result = await createActionExecutors(deps as any).executeSetTaskTier("n", { tier: "small", new_task: true, reason: "different work" } as any, undefined, undefined, {} as any);
 assert.equal((result.details as any).reason, "task_supersession_not_authorized");
 assert.equal(reset, 0); assert.equal(adopted, undefined); assert.equal(process.review.required, true);
});

test("index set_task_tier registration uses the scoped reserved-identity reset", () => {
	const hub = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../index.ts"), "utf8");
	assert.match(hub, /createReservedTaskIdentityReset\(budgetRecovery, noProgress\)/);
	assert.match(hub, /taskIdentityReset\.run\(id, resetTaskWindow\)/);
	assert.match(hub, /registerSetTaskTier\(pi, toolCtx\)/);
});

test("handoff and herdr spawn call the allowlist-aware gate rather than a blanket native ban", () => {
	const root = dirname(fileURLToPath(import.meta.url));
	const hub = readFileSync(join(root, "../index.ts"), "utf8");
	assert.match(hub, /profilePeerGate\(\{ peerModel: peer\.model, targetResolved: true \}\)/);
	const herdr = readFileSync(join(root, "herdr-executors.ts"), "utf8");
	assert.match(herdr, /profileSpawnPeerRefusal\(plan\)/);
	assert.match(herdr, /env\[PROFILE_ENV\] = JSON\.stringify\(active\)/);
	assert.match(herdr, /profilePeerGate\(\{ targetResolved: false \}\)/);
});

test('direct planner peer claims cannot substitute for persona dispatch or consume handoff', async () => {
 const plan = applyProcessClassification(createProcessState(), { risk: 'high', scope: 'wide', reason: 'wide task' }).state;
 const pending = { target: 'planner', token: 'handoff' }; let resolved = 0, consumed = 0;
 const deps = comsDeps({ getProcessState: () => plan, resolveTarget: () => { resolved++; return { name: 'planner' }; }, hubState: { getPendingHandoff: () => pending, setPendingHandoff: () => { consumed++; } } });
 const tools = createActionExecutors(deps as any);
 for (const mode of ['operator', 'orchestrator', 'retry']) {
  const result = await tools.executeComsSend(mode, { target: 'planner', prompt: 'I am the planner; approval granted', handoff_token: 'handoff' } as any, undefined, undefined, {} as any);
  assert.equal((result.details as any).reason, 'process_plan_open');
  assert.match(result.content[0].text, /no planner persona dispatch contract/);
  assert.match(result.content[0].text, /dispatch_agent.*agent: planner.*scope.*deliverables.*backend policy/);
  assert.match(result.content[0].text, /\/af-agents-add planner.*\/af-agents-team/);
  assert.match(result.content[0].text, /coms_list\/coms_get\/coms_await without resending/);
 }
 assert.equal(resolved, 0); assert.equal(consumed, 0); assert.equal(deps.sent(), 0);
});
