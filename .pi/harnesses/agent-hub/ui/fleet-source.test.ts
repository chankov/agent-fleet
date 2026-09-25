import assert from "node:assert/strict";
import test from "node:test";
import { createFleetSource } from "./fleet-source.ts";
import { createProactiveRuntime } from "../proactive-runtime.ts";

const now = 20_000;
const agent = (overrides: any = {}) => ({ def: { name: "builder", description: "build" }, status: "running", task: "task", toolCount: 2, elapsed: 0, lastWork: "edit", contextPct: 42, contextTokens: 100, histEntry: { startedAt: 10_000, endedAt: null }, runCount: 1, delegations: new Map(), ...overrides });
function source(options: any = {}) {
	const agents = new Map([["builder", agent(options.agent)]]);
	return createFleetSource({
		getAgents: () => agents,
		getResearch: () => new Map(),
		getPeerInputs: () => options.peers ?? [],
		getPeerCards: () => options.cards ?? new Map(),
		getPendingReplies: () => options.pending ?? [],
		displayName: (name: string) => name.toUpperCase(),
		modelForAgent: () => "native-model",
		modelForResearch: () => "research-model",
		modelForPeer: (model: string) => model,
		getProactive: () => options.ledger ?? null,
	});
}

test("shared source preserves nested delegate hierarchy and stable run identity", () => {
	const delegations = new Map([
		["grand", { id: "grand", parent: "child", role: "grand", model: "m", status: "running", toolCount: 1, tokens: 9, lastWork: "g", startedAt: 15_000, elapsed: 0 }],
		["child", { id: "child", parent: "root", role: "child", model: "m", status: "running", toolCount: 1, tokens: 8, lastWork: "c", startedAt: 14_000, elapsed: 0 }],
	]);
	const first = source({ agent: { delegations, dispatchId: "dispatch-1" } }).rows(now, { showFinished: true });
	assert.deepEqual(first.map(row => [row.key, row.parentKey, row.depth]), [["builder", undefined, 0], ["child", "builder", 1], ["grand", "child", 2]]);
	assert.equal(first[0].runToken, "builder:dispatch-1");
	assert.equal(source({ agent: { delegations, dispatchId: "dispatch-2" } }).rows(now, { showFinished: true })[0].runToken, "builder:dispatch-2");
});

test("malformed delegate parentage is deterministic and never drops rows", () => {
	const delegations = new Map([
		["orphan", { id: "orphan", parent: "missing", role: "orphan", model: "m", status: "running", toolCount: 0, tokens: 0, lastWork: "", startedAt: 1, elapsed: 0 }],
		["self", { id: "self", parent: "self", role: "self", model: "m", status: "running", toolCount: 0, tokens: 0, lastWork: "", startedAt: 1, elapsed: 0 }],
		["a", { id: "a", parent: "b", role: "a", model: "m", status: "running", toolCount: 0, tokens: 0, lastWork: "", startedAt: 1, elapsed: 0 }],
		["b", { id: "b", parent: "a", role: "b", model: "m", status: "running", toolCount: 0, tokens: 0, lastWork: "", startedAt: 1, elapsed: 0 }],
	]);
	const rows = source({ agent: { delegations } }).rows(now, { showFinished: true });
	assert.deepEqual(new Set(rows.map(row => row.key)), new Set(["builder", "orphan", "self", "a", "b"]));
	assert.ok(rows.slice(1).every(row => row.parentKey === "builder"));
});

