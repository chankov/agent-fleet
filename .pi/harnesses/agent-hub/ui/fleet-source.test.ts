import assert from "node:assert/strict";
import test from "node:test";
import { createFleetSource } from "./fleet-source.ts";

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
