import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MonitorEventJournal } from "./hermes-monitor-events.ts";

const EPOCH = "2026-01-01T00:00:00.000Z";
const roots: string[] = [];

test.after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function journalFile() {
	const root = mkdtempSync(join(tmpdir(), "events-"));
	roots.push(root);
	return join(root, "events.ndjson");
}

function event(sequence: number, occurredAt = EPOCH) {
	return {
		schema: "agent-fleet.monitor-event",
		schemaVersion: 1,
		eventId: `hub:evt-${sequence}`,
		eventSequence: sequence,
		profileKey: "sha256:abc",
		hubInstanceId: "hub",
		ownerId: "owner",
		occurredAt,
		kind: "task.state_changed",
		task: { id: "task", generation: 1, toState: "running", outputSequence: sequence },
		materialKey: `task:${sequence}`,
	};
}

const now = () => new Date(EPOCH);
const sequences = (result: any) => result.items.map((item: any) => item.eventSequence);

test("journal persists ordered facts before replay and rejects cursor gaps", () => {
	const file = journalFile();
	const journal = new MonitorEventJournal({ file, now });
	journal.append(event(1));
	journal.append(event(2));

	const restarted = new MonitorEventJournal({ file, now });

	assert.equal(restarted.latestSequence(), 2);
	assert.deepEqual(sequences(restarted.replay(0, 10)), [1, 2]);
	assert.equal(restarted.replay(-1, 10).error, "cursor_too_old");
});

test("a retained journal restarts from its first retained sequence", () => {
	const file = journalFile();
	let instant = new Date(EPOCH);
	const journal = new MonitorEventJournal({ file, now: () => instant });
	journal.append(event(1));

	instant = new Date("2026-01-03T00:00:00.000Z");
	journal.append(event(2, instant.toISOString()));
	const restarted = new MonitorEventJournal({ file, now: () => instant });

	assert.equal(restarted.latestSequence(), 2);
	assert.deepEqual(sequences(restarted.replay(1, 10)), [2]);
});

test("appending does not leak file descriptors", { skip: process.platform !== "linux" }, () => {
	const file = journalFile();
	const instant = new Date(EPOCH);
	const journal = new MonitorEventJournal({ file, now: () => instant });

	const before = readdirSync("/proc/self/fd").length;
	for (let sequence = 1; sequence <= 100; sequence++) journal.append(event(sequence, instant.toISOString()));

	assert.ok(readdirSync("/proc/self/fd").length <= before + 2);
});

test("a long poll replays an appended fact as soon as it lands", async () => {
	const journal = new MonitorEventJournal({ file: journalFile(), now });

	const live = journal.replay(0, 10, 100) as Promise<any>;
	journal.append(event(1));

	assert.deepEqual(sequences(await live), [1]);
});

test("a long poll times out cleanly when nothing arrives", async () => {
	const journal = new MonitorEventJournal({ file: journalFile(), now });

	const result = await (journal.replay(1, 10, 1) as Promise<any>);

	assert.equal(result.timedOut, true);
});

test("a disconnected waiter is released without being reported as a timeout", async () => {
	const journal = new MonitorEventJournal({ file: journalFile(), now });
	const abort = new AbortController();

	const disconnected = journal.replay(1, 10, 100, abort.signal) as Promise<any>;
	abort.abort();

	assert.equal((await disconnected).timedOut, false);
});

test("a torn journal fails closed", () => {
	const file = journalFile();
	writeFileSync(file, "{bad\n", { mode: 0o600 });

	assert.throws(() => new MonitorEventJournal({ file }), /torn|unsafe/);
});

test("an over-permissive journal mode fails closed", () => {
	const file = journalFile();
	writeFileSync(file, "", { mode: 0o600 });
	chmodSync(file, 0o644);

	assert.throws(() => new MonitorEventJournal({ file }), /unsafe/);
});
