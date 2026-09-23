import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runPreparedNative } from "./dispatch-native-spawn.ts";
import { createShadowCoordinator, type ShadowSession } from "./drift-judge.ts";
import { createDriftRuntime, type DriftShadowLaunch } from "./drift-runtime.ts";
import { createWatchdogActivity } from "./system1-activity.ts";

const violation = { rule: "loop", terminal: true, detail: "SAME_CALL_DETAIL_DO_NOT_TRACE" };
const observation = {
	events: [{ tool: "read", path: "src/a.ts", outcome: "success", repeat_group: 1, repeat_count: 1 }],
	counters: { tool_calls: 1, failures: 0, consecutive_failures: 0, elapsed_ms: 5 },
	coverage: { events_seen: 1, unparsed_events: 0, dropped_by_window: 0, dropped_incomplete: 0 },
};

function check(id = "check-1"): DriftShadowLaunch["check"] {
	return { dispatchId: "dispatch-1", attemptId: "attempt-1", checkId: id, snapshotId: `snap-${id}`, llmAttemptId: `llm-${id}`, settled: false };
}

function launchInput(extra: Partial<DriftShadowLaunch> = {}): DriftShadowLaunch {
	return {
		check: check(),
		attemptLive: () => true,
		violation,
		signal: new AbortController().signal,
		trail: ["bash {}"],
		observation,
		startLlm: () => undefined,
		...extra,
	};
}