test("peer activity covers working, queue depth, synthetic pending, stale plus pending and name collision", () => {
	const peers = [
		{ key: "peer:s1", name: "worker", model: "m", lastWork: "one", staleCount: 3 },
		{ key: "peer:s2", name: "duplicate", model: "m", lastWork: "two" },
		{ key: "peer:s3", name: "duplicate", model: "m", lastWork: "three" },
	];
	const cards = new Map([
		["s1", { name: "worker", model: "m", purpose: "one", color: "#fff", staleCount: 3, status: "working" }],
		["s2", { name: "duplicate", model: "m", purpose: "two", color: "#fff", queue_depth: 2 }],
		["s3", { name: "duplicate", model: "m", purpose: "three", color: "#fff" }],
	]);
	const pending = [
		{ target_name: "worker", created_at: new Date(10_000).toISOString() },
		{ target_name: "missing", created_at: "invalid" },
		{ target_name: "duplicate", created_at: new Date(12_000).toISOString() },
	];
	const rows = source({ peers, cards, pending }).rows(now, { showFinished: true });
	assert.equal(rows.find(row => row.key === "peer:s1")?.status, "running");
	assert.equal(rows.find(row => row.key === "peer:s1")?.timingKind, "wait");
	assert.equal(rows.find(row => row.key === "peer:s2")?.status, "running");
	assert.equal(rows.find(row => row.key === "peer-pending:missing")?.elapsed, 0);
	assert.equal(rows.find(row => row.key === "peer-pending:missing")?.startedAt, undefined);
	assert.ok(rows.some(row => row.key === "peer-pending:duplicate"));
	assert.equal(rows.filter(row => row.name === "duplicate" && row.status === "running").length, 2);
});

test("synthetic pending identity reconciles to one real peer alias and never grants actions", () => {
	const synthetic = source({ pending: [{ target_name: "alice", created_at: new Date(10_000).toISOString() }] }).rows(now, { showFinished: true }).find(row => row.key === "peer-pending:alice")!;
	assert.equal(synthetic.key, "peer-pending:alice");
	const real = source({ peers: [{ key: "peer:s1", name: "alice", model: "m", lastWork: "" }], pending: [{ target_name: "alice", created_at: new Date(10_000).toISOString() }] }).rows(now, { showFinished: true }).find(row => row.key === "peer:s1")!;
	assert.deepEqual(real.aliasKeys, [synthetic.key]);
	assert.equal(real.runToken, undefined);
});

test("A12 Hub-only and concurrent consumers preserve run identity, counters, and independent coverage", () => {
	const ledger = { records: [
		{ owner: "hub", attempt: "direct", turnId: "hub:direct:0", status: "reviewed" },
		{ owner: "builder", attempt: "dispatch-1", turnId: "builder:dispatch-1:0", status: "not_checked" },
	], history: [{ owner: "hub", attempt: "direct", turnId: "hub:direct:0", coverage: { status: "checked", gaps: [], checked: ["r1"] } },
		{ owner: "builder", attempt: "dispatch-1", turnId: "builder:dispatch-1:0", coverage: { status: "partial", gaps: ["coverage_gap"], checked: [] } }],
		current: [
			{ owner: "hub", attempt: "direct", source: "system1" as const, claim: "suspicion" as const, state: "current" as const },
			{ owner: "builder", attempt: "dispatch-1", source: "deterministic" as const, claim: "violation" as const, state: "current" as const },
		], activity: [] };
	const empty = source({ ledger, agent: { dispatchId: "dispatch-1" } });
	// A headless/Hub-only session can have no roster rows, yet retains its summary.
	const headless = createFleetSource({ getAgents: () => new Map(), getResearch: () => new Map(), getPeerInputs: () => [], getPeerCards: () => new Map(), getPendingReplies: () => [], displayName: (n: string) => n, modelForAgent: () => "", modelForResearch: () => "", modelForPeer: (n: string) => n, getProactive: () => ledger });
	assert.deepEqual(headless.rows(now, { showFinished: true }), []);
	assert.deepEqual(headless.snapshot(now).proactive?.owners.map(v => v.runToken), ["hub:direct", "builder:dispatch-1"]);
	assert.equal(headless.snapshot(now).proactive?.currentSuspicions, 1);
	const before = empty.snapshot(now);
	const row = empty.rows(now, { showFinished: true })[0];
	assert.equal(row.proactive?.currentViolations, 1);
	assert.equal(row.proactive?.currentSuspicions, 0);
	assert.equal(row.proactive?.coverage, "partial");
	assert.equal(before.proactive?.reviewed, 1);
	assert.deepEqual([row.status, row.model, row.toolCount, row.contextTokens], ["running", "native-model", 2, 100]);
	const restarted = source({ ledger, agent: { dispatchId: "dispatch-2", runCount: 2 } });
	assert.equal(restarted.rows(now, { showFinished: true })[0].proactive, undefined);
	assert.equal(restarted.snapshot(now).proactive?.owners.find(v => v.attempt === "dispatch-1")?.currentViolations, 1);
	assert.equal(restarted.rows(now, { showFinished: true })[0].runToken, "builder:dispatch-2");
	assert.equal(ledger.records.length, 2); // rendering is read-only
});

