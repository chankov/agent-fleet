import { statSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Run } from "./run.ts";
import { executeQuality } from "./quality.ts";

export interface GateCheck { item: string; ok: boolean; note: string }
export class GateReport {
	readonly gate: string;
	readonly checks: GateCheck[] = [];
	constructor(gate: string) { this.gate = gate; }
	check(item: string, ok: boolean, note: string): this { this.checks.push({ item, ok, note }); return this; }
	get ok(): boolean { return this.checks.length > 0 && this.checks.every(check => check.ok); }
	failures(): GateCheck[] { return this.checks.filter(check => !check.ok); }
}

export type Gate<T = any> = (envelope: T, run: Run) => GateReport | Promise<GateReport>;

function artifactPath(path: string, run: Run): string { return isAbsolute(path) ? path : resolve(run.trace.cwd, path); }

export const artifactsExist: Gate<{ artifacts?: string[] }> = (envelope, run) => {
	const report = new GateReport("artifactsExist");
	for (const item of envelope.artifacts ?? []) {
		try { const stat = statSync(artifactPath(item, run)); report.check(item, true, `${stat.size} bytes`); }
		catch { report.check(item, false, "declared artifact does not exist"); }
	}
	return envelope.artifacts?.length ? report : report.check("artifacts", true, "no artifacts declared");
};

export const filesNonEmpty: Gate<{ artifacts?: string[] }> = (envelope, run) => {
	const report = new GateReport("filesNonEmpty");
	for (const item of envelope.artifacts ?? []) {
		try { const size = statSync(artifactPath(item, run)).size; report.check(item, size > 0, `${size} bytes`); }
		catch { report.check(item, false, "file cannot be read"); }
	}
	return envelope.artifacts?.length ? report : report.check("artifacts", true, "no artifacts declared");
};

export const jsonParses: Gate<{ artifacts?: string[] }> = (envelope, run) => {
	const report = new GateReport("jsonParses");
	const items = (envelope.artifacts ?? []).filter(item => item.toLowerCase().endsWith(".json"));
	for (const item of items) {
		try { JSON.parse(readFileSync(artifactPath(item, run), "utf8")); report.check(item, true, "JSON.parse succeeded"); }
		catch (error) { report.check(item, false, error instanceof Error ? error.message : String(error)); }
	}
	return items.length ? report : report.check("json artifacts", true, "no JSON artifacts declared");
};

export const diffMatchesClaims: Gate<{ changed_files?: string[] }> = (envelope, run) => {
	const report = new GateReport("diffMatchesClaims");
	for (const item of envelope.changed_files ?? []) {
		try { const stat = statSync(artifactPath(item, run)); report.check(item, true, `${stat.size} bytes on disk`); }
		catch { report.check(item, false, "claimed changed file does not exist"); }
	}
	return envelope.changed_files?.length ? report : report.check("changed_files", true, "no changed files claimed");
};

export function testsPass(argv: string[], options: { cwd?: string; timeoutSeconds?: number } = {}): Gate {
	return async (_envelope, run) => {
		const logPath = resolve(run.trace.directory, `gate-tests-${Date.now()}.log`);
		const result = await executeQuality(argv, { cwd: options.cwd ?? run.trace.cwd, logPath, timeoutSeconds: options.timeoutSeconds, signal: run.signal });
		const evidence = result.passed ? `exit 0; ${logPath}` : `${(result.stderr || result.stdout).slice(-4000)}\n${logPath}`;
		return new GateReport("testsPass").check(argv.join(" "), result.passed, evidence);
	};
}

export const verdictConsistent: Gate<{ approved?: boolean; assertions_failed?: unknown[]; assertions_unproven?: unknown[]; open_risks?: unknown[]; requires_user_decision?: unknown[] }> = envelope => {
	const report = new GateReport("verdictConsistent");
	const failed = envelope.assertions_failed ?? [];
	const unproven = envelope.assertions_unproven ?? [];
	const decisions = envelope.requires_user_decision ?? [];
	const problems = [...failed, ...unproven, ...(envelope.open_risks ?? []), ...decisions];
	report.check("approved vs failed assertions", !envelope.approved || failed.length === 0, envelope.approved && failed.length ? "approved verdict has blocking failed assertions" : "consistent");
	report.check("approved vs unresolved work", !envelope.approved || (unproven.length === 0 && decisions.length === 0), envelope.approved && (unproven.length || decisions.length) ? "approved verdict has unresolved assertions or decisions" : "consistent");
	report.check("rejection names a problem", envelope.approved !== false || problems.length > 0, envelope.approved === false && problems.length === 0 ? "rejected verdict names no problem" : "consistent");
	return report;
};

export function gateCorrectionPrompt(reports: GateReport[]): string {
	const failures = reports.flatMap(report => report.failures().map(check => `- ${report.gate} / ${check.item}: ${check.note}`));
	return `Your previous work failed executable gates:\n${failures.join("\n")}\nCorrect the work in this same session, then re-emit ONLY your Report JSON.`;
}
