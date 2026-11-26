import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applySessionOverrides, resetHubSession } from "./session-orchestration.ts";
import { DEFAULT_OVERRIDES } from "../config/overrides.ts";
import { createModelPolicy } from "../policy/models.ts";
import type { AgentDef } from "../types.ts";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("session reset disposes the old fleet UI before context replacement and installs the new one", () => {
	assert.match(source, /clearWidgets: _ctx => \{ fleetUiGeneration\+\+; fleetActions\?\.reset\(\); gridUI\.dispose\(\); \}/);
	assert.match(source, /resetSessionState: ctx => \{[^}]*widgetCtx = ctx;[^}]*gridUI\.reset\(\); \}/);
	assert.match(source, /clearPoolWidget: \(\) => \{\s*gridUI\.dispose\(\);/);
});

test("resetHubSession invokes UI cleanup once in deterministic lifecycle order", () => {
	const calls: string[] = [];
	const call = (name: string) => () => { calls.push(name); };
	const ctx: any = { cwd: "/tmp", ui: { notify() {} } };
	resetHubSession(ctx, {
		registerVersion: call("version"), resetPressure: call("pressure"), captureBaselineTools: call("tools"), resetAccessApproval: call("approval"), terminateResearch: call("terminate"), resetResearch: call("research"), resetHistory: call("history"), resetBudgets: call("budgets"), clearWidgets: call("widgets"), closeDelegationWatchers: call("watchers"), resetSessionState: call("session"), resolveSafety: () => true, resolveDelegate: call("delegate"),
	});
	assert.deepEqual(calls, ["version", "pressure", "tools", "approval", "terminate", "research", "history", "budgets", "widgets", "watchers", "session", "delegate"]);
});

test("overrides-file practice models reach the model policy after its reset; entries for a missing role warn", () => {
	const defs: AgentDef[] = [{ name: "editor", description: "", tools: "", systemPrompt: "", file: "editor.md", model: "p/role", practiceModels: { planning: { model: "p/file" } } }];
	const policy = createModelPolicy({ getAllDefs: () => defs, getActiveDef: () => defs[0], getResearchDefs: () => [], refreshUi() {} });
	const notices: string[] = [];
	const ctx: any = { cwd: "/tmp", ui: { notify: (message: string) => notices.push(message) } };
	const order: string[] = [];
	const noop = () => {};
	applySessionOverrides(ctx, { ...DEFAULT_OVERRIDES, warnings: [], practiceModels: { "editor.planning": { model: "p/overrides", thinking: "high" }, "builder.planning": { model: "p/x" } } }, {
		setLanguage: noop, setReconTimeout: noop, setBudgetOverrides: noop, setWatchdog: noop, resetTurnCounts: noop, resetTaskWindow: noop, updateModeStatus: noop,
		setProjectRules: noop, setProjectDocs: noop,
		resetModelPolicy: () => { order.push("reset"); policy.reset(); },
		setPracticeModelOverrides: value => { order.push("practices"); policy.setConfiguredPracticeSelections(value); },
		getAgentDefs: () => defs, getModelProfiles: () => ({}), deleteModelProfile: noop, allowedModels: () => [], getDispatchPolicyWarnings: () => [], setResearchPersonas: noop,
	});
	assert.deepEqual(order, ["reset", "practices"]);
	assert.deepEqual(policy.resolvedSelection(defs[0], ["planning"]), { model: "p/overrides", thinking: "high", source: "practice:planning:overrides", practice: "planning" });
	assert.ok(notices.some(message => /ignored practice model entry "builder\.planning" — no role definition/.test(message)), notices.join("\n"));
	assert.equal(defs[0].practiceModels?.planning.model, "p/file", "the role file default is not rewritten");
});
