import { asEnvelope, qualityCommand, runTests } from "./lib/quality.ts";
import type { Run, FinishResult } from "./lib/run.ts";

export function qualityWorkflowPreflight(cwd: string): void { qualityCommand(cwd); }

/** Phases: engineer(request) → code(quality) */
export async function qualityWorkflow(run: Run, input: { args: string[]; dryRun: boolean; cwd: string }): Promise<FinishResult> {
	const request = input.args.join(" ") || "Run the repository quality suite";
	await run.phase({ name: "request", kind: "engineer", owner: "operator", description: "Record the quality outcome the operator asked the workflow to prove" }, ph => ph.log(request));
	const result = await run.phase({ name: "quality", kind: "code", owner: "quality", description: "Execute the configured suite as deterministic acceptance evidence" }, async ph => {
		if (input.dryRun) {
			ph.log("dry-run: quality command skipped");
			return { passed: true, exitCode: 0, argv: ["dry-run"], stdout: "", stderr: "", logPath: run.trace.file };
		}
		const quality = await runTests(run, { cwd: input.cwd });
		ph.log(asEnvelope(quality, "quality suite").summary, { exitCode: quality.exitCode, logPath: quality.logPath });
		return quality;
	});
	return run.finish({ accepted: result.passed, reason: result.passed ? undefined : "the quality suite did not pass" });
}
