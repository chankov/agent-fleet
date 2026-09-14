import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resetHubSession } from "./session-orchestration.ts";

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
		registerVersion: call("version"), resetPressure: call("pressure"), clearRosterRecovery: call("roster"), captureBaselineTools: call("tools"), resetAccessApproval: call("approval"), terminateResearch: call("terminate"), resetResearch: call("research"), resetHistory: call("history"), resetBudgets: call("budgets"), clearWidgets: call("widgets"), closeDelegationWatchers: call("watchers"), resetSessionState: call("session"), resolveSafety: () => true, resolveDelegate: call("delegate"),
	});
	assert.deepEqual(calls, ["version", "pressure", "roster", "tools", "approval", "terminate", "research", "history", "budgets", "widgets", "watchers", "session", "delegate"]);
});
