import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { createDispatchComs } from "./dispatch-coms.ts";
import { completeNativeRun } from "./dispatch-native-complete.ts";
import { runPreparedNative } from "./dispatch-native-spawn.ts";
import {
	createDriftRuntime,
	fenceOperatorCancel,
	judgeSessionFileName,
	normalizeJudgeOutcome,
	reconcileAppliedDriftStop,
	type DriftJudgeOutcome,
	type DriftMonitorLike,
} from "./drift-runtime.ts";
import { killPiTree, spawnPiAgent, type PiRunControl } from "./spawn.ts";
import { createProactiveRuntime } from "./proactive-runtime.ts";
import type { ObserverAssignment } from "./proactive-observer.ts";
import type { ProactiveConfig } from "./proactive-types.ts";
import { createHash } from "node:crypto";

const violation = { rule: "loop", terminal: true, detail: "same call" };
const monitor: DriftMonitorLike = {
	onToolStart: () => violation,
	onToolEnd: () => null,
	trail: () => ["bash {}"],
};

function runtime(runDriftJudge: (input: any, ctx: unknown) => Promise<unknown>, extra: Record<string, unknown> = {}) {
	return createDriftRuntime({
		dispatchId: "dispatch-1",
		agentKey: "builder",
		agentLabel: "Builder",
		task: "stay on task",
		scopeGlobs: ["src/**"],
		hubOwnedGlobs: [],
		armed: true,
		ctx: {},
		monitor,
		runDriftJudge,
		...extra,
	});
}

function control(): { control: PiRunControl; reasons: string[] } {
	const reasons: string[] = [];
	return { reasons, control: { terminate: (reason = "drift_stop") => { reasons.push(reason); } } };
}

async function flush(): Promise<void> {
	await new Promise(resolve => setImmediate(resolve));
}

test("D1 unavailable retries once after 5s on a fresh snapshot; no success cooldown and no loop", async () => {
 let clock = 100, pending: { fn: () => void; at: number }[] = [];
 const seen: any[] = [], attributions: any[] = [];
 const drift = runtime(async input => { seen.push(input); return { status: "unavailable" }; }, {
  now: () => clock, setTimer: (fn: () => void, ms: number) => { const timer = { fn, at: clock + ms }; pending.push(timer); return timer; },
  clearTimer: (handle: any) => { pending = pending.filter(t => t !== handle); },
  onOutcome: (result: any) => attributions.push(...result.attributions),
  monitor: { ...monitor, isSignalCurrent: () => true },
 });
 drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 }); drift.escalate(violation); await flush();
 assert.equal(seen.length, 1); assert.equal(pending.length, 1); assert.equal(pending[0].at, 5100);
 clock = 5100; pending.shift()!.fn(); await flush();
 assert.equal(seen.length, 2); assert.notEqual(seen[0].snapshotId, seen[1].snapshotId);
 assert.notEqual(seen[0].llmAttemptId, seen[1].llmAttemptId);
 assert.equal(pending.length, 0); drift.outcomeFor({});
 assert.deepEqual(attributions.map(a => a.outcome), ["judge_unavailable", "judge_unavailable"]);
 drift.dispose();
});

test("D1 stale one-shot retry is dropped by rule revalidation and does not call LLM", async () => {
 let clock = 0, run!: () => void, current = true, calls = 0;
 const drift = runtime(async () => { calls++; return { status: "unavailable" }; }, {
  now: () => clock, setTimer: (fn: () => void) => { run = fn; return {} as any; }, clearTimer: () => undefined,
  monitor: { ...monitor, isSignalCurrent: () => current },
 });
 drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 }); drift.escalate(violation); await flush();
 assert.equal(calls, 1); current = false; clock = 5_000; run(); await flush();
 assert.equal(calls, 1); assert.equal(drift.attempts[0].checks.length, 1);
 drift.dispose();
});

test("D1 busy/cooldown coalesces terminal before advisory, revalidates and cancels timers", async () => {
 let clock = 0, pending: { fn: () => void; at: number }[] = [], valid = true;
 const seen: string[] = [];
 const drift = runtime(async input => { seen.push(input.violation.rule); return { status: "verdict", verdict: "on_track" }; }, {
  now: () => clock, setTimer: (fn: () => void, ms: number) => { const timer = { fn, at: clock + ms }; pending.push(timer); return timer; },
  clearTimer: (handle: any) => { pending = pending.filter(t => t !== handle); },
  monitor: { ...monitor, isSignalCurrent: () => valid },
 });
 drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 }); drift.escalate(violation);
 drift.escalate({ rule: "scope", terminal: false, detail: "out" });
 drift.escalate({ rule: "toolcap", terminal: true, detail: "cap" });
 await flush(); assert.deepEqual(seen, ["loop"]); assert.equal(pending.length, 1);
 clock = 90_000; pending.shift()!.fn(); await flush(); assert.deepEqual(seen, ["loop", "toolcap"]);
 // A disposed attempt cannot run its queued advisory.
 drift.dispose(); for (const task of pending) task.fn(); assert.deepEqual(seen, ["loop", "toolcap"]);
 valid = false;
});

