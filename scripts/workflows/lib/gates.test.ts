import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactsExist, diffMatchesClaims, filesNonEmpty, jsonParses, testsPass, verdictConsistent } from "./gates.ts";
import { Run } from "./run.ts";

function fixture() { const cwd = mkdtempSync(join(tmpdir(), "flow-gates-")); return { cwd, run: new Run({ cwd, runId: "gates" }) }; }

test("artifact gates report evidence for every checked item", () => {
	const { cwd, run } = fixture();
	try {
		writeFileSync(join(cwd, "good.json"), "{\"ok\":true}"); writeFileSync(join(cwd, "empty.txt"), "");
		const exists = artifactsExist({ artifacts: ["good.json", "missing.txt"] }, run);
		assert.deepEqual(exists.checks.map(check => [check.item, check.ok]), [["good.json", true], ["missing.txt", false]]);
		assert.equal(filesNonEmpty({ artifacts: ["good.json", "empty.txt"] }, run).ok, false);
		assert.equal(jsonParses({ artifacts: ["good.json"] }, run).ok, true);
		writeFileSync(join(cwd, "bad.json"), "{"); assert.equal(jsonParses({ artifacts: ["bad.json"] }, run).ok, false);
		assert.equal(diffMatchesClaims({ changed_files: ["good.json", "gone.ts"] }, run).ok, false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("testsPass executes a real red command and returns correction evidence", async () => {
	const { cwd, run } = fixture();
	try {
		const report = await testsPass([process.execPath, "-e", "console.error('RED-SUITE');process.exit(9)"], { cwd })({}, run);
		assert.equal(report.ok, false); assert.match(report.checks[0].note, /RED-SUITE/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("verdictConsistent rejects all three contradictory verdicts", () => {
	const base = { assertions_failed: [], assertions_unproven: [], open_risks: [], requires_user_decision: [] };
	assert.equal(verdictConsistent({ ...base, approved: true, assertions_failed: ["blocking"] }, {} as Run).ok, false);
	assert.equal(verdictConsistent({ ...base, approved: true, assertions_unproven: ["A1"] }, {} as Run).ok, false);
	assert.equal(verdictConsistent({ ...base, approved: false }, {} as Run).ok, false);
	assert.equal(verdictConsistent({ ...base, approved: true }, {} as Run).ok, true);
});
