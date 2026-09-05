import assert from "node:assert/strict";
import test from "node:test";
import { prepareDispatch } from "./dispatch-execution.ts";

function prepareDeps(overrides: { agents?: string[]; research?: string[]; turn?: number } = {}) {
	let turn = overrides.turn ?? 0;
	let task = 0;
	const agents = new Map((overrides.agents ?? ["builder"]).map(name => [name.toLowerCase(), { def: { name, tools: "read" }, runCount: 0, contextPct: 0 }]));
	const turnReport = { refusals: 0, dispatches: [] as unknown[], research: 0, tier: "small" };
	const sessionTotals = { refusals: 0, dispatches: 0, research: 0, billed: 0, out: 0 };
	return {
		state: {
			getTurnDispatchCount: () => turn,
			setTurnDispatchCount: (v: number) => { turn = v; },
			getTurnResearchCount: () => 0,
			setTurnResearchCount() {},
			getTaskDispatchCount: () => task,
			setTaskDispatchCount: (v: number) => { task = v; },
			getTaskResearchCount: () => 0,
			setTaskResearchCount() {},
			getTaskReviewRounds: () => 0,
			setTaskReviewRounds() {},
			getTaskTier: () => "small",
			getTurnReport: () => turnReport,
			getSessionTotals: () => sessionTotals,
			getTurnDispatchFingerprints: () => new Set<string>(),
			getExternalBlockers: () => [],
			getExternalBlockerAcknowledged: () => false,
			setExternalBlockerAcknowledged() {},
			getExternalBlockerRefusedOnce: () => false,
			setExternalBlockerRefusedOnce() {},
			isAskUserAvailable: () => true,
			getUserLanguage: () => "English",
			getSessionDir: () => "/tmp",
			getAgentStates: () => agents,
			getResearchPersonas: () => (overrides.research ?? ["researcher", "deep-researcher"]).map(name => ({ name })),
			getActiveWritableDispatches: () => 0,
			setActiveWritableDispatches() {},
			getWritableOverlapCounter: () => 0,
			setWritableOverlapCounter() {},
		},
		budget: {
			ensureTaskTier() {},
			taskCounters: () => ({ dispatches: task, research: 0, reviewRounds: 0 }),
			currentTaskBudget: () => ({ maxDispatch: 8, maxResearch: 8, maxReviewRounds: 4 }),
			taskActiveElapsedMs: () => 0,
			currentBudget: () => ({ maxDispatch: 2, maxResearch: 2 }),
			turnBudgetActiveElapsedMs: () => 0,
			armBudgetContinuation() {},
			updateModeStatus() {},
		},
		artifacts: {
			loadInputArtifacts: () => [],
		},
		research: {},
		provisionalCapabilityRefusal: () => null,
		dispatchAgent: async () => ({ output: "", exitCode: 0, elapsed: 0 }),
		runReturnExtraction: async () => null,
		extractNeedsResearch: () => [],
		extractAskUserQuestions: () => [],
		contextPressure: () => false,
		displayName: (n: string) => n,
		_turn: () => turn,
		_task: () => task,
		_report: turnReport,
	};
}

test("unknown agent does not increment dispatch budget and lists available agents", () => {
	const d = prepareDeps({ agents: ["builder"] });
	const result = prepareDispatch(d as any, { agent: "not-a-real-agent", task: "do work" } as any, {} as any);
	assert.equal("agent" in result && !("content" in result), false);
	assert.equal((result as any).details.status, "unknown_agent");
	assert.match((result as any).content[0].text, /Available agents: builder/);
	assert.match((result as any).content[0].text, /Do not invent a substitute dispatch/);
	assert.equal(d._turn(), 0);
	assert.equal(d._task(), 0);
});

test("dispatch_agent researcher redirects to spawn_research without consuming budget", () => {
	const d = prepareDeps({ agents: ["builder"], research: ["researcher", "deep-researcher"] });
	const result = prepareDispatch(d as any, { agent: "researcher", task: "look around" } as any, {} as any);
	assert.equal((result as any).details.status, "research_persona_via_dispatch");
	assert.match((result as any).content[0].text, /spawn_research/);
	assert.match((result as any).content[0].text, /Available agents: builder/);
	assert.equal(d._turn(), 0);
	assert.equal(d._task(), 0);
});

test("dispatch_agent deep-researcher redirects to spawn_research without consuming budget", () => {
	const d = prepareDeps({ agents: ["builder"] });
	const result = prepareDispatch(d as any, { agent: "deep-researcher", task: "trace paths" } as any, {} as any);
	assert.equal((result as any).details.status, "research_persona_via_dispatch");
	assert.match((result as any).content[0].text, /spawn_research/);
	assert.match((result as any).content[0].text, /persona "deep-researcher"/);
	assert.equal(d._turn(), 0);
});

test("known roster agent still increments after validation", () => {
	const d = prepareDeps({ agents: ["builder"] });
	const result = prepareDispatch(d as any, { agent: "builder", task: "implement the guard" } as any, {} as any);
	assert.equal((result as any).agent, "builder");
	assert.equal(d._turn(), 1);
	assert.equal(d._task(), 1);
});
