import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MonitorInvokeJournal } from "./monitor-invoke-journal.ts";
import { createMonitorInvokeAdmission } from "./monitor-invoke.ts";

const invoke = {
	requestId: "request-a",
	taskId: "route-planner",
	generation: 1,
	action: "request_status",
	parameters: { assertionIds: ["A1"], evidenceEventIds: ["hub:1"] },
	basis: { deviation: "stalled_progress", judgment: "confirmed" },
};

const journalFile = () => join(mkdtempSync(join(tmpdir(), "invoke-")), "audit.ndjson");

test("invoke intent is durable, field-redacted, and hash-safe across restart", () => {
	const file = journalFile();
	const journal = new MonitorInvokeJournal(file);
	assert.equal(journal.admit(invoke.requestId, invoke).row?.status, "pending");
	assert.equal(journal.admit(invoke.requestId, invoke).duplicate, true);
	assert.equal(journal.admit(invoke.requestId, { ...invoke, action: "request_research" }).error, "idempotency_conflict");
	journal.result(invoke.requestId, "accepted");
	assert.equal(new MonitorInvokeJournal(file).admit(invoke.requestId, invoke).row?.status, "accepted");
});

test("an orphaned durable pending row is re-driven exactly once after restart", async () => {
	const file = journalFile();
	new MonitorInvokeJournal(file).admit(invoke.requestId, invoke); // simulate a crash before enqueue
	let queued = 0;
	const task = { id: invoke.taskId, generation: 1, state: "running", ownerSessionId: "owner" };
	const admission = createMonitorInvokeAdmission({
		journal: new MonitorInvokeJournal(file),
		task: () => task,
		owner: () => "owner",
		queueDepth: () => 0,
		queueLimit: 1,
		enqueue: () => { queued += 1; },
	});
	assert.deepEqual(await admission(invoke), { status: "accepted" });
	assert.equal(queued, 1);
	assert.deepEqual(await admission(invoke), { status: "duplicate" });
	assert.equal(queued, 1);
});

test("canonical hashing dedupes reordered payloads and owner rollover cannot redrive an accepted follow-up", async () => {
	const file = journalFile();
	const reordered = { ...invoke, parameters: { evidenceEventIds: ["hub:1"], assertionIds: ["A1"] }, basis: { judgment: "confirmed", deviation: "stalled_progress" } };
	assert.equal(MonitorInvokeJournal.hash(invoke), MonitorInvokeJournal.hash(reordered));
	let queued = 0;
	const task = { id: invoke.taskId, generation: 1, state: "running", ownerSessionId: "owner-a" };
	const first = createMonitorInvokeAdmission({ journal: new MonitorInvokeJournal(file), task: () => task, owner: () => "owner-a", queueDepth: () => 0, queueLimit: 1, enqueue: () => { queued += 1; } });
	assert.deepEqual(await first(invoke), { status: "accepted" });
	task.ownerSessionId = "owner-b";
	const afterRollover = createMonitorInvokeAdmission({ journal: new MonitorInvokeJournal(file), task: () => task, owner: () => "owner-b", queueDepth: () => 0, queueLimit: 1, enqueue: () => { queued += 1; } });
	assert.deepEqual(await afterRollover(reordered), { status: "duplicate" });
	assert.equal(queued, 1);
});
