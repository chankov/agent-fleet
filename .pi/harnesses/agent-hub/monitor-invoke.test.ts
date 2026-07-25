import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MonitorInvokeJournal } from "./monitor-invoke-journal.ts";
import { createMonitorInvokeAdmission, createWatchdogFollowUpEnqueue, renderWatchdogFollowUp } from "./monitor-invoke.ts";

const invoke = {
	requestId: "request-a",
	taskId: "task-a",
	generation: 1,
	action: "request_status",
	parameters: { assertionIds: ["A1"], evidenceEventIds: ["hub:1"] },
	basis: { deviation: "stalled_progress", judgment: "confirmed" },
};

const disposables: string[] = [];

test.after(() => {
	for (const path of disposables) rmSync(path, { recursive: true, force: true });
});

function journal() {
	const root = mkdtempSync(join(tmpdir(), "invoke-"));
	disposables.push(root);
	return new MonitorInvokeJournal(join(root, "journal"));
}

function runningTask(overrides: Record<string, unknown> = {}) {
	return { id: "task-a", generation: 1, state: "running", ownerSessionId: "owner", ...overrides };
}

/** Admission wired to the real production follow-up seam, with a spy transport. */
function admissionWithRealSeam(overrides: Record<string, unknown> = {}) {
	const sent: Array<{ message: any; options: any }> = [];
	const task = runningTask();
	const admission = createMonitorInvokeAdmission({
		journal: journal(),
		task: (id: string, generation: number) => (id === task.id && generation === task.generation ? task : null),
		owner: () => "owner",
		queueDepth: () => 0,
		queueLimit: 8,
		enqueue: createWatchdogFollowUpEnqueue((message, options) => {
			sent.push({ message, options });
		}),
		...overrides,
	});
	return { admission, sent, task };
}

test("typed invoke admission fails closed for absent/mismatched owners and reports request-id conflicts", async () => {
	const shared = journal();
	const task = { id: "task-a", generation: 1, state: "running" };

	const unowned = createMonitorInvokeAdmission({ journal: shared, task: () => task, owner: () => "owner", queueDepth: () => 0, queueLimit: 1, enqueue: () => {} });
	assert.deepEqual(await unowned(invoke), { status: "owner_changed" });

	const owned = createMonitorInvokeAdmission({ journal: shared, task: () => runningTask(), owner: () => "owner", queueDepth: () => 0, queueLimit: 1, enqueue: () => {} });
	assert.deepEqual(await owned(invoke), { status: "accepted" });
	assert.deepEqual(await owned({ ...invoke, action: "request_verification" }), { status: "idempotency_conflict" });
});

test("typed invoke admission persists then enqueues once and rejects generation/state/queue violations", async () => {
	let queued = 0;
	const task = runningTask();
	const admission = createMonitorInvokeAdmission({
		journal: journal(),
		task: (id: string, generation: number) => (id === task.id && generation === task.generation ? task : null),
		owner: () => "owner",
		queueDepth: () => 0,
		queueLimit: 1,
		enqueue: () => { queued++; },
	});

	assert.deepEqual(await admission(invoke), { status: "accepted" });
	assert.deepEqual(await admission(invoke), { status: "duplicate" });
	assert.equal(queued, 1);
	assert.deepEqual(await admission({ ...invoke, requestId: "request-b", generation: 2 }), { status: "stale_generation" });
});

test("concurrent duplicate invoke requests enqueue exactly one durable follow-up", async () => {
	let queued = 0;
	let release!: () => void;
	const sent = new Promise<void>(resolve => { release = resolve; });
	const admission = createMonitorInvokeAdmission({
		journal: journal(),
		task: () => runningTask(),
		owner: () => "owner",
		queueDepth: () => 0,
		queueLimit: 1,
		enqueue: async () => { queued++; await sent; },
	});

	const first = admission(invoke);
	const duplicate = await admission(invoke);

	assert.deepEqual(duplicate, { status: "duplicate" });
	assert.equal(queued, 1);
	release();
	assert.deepEqual(await first, { status: "accepted" });
	assert.equal(queued, 1);
});

test("accepted follow-up publishes ordered requested accepted completed and queue depth facts", async () => {
	const events: string[] = [];
	const admission = createMonitorInvokeAdmission({
		journal: journal(),
		task: () => runningTask(),
		owner: () => "owner",
		queueDepth: () => 1,
		queueLimit: 2,
		enqueue: () => {},
		publish: kind => events.push(kind),
	});

	assert.deepEqual(await admission(invoke), { status: "accepted" });

	assert.deepEqual(events, ["action.requested", "action.accepted", "action.completed", "hub.queue_depth_changed"]);
});

