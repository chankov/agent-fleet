import test from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_WATCHDOG_SETTING,
	DRIFT_DEFAULTS,
	HUB_OWNED_SUBDIRS,
	buildJudgePrompt,
	createDriftMonitor,
	hubOwnedScopeGlobs,
	normalizeWatchdogSetting,
	parseJudgeVerdict,
	resolveWatchdogActive,
} from "./drift-watchdog.js";

test("normalizeWatchdogSetting accepts variants and rejects unknowns", () => {
	assert.equal(normalizeWatchdogSetting("on"), "on");
	assert.equal(normalizeWatchdogSetting(" AUTO "), "auto");
	assert.equal(normalizeWatchdogSetting("Off"), "off");
	assert.equal(normalizeWatchdogSetting("watch"), null);
	assert.equal(normalizeWatchdogSetting(undefined), null);
	assert.equal(DEFAULT_WATCHDOG_SETTING, "auto");
});

test("resolveWatchdogActive precedence: dispatch param > agent override > hub setting", () => {
	assert.equal(resolveWatchdogActive(true, "off", "off"), true);
	assert.equal(resolveWatchdogActive(false, "on", "on"), false);
	assert.equal(resolveWatchdogActive(undefined, "on", "off"), true);
	assert.equal(resolveWatchdogActive(undefined, "off", "auto"), false);
	assert.equal(resolveWatchdogActive(undefined, undefined, "auto"), true);
	assert.equal(resolveWatchdogActive(undefined, undefined, "on"), true);
	assert.equal(resolveWatchdogActive(undefined, undefined, "off"), false);
	// Junk hub settings fail open to armed (the harness normalizes upstream).
	assert.equal(resolveWatchdogActive(undefined, undefined, "junk"), true);
});

test("orchestrator auto-arms the watchdog and ignores dispatch watchdog:false", () => {
	assert.equal(resolveWatchdogActive(undefined, undefined, "auto", "orchestrator"), true);
	assert.equal(resolveWatchdogActive(undefined, undefined, "on", "orchestrator"), true);
	assert.equal(resolveWatchdogActive(false, undefined, "auto", "orchestrator"), true);
	assert.equal(resolveWatchdogActive(false, undefined, "off", "orchestrator"), false);
	assert.equal(resolveWatchdogActive(undefined, "off", "auto", "orchestrator"), false);
	assert.equal(resolveWatchdogActive(false, undefined, "auto", "operator"), false);
});

test("scope rule fires only for write tools outside the declared scope", () => {
	const m = createDriftMonitor({ scopeGlobs: ["src/**"] });
	assert.equal(m.onToolStart("read", JSON.stringify({ path: "docs/README.md" })), null);
	assert.equal(m.onToolStart("edit", JSON.stringify({ path: "src/app.ts" })), null);
	const v = m.onToolStart("write", JSON.stringify({ path: "scripts/rogue.sh" }));
	assert.equal(v.rule, "scope");
	assert.match(v.detail, /scripts\/rogue\.sh/);
});

test("scope rule never terminates a run by itself", () => {
	const m = createDriftMonitor({ scopeGlobs: ["src/**"] });
	const v = m.onToolStart("write", JSON.stringify({ path: "scripts/rogue.sh" }));
	assert.equal(v.terminal, false);
	// The rules that mean "no forward progress" stay terminal.
	const loop = createDriftMonitor({ maxRepeats: 2 });
	loop.onToolStart("grep", "{}");
	assert.equal(loop.onToolStart("grep", "{}").terminal, true);
	const caps = createDriftMonitor({ maxToolCalls: 1, maxRepeats: 100 });
	assert.equal(caps.onToolStart("read", "{}").terminal, true);
	const fails = createDriftMonitor({ maxConsecutiveFailures: 1 });
	assert.equal(fails.onToolEnd("bash", true).terminal, true);
});

