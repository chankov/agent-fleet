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
	assert.match(detail, /export interface DetailPanelDeps/);
	assert.match(detail, /return \{ openFleetDetail, loadAvailableModelChoices \}/);
	assert.match(contextBudget, /export interface ContextBudgetDeps/);
	assert.match(contextBudget, /return \{ contextPlanes, openContextBudget \}/);
	for (const action of ["restartSpecialist", "removeResearch", "killSpecialistProcess", "abortComs"]) assert.match(dashboard, new RegExp(`deps\\.${action}`));
	assert.doesNotMatch(dashboard, /restartResearch/);
	assert.doesNotMatch(dashboard, /restart-research/);
});

test("composition root wires mutable getters, policy, shared formatters, and lifecycle callbacks", () => {
	assert.match(root, /createDetailPanel<AgentDef, AgentState, ResearchState>\(\{[\s\S]*?getAgent: key => agentStates\.get\(key\)[\s\S]*?modelPolicy/);
	assert.match(root, /createFleetDashboard<AgentDef, AgentState, ResearchState>\(\{[\s\S]*?getAgents: \(\) => agentStates[\s\S]*?getShowFinished: \(\) => fleetShowFinished[\s\S]*?setShowFinished:[\s\S]*?getFilter: \(\) => fleetFilter[\s\S]*?setFilter:[\s\S]*?shortModel,[\s\S]*?thinkingSuffix,[\s\S]*?modelWithThinking,[\s\S]*?modelPolicy/);
	assert.match(root, /createContextBudgetUi<AgentDef, AgentState, ResearchState>\(\{[\s\S]*?getPromptLedger: \(\) => lastHubLedger[\s\S]*?getPressureState: \(\) => contextPressureState/);
	assert.doesNotMatch(dashboard + detail, /function (?:shortModel|thinkingSuffix|modelWithThinking)\(/);
});
