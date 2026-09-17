import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createActionExecutors } from "./action-executors.ts";
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
 });
 const actions = createActionExecutors(deps as any);
 await actions.executeSetAssertions("set", { assertions: [{ id: "A1", tag: "test", text: "UTC day", source: "user request", reference: "PLAN.md:42", critical_conditions: ["UTC calendar day"], test_command: "node --test utc.test.js" }] } as any, undefined, undefined, { ui: { notify() {} } } as any);
 await actions.executeUpdateAssertion("update", { id: "A1", status: "proven", evidence: "node --test acceptance.test.ts → 11/11 pass" }, undefined, undefined, {} as any);
 assert.equal(assertions[0].testCommand, "node --test utc.test.js"); assert.equal(assertions[0].source, "user request"); assert.equal(assertions[0].reference, "PLAN.md:42");
 assert.deepEqual(assertions[0].criticalConditions, ["UTC calendar day"]);
 assert.equal(assertions[0].evidenceTaskId, "task-current"); assert.equal(assertions[0].evidenceRevision, "revision-current");
 assert.equal(persisted, 2);
});

test("new-task reset clears prior acceptance assertions with the task window", async () => {
 let assertions: any[] = [{ id: "A1" }], reset = 0, persisted = 0;
 const deps = comsDeps({
  getAssertions: () => assertions, setAssertions: (value: any[]) => { assertions = value; },
  budget: { taskResetSnapshot: () => ({}), resetTaskWindow: () => { reset++; }, appendTaskResetEntry() {}, currentBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), currentTaskBudget: () => ({ maxDispatches: 1, maxResearch: 1 }), updateModeStatus() {} },
  artifacts: { persistAssertions: () => { persisted++; } },
 });
 const result = await createActionExecutors(deps as any).executeSetTaskTier("tier", { tier: "small", new_task: true } as any, undefined, undefined, {} as any);
 assert.match(result.content[0].text, /prior assertion ledger cleared/); assert.deepEqual(assertions, []); assert.equal(reset, 1); assert.equal(persisted, 1); assert.equal((result.details as any).newTask, true);
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