test("hubOwnedScopeGlobs covers every session path form", () => {
	const globs = hubOwnedScopeGlobs("/repo/.pi/agent-sessions", ".pi/agent-sessions/");
	assert.equal(globs.length, HUB_OWNED_SUBDIRS.length * 2);
	assert.ok(globs.includes("/repo/.pi/agent-sessions/artifacts/**"));
	assert.ok(globs.includes(".pi/agent-sessions/findings/**"));
	assert.ok(globs.includes(".pi/agent-sessions/delegations/**"));
	// Empty / duplicate inputs contribute nothing.
	assert.deepEqual(hubOwnedScopeGlobs("", null, undefined), []);
	assert.equal(hubOwnedScopeGlobs("/a", "/a").length, HUB_OWNED_SUBDIRS.length);
});

test("writes to hub-owned artifact paths never fire the scope rule", () => {
	// The regression that killed `planner` after 1088s: the deliverable protocol
	// tells the specialist to write here, the dispatcher's scope never lists it.
	const allowGlobs = hubOwnedScopeGlobs("/repo/.pi/agent-sessions", ".pi/agent-sessions");
	const m = createDriftMonitor({ scopeGlobs: ["bin/**", "docs/**"], allowGlobs });

	assert.equal(m.onToolStart("write", JSON.stringify({ path: ".pi/agent-sessions/artifacts/plans/planner-run1.md" })), null);
	assert.equal(m.onToolStart("write", JSON.stringify({ path: "/repo/.pi/agent-sessions/artifacts/returns/x-run2.md" })), null);
	assert.equal(m.onToolStart("write", JSON.stringify({ path: ".pi/agent-sessions/findings/x-r1.md" })), null);
	// A genuinely rogue write still fires.
	assert.equal(m.onToolStart("write", JSON.stringify({ path: "src/rogue.ts" })).rule, "scope");
	// The allowlist does not silently widen the reported scope.
	const v = m.onToolStart("edit", JSON.stringify({ path: "other/x.ts" }));
	assert.match(v.detail, /bin\/\*\*, docs\/\*\*/);
	assert.equal(v.detail.includes("agent-sessions"), false);
});

test("a scope return does not consume the loop threshold", () => {
	const m = createDriftMonitor({ scopeGlobs: ["src/**"], maxRepeats: 2 });
	assert.equal(m.onToolStart("write", JSON.stringify({ path: "scripts/a.sh" })).rule, "scope");
	assert.equal(m.onToolStart("write", JSON.stringify({ path: "scripts/a.sh" })).rule, "scope");
	assert.equal(m.onToolStart("write", JSON.stringify({ path: "src/a.sh" })), null);
	assert.equal(m.onToolStart("write", JSON.stringify({ path: "src/a.sh" })).rule, "loop");
});

test("scope rule stays inert without declared scope globs", () => {
	const m = createDriftMonitor({});
	assert.equal(m.onToolStart("write", JSON.stringify({ path: "/etc/passwd" })), null);
});

test("loop rule fires once when the identical call crosses the repeat threshold", () => {
	const m = createDriftMonitor({ maxRepeats: 3 });
	const args = JSON.stringify({ pattern: "foo" });
	assert.equal(m.onToolStart("grep", args), null);
	assert.equal(m.onToolStart("grep", args), null);
	const v = m.onToolStart("grep", args);
	assert.equal(v.rule, "loop");
	// Only at the crossing — no spam on the next repeat.
	assert.equal(m.onToolStart("grep", args), null);
	// Different args are a different call.
	assert.equal(m.onToolStart("grep", JSON.stringify({ pattern: "bar" })), null);
});