test("typed judge outcomes stay distinct and legacy null is unavailable, not a verdict", () => {
	assert.deepEqual(normalizeJudgeOutcome(null), { status: "unavailable" });
	assert.deepEqual(normalizeJudgeOutcome({ verdict: "on_track", reason: "ok" }), { status: "verdict", verdict: "on_track", reason: "ok" });
	assert.deepEqual(normalizeJudgeOutcome({ status: "cancelled" }), { status: "cancelled" });
	assert.deepEqual(normalizeJudgeOutcome({ status: "verdict", verdict: "unknown" }), { status: "unavailable" });
	assert.equal(judgeSessionFileName("attempt/../check").includes("/"), false);
	assert.notEqual(judgeSessionFileName("a"), judgeSessionFileName("b"));
});

test("A1 stale judge cannot terminate or mutate the replacement attempt", async () => {
	let release!: (value: DriftJudgeOutcome) => void;
	const drift = runtime(() => new Promise(resolve => { release = resolve; }));
	const first = control();
	const replacement = control();
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.bindControl(first.control);
	drift.escalate(violation);
	const stale = drift.attempts[0];
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 2 });
	drift.bindControl(replacement.control);
	release({ status: "verdict", verdict: "drifting", reason: "old trail" });
	await flush();
	assert.equal(replacement.reasons.length, 0);
	assert.equal(drift.attempts[1].stop, null);
	assert.equal(drift.attempts[1].advisories.length, 0);
	assert.equal(stale.unused.length, 1);
	assert.equal(stale.unused[0].status, "verdict");
	assert.equal(drift.outcomeFor({ termination: undefined }).applied, false);
	drift.dispose();
});

test("A1 cancelled check does not stop, advise, or buy cooldown for the replacement", async () => {
	const drift = runtime(async () => ({ status: "cancelled" }), { now: () => 1_000 });
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.escalate(violation);
	await flush();
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	let calls = 0;
	const next = runtime(async () => { calls++; return { status: "verdict", verdict: "on_track", reason: "fresh" }; }, { now: () => 1_001 });
	next.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	next.escalate(violation);
	await flush();
	assert.equal(calls, 1);
	assert.equal(drift.attempts[0].stop, null);
	drift.dispose();
	next.dispose();
});

test("A1 duplicate judge delivery cannot replace the first live decision", async () => {
	const drift = runtime(() => ({
		then(onOk: (value: DriftJudgeOutcome) => void) {
			onOk({ status: "verdict", verdict: "drifting", reason: "first" });
			onOk({ status: "verdict", verdict: "stuck", reason: "second" });
			return Promise.resolve();
		},
	}) as any);
	const bound = control();
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.bindControl(bound.control);
	drift.escalate(violation);
	await flush();
	assert.deepEqual(bound.reasons, ["drift_stop"]);
	assert.equal(drift.attempts[0].stop?.verdict, "drifting");
	assert.equal(drift.attempts[0].checks[0].settled, true);
	drift.dispose();
});

test("LLM-only stopping: on_track, unavailable and advisory never terminate", async () => {
	const cases: Array<{ outcome: DriftJudgeOutcome | null; terminal?: boolean; stops: boolean }> = [
		{ outcome: { status: "verdict", verdict: "on_track", reason: "serving" }, stops: false },
		{ outcome: { status: "unavailable" }, stops: false },
		{ outcome: null, stops: false },
		{ outcome: { status: "verdict", verdict: "drifting", reason: "scope" }, terminal: false, stops: false },
		{ outcome: { status: "verdict", verdict: "stuck", reason: "loop" }, stops: true },
	];
	for (const sample of cases) {
		const bound = control();
		const drift = runtime(async () => sample.outcome, { monitor: { ...monitor, onToolStart: () => ({ ...violation, terminal: sample.terminal }) } });
		drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
		drift.bindControl(bound.control);
		drift.escalate({ ...violation, terminal: sample.terminal });
		await flush();
		assert.equal(bound.reasons.length === 1, sample.stops);
		if (!sample.stops) assert.equal(drift.attempts[0].stop, null);
		if (sample.terminal === false) assert.equal(drift.attempts[0].advisories.length, 1);
		drift.dispose();
	}
});

