import assert from "node:assert/strict";
import test from "node:test";
import { createFleetActions } from "./fleet-actions.ts";
import type { FleetRow } from "../../lib/fleet-read-model.ts";

const row = (overrides: Partial<FleetRow> = {}): FleetRow => ({ key: "builder", runToken: "builder:1", kind: "specialist", name: "Builder", depth: 0, status: "running", model: "m", backend: "native", contextPct: null, contextTokens: null, elapsed: 0, timingKind: "run", startedAt: 1, toolCount: 0, lastWork: "", hasTimeline: true, ...overrides });
const ctx: any = { ui: { messages: [] as string[], notify(message: string) { this.messages.push(message); } } };

test("shared actions recheck row/run and preserve owned-process versus coms-abort policy", async () => {
	let rows = [row()]; let killed = 0, aborted = 0;
	const agent: any = { def: { name: "builder" }, task: "work", proc: { pid: 1 }, comsAbort: () => {} };
	const actions = createFleetActions({ getRows: () => rows, getAgents: () => new Map([["builder", agent]]), getResearch: () => new Map(), parseResearchHandle: () => null, displayName: value => value, modelWorkBlocked: () => false, restartSpecialist: async () => {}, removeResearch: () => {}, killSpecialistProcess: () => { killed++; }, abortComs: () => { aborted++; }, openDetail: async () => false, generation: () => 1 });
	await actions.execute("kill", "builder", "builder:old", ctx); assert.equal(killed, 0);
	await actions.execute("kill", "builder", "builder:1", ctx); assert.equal(killed, 1); assert.equal(aborted, 0);
	delete agent.proc;
	await actions.execute("kill", "builder", "builder:1", ctx); assert.equal(aborted, 1);
	rows = [];
	await actions.execute("kill", "builder", "builder:1", ctx); assert.equal(killed, 1);
});

test("kill fences the native attempt before the process kill", async () => {
	let order: string[] = [];
	const agent: any = { def: { name: "builder" }, task: "work", proc: { pid: 1 }, driftFence: { dispose() { order.push("fence"); } } };
	const actions = createFleetActions({ getRows: () => [row()], getAgents: () => new Map([["builder", agent]]), getResearch: () => new Map(), parseResearchHandle: () => null, displayName: value => value, modelWorkBlocked: () => false, restartSpecialist: async () => {}, removeResearch: () => {}, killSpecialistProcess: () => { order.push("kill"); }, abortComs: () => {}, openDetail: async () => false, generation: () => 1 });
	await actions.execute("kill", "builder", "builder:1", ctx);
	assert.deepEqual(order, ["fence", "kill"]);
});

test("restart pending guard prevents duplicate async execution and clears after failure", async () => {
	let calls = 0, release!: () => void;
	const wait = new Promise<void>(resolve => { release = resolve; });
	const agent: any = { def: { name: "builder" }, task: "work" };
	const actions = createFleetActions({ getRows: () => [row()], getAgents: () => new Map([["builder", agent]]), getResearch: () => new Map(), parseResearchHandle: () => null, displayName: value => value, modelWorkBlocked: () => false, restartSpecialist: async () => { calls++; await wait; }, removeResearch: () => {}, killSpecialistProcess: () => {}, abortComs: () => {}, openDetail: async () => false, generation: () => 1 });
	const first = actions.execute("restart", "builder", "builder:1", ctx);
	const duplicate = actions.execute("restart", "builder", "builder:1", ctx);
	assert.equal(calls, 1); release(); await Promise.all([first, duplicate]);
	assert.equal(actions.pending("restart", "builder", "builder:1"), false);
});