test("failures rule needs consecutive errors and resets on success", () => {
	const m = createDriftMonitor({ maxConsecutiveFailures: 3 });
	assert.equal(m.onToolEnd("bash", true), null);
	assert.equal(m.onToolEnd("bash", true), null);
	assert.equal(m.onToolEnd("bash", false), null); // reset
	assert.equal(m.onToolEnd("bash", true), null);
	assert.equal(m.onToolEnd("bash", true), null);
	const v = m.onToolEnd("bash", true);
	assert.equal(v.rule, "failures");
	// Streams without error flags never trip the rule.
	const inert = createDriftMonitor({ maxConsecutiveFailures: 1 });
	assert.equal(inert.onToolEnd("bash", undefined), null);
});

test("toolcap rule fires at the total-call ceiling", () => {
	const m = createDriftMonitor({ maxToolCalls: 5, maxRepeats: 100 });
	let verdicts = [];
	for (let i = 0; i < 6; i++) {
		const v = m.onToolStart("read", JSON.stringify({ path: `f${i}.ts` }));
		if (v) verdicts.push(v);
	}
	assert.equal(verdicts.length, 1);
	assert.equal(verdicts[0].rule, "toolcap");
});

test("trail keeps the recent bounded window", () => {
	const m = createDriftMonitor({ trailLimit: 3, maxRepeats: 100, maxToolCalls: 1000 });
	for (let i = 0; i < 5; i++) m.onToolStart("read", JSON.stringify({ path: `f${i}.ts` }));
	const trail = m.trail(10);
	assert.equal(trail.length, 3);
	assert.match(trail[2], /f4\.ts/);
});

test("buildJudgePrompt embeds task, scope, signal, and trail", () => {
	const prompt = buildJudgePrompt({
		agent: "builder",
		task: "Fix the login form validation",
		scopeGlobs: ["src/auth/**"],
		trail: ["edit {\"path\":\"src/auth/login.ts\"}"],
		violation: { rule: "loop", detail: "edit called 4x" },
	});
	assert.match(prompt, /Fix the login form validation/);
	assert.match(prompt, /src\/auth\/\*\*/);
	assert.match(prompt, /Rule "loop" fired/);
	assert.match(prompt, /VERDICT: ON_TRACK/);
});