test("F-10 a live advisory survives the next physical attempt", async () => {
	let clock = 0;
	const drift = runtime(async () => ({ status: "verdict", verdict: "drifting", reason: "scope" }), {
		now: () => clock,
		monitor: { ...monitor, onToolStart: () => ({ rule: "scope", terminal: false, detail: "kept advisory" }) },
	});
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.escalate({ rule: "scope", terminal: false, detail: "kept advisory" });
	await flush();
	assert.equal(drift.attempts[0].advisories.length, 1);
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	clock = 90_000;
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	const retained = drift.outcomeFor({ termination: undefined });
	assert.equal(retained.applied, false);
	assert.equal(retained.driftStop, null);
	assert.equal(retained.driftAdvisories.length, 1);
	assert.equal(retained.driftAdvisories[0].detail, "kept advisory");
	assert.equal(drift.attempts[1].advisories.length, 0);
	assert.equal(drift.attempts[1].stop, null);
	drift.dispose();
});

test("F-10 a stale advisory cannot mutate the replacement or the retained list", async () => {
	let release!: (value: DriftJudgeOutcome) => void;
	const drift = runtime(() => new Promise(resolve => { release = resolve; }));
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.escalate({ rule: "scope", terminal: false, detail: "stale advisory" });
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	release({ status: "verdict", verdict: "drifting", reason: "late" });
	await flush();
	assert.equal(drift.attempts[0].unused.length, 1);
	assert.equal(drift.attempts[1].advisories.length, 0);
	assert.equal(drift.attempts[1].stop, null);
	const outcome = drift.outcomeFor({ termination: undefined });
	assert.deepEqual(outcome.driftAdvisories, []);
	assert.equal(outcome.applied, false);
	drift.dispose();
});

test("A2 physical fallback and corruption retry get isolated attempt and judge identities", async () => {
	const seen: string[] = [];
	let clock = 0;
	const drift = runtime(async (input) => {
		seen.push(String(input.sessionKey));
		assert.equal(input.signal.aborted, false);
		return { status: "verdict", verdict: "on_track", reason: "ok" };
	}, { now: () => clock });
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.escalate(violation);
	await flush();
	const first = drift.attempts[0];
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	assert.equal(first.signal.aborted, true);
	clock = 90_000;
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.escalate(violation);
	await flush();
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	const second = drift.attempts[1];
	assert.notEqual(first.attemptId, second.attemptId);
	assert.notEqual(first.checks[0].checkId, second.checks[0].checkId);
	assert.notEqual(first.checks[0].snapshotId, second.checks[0].snapshotId);
	assert.notEqual(first.checks[0].llmAttemptId, second.checks[0].llmAttemptId);
	assert.equal(new Set(seen).size, 2);
	assert.equal(first.checks[0].dispatchId, "dispatch-1");
	drift.dispose();
});

test("A2 judge sessions stay unique across overlapping checks and finally deletes only its own file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "drift-judge-"));
	const entered: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const coms = createDispatchComs({
		getSessionDir: () => dir,
		getWatchdogJudgeModel: () => "fake/judge",
		getResearcherModel: () => null,
		safePathWithin: (root: string, name: string) => join(root, name),
		spawnPiAgent: async (opts: any) => {
			entered.push(opts.sessionFile);
			writeFileSync(opts.sessionFile, "live");
			await gate;
			return { output: "VERDICT: ON_TRACK — serving", exitCode: 0 };
		},
	} as any);
	const input = { agentLabel: "Builder", agentKey: "builder", task: "t", scopeGlobs: [], hubOwnedGlobs: [], trail: [], violation };
	const pending = Promise.all([
		coms.runDriftJudge({ ...input, sessionKey: "attempt-a-check-a" }, {} as any),
		coms.runDriftJudge({ ...input, sessionKey: "attempt-b-check-b" }, {} as any),
	]);
	while (entered.length < 2) await flush();
	assert.equal(entered[0] === entered[1], false);
	assert.equal(existsSync(entered[0]), true);
	assert.equal(existsSync(entered[1]), true);
	release();
	const outcomes = await pending;
	assert.equal(outcomes.every(item => item.status === "verdict"), true);
	assert.equal(existsSync(entered[0]), false);
	assert.equal(existsSync(entered[1]), false);
	rmSync(dir, { recursive: true, force: true });
});

