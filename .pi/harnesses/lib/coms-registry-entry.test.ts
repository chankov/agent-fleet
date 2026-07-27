// Tests for the shared live-registry entry builder.
//
// The regression that created this module: both harnesses rewrote `started_at`
// with the current time on every 30s heartbeat, so a session that had been
// running for two hours reported an age of a few seconds. The first test is
// that one, written the way the bug actually presented — two writes, one
// session.

import test from "node:test";
import assert from "node:assert/strict";

import { buildLiveRegistryEntry, type ComsIdentity } from "./coms-registry-entry.ts";

const identity: ComsIdentity = {
	session_id: "01KYFW92KPDGDYT3MAAM6JA6JN",
	name: "orchestrator",
	purpose: "agent-hub dispatcher",
	color: "#8ab4f8",
	cwd: "/home/nchankov/repos/agent-fleet",
	endpoint: "/home/nchankov/.pi/coms/sockets/01KYFW92KPDGDYT3MAAM6JA6JN.sock",
	explicit: true,
	model: "gpt-5.6-luna",
	started_at: "2026-07-26T18:00:00.000Z",
};

test("the heartbeat carries started_at forward and only moves heartbeat_at", () => {
	const first = buildLiveRegistryEntry(identity, { now: "2026-07-26T18:00:30.000Z", pid: 4242 });
	const later = buildLiveRegistryEntry(identity, { now: "2026-07-26T20:00:00.000Z", pid: 4242 });

	assert.equal(first.started_at, identity.started_at);
	assert.equal(later.started_at, identity.started_at, "two hours of heartbeats must not reset the start");
	assert.equal(first.heartbeat_at, "2026-07-26T18:00:30.000Z");
	assert.equal(later.heartbeat_at, "2026-07-26T20:00:00.000Z");
});

test("the live model wins over the registered one, and absence falls back", () => {
	const switched = buildLiveRegistryEntry(identity, { now: "t", pid: 1, model: "gpt-5.6-sol" });
	const unknown = buildLiveRegistryEntry(identity, { now: "t", pid: 1, model: null });

	assert.equal(switched.model, "gpt-5.6-sol");
	assert.equal(unknown.model, "gpt-5.6-luna");
});

test("context and queue are non-negative integers whatever arrives", () => {
	const entry = buildLiveRegistryEntry(identity, {
		now: "t",
		pid: 1,
		contextUsedPct: 12.6,
		queueDepth: 3,
	});
	const missing = buildLiveRegistryEntry(identity, { now: "t", pid: 1 });
	const nonsense = buildLiveRegistryEntry(identity, {
		now: "t",
		pid: 1,
		contextUsedPct: Number.NaN,
		queueDepth: -1,
	});

	assert.equal(entry.context_used_pct, 13);
	assert.equal(entry.queue_depth, 3);
	assert.equal(missing.context_used_pct, 0);
	assert.equal(missing.queue_depth, 0);
	assert.equal(nonsense.context_used_pct, 0);
	assert.equal(nonsense.queue_depth, 0, "a negative queue is a bug upstream, not a value to publish");
});

test("every field a reader relies on is present, including on a self-heal write", () => {
	const entry = buildLiveRegistryEntry(identity, { now: "2026-07-26T18:00:30.000Z", pid: 4242 });

	assert.deepEqual(Object.keys(entry).sort(), [
		"color",
		"context_used_pct",
		"cwd",
		"endpoint",
		"explicit",
		"heartbeat_at",
		"model",
		"name",
		"pid",
		"purpose",
		"queue_depth",
		"session_id",
		"started_at",
		"version",
	]);
	assert.equal(entry.pid, 4242, "the pid comes from the live process, not from registration");
	assert.equal(entry.version, 1);
});
