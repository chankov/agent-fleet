import assert from "node:assert/strict";
import test from "node:test";
import { buildFleetRows, fleetTiming, projectSystem1Owner, selectWidgetRows, summarise, summariseWidget, system1Visible, unionMs, type FleetRow, type FleetSource, type System1CheckInput } from "./fleet-read-model.ts";

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

test("widget retention is exact at 10 seconds, pins only the same run, and keeps structural ancestors", () => {
	const source: FleetSource = { specialists: [{ ...base("parent", "done"), endedAt: 1, runToken: "p:1", delegates: [{ ...base("child", "done"), endedAt: 1000, runToken: "c:1" }] }], research: [], peers: [] };
	const rows = buildFleetRows(source, { showFinished: true });
	assert.deepEqual(selectWidgetRows(rows, 10_999).map(row => row.key), ["parent", "child"]);
	assert.deepEqual(selectWidgetRows(rows, 11_000).map(row => row.key), []);
	assert.deepEqual(selectWidgetRows(rows, 11_000, { key: "child", runToken: "c:1" }).map(row => [row.key, row.structuralOnly]), [["parent", true], ["child", false]]);
	assert.deepEqual(selectWidgetRows(rows, 11_000, { key: "child", runToken: "c:old" }), []);
	assert.deepEqual(selectWidgetRows([], 11_000, { key: "child", runToken: "c:1" }), []);
});

test("widget summary separates peers, uses context max and overlap-aware task wall with known totals", () => {
	const rows: FleetRow[] = [
		{ ...base("a"), kind: "specialist", depth: 0, timingKind: "run", contextPct: 38, startedAt: 0, elapsed: 100 },
		{ ...base("b"), kind: "research", depth: 0, timingKind: "run", contextPct: null, startedAt: 50, elapsed: 100 },
		{ ...base("peer"), kind: "peer", depth: 0, backend: "coms", timingKind: "wait", contextPct: null, startedAt: 0, elapsed: 999 },
		{ ...base("struct"), kind: "specialist", depth: 0, structuralOnly: true, contextPct: 99 },
	];
	assert.deepEqual(summariseWidget(rows), { running: 2, peerActive: 1, done: 0, failed: 0, contextMax: 38, contextKnown: 1, contextTotal: 2, wallMs: 150, wallKnown: 2, wallTotal: 2 });
});

const check = (overrides: Partial<System1CheckInput> = {}): System1CheckInput => ({
	dispatchId: "dispatch-1", attemptId: "attempt-1", checkId: "check-1", snapshotId: "snap-1",
	evaluation: "finished", llm: "finished", status: "ok", reason: "unknown", elapsedMs: 402, finishedAt: 1_000,
	rule: "failures", effectiveMode: "shadow", configuredMode: "shadow", statusChoice: "on_track",
	numerical: { status_confidence: 0.88 }, returnedModel: "jev-1.13.0", usage: { inputTokens: 3, outputTokens: 1 },
	source: "llm", applied: "no", outcome: "continue", llmVerdict: "stuck", ...overrides,
});

test("A14 System 1 keeps the owner row through idle retention without changing worker counters", () => {
	const view = projectSystem1Owner(check(), "builder:dispatch-1", 2_000)!;
	assert.match(view.label, /S1 on_track/);
	assert.match(view.label, /LLM parallel/);
	assert.match(view.detail, /confidence 0\.88/);
	assert.match(view.detail, /usage 3\/1/);
	const idle: FleetRow = { ...base("builder", "idle"), kind: "specialist", depth: 0, runToken: "builder:dispatch-1", toolCount: 4, lastWork: "edit", model: "native-model", system1: view };
	assert.equal(system1Visible(idle, 10_999), true);
	assert.equal(system1Visible(idle, 11_000), false);
	assert.equal(system1Visible({ ...idle, runToken: "builder:dispatch-2" }, 2_000), false);
	const selected = selectWidgetRows([idle], 2_000);
	assert.deepEqual(selected.map(row => row.key), ["builder"]);
	assert.equal(selected[0].status, "idle");
	assert.equal(selected[0].toolCount, 4);
	assert.equal(selected[0].lastWork, "edit");
	assert.equal(selected[0].model, "native-model");
	assert.equal(summariseWidget(selected).running, 0);
	assert.equal(selectWidgetRows([idle], 11_000).length, 0);
	const fallback = projectSystem1Owner(check({ llmRelation: "fallback", status: "unavailable", statusChoice: undefined, evaluation: "finished" }), "builder:dispatch-1", 2_000)!;
	assert.match(fallback.compact, /S1 unavailable → LLM judging/);
	assert.equal(projectSystem1Owner(check({ numerical: undefined }), "builder:dispatch-1", 2_000)!.detail.includes("confidence unknown"), true);
	assert.equal(projectSystem1Owner(check({ configuredMode: "off", effectiveMode: "off", evaluation: "unknown" }), "builder:dispatch-1", 5_001), undefined);
	assert.equal(projectSystem1Owner(check({ evaluation: "unknown", effectiveMode: undefined, configuredMode: undefined, finishedAt: undefined }), "builder:dispatch-1", 5_001), undefined);
	assert.equal(projectSystem1Owner(check({ finishedAt: undefined }), "builder:dispatch-1", 5_001)!.retainUntil, 0);
});

test("F-19 agreeing results are not mixed because elapsed differs", () => {
	const slow = projectSystem1Owner(check({ elapsedMs: 700, finishedAt: 1_200 }), "reviewer:dispatch-1", 2_000)!;
	const fast = projectSystem1Owner(check({ elapsedMs: 402 }), "builder:dispatch-1", 2_000)!;
	const rows = [
		{ ...base("builder"), kind: "specialist" as const, depth: 0, runToken: "builder:dispatch-1", system1: fast },
		{ ...base("reviewer"), kind: "specialist" as const, depth: 0, runToken: "reviewer:dispatch-1", system1: slow },
	];
	const summary = summariseWidget(rows);
	assert.equal(summary.system1Mixed, false);
	assert.match(summary.system1Last ?? "", /S1 on_track/);
	assert.equal(summary.system1Mode, "shadow");
});