test("A2 cancellation is a typed outcome and aborts before a judge child launch", async () => {
	let launched = 0;
	const coms = createDispatchComs({
		getSessionDir: () => "/tmp",
		getWatchdogJudgeModel: () => "fake/judge",
		safePathWithin: (root: string, name: string) => join(root, name),
		spawnPiAgent: async () => { launched++; return { output: "", exitCode: 1 }; },
	} as any);
	const signal = AbortSignal.abort();
	const outcome = await coms.runDriftJudge({
		agentLabel: "Builder", agentKey: "builder", task: "t", scopeGlobs: [], hubOwnedGlobs: [], trail: [], violation, signal,
	}, {} as any);
	assert.equal(outcome.status, "cancelled");
	assert.equal(launched, 0);
});

test("A3 applied drift-stop follows classified termination, not the terminate request", () => {
	const requested = { rule: "loop", detail: "same call", verdict: "drifting", reason: "loop" };
	assert.deepEqual(reconcileAppliedDriftStop(requested, { reason: "cancelled", confirmed: true, escalated: false }), { applied: false, driftStop: null });
	assert.equal(reconcileAppliedDriftStop(requested, { reason: "drift_stop", confirmed: false, escalated: false }).applied, true);
	assert.equal(reconcileAppliedDriftStop(null, { reason: "drift_stop", confirmed: true, escalated: true }).driftStop, null);
	assert.equal(reconcileAppliedDriftStop(requested, undefined).applied, false);
});

