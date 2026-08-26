import assert from "node:assert/strict";
import test from "node:test";

import {
	COMS_TOOLS,
	HERDR_TOOLS,
	ORCHESTRATION_TOOLS,
	latestPersistedNativeRoster,
	latestPersistedWorkMode,
	parseWorkMode,
	persistedNativeRosterState,
	workModePrompt,
	resolveWorkModeTools,
	resolveSessionWorkMode,
	resolveSessionRoster,
	resolveStartupWorkMode,
} from "./work-mode.ts";

test("parseWorkMode accepts only operator and orchestrator", () => {
	assert.equal(parseWorkMode("operator"), "operator");
	assert.equal(parseWorkMode("orchestrator"), "orchestrator");
	assert.equal(parseWorkMode(" operator "), "operator");
	assert.equal(parseWorkMode("builder"), null);
	assert.equal(parseWorkMode(undefined), null);
});

test("startup work mode honors explicit work mode before roster implication", () => {
	assert.equal(resolveStartupWorkMode({}), "operator");
	assert.equal(resolveStartupWorkMode({ hasExplicitRoster: false }), "operator");
	assert.equal(resolveStartupWorkMode({ hasExplicitRoster: true }), "orchestrator");
	assert.equal(
		resolveStartupWorkMode({ explicitWorkMode: "operator", hasExplicitRoster: true }),
		"operator",
	);
	assert.equal(
		resolveStartupWorkMode({ explicitWorkMode: "orchestrator", hasExplicitRoster: false }),
		"orchestrator",
	);
	assert.throws(
		() => resolveStartupWorkMode({ explicitWorkMode: "builder" }),
		/Unknown work mode "builder"/,
	);
});

test("latest persisted work mode restores canonical and legacy session state", () => {
	const entries = [
		{ type: "custom", customType: "agent-hub-work-mode", data: { workMode: "operator" } },
		{ type: "message", role: "user", content: "ignore" },
		{ type: "custom", customType: "agent-hub-work-mode", data: { workMode: "builder" } },
		{ type: "custom", customType: "agent-hub-posture", data: { posture: "orchestrator" } },
	];
	assert.equal(latestPersistedWorkMode(entries), "orchestrator");
	assert.equal(latestPersistedWorkMode([
		{ type: "custom", customType: "agent-hub-posture", data: { posture: "operator" } },
	]), "operator");
	assert.equal(latestPersistedWorkMode([]), null);
});

test("session work mode restores state unless an explicit CLI work mode overrides it", () => {
	const entries = [
		{ type: "custom", customType: "agent-hub-work-mode", data: { workMode: "orchestrator" } },
	];
	assert.equal(resolveSessionWorkMode({ entries }), "orchestrator");
	assert.equal(resolveSessionWorkMode({ entries, explicitWorkMode: "operator" }), "operator");
	assert.equal(resolveSessionWorkMode({ entries: [], hasExplicitRoster: true }), "orchestrator");
});

test("native roster metadata restores only versioned team names", () => {
	const entries = [
		{ type: "custom", customType: "agent-hub-native-roster", data: { version: 1, team: "default", task: "must not be copied" } },
		{ type: "custom", customType: "agent-hub-native-roster", data: { version: 2, team: "future" } },
	];
	assert.deepEqual(persistedNativeRosterState(" Frontend "), { version: 1, team: "Frontend" });
	assert.equal(latestPersistedNativeRoster(entries), "default");
	assert.equal(latestPersistedNativeRoster([{ type: "custom", customType: "agent-hub-native-roster", data: { version: 1, team: "" } }]), null);
});

test("session roster gives explicit CLI selection precedence over persisted metadata", () => {
	const entries = [{ type: "custom", customType: "agent-hub-native-roster", data: { version: 1, team: "default" } }];
	const resolved = resolveSessionRoster({
		teams: { default: ["builder"], Security: ["security-auditor"] },
		entries,
		explicitRoster: "security",
		availablePersonas: ["builder", "security-auditor"],
	});
	assert.deepEqual(resolved, {
		source: "explicit",
		roster: { name: "Security", members: ["security-auditor"] },
		diagnostic: null,
	});
	assert.deepEqual(resolveSessionRoster({
		teams: { default: ["builder"] }, entries,
		availablePersonas: ["builder"], includePersisted: false,
	}), { source: "none", roster: null, diagnostic: null });
});

