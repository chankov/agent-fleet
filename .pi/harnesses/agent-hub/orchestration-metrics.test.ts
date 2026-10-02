import assert from "node:assert/strict";
import test from "node:test";
import { acceptTestEvidence, p23Baseline, recordTestRun, uniqueCoverage } from "./orchestration-metrics.ts";

test("P2.3 baseline keeps specialist time separate from unknown splits", () => {
	const baseline = p23Baseline();
	assert.equal(baseline.specialistWallMs, 2799);
	assert.equal(baseline.humanWaitExcluded, true);
	assert.equal(baseline.timings.orchestrationMs, "unknown");
	assert.equal(baseline.timings.modelMs, "unknown");
	assert.equal(baseline.timings.toolTestMs, "unknown");
	assert.equal(baseline.timings.waitMs, "unknown");
	assert.notEqual(baseline.timings.modelMs, 0);
});

test("overlapping suites are not summed into unique coverage", () => {
	const coverage = uniqueCoverage([
		{ suiteId: "focused", selector: "adapter", executed: 69, passed: 69, failed: 0 },
		{ suiteId: "regression", selector: "adapter-regression", executed: 141, passed: 141, failed: 0 },
	]);
	assert.equal(coverage.executions, 210);
	assert.equal(coverage.runs, 2);
	assert.equal(coverage.unique, "unknown");
	assert.notEqual(coverage.unique, 210);
});

test("named test ids can report overlap without inventing it", () => {
	const coverage = uniqueCoverage([
		{ suiteId: "focused", selector: "a", executed: 2, passed: 2, failed: 0, testIds: ["t1", "t2"] },
		{ suiteId: "regression", selector: "b", executed: 2, passed: 2, failed: 0, testIds: ["t2", "t3"] },
	]);
	assert.equal(coverage.unique, 3);
	assert.equal(coverage.overlap, 1);
});

test("each run keeps selector identity and skipped or indeterminate work is not a pass", () => {
	const focused = recordTestRun({ suiteId: "focused", selector: "adapter", executed: 69, passed: 69, failed: 0, result: "pass" });
	const regression = recordTestRun({ suiteId: "regression", selector: "adapter-regression", executed: 141, passed: 141, failed: 0, result: "pass" });
	const coverage = uniqueCoverage([focused, regression]);
	assert.equal(coverage.runs, 2);
	assert.equal(coverage.executions, 210);
	assert.equal(coverage.unique, "unknown");
	assert.match(acceptTestEvidence(recordTestRun({ suiteId: "skipped", selector: "adapter", executed: 0, passed: 0, failed: 0, result: "skipped" })).reason, /not success/);
	assert.match(acceptTestEvidence(recordTestRun({ suiteId: "unknown-run", selector: "adapter", executed: 1, passed: 0, failed: 0, result: "indeterminate" })).reason, /not success/);
});

test("schema rejects fabricated, missing, and zero-test success", () => {
	assert.equal(acceptTestEvidence(undefined).ok, false);
	assert.match(acceptTestEvidence({ claimed: "pass" }).reason, /missing/);
	assert.match(acceptTestEvidence({
		suiteId: "empty", selector: "none", executed: 0, passed: 0, failed: 0, claimed: "pass",
	}).reason, /zero-test/);
	assert.match(acceptTestEvidence({
		suiteId: "made-up", selector: "none", executed: 1, passed: 1, failed: 0, claimed: "pass", fabricated: true,
	}).reason, /fabricated/);
	assert.equal(acceptTestEvidence({
		suiteId: "focused", selector: "adapter", executed: 69, passed: 69, failed: 0, claimed: "pass",
	}).ok, true);
});