test("A12 actual session runtime ledger projects Hub and restarted specialist without private readback", () => {
	const runtime = createProactiveRuntime({ config: { version: 1, mode: "shadow", remoteContext: "disabled", include: ["src/**"], maxEvaluationsPerSession: 1 } });
	const ledger = () => ({ records: runtime.records, history: runtime.findings.history, current: runtime.findings.current, activity: runtime.activity.live() });
	const empty = createFleetSource({ getAgents: () => new Map(), getResearch: () => new Map(), getPeerInputs: () => [], getPeerCards: () => new Map(), getPendingReplies: () => [], displayName: (n: string) => n, modelForAgent: () => "", modelForResearch: () => "", modelForPeer: (n: string) => n, getProactive: ledger });
	runtime.recordGap("hub", "direct", "session:hub:direct:0", "not_checked");
	assert.equal(empty.snapshot(now).proactive?.owners[0].runToken, "hub:direct");
	assert.equal(empty.snapshot(now).proactive?.partial, 1);
	assert.deepEqual(empty.rows(now, { showFinished: true }), []);
	const agents = new Map([["builder", agent({ dispatchId: "old" })]]);
	const native = createFleetSource({ getAgents: () => agents, getResearch: () => new Map(), getPeerInputs: () => [], getPeerCards: () => new Map(), getPendingReplies: () => [], displayName: (n: string) => n, modelForAgent: () => "native", modelForResearch: () => "", modelForPeer: (n: string) => n, getProactive: ledger });
	runtime.recordGap("builder", "old", "session:builder:old:0", "not_instrumented");
	assert.equal(native.rows(now, { showFinished: true })[0].proactive?.attempt, "old");
	agents.set("builder", agent({ dispatchId: "new", runCount: 2 }));
	assert.equal(native.rows(now, { showFinished: true })[0].proactive, undefined);
	assert.equal(native.snapshot(now).proactive?.owners.find(view => view.attempt === "old")?.partial, 1);
	runtime.abort();
});

test("A12 P11 snapshot carries only opaque metadata; restart fences old details without render readback", () => {
	const ref = { id: "a".repeat(64), owner: "builder", attempt: "old", source: "deterministic" as const, claim: "violation" as const, state: "current" as const,
		ruleId: "rule", ruleHash: "b".repeat(64), subject: "src/file.ts", snapshotHandle: "c".repeat(64), snapshotHash: "d".repeat(64), snapshotId: "snap", unitId: "unit", excerptHash: "e".repeat(64), occurrences: 1 };
	const ledger = { records: [{ owner: "builder", attempt: "old", turnId: "t", status: "reviewed" }], history: [{ owner: "builder", attempt: "old", turnId: "t", coverage: { status: "checked", gaps: [], checked: ["rule:unit"] }, findings: [ref] }], current: [ref], activity: [] };
	const agents = new Map([ ["builder", agent({ dispatchId: "old", toolCount: 9 })] ]);
	let calls = 0;
	const fleet = createFleetSource({ getAgents: () => agents, getResearch: () => new Map(), getPeerInputs: () => [], getPeerCards: () => new Map(), getPendingReplies: () => [],
		displayName: (n: string) => n, modelForAgent: () => "native", modelForResearch: () => "", modelForPeer: (n: string) => n,
		getProactive: () => { calls++; return ledger; } });
	const first = fleet.snapshot(now);
	assert.deepEqual(first.specialists[0].proactive?.findings[0], { ...ref, runToken: "builder:old", state: "new" });
	assert.equal(first.specialists[0].toolCount, 9);
	assert.equal(first.proactive?.owners[0].history[0].coverage.status, "checked");
	agents.set("builder", agent({ dispatchId: "new", runCount: 2, toolCount: 11 }));
	assert.equal(fleet.rows(now, { showFinished: true })[0].proactive, undefined);
	assert.equal(fleet.snapshot(now).proactive?.owners[0].findings[0].attempt, "old");
	assert.equal(calls, 3); // in-memory ledger reads only; no readback port exists on the render adapter.
});

