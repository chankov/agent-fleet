import assert from "node:assert/strict";
import test from "node:test";

import {
	COMS_TOOLS,
	FLEET_TOOLS,
	HERDR_TOOLS,
	ORCHESTRATION_TOOLS,
	isRetiredWorkMode,
	parseWorkMode,
	sessionSavedInRetiredWorkMode,
	workModePrompt,
	resolveWorkModeTools,
	WORK_MODES,
} from "./work-mode.ts";

test("the Hub has one work mode; the removed orchestrator name is recognised only for migration", () => {
	assert.deepEqual([...WORK_MODES], ["operator"]);
	assert.equal(parseWorkMode("operator"), "operator");
	assert.equal(parseWorkMode(" operator "), "operator");
	assert.equal(parseWorkMode("orchestrator"), null);
	assert.equal(parseWorkMode("builder"), null);
	assert.equal(isRetiredWorkMode("orchestrator"), true);
	assert.equal(isRetiredWorkMode("builder"), false);
});

test("a session last saved in orchestrator mode (canonical or legacy posture) is detected for the one-time notice", () => {
	assert.equal(sessionSavedInRetiredWorkMode([
		{ type: "custom", customType: "agent-hub-work-mode", data: { workMode: "operator" } },
		{ type: "message", role: "user", content: "ignore" },
		{ type: "custom", customType: "agent-hub-work-mode", data: { workMode: "builder" } },
		{ type: "custom", customType: "agent-hub-posture", data: { posture: "orchestrator" } },
	]), true);
	assert.equal(sessionSavedInRetiredWorkMode([
		{ type: "custom", customType: "agent-hub-work-mode", data: { workMode: "orchestrator" } },
		{ type: "custom", customType: "agent-hub-work-mode", data: { workMode: "operator" } },
	]), false, "the operator entry recorded after the notice ends it");
	assert.equal(sessionSavedInRetiredWorkMode([]), false);
});

test("teams are gone: no roster tool, and the delegation guide names roles (D7)", () => {
	assert.ok(!(FLEET_TOOLS as readonly string[]).includes("team_adjust"));
	const { delegationGuide } = workModePrompt();
	assert.match(delegationGuide, /one editor/);
	assert.match(delegationGuide, /`reviewer`/);
	assert.doesNotMatch(delegationGuide, /builder|team/i);
});

test("the operator prompt permits direct work and carries the delegation guide", () => {
	const operator = workModePrompt();
	assert.match(operator.intro, /Fleet operator/);
	assert.match(operator.hardRules, /MAY read, execute, edit, and write directly/);
	assert.doesNotMatch(operator.hardRules, /NEVER try to (read|execute)/);
	assert.match(operator.delegationGuide, /## When to delegate/);
});

test("operator preserves coding and approved extension tools while gating Hub capabilities", () => {
	const tools = resolveWorkModeTools({
		baselineTools: [
			"read", "bash", "edit", "write", "bowser", "ask_user",
			"coms_send", "herdr_spawn_peer", "dispatch_agent",
		],
		comsReady: false,
		herdrReady: false,
		askUserAvailable: true,
	});

	for (const tool of ["read", "bash", "edit", "write", "bowser", "ask_user", ...ORCHESTRATION_TOOLS.filter(name => name !== "dispatch_triage" && name !== 'recover_task')]) {
		assert.ok(tools.includes(tool), `${tool} should be active`);
	}
	assert.ok(!tools.includes("dispatch_triage"), "dispatch_triage stays hidden until the consumer can evaluate");
	for (const tool of [...COMS_TOOLS, ...HERDR_TOOLS]) {
		assert.ok(!tools.includes(tool), `${tool} should be gated`);
	}
	assert.equal(new Set(tools).size, tools.length, "tool names are deduplicated");
});

test("operator adds only runtime-ready coms and Herdr groups", () => {
	const tools = resolveWorkModeTools({
		baselineTools: ["read", "coms_send", "herdr_spawn_peer"],
		comsReady: true,
		herdrReady: true,
		askUserAvailable: false,
	});

	for (const tool of [...COMS_TOOLS, ...HERDR_TOOLS]) assert.ok(tools.includes(tool));
	assert.ok(!tools.includes("ask_user"));
});

test("dispatch_triage is listed only when the consumer can evaluate", () => {
	const hidden = resolveWorkModeTools({
		baselineTools: ["read"], comsReady: false, herdrReady: false, askUserAvailable: false,
	});
	const shown = resolveWorkModeTools({
		baselineTools: ["read"], comsReady: false, herdrReady: false, askUserAvailable: false, triageEnabled: true,
	});
	assert.ok(!hidden.includes("dispatch_triage"));
	assert.ok(shown.includes("dispatch_triage"));
});

test("ask_user remains gated even when present in the baseline", () => {
	const tools = resolveWorkModeTools({
		baselineTools: ["read", "ask_user"],
		comsReady: false,
		herdrReady: false,
		askUserAvailable: false,
	});
	assert.ok(!tools.includes("ask_user"));
});
