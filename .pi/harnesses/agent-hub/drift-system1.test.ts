import assert from "node:assert/strict";
import test from "node:test";
import { createDriftMonitor } from "./drift-watchdog.js";
import {
	WATCHDOG_QUESTIONS,
	WATCHDOG_QUESTIONS_VERSION,
	WATCHDOG_REQUIRED_CAPABILITIES,
	WATCHDOG_STATE_MAX_BYTES,
	WATCHDOG_STATE_VERSION,
	buildWatchdogState,
	classifyStatusAnswer,
	parseWatchdogStateV1,
} from "./drift-system1.ts";

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz";
const COMMAND = "rm -rf SECRET_COMMAND_DO_NOT_SEND";
const BODY = "SECRET_WRITE_BODY_DO_NOT_SEND";

test("watchdog questions use shared primitives and do not synthesize confidence or consumer wire forms", () => {
	assert.equal(WATCHDOG_QUESTIONS_VERSION, "watchdog-questions/v1");
	assert.deepEqual(WATCHDOG_REQUIRED_CAPABILITIES, ["distribution", "probability_true"]);
	assert.equal(WATCHDOG_REQUIRED_CAPABILITIES.includes("provider_confidence"), false);
	assert.deepEqual(WATCHDOG_QUESTIONS.map((question) => [question.id, question.type]), [
		["status", "choice"],
		["repeating", "predicate"],
		["outside_task", "predicate"],
		["trail_carries_instructions", "predicate"],
	]);
	const status = WATCHDOG_QUESTIONS[0];
	assert.equal(status.type, "choice");
	if (status.type !== "choice") return;
	assert.deepEqual(Object.keys(status.options), ["on_track", "drifting", "stuck", "insufficient_evidence"]);
	const serialized = JSON.stringify(WATCHDOG_QUESTIONS);
	assert.equal(serialized.includes("noul"), false);
	assert.equal(serialized.includes("needs_external"), false);
	assert.equal(serialized.includes("\"ok\":false"), false);
	assert.match(serialized, /untrusted data/);
	assert.match(serialized, /Protocol-owned paths are not drift/);
	const missing = classifyStatusAnswer({
		questionId: "status",
		type: "choice",
		value: "on_track",
		uncertainty: { provenance: "provider", distribution: { on_track: 1, drifting: 0, stuck: 0, insufficient_evidence: 0 } },
	});
	assert.deepEqual(missing, { usable: false, reason: "missing_confidence" });
	assert.equal("confidence" in missing, false);
	assert.equal(classifyStatusAnswer({ questionId: "repeating", type: "predicate", probabilityTrue: 0.9 }).usable, false);
});

test("canonical outbound state keeps relative protocol paths and omits raw arguments, detail, and secrets", () => {
	const monitor = createDriftMonitor({
		scopeGlobs: ["src/**"],
		allowGlobs: [".pi/agent-sessions/artifacts/**"],
		maxRepeats: 100,
		maxToolCalls: 1000,
	});
	monitor.onToolStart("read", JSON.stringify({ path: "src/app.ts" }));
	monitor.onToolEnd("read", false);
	monitor.onToolStart("write", JSON.stringify({ path: ".pi/agent-sessions/artifacts/plans/x.md", content: BODY }));
	monitor.onToolEnd("write", false);
	monitor.onToolStart("bash", JSON.stringify({ command: COMMAND }));
	monitor.onToolEnd("bash", false);
	const built = buildWatchdogState({
		task: "Fix login",
		scope: ["src/**"],
		hubOwnedPaths: [".pi/agent-sessions/artifacts/**"],
		root: "/repo",
		elapsedMs: 1000,
		signal: { rule: "loop", terminal: true, detail: `edit touched /etc/passwd ${SECRET}` },
		observation: monitor.structuredObservation(),
	});
	assert.equal(built.ok, true);
	if (!built.ok) return;
	assert.deepEqual(built.state, {
		schema: WATCHDOG_STATE_VERSION,
		task: "Fix login",
		scope: ["src/**"],
		hub_owned_paths: [".pi/agent-sessions/artifacts/**"],
		tool_events: [
			{ tool: "read", path: "src/app.ts", outcome: "success", repeat_group: 1, repeat_count: 1, protocol_owned: false },
			{ tool: "write", path: ".pi/agent-sessions/artifacts/plans/x.md", outcome: "success", repeat_group: 2, repeat_count: 1, protocol_owned: true },
			{ tool: "bash", outcome: "success", repeat_group: 3, repeat_count: 1, protocol_owned: false },
		],
		signal: { rule: "loop", terminal: true, facts: { tool_calls: 3, failures: 0, consecutive_failures: 0 } },
		counters: { tool_calls: 3, failures: 0, consecutive_failures: 0, elapsed_ms: 1000 },
		coverage: {
			events_seen: 3,
			events_retained: 3,
			dropped_by_window: 0,
			dropped_incomplete: 0,
			unparsed_events: 0,
			missing_tool_end: 0,
			missing_counters: false,
			truncated_fields: [],
			shortcut_blocked: false,
		},
	});
	const serialized = JSON.stringify(built.state);
	for (const sentinel of [COMMAND, BODY, SECRET, "/etc/passwd", "noul", "needs_external"]) {
		assert.equal(serialized.includes(sentinel), false, sentinel);
	}
	assert.equal(built.bytes, 881);
	assert.deepEqual(parseWatchdogStateV1(built.state), built.state);
});

