import { test } from "node:test";
import assert from "node:assert/strict";

import { validateEvidence } from "./evidence-rules.js";

const exists = (wanted) => (path) => path === wanted;
const evidenceRoot = "/tmp/session/.pi/agent-sessions/artifacts/evidence";

test("test evidence requires command/test identifier and outcome", () => {
	assert.deepEqual(validateEvidence("test", "npm test → pass (44/44)"), { ok: true });
	assert.match(validateEvidence("test", "npm test").reason, /outcome/);
	assert.match(validateEvidence("test", "passed 44\/44").reason, /command or test identifier/);
});

test("runtime-ui evidence requires an existing session artifacts/evidence path", () => {
	assert.deepEqual(
		validateEvidence("runtime-ui", "screenshot: artifacts/evidence/login.png", {
			evidenceRoot,
			fileExists: exists(`${evidenceRoot}/login.png`),
		}),
		{ ok: true },
	);
	assert.match(validateEvidence("runtime-ui", "DOM observation only", { evidenceRoot, fileExists: () => true }).reason, /artifacts\/evidence/);
	assert.match(validateEvidence("runtime-ui", "screenshot: artifacts/evidence/missing.png", { evidenceRoot, fileExists: () => false }).reason, /does not exist/);
});

test("runtime-ui evidence rejects repo-local artifacts/evidence paths", () => {
	assert.match(
		validateEvidence("runtime-ui", "screenshot: ./artifacts/evidence/login.png", {
			evidenceRoot,
			fileExists: exists(`${evidenceRoot}/login.png`),
		}).reason,
		/session artifact evidence path/,
	);
});

test("code-grep evidence requires pattern and match or no-match sample", () => {
	assert.deepEqual(validateEvidence("code-grep", "pattern: /foo/; match: src/a.ts:12 foo"), { ok: true });
	assert.match(validateEvidence("code-grep", "pattern: /foo/").reason, /result sample/);
	assert.match(validateEvidence("code-grep", "src/a.ts:12 foo matched").reason, /searched pattern/);
});

test("manual evidence requires user or ask_user confirmation", () => {
	assert.deepEqual(validateEvidence("manual", "ask_user answer: user confirmed option A"), { ok: true });
	assert.match(validateEvidence("manual", "looks reasonable").reason, /user confirmation/);
});

test("unknown assertion tags are rejected for proven evidence", () => {
	assert.match(validateEvidence("security", "evidence: ok").reason, /Unknown assertion tag/);
});
