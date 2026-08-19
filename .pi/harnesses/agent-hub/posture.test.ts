import assert from "node:assert/strict";
import test from "node:test";

import {
	COMS_TOOLS,
	HERDR_TOOLS,
	ORCHESTRATION_TOOLS,
	latestPersistedNativeRoster,
	latestPersistedPosture,
	parsePosture,
	persistedNativeRosterState,
	posturePrompt,
	resolvePostureTools,
	resolveSessionPosture,
	resolveSessionRoster,
	resolveStartupPosture,
} from "./posture.ts";

test("parsePosture accepts only operator and orchestrator", () => {
	assert.equal(parsePosture("operator"), "operator");
	assert.equal(parsePosture("orchestrator"), "orchestrator");
	assert.equal(parsePosture(" operator "), "operator");
	assert.equal(parsePosture("builder"), null);
	assert.equal(parsePosture(undefined), null);
});

test("startup posture honors explicit posture before roster implication", () => {
	assert.equal(resolveStartupPosture({}), "operator");
	assert.equal(resolveStartupPosture({ hasExplicitRoster: false }), "operator");
	assert.equal(resolveStartupPosture({ hasExplicitRoster: true }), "orchestrator");
	assert.equal(
		resolveStartupPosture({ explicitPosture: "operator", hasExplicitRoster: true }),
		"operator",
	);
	assert.equal(
		resolveStartupPosture({ explicitPosture: "orchestrator", hasExplicitRoster: false }),
		"orchestrator",
	);
	assert.throws(
		() => resolveStartupPosture({ explicitPosture: "builder" }),
		/Unknown posture "builder"/,
	);
});

test("latest persisted posture restores session state and ignores malformed entries", () => {
	const entries = [
		{ type: "custom", customType: "agent-hub-posture", data: { posture: "operator" } },
		{ type: "message", role: "user", content: "ignore" },
		{ type: "custom", customType: "agent-hub-posture", data: { posture: "builder" } },
		{ type: "custom", customType: "agent-hub-posture", data: { posture: "orchestrator" } },
	];
	assert.equal(latestPersistedPosture(entries), "orchestrator");
	assert.equal(latestPersistedPosture([]), null);
});

test("session posture restores state unless an explicit CLI posture overrides it", () => {
	const entries = [
		{ type: "custom", customType: "agent-hub-posture", data: { posture: "orchestrator" } },
	];
	assert.equal(resolveSessionPosture({ entries }), "orchestrator");
	assert.equal(resolveSessionPosture({ entries, explicitPosture: "operator" }), "operator");
	assert.equal(resolveSessionPosture({ entries: [], hasExplicitRoster: true }), "orchestrator");
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

test("posture prompt permits direct work only for operators", () => {
	const operator = posturePrompt("operator");
	assert.match(operator.intro, /Fleet operator/);
	assert.match(operator.hardRules, /MAY read, execute, edit, and write directly/);
	assert.doesNotMatch(operator.hardRules, /NEVER try to read, write, or execute/);

	const orchestrator = posturePrompt("orchestrator");
	assert.match(orchestrator.intro, /dispatcher agent/);
	assert.match(orchestrator.hardRules, /NEVER try to read, write, or execute/);
	assert.doesNotMatch(orchestrator.hardRules, /herdr_spawn_pane/);
});

test("operator preserves coding and approved extension tools while gating Hub capabilities", () => {
	const tools = resolvePostureTools({
		posture: "operator",
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
	const tools = resolvePostureTools({
		posture: "operator",
		baselineTools: ["read", "coms_send", "herdr_spawn_peer"],
		comsReady: true,
		herdrReady: true,
		askUserAvailable: false,
	});

	for (const tool of [...COMS_TOOLS, ...HERDR_TOOLS]) assert.ok(tools.includes(tool));
	assert.ok(!tools.includes("ask_user"));
});

test("orchestrator excludes direct and unrelated extension tools", () => {
	const tools = resolvePostureTools({
		posture: "orchestrator",
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
	for (const posture of ["operator", "orchestrator"] as const) {
		const tools = resolvePostureTools({
			posture,
			baselineTools: ["read", "ask_user"],
			comsReady: false,
			herdrReady: false,
			askUserAvailable: false,
		});
		assert.ok(!tools.includes("ask_user"));
	}
});