test("protocol_owned is decided in the emitted relative path space, including absolute tool paths", () => {
	const root = "/repo";
	const hub = [".pi/agent-sessions/artifacts/**"];
	const absolute = buildWatchdogState({
		task: "write plan",
		scope: ["src/**"],
		hubOwnedPaths: hub,
		root,
		elapsedMs: 1,
		observation: {
			events: [
				{ tool: "write", path: "/repo/.pi/agent-sessions/artifacts/plans/x.md", outcome: "success", repeat_group: 1, repeat_count: 1 },
				{ tool: "write", path: "/repo/src/app.ts", outcome: "success", repeat_group: 2, repeat_count: 1 },
			],
			counters: { tool_calls: 2, failures: 0, consecutive_failures: 0 },
			coverage: { events_seen: 2, unparsed_events: 0, dropped_by_window: 0, dropped_incomplete: 0 },
		},
	});
	assert.equal(absolute.ok, true);
	if (!absolute.ok) return;
	assert.equal(absolute.state.tool_events[0].path, ".pi/agent-sessions/artifacts/plans/x.md");
	assert.equal(absolute.state.tool_events[0].protocol_owned, true);
	assert.equal(absolute.state.tool_events[1].path, "src/app.ts");
	assert.equal(absolute.state.tool_events[1].protocol_owned, false);
	assert.equal(absolute.state.hub_owned_paths[0], ".pi/agent-sessions/artifacts/**");

	const absoluteGlob = buildWatchdogState({
		task: "write plan",
		hubOwnedPaths: ["/repo/.pi/agent-sessions/artifacts/**"],
		root,
		elapsedMs: 1,
		observation: {
			events: [{ tool: "write", path: "/repo/.pi/agent-sessions/artifacts/plans/x.md", outcome: "success", repeat_group: 1, repeat_count: 1 }],
			counters: { tool_calls: 1, failures: 0, consecutive_failures: 0 },
			coverage: { events_seen: 1, unparsed_events: 0, dropped_by_window: 0, dropped_incomplete: 0 },
		},
	});
	assert.equal(absoluteGlob.ok && absoluteGlob.state.tool_events[0].protocol_owned, true);
	assert.equal(absoluteGlob.ok && absoluteGlob.state.tool_events[0].path, ".pi/agent-sessions/artifacts/plans/x.md");
	assert.equal(parseWatchdogStateV1({ raw_command: COMMAND, absolute: "/home/user/.ssh/id_rsa", api_key: SECRET }), null);
});

