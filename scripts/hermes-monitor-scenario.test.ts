/**
 * Local runtime evidence for the Hermes watchdog against a disposable Hub UDS.
 *
 * Boundary: every assertion below is `synthetic-local`. The endpoint is a
 * disposable Unix domain socket under a temporary runtime root, the watcher runs
 * in `observe` mode with Gate O absent, and recovery mechanics are driven by the
 * test. Nothing here proves Gate O, live origin delivery, steering, surgical
 * runtime use, or A6.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScenario, execute, registerDisposable, waitFor, watcherAudit, watcherLocks } from "./hermes-monitor-scenario.ts";

const roots: string[] = [];

test.after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scenarioRoot(label: string) {
	const root = mkdtempSync(join(tmpdir(), `${label}-`));
	roots.push(root);
	return root;
}

function invokeRequest(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		requestId: "request-1",
		taskId: "native",
		generation: 1,
		action: "request_status",
		parameters: { assertionIds: ["A1"], evidenceEventIds: ["hub:1"] },
		basis: { deviation: "stalled_progress", judgment: "confirmed" },
		...overrides,
	});
}

// ── existing scenario coverage ───────────────────────────────────────────────

test("scenario serve/apply/get uses owned UDS for concurrent cursor tasks", async t => {
	const s = createScenario(scenarioRoot("scenario"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await Promise.all([execute(s, ["apply", "child", "aaa", "p"]), execute(s, ["apply", "child", "bbb", "p"])]);
	await execute(s, ["apply", "output", "aaa", "one"]);
	await execute(s, ["apply", "output", "aaa", "two"]);

	const out: any = await execute(s, ["get", "output", "aaa", "1", "1"]);
	assert.equal(out.output.text, "two");
	assert.equal((await execute(s, ["get"])).ok, true);

	await execute(s, ["stop-owned"]);
	assert.deepEqual(await execute(s, ["wait-owned"]), { live: false, handles: 0 });
});

test("scenario replays Hub-journal events to two UDS consumers and admits one invoke", async t => {
	const s = createScenario(scenarioRoot("scenario-events"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);

	const first: any = await execute(s, ["get", "events", "", "", "0"]);
	const second: any = await execute(s, ["get", "events", "", "", "0"]);

	assert.ok(first.events.items.length >= 2);
	assert.deepEqual(
		second.events.items.map((event: any) => event.eventSequence),
		first.events.items.map((event: any) => event.eventSequence),
		"independent consumers read the same journal from their own cursor",
	);

	assert.equal((await execute(s, ["get", "invoke", invokeRequest()])).result.status, "accepted");
	assert.equal((await execute(s, ["get", "invoke", invokeRequest()])).result.status, "duplicate");

	await execute(s, ["stop-owned"]);
	assert.deepEqual(await execute(s, ["wait-owned"]), { live: false, handles: 0 });
});

test("hybrid scenario watches Herdr status/resync and gates polling by visibility", async t => {
	const s = createScenario(scenarioRoot("scenario-hybrid"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await waitFor(async () => (await execute(s, ["counters"])).statuses >= 1, { label: "first Herdr status" });
	const initial: any = await execute(s, ["counters"]);

	await execute(s, ["apply", "reconnect", "workspace-two"]);
	await execute(s, ["apply", "status"]);
	await waitFor(async () => (await execute(s, ["counters"])).statuses > initial.statuses, { label: "status after reconnect" });
	assert.equal((await execute(s, ["counters"])).outputs, 1, "resync output is delivered exactly once");

	await execute(s, ["apply", "disconnect"]);
	await waitFor(async () => (await execute(s, ["counters"])).subscriptions > initial.subscriptions, { label: "resubscription" });
	assert.equal((await execute(s, ["counters"])).outputs, 1, "reconnect does not replay the resync output");

	await execute(s, ["visibility", "show"]);
	await waitFor(async () => (await execute(s, ["counters"])).polls > 0, { label: "visible polling" });

	await execute(s, ["visibility", "hide"]);
	const stopped = (await execute(s, ["counters"])).polls;
	await waitFor(async () => (await execute(s, ["counters"])).polls === stopped, { label: "polling settled" });
	assert.equal((await execute(s, ["counters"])).polls, stopped, "hidden viewers stop polling");
});

test("scenario fake clock orphans explicit-gone work only at owner lease expiry", async t => {
	let now = 0;
	const s = createScenario(scenarioRoot("scenario-orphan"), { clock: { now: () => now } });
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "owner", "owner", new Date(30_000).toISOString()]);
	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "active", "p"]);
	await execute(s, ["apply", "evidence-loss"]);

	let snapshot: any = await execute(s, ["get"]);
	assert.equal(snapshot.snapshot.tasks.find((task: any) => task.id === "active").state, "recovering");

	now = 30_000;
	await execute(s, ["apply", "evidence-loss"]);
	snapshot = await execute(s, ["get"]);
	assert.equal(snapshot.snapshot.tasks.find((task: any) => task.id === "active").state, "orphaned");
});

test("scenario wait-only cancellation stays cancelled through late events", async t => {
	let now = 0;
	const s = createScenario(scenarioRoot("scenario-cancel"), { clock: { now: () => now } });
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "wait", "p"]);
	await execute(s, ["apply", "wait-only", "wait"]);
	await execute(s, ["apply", "cancel-wait", "wait"]);
	await execute(s, ["apply", "late", "wait", "late"]);

	const snapshot: any = await execute(s, ["get"]);
	assert.equal(snapshot.snapshot.tasks.find((task: any) => task.id === "wait").state, "cancelled");
});

test("owned disposables clean subscription and interval once after partial start failure", async () => {
	const s = createScenario(scenarioRoot("scenario"));
	let subscriptions = 0;
	let intervals = 0;
	registerDisposable(s, () => subscriptions++);
	registerDisposable(s, () => intervals++);

	await execute(s, ["stop-owned"]);
	await execute(s, ["stop-owned"]);

	assert.equal(subscriptions, 1);
	assert.equal(intervals, 1);
	assert.deepEqual(await execute(s, ["wait-owned"]), { live: false, handles: 0 });
});

test("scenario rejects unsafe roots and unsupported commands", async () => {
	assert.throws(() => createScenario("/"));
	await assert.rejects(execute(createScenario(scenarioRoot("scenario")), ["nope"]));
});

// ── canonical Task 21: the real foreground watcher child ─────────────────────

test("the shipped watcher child discovers the disposable Hub UDS and stays journal-only", async t => {
	const s = createScenario(scenarioRoot("scenario-watcher"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);

	const watcher: any = await execute(s, ["watcher", "start"]);
	assert.ok(watcher.child.pid, "a real Python foreground child is running");

	await waitFor(() => watcherAudit(s).some(row => row.decision === "material_event"), {
		label: "watcher journals a material event",
		timeoutMs: 15_000,
	});

	const audit = watcherAudit(s);
	assert.ok(audit.length > 0, "the watcher wrote its own audit journal");
	assert.deepEqual(
		audit.filter(row => ["invoke_proposed", "recovery_proposed", "delivered"].includes(row.decision)),
		[],
		"observe mode performs no invoke, cancel, or delivery",
	);
	for (const row of audit) {
		assert.equal(row.tier ?? "observe", "observe", "every journaled decision stays at the observe tier");
	}
	assert.deepEqual(await execute(s, ["follow-ups"]), [], "the watcher enqueues nothing");
	assert.deepEqual(await execute(s, ["cancels"]), [], "the watcher cancels nothing");
});

test("the watcher and an independent consumer keep separate cursors", async t => {
	const s = createScenario(scenarioRoot("scenario-cursors"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);
	await execute(s, ["watcher", "start"]);

	await waitFor(() => watcherAudit(s).some(row => row.decision === "material_event"), {
		label: "watcher consumes events",
		timeoutMs: 15_000,
	});

	// The watcher has advanced its own cursor; a second consumer still replays
	// the whole journal from zero.
	const replay: any = await execute(s, ["get", "events", "", "", "0"]);
	assert.ok(replay.events.items.length >= 2, "the second consumer reads from its own cursor");

	await execute(s, ["apply", "child", "second", "p"]);
	await waitFor(async () => {
		const later: any = await execute(s, ["get", "events", "", "", "0"]);
		return later.events.items.length > replay.events.items.length;
	}, { label: "journal grows for the second consumer" });
});

test("a retention gap forces the watcher to reconcile from a snapshot", async t => {
	let now = Date.parse("2026-01-01T00:00:00.000Z");
	const s = createScenario(scenarioRoot("scenario-gap"), { clock: { now: () => now } });
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);

	// Advance past the retention window, then append: the journal prunes every
	// earlier event, so its first available sequence is now well ahead of the
	// cursor a fresh consumer starts from.
	now += 25 * 60 * 60 * 1000;
	await execute(s, ["apply", "parent", "p2"]);
	await execute(s, ["apply", "child", "after-gap", "p2"]);
	const replay: any = await execute(s, ["get", "events", "", "", "0"]);
	assert.equal(replay.ok, false);
	assert.equal(replay.error, "cursor_too_old", "the journal really did drop the earlier window");

	await execute(s, ["watcher", "start"]);

	await waitFor(() => watcherAudit(s).some(row => row.decision === "snapshot_reconciled"), {
		label: "watcher reconciles from a snapshot",
		timeoutMs: 15_000,
	});

	assert.deepEqual(
		watcherAudit(s).filter(row => ["invoke_proposed", "recovery_proposed"].includes(row.decision)),
		[],
		"reconciliation never escalates past journaling",
	);
});

test("owner rollover forces the watcher to rediscover without cross-profile fallback", async t => {
	const s = createScenario(scenarioRoot("scenario-rollover"));
	const first: any = await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);
	await execute(s, ["watcher", "start"]);
	await waitFor(() => watcherAudit(s).some(row => row.decision === "material_event"), {
		label: "watcher attaches to the first owner",
		timeoutMs: 15_000,
	});

	const rolled: any = await execute(s, ["roll-owner"]);
	assert.notEqual(rolled.socketPath, first.socketPath, "rollover mints a new socket");

	await execute(s, ["apply", "parent", "p2"]);
	await execute(s, ["apply", "child", "after-rollover", "p2"]);

	await waitFor(() => {
		const audit = watcherAudit(s);
		const rolloverIndex = audit.findIndex(row => row.decision === "offline");
		return rolloverIndex >= 0 && audit.slice(rolloverIndex).some(row => row.decision === "material_event");
	}, { label: "watcher rediscovers after rollover", timeoutMs: 20_000 });

	assert.deepEqual(await execute(s, ["follow-ups"]), [], "rollover never redrives work");
});

test("SIGINT stops the watcher, releases its lock, and leaves no child behind", async t => {
	const s = createScenario(scenarioRoot("scenario-sigint"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);
	const watcher: any = await execute(s, ["watcher", "start"]);
	await waitFor(() => watcherLocks(s).length === 1, { label: "watch.lock is taken", timeoutMs: 15_000 });
	await waitFor(() => watcherAudit(s).length > 0, { label: "watcher writes its journal", timeoutMs: 15_000 });

	const result: any = await execute(s, ["watcher", "stop"]);

	assert.equal(result.stopped, true);
	assert.deepEqual(watcherLocks(s), [], "watch.lock is released");
	assert.equal(watcher.child.killed || watcher.child.exitCode !== null || watcher.child.signalCode !== null, true);
	assert.equal(existsSync(watcher.auditPath), true, "the local journal survives the stop");
	assert.deepEqual(
		watcher.stdout.join("").match(/token|secret/gi) ?? [],
		[],
		"the watcher never prints credential material",
	);
});

// ── canonical Task 21: synthetic-local queue, native, coms, and N+1 mechanics ─

test("synthetic-local: a full queue refuses the invoke and creates no follow-up", async t => {
	const s = createScenario(scenarioRoot("scenario-queue"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);
	await execute(s, ["queue", "1"]);

	const refused: any = await execute(s, ["get", "invoke", invokeRequest()]);

	assert.equal(refused.result.status, "queue_full");
	assert.deepEqual(await execute(s, ["follow-ups"]), []);

	await execute(s, ["queue", "0"]);
	const accepted: any = await execute(s, ["get", "invoke", invokeRequest({ requestId: "request-2" })]);

	assert.equal(accepted.result.status, "accepted");
	assert.equal((await execute(s, ["follow-ups"])).length, 1);
});

test("synthetic-local: a duplicate accepted invoke yields exactly one production follow-up", async t => {
	const s = createScenario(scenarioRoot("scenario-followup"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);

	assert.equal((await execute(s, ["get", "invoke", invokeRequest()])).result.status, "accepted");
	assert.equal((await execute(s, ["get", "invoke", invokeRequest()])).result.status, "duplicate");

	const followUps: any[] = await execute(s, ["follow-ups"]);

	assert.equal(followUps.length, 1);
	assert.deepEqual(followUps[0].options, { deliverAs: "followUp", triggerTurn: true });
	assert.equal(followUps[0].message.customType, "hermes-watchdog-invoke");
	assert.match(followUps[0].message.content, /^\[Hermes watchdog request\]/);
});

test("synthetic-local: a stale or superseded owner never redrives an accepted request", async t => {
	const s = createScenario(scenarioRoot("scenario-redrive"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);
	assert.equal((await execute(s, ["get", "invoke", invokeRequest()])).result.status, "accepted");

	const superseded: any = await execute(s, ["get", "invoke", invokeRequest({ requestId: "request-next", generation: 2 })]);

	assert.equal(superseded.result.status, "stale_generation");
	assert.equal((await execute(s, ["follow-ups"])).length, 1, "the N+1 request adds no follow-up");
});

test("synthetic-local: a real native child is cancelled only by its exact generation", async t => {
	const s = createScenario(scenarioRoot("scenario-native"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);
	const native: any = await execute(s, ["native", "start", "native", "1"]);
	assert.ok(native.pid, "a real disposable child process is running");

	const wrongGeneration: any = await execute(s, ["get", "cancel", "native", "2"]);
	assert.deepEqual(wrongGeneration.result, { cancelled: false, reason: "unsupported" });
	assert.equal(await execute(s, ["native", "alive", "native", "1"]), true, "N+1 leaves generation N untouched");

	const exact: any = await execute(s, ["get", "cancel", "native", "1"]);
	assert.deepEqual(exact.result, { cancelled: true, state: "cancelled" });
	assert.equal(await execute(s, ["native", "alive", "native", "1"]), false, "the exact generation exits");

	const snapshot: any = await execute(s, ["get"]);
	assert.equal(snapshot.snapshot.tasks.find((task: any) => task.id === "native").state, "cancelled");
	assert.deepEqual(await execute(s, ["cancels"]), [
		{ taskId: "native", generation: 2 },
		{ taskId: "native", generation: 1 },
	]);
});

test("synthetic-local: a terminal task refuses recovery-shaped invokes", async t => {
	const s = createScenario(scenarioRoot("scenario-terminal"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "native", "p"]);
	await execute(s, ["native", "start", "native", "1"]);
	await execute(s, ["get", "cancel", "native", "1"]);

	const refused: any = await execute(s, ["get", "invoke", invokeRequest({ requestId: "recovery:native:1" })]);

	assert.equal(refused.result.status, "already_terminal");
	assert.deepEqual(await execute(s, ["follow-ups"]), [], "a terminal target creates no recovery follow-up");
});

test("synthetic-local: a coms wait-only cancellation abandons the local wait and never recovers", async t => {
	const s = createScenario(scenarioRoot("scenario-coms"));
	await execute(s, ["serve"]);
	t.after(() => execute(s, ["stop-owned"]));

	await execute(s, ["apply", "parent", "p"]);
	await execute(s, ["apply", "child", "coms", "p"]);
	await execute(s, ["apply", "wait-only", "coms"]);

	await execute(s, ["apply", "cancel-wait", "coms"]);

	const snapshot: any = await execute(s, ["get"]);
	assert.equal(snapshot.snapshot.tasks.find((task: any) => task.id === "coms").state, "cancelled");
	assert.deepEqual(await execute(s, ["cancels"]), [], "no process cancellation is attempted for a coms run");
	assert.deepEqual(await execute(s, ["follow-ups"]), [], "coms cancellation creates no recovery invoke");

	const recovery: any = await execute(s, ["get", "invoke", invokeRequest({ requestId: "recovery:coms:1", taskId: "coms" })]);
	assert.equal(recovery.result.status, "already_terminal", "a cancelled coms run cannot be recovered");
});
