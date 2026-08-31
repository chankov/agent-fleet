import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssertionsArtifactsContext, type Assertion } from "./assertions-artifacts.ts";

function fixture(assertions: Assertion[] = []) {
	const sessionDir = mkdtempSync(join(tmpdir(), "hub-context-"));
	const statuses: Array<[string, string]> = [];
	const context = createAssertionsArtifactsContext({
		getAssertions: () => assertions,
		getSessionDir: () => sessionDir,
		getRunHistoryKeep: () => 2,
		setStatus: (key, value) => statuses.push([key, value]),
	});
	return { context, sessionDir, statuses };
}

test("assertion context persists statuses and appends evidence to machine handoffs", () => {
	const assertions: Assertion[] = [
		{ id: "A1", tag: "test", text: "passes", source: "plan", status: "proven", evidence: "suite" },
		{ id: "A7", tag: "code-grep", text: "is wired", source: "plan", status: "open" },
	];
	const { context, sessionDir, statuses } = fixture(assertions);
	context.persistAssertions();
	context.updateAssertionStatus();
	const persisted = JSON.parse(readFileSync(join(sessionDir, "assertions.json"), "utf8"));
	assert.deepEqual(persisted, assertions);
	assert.match(statuses[0][1], /1✓ 1○ 0✗ · open: A7/);
	const evidenceDir = join(context.ensureArtifactsLayout(), "evidence");
	writeFileSync(join(evidenceDir, "proof.txt"), "runtime proof\n", "utf8");
	assert.equal(context.evidencePathExists("artifacts/evidence/proof.txt"), true);
	const handoff = context.appendMachineHandoffSections("brief");
	assert.match(handoff, /Verification ledger \(verbatim, machine-appended\)[\s\S]*A1 \[test\] PROVEN/);
	assert.match(handoff, /Artifact index[\s\S]*artifacts\/evidence\/proof\.txt/);
});

test("artifact context archives non-empty prior layouts without deleting recoverable data", () => {
	const { context, sessionDir } = fixture();
	const root = context.ensureArtifactsLayout();
	writeFileSync(join(root, "returns", "builder-run1.md"), "# Return\n", "utf8");
	const runId = context.archivePreviousRun();
	assert.ok(runId);
	assert.equal(existsSync(root), false);
	assert.equal(existsSync(join(sessionDir, "runs", runId!, "artifacts", "returns", "builder-run1.md")), true);
	assert.equal(existsSync(join(sessionDir, "runs", runId!, "meta.json")), true);
});