test("absolute and outside-root paths become markers and secret redaction blocks shortcut", () => {
	const built = buildWatchdogState({
		task: `review ${SECRET}`,
		scope: ["/etc/**", "../outside/**", "src/**"],
		hubOwnedPaths: ["/repo/.pi/agent-sessions/artifacts/**"],
		root: "/repo",
		elapsedMs: 5,
		observation: {
			events: [
				{ tool: "read", path: "/etc/passwd", outcome: "success", repeat_group: 1, repeat_count: 1 },
				{ tool: "edit", path: "../secret.env", outcome: "success", repeat_group: 2, repeat_count: 1 },
				{ tool: "chrome", path: "src/app.ts", outcome: "success", repeat_group: 3, repeat_count: 1 },
				{ tool: "read", path: "src/smuggle.ts", outcome: "success", repeat_group: 4, repeat_count: 1, command: COMMAND },
			],
			counters: { tool_calls: 3, failures: 0, consecutive_failures: 0 },
			coverage: { events_seen: 3, dropped_by_window: 0, dropped_incomplete: 0, unparsed_events: 0 },
		},
	});
	assert.equal(built.ok, true);
	if (!built.ok) return;
	assert.equal(built.state.scope.includes("/repo/src/**"), false);
	assert.equal(built.state.scope.includes("absolute"), true);
	assert.equal(built.state.scope.includes("outside_root"), true);
	assert.equal(built.state.hub_owned_paths.includes("/repo/.pi/agent-sessions/artifacts/**"), false);
	assert.equal(built.state.tool_events[0].path, "absolute");
	assert.equal(built.state.tool_events[1].path, "outside_root");
	assert.equal(built.state.tool_events[2].tool, "other");
	assert.equal(built.state.tool_events.some((event) => event.path === "src/smuggle.ts"), false);
	assert.equal(JSON.stringify(built.state).includes(SECRET), false);
	assert.equal(JSON.stringify(built.state).includes(COMMAND), false);
	assert.equal(built.state.coverage.shortcut_blocked, true);
	assert.equal(built.state.coverage.unparsed_events >= 1, true);
});

test("rolling window alone does not block shortcut; missing end, unparsed events, and missing counters do", () => {
	const monitor = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	for (let i = 0; i < 41; i++) {
		monitor.onToolStart("read", JSON.stringify({ path: `src/f${i}.ts` }));
		monitor.onToolEnd("read", false);
	}
	const rolling = buildWatchdogState({
		task: "bounded",
		scope: ["src/**"],
		elapsedMs: 10,
		observation: monitor.structuredObservation(),
	});
	assert.equal(rolling.ok, true);
	if (!rolling.ok) return;
	assert.equal(rolling.state.coverage.dropped_by_window, 1);
	assert.equal(rolling.state.coverage.events_retained, 40);
	assert.equal(rolling.state.coverage.shortcut_blocked, false);

	const open = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	open.onToolStart("read", JSON.stringify({ path: "src/open.ts" }));
	const missingEnd = buildWatchdogState({ task: "open", elapsedMs: 1, observation: open.structuredObservation() });
	assert.equal(missingEnd.ok && missingEnd.state.coverage.missing_tool_end, 1);
	assert.equal(missingEnd.ok && missingEnd.state.coverage.shortcut_blocked, true);

	const unparsed = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	unparsed.onToolStart("read", JSON.stringify({ path: "src/ok.ts" }));
	unparsed.onToolEnd("read", false);
	unparsed.onToolStart({ nope: true }, "nope");
	const exceptional = buildWatchdogState({ task: "bad", elapsedMs: 1, observation: unparsed.structuredObservation() });
	assert.equal(exceptional.ok && exceptional.state.coverage.unparsed_events, 1);
	assert.equal(exceptional.ok && exceptional.state.coverage.shortcut_blocked, true);

	const withheld = buildWatchdogState({
		task: "no counters",
		counters: null,
		observation: { events: [], coverage: { events_seen: 0, unparsed_events: 0, dropped_by_window: 0, dropped_incomplete: 0 } },
	});
	assert.equal(withheld.ok && withheld.state.coverage.missing_counters, true);
	assert.equal(withheld.ok && withheld.state.counters.elapsed_ms, undefined);
	assert.equal(withheld.ok && withheld.state.coverage.shortcut_blocked, true);
});