test("session roster restores current team configuration and fails closed when it is stale", () => {
	const persisted = [{ type: "custom", customType: "agent-hub-native-roster", data: { version: 1, team: "default" } }];
	assert.deepEqual(resolveSessionRoster({
		teams: { default: ["builder", "test-engineer"] }, entries: persisted,
		availablePersonas: ["builder", "test-engineer"],
	}), {
		source: "persisted",
		roster: { name: "default", members: ["builder", "test-engineer"] },
		diagnostic: null,
	});
	const stale = resolveSessionRoster({
		teams: { default: ["builder", "removed-persona"] }, entries: persisted,
		availablePersonas: ["builder"],
	});
	assert.equal(stale.roster, null);
	assert.match(stale.diagnostic ?? "", /default.*removed-persona/);
	assert.equal(stale.source, "persisted");
});

test("work mode prompt permits direct work only for operators", () => {
	const operator = workModePrompt("operator");
	assert.match(operator.intro, /Fleet operator/);
	assert.match(operator.hardRules, /MAY read, execute, edit, and write directly/);
	assert.doesNotMatch(operator.hardRules, /NEVER try to read, write, or execute/);

	const orchestrator = workModePrompt("orchestrator");
	assert.match(orchestrator.intro, /dispatcher agent/);
	assert.match(orchestrator.hardRules, /NEVER try to read, write, or execute/);
	assert.doesNotMatch(orchestrator.hardRules, /herdr_spawn_pane/);
});

test("operator preserves coding and approved extension tools while gating Hub capabilities", () => {
	const tools = resolveWorkModeTools({
		workMode: "operator",
		baselineTools: [
			"read", "bash", "edit", "write", "bowser", "ask_user",
			"coms_send", "herdr_spawn_peer", "dispatch_agent",
		],
		comsReady: false,
		herdrReady: false,
		askUserAvailable: true,
	});

	for (const tool of ["read", "bash", "edit", "write", "bowser", "ask_user", ...ORCHESTRATION_TOOLS]) {
		assert.ok(tools.includes(tool), `${tool} should be active`);
	}
	for (const tool of [...COMS_TOOLS, ...HERDR_TOOLS]) {
		assert.ok(!tools.includes(tool), `${tool} should be gated`);
	}
	assert.equal(new Set(tools).size, tools.length, "tool names are deduplicated");
});

test("operator adds only runtime-ready coms and Herdr groups", () => {
	const tools = resolveWorkModeTools({
		workMode: "operator",
		baselineTools: ["read", "coms_send", "herdr_spawn_peer"],
		comsReady: true,
		herdrReady: true,
		askUserAvailable: false,
	});

	for (const tool of [...COMS_TOOLS, ...HERDR_TOOLS]) assert.ok(tools.includes(tool));
	assert.ok(!tools.includes("ask_user"));
});

test("orchestrator excludes direct and unrelated extension tools", () => {
	const tools = resolveWorkModeTools({
		workMode: "orchestrator",
		baselineTools: ["read", "bash", "edit", "write", "bowser", "ask_user"],
		comsReady: true,
		herdrReady: true,
		askUserAvailable: true,
	});

	for (const tool of ["read", "bash", "edit", "write", "bowser"]) {
		assert.ok(!tools.includes(tool), `${tool} should not be active`);
	}
	for (const tool of [...ORCHESTRATION_TOOLS, ...COMS_TOOLS, ...HERDR_TOOLS, "ask_user"]) {
		assert.ok(tools.includes(tool), `${tool} should be active`);
	}
});

test("ask_user remains gated even when present in the baseline", () => {
	for (const workMode of ["operator", "orchestrator"] as const) {
		const tools = resolveWorkModeTools({
			workMode,
			baselineTools: ["read", "ask_user"],
			comsReady: false,
			herdrReady: false,
			askUserAvailable: false,
		});
		assert.ok(!tools.includes("ask_user"));
	}
});