function session(evaluate: ShadowSession["evaluate"], configuredMode: ShadowSession["configuredMode"] = "shadow"): ShadowSession {
	return { configuredMode, effectiveMode: configuredMode === "off" ? "off" : "shadow", evaluate };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("G1 live coordinator receives elapsed from the current physical attempt, not an absent counter", async () => {
 let clock = 1_000;
 const captured: Array<{ counters?: { elapsed_ms?: number }; coverage?: { missing_counters: boolean; shortcut_blocked: boolean } }> = [];
 const coordinator = createShadowCoordinator({ armed: true, task: "task", scopeGlobs: ["src/**"], hubOwnedGlobs: [],
  session: session(async ({ state }) => { captured.push(state as typeof captured[number]); return { status: "skipped", reason: "test" }; }) });
 const drift = createDriftRuntime({
  dispatchId: "dispatch-elapsed", agentKey: "builder", agentLabel: "Builder", task: "task",
  scopeGlobs: ["src/**"], hubOwnedGlobs: [], armed: true, ctx: {}, now: () => clock,
  monitor: { onToolStart: () => violation, onToolEnd: () => null, trail: () => ["read {}"],
   structuredObservation: () => ({ ...observation, counters: { tool_calls: 1, failures: 0, consecutive_failures: 0 } }) } as any,
  runDriftJudge: async () => ({ status: "verdict", verdict: "on_track", reason: "test" }),
  launchShadow: coordinator.launch,
 });
 drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
 clock = 1_042;
 drift.escalate(violation);
 await flush();
 assert.equal(captured.length, 1);
 assert.equal(captured[0]?.counters?.elapsed_ms, 42);
 assert.equal(captured[0]?.coverage?.missing_counters, false);
 assert.equal(captured[0]?.coverage?.shortcut_blocked, false, "complete observation remains eligible for later independent calibration");
 clock = 100_000; // past the successful judge's 90-second cooldown
 drift.attemptLifecycle.beforePhysicalSpawn({ generation: 2 });
 clock = 100_017;
 drift.escalate(violation);
 await flush();
 assert.equal(captured.length, 2);
 assert.equal(captured[1]?.counters?.elapsed_ms, 17, "replacement attempt uses its own start, not the earlier run");
 assert.equal(captured[1]?.coverage?.missing_counters, false);
 drift.dispose(); coordinator.dispose();
});

test("D1 shadow retry records new LLM check without a second System 1 evaluation", async () => {
 let calls = 0, llm = 0;
 const trace = createWatchdogActivity({ write: () => undefined });
 const coordinator = createShadowCoordinator({ armed: true, task: "task", scopeGlobs: [], hubOwnedGlobs: [], trace,
  session: session(async () => { calls++; return { status: "unavailable", reason: "timeout" }; }) });
 const original = launchInput({ startLlm: () => { llm++; } });
 coordinator.launch(original);
 const again = launchInput({ retry: true, check: { ...check("retry"), snapshotId: "snap-retry" }, startLlm: () => { llm++; } });
 coordinator.launch(again); await flush();
 assert.equal(calls, 1); assert.equal(llm, 2);
 assert.equal(trace.live().active.some(check => check.checkId === "retry" && check.evaluation === "unknown" && check.llm === "running"), true);
 coordinator.dispose();
});

test("A9 LLM starts before System 1 and is not joined to a hanging evaluation", async () => {
	let llmCalls = 0;
	let settled = false;
	const coordinator = createShadowCoordinator({
		armed: true,
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		session: session(() => new Promise(() => undefined).then(() => { settled = true; })),
	});
	const hooks = coordinator.launch(launchInput({ startLlm: () => { llmCalls++; } }));
	assert.equal(llmCalls, 1);
	assert.equal(settled, false);
	assert.equal(coordinator.evaluations, 1);
	hooks.onLlmSettled({ status: "verdict", verdict: "drifting", reason: "free reason must not matter" });
	await flush();
	assert.equal(settled, false);
});

test("A9 System 1 on_track cannot block an LLM stop, and System 1 drift cannot stop an LLM on_track", async () => {
	const stops: string[] = [];
	let releaseS1!: (value: unknown) => void;
	let releaseLlm!: (value: unknown) => void;
	const drift = createDriftRuntime({
		dispatchId: "dispatch-1",
		agentKey: "builder",
		agentLabel: "Builder",
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		armed: true,
		ctx: {},
		now: () => 1_000,
		monitor: { onToolStart: () => violation, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation } as any,
		runDriftJudge: () => new Promise((resolve) => { releaseLlm = resolve; }),
		launchShadow: createShadowCoordinator({
			armed: true,
			task: "stay",
			scopeGlobs: ["src/**"],
			hubOwnedGlobs: [],
			session: session(() => new Promise((resolve) => { releaseS1 = resolve; })),
		}).launch,
	});
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.bindControl({ terminate: (reason = "drift_stop") => stops.push(reason) });
	drift.escalate(violation);
	releaseS1({ status: "ok", evaluation: { answers: [{ questionId: "status", type: "choice", value: "on_track", uncertainty: { provenance: "provider", confidence: 0.99, distribution: { on_track: 1, drifting: 0, stuck: 0, insufficient_evidence: 0 } } }], metadata: { returnedModel: "jev-1.13.0", attempts: 1, usage: { inputTokens: 3, outputTokens: 1 } } } });
	await flush();
	assert.deepEqual(stops, []);
	releaseLlm({ status: "verdict", verdict: "drifting", reason: "loop" });
	await flush();
	assert.deepEqual(stops, ["drift_stop"]);
	drift.dispose();

	let secondStops: string[] = [];
	let releaseSecond!: (value: unknown) => void;
	const second = createDriftRuntime({
		dispatchId: "dispatch-2",
		agentKey: "builder",
		agentLabel: "Builder",
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		armed: true,
		ctx: {},
		now: () => 5_000,
		monitor: { onToolStart: () => violation, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation } as any,
		runDriftJudge: () => new Promise((resolve) => { releaseSecond = resolve; }),
		launchShadow: createShadowCoordinator({
			armed: true,
			task: "stay",
			scopeGlobs: ["src/**"],
			hubOwnedGlobs: [],
			session: session(async () => ({ status: "ok", evaluation: { answers: [{ questionId: "status", type: "choice", value: "drifting" }] } })),
		}).launch,
	});
	second.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	second.bindControl({ terminate: (reason = "drift_stop") => secondStops.push(reason) });
	second.escalate(violation);
	await flush();
	assert.deepEqual(secondStops, []);
	releaseSecond({ status: "verdict", verdict: "on_track", reason: "fine" });
	await flush();
	assert.deepEqual(secondStops, []);
	second.dispose();
});

test("A9 System 1 completion does not buy cooldown or start a fallback judge", async () => {
	let llmCalls = 0;
	let releaseS1!: (value: unknown) => void;
	const drift = createDriftRuntime({
		dispatchId: "dispatch-1",
		agentKey: "builder",
		agentLabel: "Builder",
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		armed: true,
		ctx: {},
		now: () => 2_000,
		monitor: { onToolStart: () => violation, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation } as any,
		runDriftJudge: async () => { llmCalls++; return { status: "cancelled" }; },
		launchShadow: createShadowCoordinator({
			armed: true,
			task: "stay",
			scopeGlobs: ["src/**"],
			hubOwnedGlobs: [],
			session: session(() => new Promise((resolve) => { releaseS1 = resolve; })),
		}).launch,
	});
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.escalate(violation);
	await flush();
	assert.equal(llmCalls, 1);
	releaseS1({ status: "cancelled" });
	await flush();
	drift.escalate(violation);
	await flush();
	assert.equal(llmCalls, 2);
	drift.dispose();
});

test("A9 a stale System 1 result does not terminate the replacement attempt", async () => {
	const stops: string[] = [];
	let releaseS1!: (value: unknown) => void;
	const drift = createDriftRuntime({
		dispatchId: "dispatch-1",
		agentKey: "builder",
		agentLabel: "Builder",
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		armed: true,
		ctx: {},
		monitor: { onToolStart: () => violation, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation } as any,
		runDriftJudge: async () => ({ status: "cancelled" }),
		launchShadow: createShadowCoordinator({
			armed: true,
			task: "stay",
			scopeGlobs: ["src/**"],
			hubOwnedGlobs: [],
			session: session(() => new Promise((resolve) => { releaseS1 = resolve; })),
		}).launch,
	});
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.bindControl({ terminate: () => stops.push("old") });
	drift.escalate(violation);
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 2 });
	drift.bindControl({ terminate: () => stops.push("new") });
	releaseS1({ status: "ok", evaluation: { answers: [{ questionId: "status", type: "choice", value: "drifting" }] } });
	await flush();
	assert.deepEqual(stops, []);
	assert.equal(drift.attempts[1].stop, null);
	drift.dispose();
});

