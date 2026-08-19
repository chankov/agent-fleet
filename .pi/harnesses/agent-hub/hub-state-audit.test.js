import assert from "node:assert/strict";
import test from "node:test";

import {
	buildBudgetContinuationAudit,
	buildHubAuditIdentity,
	buildHubModeAudit,
	buildTaskResetAudit,
} from "./hub-state-audit.js";

test("Hub audit identity contains only allowlisted routing fields", () => {
	const identity = buildHubAuditIdentity({
		cwd: "/repo",
		pid: 42,
		sessionId: "session-1",
		project: "af",
		workspaceId: "workspace-1",
		paneId: "w1:p2",
		API_TOKEN: "secret",
		env: { PASSWORD: "secret" },
		prompt: "private task body",
	});
	assert.deepEqual(identity, {
		cwd: "/repo",
		pid: 42,
		session_id: "session-1",
		project: "af",
		herdr_workspace_id: "workspace-1",
		herdr_pane_id: "w1:p2",
	});
	assert.doesNotMatch(JSON.stringify(identity), /secret|private task body/);
});

test("mode audit distinguishes slash commands from project override application", () => {
	const identity = { cwd: "/repo", pid: 42, paneId: "w1:p2" };
	const command = buildHubModeAudit({
		previousMode: "fast",
		mode: "standard",
		source: "slash-command",
		taskTier: "feature",
		turnDispatches: 2,
		turnResearch: 1,
		identity,
	});
	const startup = buildHubModeAudit({
		previousMode: "standard",
		mode: "fast",
		source: "project-override",
		overrideFile: ".ai/agent-fleet-overrides.md",
		identity,
	});
	assert.equal(command.source, "slash-command");
	assert.equal(command.override_file, null);
	assert.equal(startup.source, "project-override");
	assert.equal(startup.override_file, ".ai/agent-fleet-overrides.md");
	assert.notDeepEqual(command, startup);
});

test("task reset audit records bounded prior counters without task bodies or environment", () => {
	const audit = buildTaskResetAudit({
		source: "tool:set_task_tier",
		label: " next task\ncontinued ",
		prior: { tier: "project", dispatches: 4, research: 2, reviewRounds: 1, activeMs: 1234 },
		identity: { cwd: "/repo", pid: 42, secret: "do-not-log" },
		prompt: "do-not-log",
	});
	assert.equal(audit.source, "tool:set_task_tier");
	assert.equal(audit.label, "next task continued");
	assert.deepEqual(audit.prior, {
		tier: "project",
		dispatches: 4,
		research: 2,
		review_rounds: 1,
		active_ms: 1234,
	});
	assert.doesNotMatch(JSON.stringify(audit), /do-not-log|prompt/);
});

test("budget continuation audit records the renewed tranche without task prose", () => {
	const audit = buildBudgetContinuationAudit({
		kind: "task",
		continuation: 3,
		reason: "task_wall",
		prior: { tier: "feature", dispatches: 6, research: 2, reviewRounds: 2, activeMs: 123_456 },
		identity: { cwd: "/repo", pid: 42 },
		prompt: "private remaining work",
	});
	assert.deepEqual(audit.prior, {
		tier: "feature",
		dispatches: 6,
		research: 2,
		review_rounds: 2,
		active_ms: 123456,
	});
	assert.equal(audit.kind, "task");
	assert.equal(audit.continuation, 3);
	assert.equal(audit.reason, "task_wall");
	assert.doesNotMatch(JSON.stringify(audit), /private remaining work|prompt/);
});

test("audit serializers are fail-soft for missing or malformed values", () => {
	assert.doesNotThrow(() => buildHubModeAudit());
	assert.doesNotThrow(() => buildTaskResetAudit({ prior: { activeMs: Number.NaN } }));
	assert.doesNotThrow(() => buildBudgetContinuationAudit({ prior: { activeMs: Number.NaN } }));
	assert.equal(buildTaskResetAudit({ prior: { activeMs: Number.NaN } }).prior.active_ms, 0);
	assert.equal(buildBudgetContinuationAudit({ prior: { activeMs: Number.NaN } }).prior.active_ms, 0);
});
