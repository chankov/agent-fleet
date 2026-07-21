import test from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_WATCHDOG_SETTING,
	DRIFT_DEFAULTS,
	buildJudgePrompt,
	createDriftMonitor,
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

test("scope rule fires only for write tools outside the declared scope", () => {
	const m = createDriftMonitor({ scopeGlobs: ["src/**"] });
	assert.equal(m.onToolStart("read", JSON.stringify({ path: "docs/README.md" })), null);
	assert.equal(m.onToolStart("edit", JSON.stringify({ path: "src/app.ts" })), null);
	const v = m.onToolStart("write", JSON.stringify({ path: "scripts/rogue.sh" }));
	assert.equal(v.rule, "scope");
	assert.match(v.detail, /scripts\/rogue\.sh/);
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