test("A10 off, disarmed and non-native callers do not evaluate", async () => {
	let calls = 0;
	const evaluate = async () => { calls++; return { status: "skipped", reason: "disabled" }; };
	for (const mode of ["off"] as const) {
		createShadowCoordinator({ armed: true, task: "stay", scopeGlobs: [], hubOwnedGlobs: [], session: session(evaluate, mode) }).launch(launchInput());
	}
	createShadowCoordinator({ armed: false, task: "stay", scopeGlobs: [], hubOwnedGlobs: [], session: session(evaluate) }).launch(launchInput());
	createShadowCoordinator({ armed: true, task: "stay", scopeGlobs: [], hubOwnedGlobs: [], session: null }).launch(launchInput());
	const active = createShadowCoordinator({
		armed: true,
		task: "stay",
		scopeGlobs: [],
		hubOwnedGlobs: [],
		session: session(evaluate, "active"),
	});
	active.launch(launchInput());
	await flush();
	assert.equal(calls, 1);
	assert.equal(active.evaluations, 1);
	for (const file of ["research-watchdog.ts", "dispatch-coms.ts", "research/spawn-run.ts", "dispatch-observability.ts"]) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.equal(source.includes("createShadowCoordinator"), false);
		assert.equal(source.includes("drift-judge"), false);
	}
});