test("A1/A3 prepared native run fences replacement callbacks and does not report an unconfirmed stop", async () => {
	const timeline: string[] = [];
	let requested = 0;
	const state: any = { def: { name: "builder" }, toolCount: 0, timeline: [] };
	const run: any = {
		dispatchId: "dispatch-9",
		deps: {
			displayName: (name: string) => name,
			guardrailEnv: () => ({}),
			notifyProviderQueue() {},
			getSessionDir: () => "/tmp",
			getWatchdogAgentOverride: () => undefined,
			getWatchdogSetting: () => "on",
			getWorkMode: () => "operator",
			providerSemaphore: { run: async (_model: string, fn: () => Promise<unknown>) => fn() },
			runDriftJudge: async () => ({ status: "verdict", verdict: "drifting", reason: "loop" }),
			createDriftMonitor: () => monitor,
			updateWidget() {},
			appendTimelineText: (_state: unknown, _kind: string, delta: string) => { timeline.push(delta); },
			appendTimelineEvent() {},
			shortModel: (model: string) => model,
			getReconSearchTimeoutMs: () => 1,
			spawnPiAgentWithModelFallback: async (opts: any, _fallback: string, cbs: any) => {
				opts.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
				cbs.onControl?.({ terminate() { requested++; } });
				cbs.onTextDelta?.("attempt-a");
				cbs.onToolStart?.("bash", "{}", "1");
				await flush();
				opts.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
				cbs.onTextDelta?.("stale-a");
				opts.attemptLifecycle.beforePhysicalSpawn({ generation: 2 });
				cbs.onControl?.({ terminate() { requested++; } });
				cbs.onTextDelta?.("attempt-b");
				opts.attemptLifecycle.afterPhysicalSpawn({ generation: 2 });
				return { output: "attempt-b", exitCode: 130, stderr: "", toolCallsStarted: 1, modelUsed: "fake/model", termination: { reason: "cancelled", confirmed: true, escalated: false } };
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
		turnBudget: {},
		personaKey: "builder",
		resumeAllowed: false,
		sessionRecycled: false,
		sessionReset: null,
	};
	const outcome = await runPreparedNative(run);
	assert.deepEqual(timeline, ["attempt-a", "attempt-b"]);
	assert.equal(outcome.driftStop, null);
	assert.equal(outcome.res.termination?.reason, "cancelled");
	assert.equal(state.driftFence, undefined);
	assert.equal(requested >= 1, true);
});

test("assembled native spawn preserves watchdog authority and fences killed observation; missing manifest is explicit", async () => {
 const root = mkdtempSync(join(tmpdir(), "native-observation-"));
 const config: ProactiveConfig = { version: 1, mode: "shadow", remoteContext: "disabled", include: ["src/**"], maxEvaluationsPerSession: 4 };
 const runtime = createProactiveRuntime({ config });
 const digest = (text: string) => createHash("sha256").update(text).digest("hex");
 const context = { task: { path: "task", revision: "1", hash: digest("task") }, rules: [], exceptions: [] };
 let watchdogCalls = 0;
 const runCase = async (attempt: string, killed: boolean, manifest: boolean) => {
  const directory = join(root, attempt);
  const assignment: ObserverAssignment = { root, directory, session: "session", owner: "builder", attempt, config, context };
  const state: any = { def: { name: "builder" }, toolCount: 0, timeline: [], killedByOperator: false, restarting: false };
  const run: any = {
   dispatchId: attempt, state, proactiveAssignment: assignment, ctx: { cwd: root, ui: { notify() {} } },
   watchdogParam: true, key: "builder", scopeGlobs: ["src/**"], task: "task", agentKey: "builder",
   model: "fake/model", effectiveTools: "read", thinkingLevel: "off", replacementSystemPrompt: "",
   agentSessionFile: join(root, "session.json"), runPrompt: "prompt", extensions: [], turnBudget: {}, personaKey: "builder",
   resumeAllowed: false, sessionRecycled: false, sessionReset: null,
   deps: {
    displayName: (name: string) => name, getProactiveRuntime: () => runtime, guardrailEnv: () => ({}), notifyProviderQueue() {},
    getSessionDir: () => root, getWatchdogAgentOverride: () => undefined, getWatchdogSetting: () => "on", getWorkMode: () => "operator",
    providerSemaphore: { run: async (_model: string, fn: () => Promise<unknown>) => fn() },
    runDriftJudge: async () => { watchdogCalls++; return { status: "verdict", verdict: "on_track" }; },
    createDriftMonitor: () => ({ ...monitor, onToolStart: () => violation }),
    updateWidget() {}, appendTimelineText() {}, appendTimelineEvent() {}, shortModel: (model: string) => model,
    getReconSearchTimeoutMs: () => 1,
    spawnPiAgentWithModelFallback: async (opts: any, _fallback: string, cbs: any) => {
     opts.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
     cbs.onControl?.({ terminate() { throw new Error("review cannot terminate"); } });
     cbs.onToolStart?.("bash", "{}", "1");
     await flush();
     if (manifest) {
      const turnId = `session:builder:${attempt}:0`;
      const snapshot = { snapshotId: digest(turnId), turnId, head: "", context, planStatus: "task_only", status: "complete", gaps: [], units: [{ id: "1", path: "src/a.ts", kind: "modified", attribution: "observed_only" }], observedPaths: 1, coverage: { retainedUnits: 1, retainedBytes: 0, omittedPaths: 0 } };
      const data = JSON.stringify(snapshot);
      writeFileSync(join(directory, "snapshot-0.json"), data);
      writeFileSync(join(directory, "turn-0.json"), JSON.stringify({ producer: "agent-fleet.proactive-observer/v1", session: "session", owner: "builder", attempt, turnIndex: 0, turnId, status: "captured", snapshot: { path: "snapshot-0.json", hash: digest(data), snapshotId: snapshot.snapshotId, bytes: Buffer.byteLength(data) } }));
     }
     if (killed) state.killedByOperator = true;
     opts.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
     return { output: "done", exitCode: killed ? 130 : 0, stderr: "", termination: killed ? { reason: "cancelled", confirmed: true, escalated: false } : undefined };
    },
   },
  };
  const outcome = await runPreparedNative(run);
  assert.equal(outcome.driftStop, null);
  return runtime.records.filter(record => record.attempt === attempt);
 };
 try {
  const killed = await runCase("killed", true, true);
  assert.equal(killed.some(record => record.status === "not_checked" || record.status === "reviewed" || record.status === "not_instrumented"), false);
  const missing = await runCase("missing", false, false);
  assert.deepEqual(missing.map(record => record.status), ["not_instrumented"]);
  const captured = await runCase("normal", false, true);
  assert.deepEqual(captured.map(record => record.status), ["not_checked"]);
  assert.equal(watchdogCalls, 3);
  assert.equal(runtime.used, 0);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator fence disposes the session-owned attempt synchronously", () => {
	const drift = runtime(async () => ({ status: "unavailable" }));
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	const state = { driftFence: drift.fence };
	fenceOperatorCancel(state);
	assert.equal(drift.attempts[0].disposed, true);
	assert.equal(drift.attempts[0].signal.aborted, true);
	assert.equal(drift.attempts[0].childSignal.aborted, true);
	fenceOperatorCancel(state);
	fenceOperatorCancel(undefined);
});

test("MI-8 operator fence stays sticky across the next physical launch", async () => {
	let calls = 0;
	const drift = runtime(async () => { calls++; return { status: "verdict", verdict: "drifting", reason: "late" }; });
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	fenceOperatorCancel({ driftFence: drift.fence });
	const next = drift.attemptLifecycle.beforePhysicalSpawn({ generation: 2 });
	assert.equal(next?.signal?.aborted, true);
	assert.equal(drift.acceptsCallbacks(), false);
	assert.equal(drift.attempts[1].disposed, true);
	drift.escalate(violation);
	assert.equal(calls, 0);

	const dir = mkdtempSync(join(tmpdir(), "mi8-fence-"));
	writeFileSync(join(dir, "pi"), "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
	chmodSync(join(dir, "pi"), 0o755);
	let processes = 0;
	const blocked = await spawnPiAgent({
		model: "fake/other",
		tools: "read",
		thinking: "off",
		appendSystemPrompt: "",
		sessionFile: join(dir, "session.json"),
		prompt: "probe",
		cwd: dir,
		activeProfileSnapshot: undefined,
		env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
		attemptLifecycle: drift.attemptLifecycle,
	}, { onProcess: () => { processes++; } });
	assert.equal(processes, 0);
	assert.equal(blocked.termination?.reason, "cancelled");
	assert.equal(blocked.toolCallsStarted, 0);
	drift.dispose();
	rmSync(dir, { recursive: true, force: true });
});

test("T1 a disposed attempt's in-flight judge does not block the replacement check", async () => {
	let calls = 0;
	const drift = runtime((input) => new Promise(resolve => {
		calls++;
		const finish = () => resolve({ status: "cancelled" });
		if (input.signal.aborted) finish();
		else input.signal.addEventListener("abort", finish, { once: true });
	}));
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
	drift.escalate(violation);
	drift.escalate(violation);
	assert.equal(calls, 1);
	drift.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
	drift.attemptLifecycle.beforePhysicalSpawn({ generation: 2 });
	drift.escalate(violation);
	assert.equal(calls, 2);
	await flush();
	assert.equal(drift.attempts[1].stop, null);
	assert.equal(drift.attempts[0].unused[0]?.status, "cancelled");
	drift.dispose();
});

function writeHangingPi(dir: string): void {
	const script = `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n`;
	writeFileSync(join(dir, "pi"), script, { mode: 0o755 });
	chmodSync(join(dir, "pi"), 0o755);
}

async function completeFrom(state: any, outcome: any) {
	const monitorFinalized: string[] = [];
	const history: string[] = [];
	const result = await completeNativeRun({
		deps: {
			displayName: (name: string) => name,
			finalizeMonitorChild: async (_task: unknown, output: string, status: string) => { monitorFinalized.push(`${status}:${output}`); },
			updateWidget() {},
			appendTimelineText() {},
			flushTimelineStore() {},
			executionHistory: { end: (_entry: unknown, status: string) => { history.push(status); } },
			bumpDriftStop() {},
		},
		state,
		ctx: { ui: { notify() {} } },
		histEntry: { id: "hist" },
		monitorStart: Promise.resolve("monitor-task"),
		startTime: Date.now(),
		key: "builder",
		agentKey: "builder",
		effectiveTools: "read",
		evidenceDir: "/tmp",
		dispatchId: "dispatch-operator",
		transcriptPath: "/tmp/transcript.jsonl",
	} as any, outcome);
	return { result, monitorFinalized, history };
}

async function fencedChild(restarting: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "operator-fence-"));
	writeHangingPi(dir);
	const drift = runtime((input) => new Promise(resolve => {
		const finish = () => resolve({ status: "cancelled" });
		if (input.signal.aborted) finish();
		else input.signal.addEventListener("abort", finish, { once: true });
	}));
	const state: any = {
		def: { name: "builder" },
		status: "running",
		killedByOperator: false,
		restarting: false,
		driftFence: drift.fence,
		timeline: [],
	};
	let terminated = false;
	state.onTerminate = () => { terminated = true; };
	let started!: (proc: unknown) => void;
	const ready = new Promise(resolve => { started = resolve; });
	const spawned = spawnPiAgent({
		model: "fake/model",
		tools: "read",
		thinking: "off",
		appendSystemPrompt: "",
		sessionFile: join(dir, "session.json"),
		prompt: "probe",
		cwd: dir,
		activeProfileSnapshot: undefined,
		env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
		attemptLifecycle: drift.attemptLifecycle,
		toolWatchdog: { timeoutMs: null, termGraceMs: 200, settleGraceMs: 200 },
	}, {
		onProcess: proc => { state.proc = proc; started(proc); },
		onControl: control => drift.bindControl(control),
	});
	await ready;
	drift.escalate(violation);
	fenceOperatorCancel(state);
	state.killedByOperator = true;
	state.restarting = restarting;
	killPiTree(state.proc);
	const res = await spawned;
	const attempt = drift.attempts[0];
	assert.equal(attempt.disposed, true);
	assert.equal(attempt.signal.aborted, true);
	assert.equal(attempt.childSignal.aborted, true);
	assert.equal(attempt.control, undefined);
	assert.equal(res.termination?.reason, "cancelled");
	await flush();
	assert.equal(attempt.stop, null);
	const completed = await completeFrom(state, {
		res,
		runBilled: 0,
		runOut: 0,
		sessionRecycled: false,
		sessionReset: null,
		driftStop: attempt.stop,
		driftAdvisories: [],
	});
	rmSync(dir, { recursive: true, force: true });
	drift.dispose();
	return { ...completed, terminated, res, state };
}

test("BL-1 operator kill keeps operator classification when the fence stamps child cancellation", async () => {
	const { result, monitorFinalized, history, terminated, state } = await fencedChild(false);
	assert.equal(state.status, "idle");
	assert.equal(state.lastWork, "(killed by operator)");
	assert.equal(state.killedByOperator, false);
	assert.equal(state.restarting, false);
	assert.deepEqual(history, ["idle"]);
	assert.deepEqual(monitorFinalized, ["cancelled:operator killed run"]);
	assert.equal(terminated, true);
	assert.equal(result.diagnostics.reason, "operator_cancelled");
	assert.equal(result.diagnostics.termination.reason, "cancelled");
	assert.equal(result.exitCode, 143);
	assert.match(result.output, /killed by the operator/);
	assert.match(result.output, /Do NOT auto-retry or re-dispatch/);
	assert.equal(result.output.includes("cancelled by its caller"), false);
	assert.equal(result.output.includes("WAIT for the follow-up result"), false);
});

test("BL-1 operator restart keeps the WAIT instruction when the fence stamps child cancellation", async () => {
	const { result, monitorFinalized, history, state } = await fencedChild(true);
	assert.equal(state.status, "idle");
	assert.equal(state.lastWork, "(killed for restart)");
	assert.equal(state.killedByOperator, false);
	assert.equal(state.restarting, false);
	assert.deepEqual(history, ["idle"]);
	assert.deepEqual(monitorFinalized, ["cancelled:operator killed run"]);
	assert.equal(result.diagnostics.reason, "operator_cancelled");
	assert.equal(result.exitCode, 143);
	assert.match(result.output, /killed by the operator for a restart/);
	assert.match(result.output, /WAIT for the follow-up result before acting/);
	assert.equal(result.output.includes("cancelled by its caller"), false);
});

test("final termination classification still beats a later operator flag", async () => {
	const state: any = { def: { name: "builder" }, status: "running", killedByOperator: true, restarting: true };
	const driftStop = { rule: "loop", detail: "same call", verdict: "drifting", reason: "loop" };
	const { result, monitorFinalized, history } = await completeFrom(state, {
		res: { output: "partial", exitCode: null, stderr: "", termination: { reason: "drift_stop", confirmed: true, escalated: false } },
		runBilled: 0, runOut: 0, sessionRecycled: false, sessionReset: null, driftStop, driftAdvisories: [],
	});
	assert.equal(state.status, "error");
	assert.match(state.lastWork, /^drift_stop:/);
	assert.deepEqual(history, ["error"]);
	assert.deepEqual(monitorFinalized, []);
	assert.equal(result.exitCode, 125);
	assert.equal(result.diagnostics.reason, "drift_stop");
	assert.match(result.output, /stopped by the drift watchdog/);
	assert.equal(result.output.includes("WAIT for the follow-up result"), false);
	assert.equal(state.killedByOperator, true);
});

test("caller cancellation without an operator flag stays cancelled by caller", async () => {
	const state: any = { def: { name: "builder" }, status: "running", killedByOperator: false, restarting: false };
	const { result, monitorFinalized, history } = await completeFrom(state, {
		res: { output: "", exitCode: null, stderr: "", termination: { reason: "cancelled", confirmed: true, escalated: false } },
		runBilled: 0, runOut: 0, sessionRecycled: false, sessionReset: null, driftStop: null, driftAdvisories: [],
	});
	assert.equal(state.status, "error");
	assert.equal(state.lastWork, "cancelled by caller");
	assert.deepEqual(history, ["error"]);
	assert.deepEqual(monitorFinalized, []);
	assert.equal(result.exitCode, 130);
	assert.equal(result.diagnostics.reason, "cancelled");
	assert.match(result.output, /cancelled by its caller/);
});

test("P13a B5 proactive aligned leaves a real watchdog stop intact; review records unaffected", async () => {
 const root = mkdtempSync(join(tmpdir(), "proactive-watchdog-"));
 try {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const context = { task: { path: "task", revision: "1", hash: digest("task") }, rules: [], exceptions: [] };
  const aligned = Object.assign(async () => ({ status: "reviewed" as const, drift: { task: "aligned" as const, plan: "not_checked" as const }, rules: [], findings: [], gaps: [], evaluations: [] }), { budgeted: true as const });
  const config: ProactiveConfig = { version: 1, mode: "advisory", remoteContext: "disabled", include: ["src/**"], maxEvaluationsPerSession: 4 };
  const runtime = createProactiveRuntime({ config, evaluate: aligned });
  const terminated: string[] = [];
  const state: any = { def: { name: "builder" }, toolCount: 0, timeline: [], killedByOperator: false, restarting: false };
  const attempt = "stop-case", directory = join(root, attempt);
  const assignment: ObserverAssignment = { root, directory, session: "session", owner: "builder", attempt, config, context };
  const run: any = {
   dispatchId: attempt, state, proactiveAssignment: assignment, ctx: { cwd: root, ui: { notify() {} } },
   watchdogParam: true, key: "builder", scopeGlobs: ["src/**"], task: "task", agentKey: "builder",
   model: "fake/model", effectiveTools: "read", thinkingLevel: "off", replacementSystemPrompt: "",
   agentSessionFile: join(root, "session.json"), runPrompt: "prompt", extensions: [], turnBudget: {}, personaKey: "builder",
   resumeAllowed: false, sessionRecycled: false, sessionReset: null,
   deps: {
    displayName: (name: string) => name, getProactiveRuntime: () => runtime, guardrailEnv: () => ({}), notifyProviderQueue() {},
    getSessionDir: () => root, getWatchdogAgentOverride: () => undefined, getWatchdogSetting: () => "on", getWorkMode: () => "operator",
    providerSemaphore: { run: async (_model: string, fn: () => Promise<unknown>) => fn() },
    runDriftJudge: async () => ({ status: "verdict", verdict: "stuck", reason: "same call loop" }),
    createDriftMonitor: () => ({ ...monitor, onToolStart: () => violation }),
    updateWidget() {}, appendTimelineText() {}, appendTimelineEvent() {}, shortModel: (model: string) => model,
    getReconSearchTimeoutMs: () => 1,
    spawnPiAgentWithModelFallback: async (opts: any, _fallback: string, cbs: any) => {
     opts.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
     cbs.onControl?.({ terminate(reason = "drift_stop") { terminated.push(reason); } });
     cbs.onToolStart?.("bash", "{}", "1");
     const turnId = `session:builder:${attempt}:0`;
     const snapshot = { snapshotId: digest(turnId), turnId, head: "", context, planStatus: "task_only", status: "complete", gaps: [], units: [{ id: "1", path: "src/a.ts", kind: "modified", attribution: "observed_only" }], observedPaths: 1, coverage: { retainedUnits: 1, retainedBytes: 0, omittedPaths: 0 } };
     const data = JSON.stringify(snapshot);
     writeFileSync(join(directory, "snapshot-0.json"), data);
     writeFileSync(join(directory, "turn-0.json"), JSON.stringify({ producer: "agent-fleet.proactive-observer/v1", session: "session", owner: "builder", attempt, turnIndex: 0, turnId, status: "captured", snapshot: { path: "snapshot-0.json", hash: digest(data), snapshotId: snapshot.snapshotId, bytes: Buffer.byteLength(data) } }));
     await new Promise(r => setTimeout(r, 100)); // let the real stuck verdict settle before completion
     opts.attemptLifecycle.afterPhysicalSpawn({ generation: 1 });
     // Model Pi honoring the requested stop: a requested drift_stop ends the run as drift_stop.
     return terminated.length ? { output: "partial", exitCode: 125, stderr: "", termination: { reason: "drift_stop", confirmed: true, escalated: false } } : { output: "done", exitCode: 0, stderr: "", termination: undefined };
    },
   },
  };
  const outcome = await runPreparedNative(run);
  assert.ok(outcome.driftStop, "real watchdog stop is applied");
  assert.equal(outcome.driftStop?.verdict, "stuck");
  assert.deepEqual(terminated, ["drift_stop"]);
  for (let i = 0; i < 100 && !runtime.records.some(r => r.attempt === attempt && r.status === "reviewed"); i++) await new Promise(r => setTimeout(r, 10));
  const records = runtime.records.filter(r => r.attempt === attempt);
  assert.ok(records.some(r => r.status === "reviewed"), "proactive review still closes as reviewed");
  assert.equal(records[0].assessment?.drift.task, "aligned");
  assert.ok(runtime.findings.history.length >= 0);
  assert.equal(records.some(r => r.status === "cancelled"), false, "watchdog stop does not cancel the review record");
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("index cancel, restart and shutdown ports fence before kill", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.equal(source.includes("fenceOperatorCancel(state)"), true);
	assert.equal(source.includes("fenceOperatorCancel(st)"), true);
	assert.equal(source.includes("cancelOwned: state => { fenceOperatorCancel(state);"), true);
});
