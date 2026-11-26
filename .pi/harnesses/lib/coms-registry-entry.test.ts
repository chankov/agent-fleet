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
	model: "gpt-6-luna",
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
	const switched = buildLiveRegistryEntry(identity, { now: "t", pid: 1, model: "gpt-6.2-sol" });
	const unknown = buildLiveRegistryEntry(identity, { now: "t", pid: 1, model: null });

	assert.equal(switched.model, "gpt-6.2-sol");
	assert.equal(unknown.model, "gpt-6-luna");
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
	assert.equal(missing.context_used_pct, null);
 assert.equal(missing.context_measurement,"unknown");
 const zero=buildLiveRegistryEntry(identity,{now:"t",pid:1,contextUsedPct:0});assert.equal(zero.context_used_pct,0);assert.equal(zero.context_measurement,"measured");
	assert.equal(missing.queue_depth, 0);
	assert.equal(nonsense.context_used_pct, null);
	assert.equal(nonsense.queue_depth, 0, "a negative queue is a bug upstream, not a value to publish");
});

test("every field a reader relies on is present, including on a self-heal write", () => {
	const entry = buildLiveRegistryEntry(identity, { now: "2026-07-26T18:00:30.000Z", pid: 4242 });

	assert.deepEqual(Object.keys(entry).sort(), [
		"color",
  "context_measurement",
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

// ── read_only (PLAN-11-01, decision D3) ──
// The Hub admits a read-only role to a peer only on `read_only: true`. The claim
// is made at registration from checked launch evidence; the heartbeat rebuilds
// the entry every 30s and must neither invent nor flip it.

test("a registered read_only claim round-trips through the entry file shape", () => {
	const entry = buildLiveRegistryEntry({ ...identity, read_only: true }, { now: "t", pid: 1 });
	assert.equal(entry.read_only, true);
	assert.equal(JSON.parse(JSON.stringify(entry)).read_only, true, "the JSON written to the registry keeps the claim");
});

test("a peer that claims nothing publishes no read_only field at all", () => {
	const entry = buildLiveRegistryEntry(identity, { now: "t", pid: 1 });
	assert.equal(Object.hasOwn(entry, "read_only"), false, "absent, not false: old and non-claiming entries read alike");
	for (const value of [false, "true", 1, null] as unknown[]) {
		const odd = buildLiveRegistryEntry({ ...identity, read_only: value as boolean }, { now: "t", pid: 1 });
		assert.equal(Object.hasOwn(odd, "read_only"), false, `only literal true is a claim, not ${JSON.stringify(value)}`);
	}
});

test("heartbeats never add or flip read_only — only the registration identity decides", () => {
	// Whatever a caller smuggles into the live snapshot is ignored.
	const forged = { now: "t", pid: 1, read_only: true } as unknown as Parameters<typeof buildLiveRegistryEntry>[1];
	assert.equal(Object.hasOwn(buildLiveRegistryEntry(identity, forged), "read_only"), false, "a heartbeat cannot invent the claim");

	const readOnly: ComsIdentity = { ...identity, read_only: true };
	const revoke = { now: "t", pid: 1, read_only: false } as unknown as Parameters<typeof buildLiveRegistryEntry>[1];
	for (const now of ["2026-07-26T18:00:30.000Z", "2026-07-26T18:01:00.000Z", "2026-07-26T20:00:00.000Z"]) {
		assert.equal(buildLiveRegistryEntry(readOnly, { now, pid: 4242, queueDepth: 2, contextUsedPct: 40 }).read_only, true);
	}
	assert.equal(buildLiveRegistryEntry(readOnly, revoke).read_only, true, "a heartbeat cannot flip it either");
});