test("native Layer 1 escalation is the only prepared-run consumer and records a skipped evaluation", async () => {
	let evaluations = 0;
	const activity = createWatchdogActivity({ write: () => undefined, now: () => 3 });
	const state: any = { def: { name: "builder" }, toolCount: 0, timeline: [] };
	const run: any = {
		dispatchId: "dispatch-s1",
		deps: {
			displayName: (name: string) => name,
			guardrailEnv: () => ({}),
			notifyProviderQueue() {},
			getSessionDir: () => "/tmp",
			getWatchdogAgentOverride: () => undefined,
			getWatchdogSetting: () => "on",
			getWorkMode: () => "operator",
			getWatchdogSystem1: () => session(async () => { evaluations++; return { status: "skipped", reason: "disabled" }; }),
			getWatchdogActivity: () => activity,
			providerSemaphore: { run: async (_model: string, fn: () => Promise<unknown>) => fn() },
			runDriftJudge: async () => ({ status: "verdict", verdict: "on_track", reason: "ok" }),
			createDriftMonitor: () => ({ onToolStart: () => violation, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation }),
			updateWidget() {},
			appendTimelineText() {},
			appendTimelineEvent() {},
			shortModel: (model: string) => model,
			getReconSearchTimeoutMs: () => 1,
			spawnPiAgentWithModelFallback: async (opts: any, _fallback: string, cbs: any) => {
				opts.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
				cbs.onToolStart?.("read", "{}", "1");
				await flush();
				opts.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
				return { output: "done", exitCode: 0, stderr: "", toolCallsStarted: 1, modelUsed: "fake/model" };
			},
		},
		state,
		ctx: { cwd: "/tmp", ui: { notify() {} } },
		watchdogParam: true,
		key: "builder",
		scopeGlobs: ["src/**"],
		task: "task",
		agentKey: "builder",
		model: "fake/model",
		effectiveTools: "read",
		thinkingLevel: "off",
		replacementSystemPrompt: "",
		agentSessionFile: "/tmp/session.json",
		runPrompt: "prompt",
		extensions: [],
		personaKey: "builder",
		resumeAllowed: false,
		sessionRecycled: false,
		sessionReset: null,
		originalModelFallback: undefined,
		delegateEnv: {},
		turnBudget: {},
	};
	const outcome = await runPreparedNative(run);
	assert.equal(evaluations, 1);
	assert.equal(outcome.driftStop, null);
	assert.equal(state.timeline.some((entry: { title?: string }) => entry.title === "System 1"), true);
	assert.equal(activity.live().completed.some((item) => item.status === "skipped"), true);
	assert.equal(JSON.stringify(state.timeline).includes("SAME_CALL_DETAIL_DO_NOT_TRACE"), false);
});

test("BLK-1 a dispatch that completes with no System 1 does not dispose another worker", async () => {
	const lines: string[] = [];
	let sessionDisposes = 0;
	const activity = createWatchdogActivity({ write: (line) => lines.push(line), now: () => 5 });
	const originalDispose = activity.dispose.bind(activity);
	activity.dispose = () => { sessionDisposes++; originalDispose(); };
	let releaseB!: (value: unknown) => void;
	const coordinatorB = createShadowCoordinator({
		armed: true,
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		session: session(() => new Promise((resolve) => { releaseB = resolve; })),
		trace: activity,
	});
	const driftB = createDriftRuntime({
		dispatchId: "dispatch-B",
		agentKey: "builder",
		agentLabel: "Builder",
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		armed: true,
		ctx: {},
		monitor: { onToolStart: () => violation, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation } as any,
		runDriftJudge: () => new Promise(() => undefined),
		launchShadow: (input) => coordinatorB.launch(input),
		onDispose: () => coordinatorB.dispose(),
	});
	driftB.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	driftB.escalate(violation);
	await flush();
	assert.equal(activity.live().active.some((item) => item.dispatchId === "dispatch-B" && item.evaluation === "evaluating"), true);
	const state: any = { def: { name: "builder" }, toolCount: 0, timeline: [] };
	const run: any = {
		dispatchId: "dispatch-A",
		deps: {
			displayName: (name: string) => name,
			guardrailEnv: () => ({}),
			notifyProviderQueue() {},
			getSessionDir: () => "/tmp",
			getWatchdogAgentOverride: () => undefined,
			getWatchdogSetting: () => "on",
			getWorkMode: () => "operator",
			getWatchdogSystem1: () => session(async () => { throw new Error("dispatch A must not evaluate"); }),
			getWatchdogActivity: () => activity,
			providerSemaphore: { run: async (_model: string, fn: () => Promise<unknown>) => fn() },
			runDriftJudge: async () => { throw new Error("dispatch A must not judge"); },
			createDriftMonitor: () => ({ onToolStart: () => violation, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation }),
			updateWidget() {},
			appendTimelineText() {},
			appendTimelineEvent() {},
			shortModel: (model: string) => model,
			getReconSearchTimeoutMs: () => 1,
			spawnPiAgentWithModelFallback: async (opts: any) => {
				opts.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
				opts.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
				return { output: "done", exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: "fake/model" };
			},
		},
		state,
		ctx: { cwd: "/tmp", ui: { notify() {} } },
		watchdogParam: true,
		key: "builder",
		scopeGlobs: ["src/**"],
		task: "task",
		agentKey: "builder",
		model: "fake/model",
		effectiveTools: "read",
		thinkingLevel: "off",
		replacementSystemPrompt: "",
		agentSessionFile: "/tmp/session.json",
		runPrompt: "prompt",
		extensions: [],
		personaKey: "builder",
		resumeAllowed: false,
		sessionRecycled: false,
		sessionReset: null,
		originalModelFallback: undefined,
		delegateEnv: {},
		turnBudget: {},
	};
	await runPreparedNative(run);
	assert.equal(sessionDisposes, 0);
	assert.equal(activity.live().active.some((item) => item.dispatchId === "dispatch-B" && item.evaluation === "evaluating"), true);
	releaseB({ status: "ok", evaluation: { metadata: { returnedModel: "jev-1.13.0", attempts: 1, usage: { inputTokens: 5, outputTokens: 2 } } } });
	await flush();
	const record = activity.live().active.find((item) => item.dispatchId === "dispatch-B")
		?? activity.live().completed.find((item) => item.dispatchId === "dispatch-B");
	assert.equal(record?.status, "ok");
	assert.equal(record?.reason, "unknown");
	assert.equal(record?.unused, false);
	assert.equal(record?.returnedModel, "jev-1.13.0");
	assert.deepEqual(record?.usage, { inputTokens: 5, outputTokens: 2 });
	assert.equal(lines.some((line) => line.includes("dispatch-B") && line.includes("disposed")), false);
	const finished = lines.map((line) => JSON.parse(line)).find((item) => item.dispatchId === "dispatch-B" && item.type === "evaluation_finished");
	assert.equal(finished.status, "ok");
	assert.equal(finished.unused, false);
	driftB.dispose();
});