test("A14 shared source binds System 1 to the current dispatch and leaves worker fields unchanged", () => {
	const live = {
		active: [{ dispatchId: "dispatch-1", attemptId: "attempt-1", checkId: "check-fast", snapshotId: "snap-1", evaluation: "evaluating" as const, llm: "running", status: "unknown", reason: "unknown", elapsedMs: 400, rule: "failures", effectiveMode: "shadow" as const, configuredMode: "shadow" as const }],
		completed: [{ dispatchId: "dispatch-old", attemptId: "attempt-old", checkId: "check-old", snapshotId: "snap-old", evaluation: "finished" as const, llm: "finished", status: "ok", reason: "unknown", elapsedMs: 10, finishedAt: 19_000, rule: "loop", effectiveMode: "shadow" as const, statusChoice: "on_track" }],
		degraded: false,
	};
	const built = source({ agent: { dispatchId: "dispatch-1", toolCount: 7, lastWork: "edit", status: "running" } });
	const withLive = createFleetSource({
		getAgents: () => new Map([["builder", agent({ dispatchId: "dispatch-1", toolCount: 7, lastWork: "edit" })], ["reviewer", agent({ def: { name: "reviewer" }, dispatchId: "dispatch-2", status: "idle", toolCount: 1, lastWork: "wait" })]]),
		getResearch: () => new Map([[1, { id: 1, persona: false, def: { name: "research" }, status: "running", model: "m", toolCount: 3, elapsed: 1, lastWork: "search", contextPct: 1 }]]),
		getPeerInputs: () => [],
		getPeerCards: () => new Map(),
		getPendingReplies: () => [],
		displayName: (name: string) => name.toUpperCase(),
		modelForAgent: () => "native-model",
		modelForResearch: () => "research-model",
		modelForPeer: (model: string) => model,
		getSystem1: () => live,
	});
	const rows = withLive.rows(now, { showFinished: true });
	const builder = rows.find(row => row.key === "builder")!;
	const reviewer = rows.find(row => row.key === "reviewer")!;
	const research = rows.find(row => row.kind === "research")!;
	assert.equal(builder.system1?.checkId, "check-fast");
	assert.equal(builder.system1?.runToken, "builder:dispatch-1");
	assert.equal(builder.toolCount, 7);
	assert.equal(builder.lastWork, "edit");
	assert.equal(builder.model, "native-model");
	assert.equal(builder.status, "running");
	assert.equal(reviewer.system1, undefined);
	assert.equal(research.system1, undefined);
	assert.equal(built.rows(now, { showFinished: true })[0].system1, undefined);
	const rebound = createFleetSource({
		getAgents: () => new Map([["builder", agent({ dispatchId: "dispatch-2", runCount: 2, toolCount: 7, lastWork: "edit" })]]),
		getResearch: () => new Map(),
		getPeerInputs: () => [],
		getPeerCards: () => new Map(),
		getPendingReplies: () => [],
		displayName: (name: string) => name,
		modelForAgent: () => "native-model",
		modelForResearch: () => "research-model",
		modelForPeer: (model: string) => model,
		getSystem1: () => live,
	});
	assert.equal(rebound.rows(now, { showFinished: true })[0].system1, undefined);
	assert.equal(rebound.rows(now, { showFinished: true })[0].runToken, "builder:dispatch-2");
});
