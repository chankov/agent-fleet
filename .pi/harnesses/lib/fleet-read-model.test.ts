import assert from "node:assert/strict";
import test from "node:test";
import { buildFleetRows, fleetTiming, summarise, unionMs, type FleetRow, type FleetSource } from "./fleet-read-model.ts";

const base = (key: string, status: FleetRow["status"] = "running"): any => ({ key, name: key, status, model: "model-x", backend: "native", contextPct: 25, contextTokens: 250, elapsed: 1_000, startedAt: 10, toolCount: 2, lastWork: "read file", hasTimeline: true });

test("buildFleetRows flattens all fleet kinds and delegation descendants with observability fields", () => {
	const source: FleetSource = { specialists: [{ ...base("architect"), delegates: [{ ...base("child"), children: [{ ...base("grandchild") }] }] }], research: [{ ...base("r2"), name: "r2 research" }], peers: [{ key: "peer", name: "peer", model: "claude", lastWork: "awaiting turn", colorHex: "#fff" }] };
	const rows = buildFleetRows(source, { showFinished: true });
	assert.deepEqual(rows.map(r => [r.key, r.kind, r.depth, r.parentKey]), [["architect", "specialist", 0, undefined], ["child", "delegate", 1, "architect"], ["grandchild", "delegate", 2, "child"], ["r2", "research", 0, undefined], ["peer", "peer", 0, undefined]]);
	assert.equal(rows[0].model, "model-x");
	assert.equal(rows[0].contextTokens, 250); assert.equal(rows[0].lastWork, "read file"); assert.equal(rows[4].backend, "coms"); assert.equal(rows[4].contextPct, null);
});

test("ordering, filtering, peer classification, and parent retention are deterministic", () => {
	const source: FleetSource = { specialists: [{ ...base("done", "done"), startedAt: 1 }, { ...base("run", "running"), startedAt: 99 }, { ...base("parent", "done"), delegates: [{ ...base("live", "running") }] }], research: [], peers: [{ key: "pending", name: "pending", model: "m", lastWork: "", pending: true, staleCount: 3 }, { key: "stale", name: "stale", model: "m", lastWork: "", staleCount: 3 }] };
	assert.deepEqual(buildFleetRows(source, { showFinished: false }).map(r => r.key), ["run", "pending", "parent", "live"]);
	assert.deepEqual(buildFleetRows(source, { showFinished: true }).map(r => r.key), ["run", "pending", "done", "parent", "live", "stale"]);
	assert.deepEqual(buildFleetRows(source, { showFinished: true, query: "MODEL-X" }).map(r => r.key), ["run", "done", "parent", "live"]);
	assert.equal(buildFleetRows(source, { showFinished: true }).find(r => r.key === "pending")?.status, "pending");
	assert.equal(buildFleetRows(source, { showFinished: true }).find(r => r.key === "stale")?.status, "stale");
});

test("idle roster rows remain visible and reconcile to one running row beside coms peers", () => {
	const roster: FleetSource = {
		specialists: [base("builder", "idle"), base("researcher", "idle")],
		research: [],
		peers: [],
	};
	assert.deepEqual(buildFleetRows(roster, { showFinished: false }).map(row => row.key), ["builder", "researcher"]);
	const withComs: FleetSource = { ...roster, peers: [{ key: "peer:coms-1", name: "coms", model: "claude", lastWork: "available", pending: true }] };
	const rosterRows = buildFleetRows(withComs, { showFinished: false });
	assert.deepEqual(rosterRows.map(row => [row.key, row.status]), [["peer:coms-1", "pending"], ["builder", "idle"], ["researcher", "idle"]]);

	const runningRows = buildFleetRows({ ...withComs, specialists: [{ ...base("builder", "running"), startedAt: 20 }, base("researcher", "idle")] }, { showFinished: false });
	assert.deepEqual(runningRows.map(row => row.key), ["builder", "peer:coms-1", "researcher"]);
	assert.equal(runningRows.filter(row => row.key === "builder").length, 1);
});

test("fleetTiming preserves completed history intervals for overlap-aware wall time", () => {
	const first = fleetTiming({ startedAt: 1_000, endedAt: 301_000 }, 999_999);
	const second = fleetTiming({ startedAt: 301_000, endedAt: 601_000 }, 999_999);
	const rows = buildFleetRows({ specialists: [
		{ ...base("first", "done"), ...first },
		{ ...base("second", "done"), ...second },
	], research: [], peers: [] }, { showFinished: true });
	assert.deepEqual(summarise(rows).intervals, [[1_000, 301_000], [301_000, 601_000]]);
	assert.equal(unionMs(summarise(rows).intervals), 600_000);
	assert.equal(unionMs([[0, 100], [50, 150], [300, 400]]), 250);
});

test("summarise is deterministic and supplies intervals for overlap-aware wall time", () => {
	const rows = buildFleetRows({ specialists: [{ ...base("a"), startedAt: 0, elapsed: 100 }, { ...base("b", "done"), startedAt: 50, elapsed: 100, contextTokens: 50 }, { ...base("bad", "error"), startedAt: undefined }], research: [], peers: [] }, { showFinished: true });
	assert.deepEqual(summarise(rows), { running: 1, done: 1, failed: 1, totalTokens: 550, intervals: [[0, 100], [50, 150]] });
	assert.deepEqual(buildFleetRows({ specialists: [], research: [], peers: [] }, { showFinished: false }), []);
	assert.deepEqual(summarise([]), { running: 0, done: 0, failed: 0, totalTokens: 0, intervals: [] });
});