test("BLK-1 ending one escalating dispatch does not cancel the other worker", async () => {
	const lines: string[] = [];
	const activity = createWatchdogActivity({ write: (line) => lines.push(line), now: () => 6 });
	let releaseB!: (value: unknown) => void;
	const start = (dispatchId: string, evaluate: ShadowSession["evaluate"]) => {
		const coordinator = createShadowCoordinator({
			armed: true,
			task: "stay",
			scopeGlobs: ["src/**"],
			hubOwnedGlobs: [],
			session: session(evaluate),
			trace: activity,
		});
		const drift = createDriftRuntime({
			dispatchId,
			agentKey: "builder",
			agentLabel: "Builder",
			task: "stay",
			scopeGlobs: ["src/**"],
			hubOwnedGlobs: [],
			armed: true,
			ctx: {},
			monitor: { onToolStart: () => violation, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation } as any,
			runDriftJudge: () => new Promise(() => undefined),
			launchShadow: (input) => coordinator.launch(input),
			onDispose: () => coordinator.dispose(),
		});
		return drift;
	};
	const driftA = start("dispatch-A", async () => ({ status: "ok", evaluation: { metadata: { returnedModel: "jev-1.13.0", attempts: 1, usage: { inputTokens: 1, outputTokens: 1 } } } }));
	const driftB = start("dispatch-B", () => new Promise((resolve) => { releaseB = resolve; }));
	driftA.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	driftB.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	driftA.escalate(violation);
	driftB.escalate(violation);
	await flush();
	driftA.dispose();
	assert.equal(activity.live().active.some((item) => item.dispatchId === "dispatch-B" && item.evaluation === "evaluating"), true);
	releaseB({ status: "ok", evaluation: { metadata: { returnedModel: "jev-1.13.0", attempts: 1, usage: { inputTokens: 5, outputTokens: 2 } } } });
	await flush();
	const record = [...activity.live().active, ...activity.live().completed].find((item) => item.dispatchId === "dispatch-B");
	assert.equal(record?.status, "ok");
	assert.equal(record?.unused, false);
	assert.equal(record?.returnedModel, "jev-1.13.0");
	assert.equal(lines.some((line) => line.includes("dispatch-B") && line.includes("\"reason\":\"disposed\"")), false);
	driftB.dispose();
});

