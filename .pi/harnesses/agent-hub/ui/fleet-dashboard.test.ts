import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("./fleet-dashboard.ts", import.meta.url), "utf8");
const detail = readFileSync(new URL("./detail-panel.ts", import.meta.url), "utf8");
const contextBudget = readFileSync(new URL("./context-budget.ts", import.meta.url), "utf8");

test("Phase 6.5 UI factories expose narrow public APIs and typed action ports", () => {
	assert.match(dashboard, /export interface FleetDashboardDeps/);
	assert.match(dashboard, /return \{ fleetRows, openFleetDashboard \}/);
	assert.match(dashboard, /getComsLines/);
	assert.match(dashboard, /comsLines/);
	assert.match(detail, /export interface DetailPanelDeps/);
	assert.match(detail, /return \{ openFleetDetail, loadAvailableModelChoices \}/);
	assert.match(contextBudget, /export interface ContextBudgetDeps/);
	assert.match(contextBudget, /return \{ contextPlanes, openContextBudget \}/);
	assert.match(dashboard, /deps\.actions\.execute/);
	assert.match(dashboard, /deps\.actions\.open/);
	for (const action of ["restartSpecialist", "removeResearch", "killSpecialistProcess", "abortComs"]) assert.match(root, new RegExp(`${action}:`));
	assert.doesNotMatch(dashboard, /restartResearch/);
	assert.doesNotMatch(dashboard, /restart-research/);
});

test("composition root wires mutable getters, policy, shared formatters, and lifecycle callbacks", () => {
	assert.match(root, /createDetailPanel<AgentDef, AgentState, ResearchState>\(\{[\s\S]*?getAgent: key => agentStates\.get\(key\)[\s\S]*?modelPolicy/);
	assert.match(root, /createFleetDashboard<AgentDef, AgentState, ResearchState>\(\{[\s\S]*?getAgents: \(\) => agentStates[\s\S]*?getShowFinished: \(\) => fleetShowFinished[\s\S]*?setShowFinished:[\s\S]*?getFilter: \(\) => fleetFilter[\s\S]*?setFilter:[\s\S]*?shortModel,[\s\S]*?thinkingSuffix,[\s\S]*?modelWithThinking,[\s\S]*?modelPolicy/);
	assert.match(root, /createContextBudgetUi<AgentDef, AgentState, ResearchState>\(\{[\s\S]*?getPromptLedger: \(\) => lastHubLedger[\s\S]*?getPressureState: \(\) => contextPressureState/);
	assert.doesNotMatch(dashboard + detail, /function (?:shortModel|thinkingSuffix|modelWithThinking)\(/);
});

import { registerHooks } from "node:module";

// Pi's loader supplies these legacy aliases in production.
const aliases = registerHooks({ resolve(specifier, context, nextResolve) {
	return nextResolve(specifier.replace("@mariozechner/pi-", "@earendil-works/pi-"), context);
} });
const { createFleetDashboard } = await import("./fleet-dashboard.ts");
aliases.deregister();

test("dashboard arrows change session thinking, clamp endpoints, and respect modal/ownership boundaries", async () => {
	let level = "medium", changes = 0, panel: any;
	const overrides: string[] = [], notices: string[] = [];
	const def = { name: "builder", thinking: "low" };
	const row = { key: "builder", kind: "specialist", backend: "native", name: "Builder" };
	let filter = "";
	const dashboard = createFleetDashboard({
		getAgents: () => new Map([["builder", { def }]]),
		getResearch: () => new Map([[1, { def, persona: true }], [2, { def, persona: false }]]),
		parseResearchHandle: (key: string) => key === "research:1" ? 1 : 2,
		getFleetRows: () => [row],
		getFilter: () => filter, setFilter: (value: string) => { filter = value; },
		getShowFinished: () => true, setShowFinished() {},
		getComsLines: () => [],
		resolvedThinking: () => level,
		displayName: (name: string) => name,
		modelPolicy: { setThinkingOverride: (_name: string, value: string) => { level = value; overrides.push(value); } },
		onThinkingChanged: () => { changes++; },
	} as any);
	const ctx = { ui: {
		notify: (message: string) => notices.push(message),
		custom: async (factory: any) => {
			panel = factory({ requestRender() {}, terminal: { rows: 24, columns: 120 } }, {}, {}, () => {});
			try {
				await panel.handleInput("\u001b[C"); assert.equal(level, "high");
				await panel.handleInput("\u001b[C"); assert.equal(level, "xhigh");
				await panel.handleInput("\u001b[C"); assert.equal(changes, 2);
				await panel.handleInput("\u001b[D"); assert.equal(level, "high");
				level = "off";
				await panel.handleInput("\u001b[D"); assert.equal(level, "off"); assert.equal(changes, 3);
				row.backend = "coms";
				await panel.handleInput("\u001b[C"); assert.equal(changes, 3);
				row.backend = "native"; row.kind = "delegate";
				await panel.handleInput("\u001b[C"); assert.equal(changes, 3);
				row.kind = "specialist";
				await panel.handleInput("f"); await panel.handleInput("\u001b[C"); assert.equal(changes, 3);
				await panel.handleInput("\u001b");
				await panel.handleInput("p"); await panel.handleInput("\u001b[C"); assert.equal(changes, 3);
				await panel.handleInput("\u001b");
				row.kind = "research"; row.key = "research:1";
				await panel.handleInput("\u001b[C"); assert.equal(level, "minimal"); assert.equal(changes, 4);
				assert.match(notices.at(-1)!, /next spawn_research/);
				row.key = "research:2";
				await panel.handleInput("\u001b[C"); assert.equal(changes, 4);
			} finally { panel.dispose(); }
		},
	} };
	await dashboard.openFleetDashboard(ctx as any);
	assert.deepEqual(overrides, ["high", "xhigh", "high", "minimal"]);
	assert.match(notices[0], /session only; applies on next dispatch/);
});