test("buildJudgePrompt tells the judge hub-owned writes are on-task", () => {
	const prompt = buildJudgePrompt({
		agent: "planner",
		task: "Write the plan",
		scopeGlobs: ["bin/**"],
		hubOwnedGlobs: [".pi/agent-sessions/artifacts/**"],
		violation: { rule: "scope", terminal: false, detail: "write touched .pi/agent-sessions/artifacts/plans/p.md" },
	});
	assert.match(prompt, /Hub-owned paths \(writing here is REQUIRED/);
	assert.match(prompt, /\.pi\/agent-sessions\/artifacts\/\*\*/);
	assert.match(prompt, /ADVISORY: it cannot stop the run by itself/);

	// A terminal rule carries no advisory disclaimer.
	const terminal = buildJudgePrompt({
		agent: "builder",
		task: "Fix it",
		violation: { rule: "loop", terminal: true, detail: "edit called 4x" },
	});
	assert.equal(terminal.includes("ADVISORY"), false);
	assert.equal(terminal.includes("Hub-owned paths"), false);
});

test("parseJudgeVerdict reads the last verdict line and tolerates garbage", () => {
	assert.deepEqual(
		parseJudgeVerdict("thinking...\nVERDICT: DRIFTING — rewriting unrelated CSS"),
		{ verdict: "drifting", reason: "rewriting unrelated CSS" },
	);
	assert.equal(parseJudgeVerdict("I think it is fine"), null);
	assert.equal(parseJudgeVerdict("no verdict here"), null);
	assert.deepEqual(parseJudgeVerdict("VERDICT: ON_TRACK"), { verdict: "on_track", reason: "" });
	assert.equal(parseJudgeVerdict("VERDICT: STUCK - infinite grep loop").verdict, "stuck");
});

test("DRIFT_DEFAULTS are conservative", () => {
	assert.ok(DRIFT_DEFAULTS.maxRepeats >= 3);
	assert.ok(DRIFT_DEFAULTS.maxConsecutiveFailures >= 5);
	assert.ok(DRIFT_DEFAULTS.maxToolCalls >= 100);
});

test("structured observation omits raw arguments while legacy trail still keeps its 120-character slice", () => {
	const command = "rm -rf SECRET_COMMAND_DO_NOT_SEND";
	const body = "SECRET_WRITE_BODY_DO_NOT_SEND";
	const m = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000, scopeGlobs: ["src/**"] });
	m.onToolStart("bash", JSON.stringify({ command }));
	m.onToolEnd("bash", false);
	m.onToolStart("write", JSON.stringify({ path: "src/app.ts", content: body }));
	m.onToolEnd("write", true);
	m.onToolStart("delegate", JSON.stringify({ task: body }));
	const trail = m.trail().join("\n");
	assert.match(trail, /SECRET_COMMAND_DO_NOT_SEND/);
	assert.match(trail, /SECRET_WRITE_BODY_DO_NOT_SEND/);
	assert.match(trail, /\u21b3 FAILED/);
	const observation = m.structuredObservation();
	const serialized = JSON.stringify(observation);
	assert.equal(serialized.includes("SECRET_COMMAND_DO_NOT_SEND"), false);
	assert.equal(serialized.includes("SECRET_WRITE_BODY_DO_NOT_SEND"), false);
	assert.equal(serialized.includes("command"), false);
	assert.equal(serialized.includes("content"), false);
	assert.equal(observation.events[0].tool, "bash");
	assert.equal(observation.events[0].outcome, "success");
	assert.equal(observation.events[0].path, undefined);
	assert.equal(observation.events[1].tool, "write");
	assert.equal(observation.events[1].path, "src/app.ts");
	assert.equal(observation.events[1].outcome, "error");
	assert.equal(observation.events[2].tool, "other");
	assert.equal(observation.events[2].outcome, "unknown");
	assert.equal(observation.events[0].repeat_group, observation.events[0].repeat_group);
	assert.notEqual(observation.events[0].repeat_group, observation.events[1].repeat_group);
	assert.equal(observation.coverage.missing_tool_end, 1);
	assert.equal(observation.counters.failures, 1);
	assert.equal(observation.counters.tool_calls, 3);
	// Triggers and one-shot crossings are unchanged by the observation.
	const loop = createDriftMonitor({ maxRepeats: 2 });
	assert.equal(loop.onToolStart("grep", "{}"), null);
	assert.equal(loop.onToolStart("grep", "{}").rule, "loop");
	assert.equal(loop.onToolStart("grep", "{}"), null);
	assert.equal(loop.structuredObservation().events[2].repeat_count, 3);
});

test("structured window drop of complete events is not incomplete loss", () => {
	const m = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	for (let i = 0; i < 41; i++) {
		m.onToolStart("read", JSON.stringify({ path: `src/f${i}.ts` }));
		m.onToolEnd("read", false);
	}
	const observation = m.structuredObservation();
	assert.equal(observation.events.length, 40);
	assert.equal(observation.coverage.events_seen, 41);
	assert.equal(observation.coverage.dropped_by_window, 1);
	assert.equal(observation.coverage.dropped_incomplete, 0);
	assert.equal(observation.coverage.unparsed_events, 0);
	assert.equal(observation.coverage.missing_tool_end, 0);
	assert.equal(observation.events[0].path, "src/f1.ts");
	assert.equal(m.trail(100).length <= 60, true);
});