test("F-9 an applied decision stays on the immutable check that produced it", async () => {
	const lines: string[] = [];
	const activity = createWatchdogActivity({ write: (line) => lines.push(line), now: () => 7 });
	const coordinator = createShadowCoordinator({
		armed: true,
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		session: session(async () => ({ status: "skipped", reason: "disabled" })),
		trace: activity,
	});
	const advisory = { rule: "scope", terminal: false, detail: "kept advisory" };
	const drift = createDriftRuntime({
		dispatchId: "dispatch-1",
		agentKey: "builder",
		agentLabel: "Builder",
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		armed: true,
		ctx: {},
		now: () => 0,
		monitor: { onToolStart: () => advisory, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation } as any,
		runDriftJudge: async () => ({ status: "verdict", verdict: "drifting", reason: "scope" }),
		launchShadow: (input) => coordinator.launch(input),
		onOutcome: (outcome) => coordinator.noteOutcome(outcome),
		onDispose: () => coordinator.dispose(),
	});
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.escalate(advisory);
	await flush();
	const owner = drift.attempts[0];
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	const outcome = drift.outcomeFor({ termination: undefined });
	assert.equal(outcome.driftAdvisories.length, 1);
	assert.equal(drift.attempts[1].advisories.length, 0);
	const decisions = lines.map((line) => JSON.parse(line)).filter((item) => item.type === "decision");
	assert.equal(decisions.length, 1);
	assert.equal(decisions[0].attemptId, owner.attemptId);
	assert.equal(decisions[0].checkId, owner.checks[0].checkId);
	assert.equal(decisions[0].snapshotId, owner.checks[0].snapshotId);
	assert.equal(decisions[0].outcome, "advisory");
	assert.equal(decisions[0].applied, "no");
	assert.equal(decisions.some((item) => item.attemptId === drift.attempts[1].attemptId), false);
	drift.dispose();
});

test("F-9 an applied stop is attributed to the check that requested it", async () => {
	const lines: string[] = [];
	const activity = createWatchdogActivity({ write: (line) => lines.push(line), now: () => 9 });
	const coordinator = createShadowCoordinator({
		armed: true,
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		session: session(async () => ({ status: "skipped", reason: "disabled" })),
		trace: activity,
	});
	const drift = createDriftRuntime({
		dispatchId: "dispatch-1",
		agentKey: "builder",
		agentLabel: "Builder",
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		armed: true,
		ctx: {},
		monitor: { onToolStart: () => violation, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation } as any,
		runDriftJudge: async () => ({ status: "verdict", verdict: "stuck", reason: "loop" }),
		launchShadow: (input) => coordinator.launch(input),
		onOutcome: (outcome) => coordinator.noteOutcome(outcome),
		onDispose: () => coordinator.dispose(),
	});
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.bindControl({ terminate() {} });
	drift.escalate(violation);
	await flush();
	const owner = drift.attempts[0];
	const outcome = drift.outcomeFor({ termination: { reason: "drift_stop", confirmed: true, escalated: false } });
	assert.equal(outcome.applied, true);
	assert.equal(outcome.driftStop?.verdict, "stuck");
	const decisions = lines.map((line) => JSON.parse(line)).filter((item) => item.type === "decision");
	assert.equal(decisions.length, 1);
	assert.equal(decisions[0].attemptId, owner.attemptId);
	assert.equal(decisions[0].checkId, owner.checks[0].checkId);
	assert.equal(decisions[0].outcome, "drift_stop");
	assert.equal(decisions[0].applied, "yes");
	drift.dispose();
});

test("F-9 a later attempt outcome is not written onto the previous check", async () => {
	const lines: string[] = [];
	const activity = createWatchdogActivity({ write: (line) => lines.push(line), now: () => 8 });
	let release!: (value: unknown) => void;
	const coordinator = createShadowCoordinator({
		armed: true,
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		session: session(() => new Promise((resolve) => { release = resolve; })),
		trace: activity,
	});
	const drift = createDriftRuntime({
		dispatchId: "dispatch-1",
		agentKey: "builder",
		agentLabel: "Builder",
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		armed: true,
		ctx: {},
		monitor: { onToolStart: () => violation, onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation } as any,
		runDriftJudge: () => new Promise(() => undefined),
		launchShadow: (input) => coordinator.launch(input),
		onOutcome: (outcome) => coordinator.noteOutcome(outcome),
		onDispose: () => coordinator.dispose(),
	});
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.escalate(violation);
	const previous = drift.attempts[0];
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	const outcome = drift.outcomeFor({ termination: undefined });
	assert.equal(outcome.applied, false);
	assert.deepEqual(outcome.driftAdvisories, []);
	assert.equal(lines.map((line) => JSON.parse(line)).some((item) => item.type === "decision"), false);
	release({ status: "ok", evaluation: { metadata: { returnedModel: "jev-1.13.0", attempts: 1, usage: { inputTokens: 1, outputTokens: 1 } } } });
	await flush();
	const decisions = lines.map((line) => JSON.parse(line)).filter((item) => item.type === "decision");
	assert.equal(decisions.length, 0);
	assert.equal(drift.attempts[1].stop, null);
	assert.equal(drift.attempts[1].advisories.length, 0);
	const previousRecord = [...activity.live().active, ...activity.live().completed].find((item) => item.checkId === previous.checks[0].checkId);
	assert.notEqual(previousRecord?.outcome, "continue");
	assert.equal(previousRecord?.applied, "unknown");
	drift.dispose();
});

