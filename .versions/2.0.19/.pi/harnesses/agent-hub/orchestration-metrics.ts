export type UnknownMetric = "unknown";

export interface TimingFields {
	orchestrationMs: number | UnknownMetric;
	modelMs: number | UnknownMetric;
	toolTestMs: number | UnknownMetric;
	waitMs: number | UnknownMetric;
}

export interface TestRunRecord {
	suiteId: string;
	selector: string;
	executed: number;
	passed: number;
	failed: number;
	claimed?: "pass" | "fail";
	result?: "pass" | "fail" | "skipped" | "indeterminate";
	fabricated?: boolean;
	testIds?: string[];
}

export interface SessionBaseline {
	specialistWallMs: number;
	humanWaitExcluded: true;
	timings: TimingFields;
	runs: TestRunRecord[];
}

export interface CoverageReport {
	runs: number;
	executions: number;
	unique: number | UnknownMetric;
	overlap: number | UnknownMetric;
}

/** Observed P2.3 specialist wall time. Splits were not measured and stay unknown. */
export function p23Baseline(): SessionBaseline {
	return {
		specialistWallMs: 2799,
		humanWaitExcluded: true,
		timings: {
			orchestrationMs: "unknown",
			modelMs: "unknown",
			toolTestMs: "unknown",
			waitMs: "unknown",
		},
		runs: [
			{ suiteId: "focused", selector: "adapter", executed: 69, passed: 69, failed: 0, claimed: "pass" },
			{ suiteId: "regression", selector: "adapter-regression", executed: 141, passed: 141, failed: 0, claimed: "pass" },
		],
	};
}

export function uniqueCoverage(runs: TestRunRecord[]): CoverageReport {
	const executions = runs.reduce((sum, run) => sum + run.executed, 0);
	const identified = runs.every(run => Array.isArray(run.testIds) && run.testIds.length === run.executed);
	if (!identified) return { runs: runs.length, executions, unique: "unknown", overlap: "unknown" };
	const seen = new Map<string, number>();
	for (const run of runs) for (const id of run.testIds ?? []) seen.set(id, (seen.get(id) ?? 0) + 1);
	const unique = seen.size;
	const overlap = [...seen.values()].filter(count => count > 1).length;
	return { runs: runs.length, executions, unique, overlap };
}

export function recordTestRun(record: TestRunRecord): TestRunRecord {
	return { ...record, testIds: record.testIds ? [...record.testIds] : undefined };
}

export function acceptTestEvidence(record: TestRunRecord | undefined): { ok: true } | { ok: false; reason: string } {
	if (!record || !record.suiteId || !record.selector || typeof record.executed !== "number") {
		return { ok: false, reason: "missing test-run evidence" };
	}
	if (record.fabricated) return { ok: false, reason: "fabricated test evidence" };
	if (record.result === "skipped" || record.result === "indeterminate") return { ok: false, reason: `${record.result} run is not success` };
	if (record.claimed === "pass" && record.executed === 0) return { ok: false, reason: "zero-test run is not success" };
	if (record.claimed === "pass" && record.passed !== record.executed) return { ok: false, reason: "pass claim does not match executed count" };
	return { ok: true };
}