test("structured outcomes follow callId, including out-of-order ends and the other bucket", () => {
	const m = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	m.onToolStart("read", JSON.stringify({ path: "a.ts" }), "call-a");
	m.onToolStart("read", JSON.stringify({ path: "b.ts" }), "call-b");
	assert.equal(m.onToolEnd("read", true, "call-b"), null);
	assert.equal(m.onToolEnd("read", false, "call-a"), null);
	const overlapped = m.structuredObservation();
	assert.equal(overlapped.events[0].path, "a.ts");
	assert.equal(overlapped.events[0].outcome, "success");
	assert.equal(overlapped.events[1].path, "b.ts");
	assert.equal(overlapped.events[1].outcome, "error");
	assert.equal(overlapped.coverage.missing_tool_end, 0);
	assert.equal(overlapped.coverage.unparsed_events, 0);
	assert.equal(JSON.stringify(overlapped).includes("call-a"), false);

	const other = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	other.onToolStart("delegate", JSON.stringify({ task: "plan" }), "del-1");
	other.onToolStart("chrome", JSON.stringify({ url: "https://example.test" }), "chr-1");
	other.onToolEnd("chrome", true, "chr-1");
	const collided = other.structuredObservation();
	assert.equal(collided.events[0].tool, "other");
	assert.equal(collided.events[0].outcome, "unknown");
	assert.equal(collided.events[1].tool, "other");
	assert.equal(collided.events[1].outcome, "error");
	assert.equal(collided.coverage.missing_tool_end, 1);

	const early = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	early.onToolEnd("read", true, "late");
	early.onToolStart("read", JSON.stringify({ path: "late.ts" }), "late");
	early.onToolEnd("read", false, "late");
	const reordered = early.structuredObservation();
	assert.equal(reordered.events[0].outcome, "success");
	assert.equal(reordered.coverage.unparsed_events, 1);
	assert.equal(reordered.coverage.missing_tool_end, 0);
});

test("ambiguous or missing tool outcomes stay incomplete instead of being guessed", () => {
	const ambiguous = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	ambiguous.onToolStart("read", JSON.stringify({ path: "a.ts" }));
	ambiguous.onToolStart("read", JSON.stringify({ path: "b.ts" }));
	ambiguous.onToolEnd("read", true);
	const guessed = ambiguous.structuredObservation();
	assert.equal(guessed.events[0].outcome, "unknown");
	assert.equal(guessed.events[1].outcome, "unknown");
	assert.equal(guessed.coverage.missing_tool_end, 2);
	assert.equal(guessed.coverage.unparsed_events, 1);

	const duplicate = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	duplicate.onToolStart("read", JSON.stringify({ path: "a.ts" }), "same");
	duplicate.onToolStart("read", JSON.stringify({ path: "b.ts" }), "same");
	duplicate.onToolEnd("read", true, "same");
	assert.equal(duplicate.structuredObservation().events.every((event) => event.outcome === "unknown"), true);
	assert.equal(duplicate.structuredObservation().coverage.unparsed_events, 1);

	const missingFlag = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	missingFlag.onToolStart("read", JSON.stringify({ path: "a.ts" }));
	assert.equal(missingFlag.onToolEnd("read", undefined), null);
	missingFlag.onToolStart("read", JSON.stringify({ path: "b.ts" }));
	missingFlag.onToolEnd("read", false);
	const incomplete = missingFlag.structuredObservation();
	assert.equal(incomplete.events[0].outcome, "unknown");
	assert.equal(incomplete.events[1].outcome, "success");
	assert.equal(incomplete.coverage.missing_tool_end, 0);
	// Layer 1 still ignores a missing error flag.
	const inert = createDriftMonitor({ maxConsecutiveFailures: 1 });
	assert.equal(inert.onToolEnd("bash", undefined), null);
	assert.equal(inert.onToolStart("bash", "{}"), null);
});

test("unparsed tool starts do not copy the raw value into the observation", () => {
	const m = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	m.onToolStart({ secret: "SENTINEL_UNPARSED" }, { command: "SENTINEL_UNPARSED" });
	const observation = m.structuredObservation();
	assert.equal(observation.events.length, 0);
	assert.equal(observation.coverage.unparsed_events, 1);
	assert.equal(JSON.stringify(observation).includes("SENTINEL_UNPARSED"), false);
	assert.equal(m.trail().join("\n"), "[object Object] [object Object]");
});