test("observer failure and a mutated snapshot do not change the LLM input", async () => {
	let llm = 0;
	const mutable = structuredClone(observation);
	let seen = "";
	const activity = createWatchdogActivity({ write: () => { throw new Error("disk down"); } });
	const coordinator = createShadowCoordinator({
		armed: true,
		task: "stay sk-abcdefghijklmnopqrstuvwxyz",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		session: session(async (input) => {
			seen = JSON.stringify(input.state);
			throw new Error("observer blew up");
		}),
		trace: activity,
		onCard: () => { throw new Error("card blew up"); },
	});
	coordinator.launch(launchInput({ observation: mutable, startLlm: () => { llm++; } }));
	mutable.events[0].path = "MUTATED_AFTER_SNAPSHOT";
	await flush();
	assert.equal(llm, 1);
	assert.equal(seen.includes("MUTATED_AFTER_SNAPSHOT"), false);
	assert.equal(seen.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
	assert.equal(activity.degraded, true);
	coordinator.dispose();
});

test("F-13 a check the LLM never answered is source none, even beside an advisory", async () => {
	const lines: string[] = [];
	const cards: string[] = [];
	let clock = 0;
	const activity = createWatchdogActivity({ write: (line) => lines.push(line), now: () => clock });
	const coordinator = createShadowCoordinator({
		armed: true,
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		session: session(async () => ({ status: "skipped", reason: "disabled" })),
		trace: activity,
		onCard: (text) => cards.push(text),
		now: () => clock,
	});
	const drift = createDriftRuntime({
		dispatchId: "dispatch-1",
		agentKey: "builder",
		agentLabel: "Builder",
		task: "stay",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		armed: true,
		ctx: {},
		now: () => clock,
		monitor: { onToolStart: () => ({ rule: "scope", terminal: false, detail: "kept advisory" }), onToolEnd: () => null, trail: () => ["bash {}"], structuredObservation: () => observation } as any,
		runDriftJudge: (() => {
			let calls = 0;
			return () => {
				calls++;
				if (calls === 1) return Promise.resolve({ status: "verdict", verdict: "drifting", reason: "scope" });
				return new Promise(() => undefined);
			};
		})(),
		launchShadow: (input) => coordinator.launch(input),
		onOutcome: (outcome) => coordinator.noteOutcome(outcome),
		onDispose: () => coordinator.dispose(),
	});
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.escalate({ rule: "scope", terminal: false, detail: "kept advisory" });
	await flush();
	clock = 90_000;
	drift.escalate({ rule: "loop", terminal: true, detail: "unanswered" });
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	const outcome = drift.outcomeFor({ termination: undefined });
	assert.equal(outcome.applied, false);
	const decisions = lines.map((line) => JSON.parse(line)).filter((item) => item.type === "decision");
	const unanswered = decisions.find((item) => item.rule === "loop" || item.outcome === "continue" && item.source === "none");
	assert.equal(unanswered?.source, "none");
	assert.equal(unanswered?.applied, "no");
	assert.equal(unanswered?.outcome, "continue");
	assert.equal(decisions.some((item) => item.source === "llm" && item.outcome === "advisory"), true);
	assert.match(cards.join("\n"), /source none/);
	assert.doesNotMatch(cards.filter((card) => card.includes("source none")).join("\n"), /source llm/);
	drift.dispose();
});