test("task, path, and array caps are visible and an oversized serialization skips without returning state", () => {
	const longTask = `task-${"x".repeat(5000)}`;
	const longPath = `src/${"p".repeat(300)}.ts`;
	const capped = buildWatchdogState({
		task: longTask,
		scope: Array.from({ length: 40 }, (_, index) => `src/${index}.ts`),
		elapsedMs: 1,
		observation: {
			events: [{ tool: "read", path: longPath, outcome: "success", repeat_group: 1, repeat_count: 1 }],
			counters: { tool_calls: 1, failures: 0, consecutive_failures: 0 },
			coverage: { events_seen: 1, unparsed_events: 0, dropped_by_window: 0, dropped_incomplete: 0 },
		},
	});
	assert.equal(capped.ok, true);
	if (!capped.ok) return;
	assert.equal(capped.state.task.length, 4096);
	assert.equal(capped.state.scope.length, 32);
	assert.equal(capped.state.tool_events[0].path?.length, 256);
	assert.deepEqual(capped.state.coverage.truncated_fields, ["scope", "task", "tool_events"]);
	assert.equal(capped.state.coverage.shortcut_blocked, true);

	const huge = buildWatchdogState({
		task: "T".repeat(4096),
		scope: Array.from({ length: 32 }, () => "s".repeat(256)),
		hubOwnedPaths: Array.from({ length: 32 }, () => "h".repeat(256)),
		elapsedMs: 1,
		observation: {
			events: Array.from({ length: 40 }, (_, index) => ({
				tool: "read",
				path: `e${String(index).padStart(3, "0")}${"p".repeat(256)}`,
				outcome: "success",
				repeat_group: index + 1,
				repeat_count: 1,
			})),
			counters: { tool_calls: 40, failures: 0, consecutive_failures: 0 },
			coverage: { events_seen: 40, unparsed_events: 0, dropped_by_window: 0, dropped_incomplete: 0 },
		},
	});
	assert.equal(huge.ok, false);
	if (huge.ok) return;
	assert.equal(huge.reason, "state_too_large");
	assert.equal(huge.bytes, 35559);
	assert.equal("state" in huge, false);
	assert.equal(JSON.stringify(huge).includes("T".repeat(64)), false);
});

function completeObservation(path = "src/app.ts") {
	return {
		events: [{ tool: "read", path, outcome: "success" as const, repeat_group: 1, repeat_count: 1 }],
		counters: { tool_calls: 1, failures: 0, consecutive_failures: 0 },
		coverage: { events_seen: 1, unparsed_events: 0, dropped_by_window: 0, dropped_incomplete: 0 },
	};
}

test("F1 redacted scope and hub paths block shortcut", () => {
	const scopeOnly = buildWatchdogState({
		task: "plain task",
		scope: [`src/api_key=${SECRET}`],
		hubOwnedPaths: ["artifacts/**"],
		elapsedMs: 1,
		observation: completeObservation(),
	});
	assert.equal(scopeOnly.ok, true);
	if (!scopeOnly.ok) return;
	assert.equal(scopeOnly.state.coverage.truncated_fields.includes("scope"), true);
	assert.equal(scopeOnly.state.coverage.truncated_fields.includes("hub_owned_paths"), false);
	assert.equal(scopeOnly.state.coverage.shortcut_blocked, true);
	assert.equal(JSON.stringify(scopeOnly.state).includes(SECRET), false);
	assert.equal(parseWatchdogStateV1(scopeOnly.state)?.coverage.shortcut_blocked, true);

	const hubOnly = buildWatchdogState({
		task: "plain task",
		scope: ["src/**"],
		hubOwnedPaths: [`art/token=${SECRET}`],
		elapsedMs: 1,
		observation: completeObservation(),
	});
	assert.equal(hubOnly.ok, true);
	if (!hubOnly.ok) return;
	assert.equal(hubOnly.state.coverage.truncated_fields.includes("hub_owned_paths"), true);
	assert.equal(hubOnly.state.coverage.truncated_fields.includes("scope"), false);
	assert.equal(hubOnly.state.coverage.shortcut_blocked, true);
	assert.equal(JSON.stringify(hubOnly.state).includes(SECRET), false);
});

test("F7 truncated paths stay parser-valid and round-trip", () => {
	const cases = [
		"a".repeat(253) + "/..foo-extra",
		"a".repeat(255) + " " + "tail",
		"a".repeat(250) + "/./" + "b".repeat(20),
		"scope/".repeat(40) + "..partial",
	];
	for (const raw of cases) {
		const built = buildWatchdogState({
			task: "truncate",
			scope: [raw],
			hubOwnedPaths: [raw],
			elapsedMs: 1,
			observation: completeObservation(raw),
		});
		assert.equal(built.ok, true, "oversized path must not become state_too_large by itself");
		if (!built.ok) return;
		const parsed = parseWatchdogStateV1(built.state);
		assert.ok(parsed, `truncated path must round-trip: ${raw.slice(0, 24)}`);
		const paths = [
			...built.state.scope,
			...built.state.hub_owned_paths,
			...built.state.tool_events.map((event) => event.path ?? ""),
		];
		for (const path of paths) {
			assert.equal(path.split("/").includes(".."), false);
			assert.equal(path, path.trim());
			assert.equal(path.length <= 256, true);
		}
		if (raw.length > 256) {
			assert.equal(built.state.coverage.truncated_fields.includes("tool_events"), true);
			assert.equal(built.state.coverage.shortcut_blocked, true);
		}
	}
});
