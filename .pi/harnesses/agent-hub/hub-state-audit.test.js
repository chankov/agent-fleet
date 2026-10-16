import assert from "node:assert/strict";
import test from "node:test";

import {
	buildHubAuditIdentity,
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

test("audit serializers are fail-soft for missing or malformed values", () => {
	assert.doesNotThrow(() => buildTaskResetAudit({ prior: { activeMs: Number.NaN } }));
	assert.equal(buildTaskResetAudit({ prior: { activeMs: Number.NaN } }).prior.active_ms, 0);
});