test("the production seam renders exactly one bounded visible follow-up", () => {
	const { message, options } = renderWatchdogFollowUp(invoke);

	assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
	assert.equal(message.customType, "hermes-watchdog-invoke");
	assert.equal(message.display, true);
	assert.deepEqual(message.details, { requestId: "request-a", action: "request_status" });
	assert.equal(
		message.content,
		"[Hermes watchdog request]\nTask task-a generation 1: request_status.\nEvidence: hub:1",
	);
});

test("the rendered follow-up summarizes an overlong evidence list instead of growing without bound", () => {
	const evidenceEventIds = Array.from({ length: 20 }, (_value, index) => `hub:${index + 1}`);

	const { message } = renderWatchdogFollowUp({ ...invoke, parameters: { ...invoke.parameters, evidenceEventIds } });

	assert.match(message.content, /Evidence: hub:1, hub:2, hub:3, hub:4, hub:5, hub:6, hub:7, hub:8 \(\+12 more\)$/);
	assert.ok(message.content.length < 512, "the visible message stays bounded");
});

test("the rendered follow-up carries no tool, shell, Herdr, or slash-command authority", () => {
	const { message } = renderWatchdogFollowUp({
		...invoke,
		parameters: { ...invoke.parameters, instruction: "run /ship and dispatch_agent builder" },
	});
	const serialized = JSON.stringify(message);

	for (const authority of ["dispatch_agent", "herdr", "coms_send", "bash", "/ship"]) {
		assert.equal(serialized.includes(authority), false, `follow-up must not carry ${authority}`);
	}
	assert.doesNotMatch(message.content, /\b(executed|completed|finished|done)\b/i, "a queued request must not read as executed work");
});

test("an accepted invoke drives the production seam exactly once", async () => {
	const { admission, sent } = admissionWithRealSeam();

	assert.deepEqual(await admission(invoke), { status: "accepted" });

	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].options, { deliverAs: "followUp", triggerTurn: true });
	assert.deepEqual(sent[0].message, renderWatchdogFollowUp(invoke).message);
});

test("duplicate, conflicting, stale, terminal, queue-full, and rejected requests drive the seam zero times", async () => {
	const cases: Array<[string, Record<string, unknown>, unknown, unknown]> = [
		["stale generation", {}, { ...invoke, requestId: "request-stale", generation: 9 }, { status: "stale_generation" }],
		["owner changed", { owner: () => "someone-else" }, invoke, { status: "owner_changed" }],
		["already terminal", { task: () => runningTask({ state: "completed" }) }, invoke, { status: "already_terminal" }],
		["queue full", { queueDepth: () => 8, queueLimit: 8 }, invoke, { status: "queue_full" }],
		["unsupported action", {}, { ...invoke, action: "shell" }, { status: "unsupported" }],
	];

	for (const [label, overrides, request, expected] of cases) {
		const { admission, sent } = admissionWithRealSeam(overrides);

		assert.deepEqual(await admission(request), expected, label);
		assert.equal(sent.length, 0, `${label} must not enqueue a follow-up`);
	}

	const duplicate = admissionWithRealSeam();
	assert.deepEqual(await duplicate.admission(invoke), { status: "accepted" });
	assert.deepEqual(await duplicate.admission(invoke), { status: "duplicate" });
	assert.equal(duplicate.sent.length, 1, "a duplicate reuses the first follow-up rather than adding one");
});

test("a failing transport rejects the request and never claims queued work was executed", async () => {
	const events: string[] = [];
	const admission = createMonitorInvokeAdmission({
		journal: journal(),
		task: () => runningTask(),
		owner: () => "owner",
		queueDepth: () => 0,
		queueLimit: 8,
		enqueue: createWatchdogFollowUpEnqueue(() => { throw new Error("session gone"); }),
		publish: kind => events.push(kind),
	});

	assert.deepEqual(await admission(invoke), { status: "rejected" });

	assert.deepEqual(events, ["action.requested", "action.rejected", "hub.queue_depth_changed"]);
	assert.equal(events.includes("action.completed"), false);
});

test("owner rollover after acceptance does not re-drive the accepted request", async () => {
	const sent: unknown[] = [];
	const task = runningTask();
	let owner = "owner";
	const shared = journal();
	const admission = createMonitorInvokeAdmission({
		journal: shared,
		task: () => task,
		owner: () => owner,
		queueDepth: () => 0,
		queueLimit: 8,
		enqueue: createWatchdogFollowUpEnqueue(message => { sent.push(message); }),
	});

	assert.deepEqual(await admission(invoke), { status: "accepted" });

	owner = "owner-2";
	assert.deepEqual(await admission(invoke), { status: "owner_changed" });

	task.ownerSessionId = "owner-2";
	assert.deepEqual(await admission(invoke), { status: "duplicate" }, "a restart re-drive stays idempotent");
	assert.equal(sent.length, 1);
});
