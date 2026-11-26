import { runAgentPhase } from "./lib/agent-phase.ts";
import { ENVELOPE_EXAMPLES, validateEnvelope, type BuildEnvelope as BuildEnvelopeSchema } from "./lib/envelopes.ts";
import { artifactsExist, diffMatchesClaims } from "./lib/gates.ts";
import { commitAll } from "./lib/git.ts";
import { snapshot, type PermissionSnapshot } from "./lib/permissions.ts";
import { logAssignment, resolveRole, withAssignment, type PersonaDefinition } from "./lib/personas.ts";
import { qualityCommand, runTests, type QualityResult } from "./lib/quality.ts";
import type { FinishResult, Run } from "./lib/run.ts";
import type { Static } from "@sinclair/typebox";

export type BuildReport = Static<typeof BuildEnvelopeSchema>;
export const MAX_BUILD_FIX_ATTEMPTS = 2;
const EDITOR_PERMISSION_POLICY = { writes: ["**"] };
/** The build phase is an editor with the implementation practice; the suite is the flow's own code phase. */
export const BUILD_ASSIGNMENT = { role: "editor", practices: ["implementation"] } as const;
export interface BuildTestDeps {
	agent?: (options: Parameters<typeof runAgentPhase<BuildReport>>[0]) => Promise<BuildReport>;
	tests?: (run: Run, options: { cwd: string }) => Promise<QualityResult>;
	commit?: (message: string, cwd: string, baseline: PermissionSnapshot, policy: { writes?: string[] }) => string | null;
	persona?: PersonaDefinition & { assignment?: string };
	baseline?: PermissionSnapshot;
	maxFixAttempts?: number;
}
const resolveEditor = (cwd: string) => resolveRole(BUILD_ASSIGNMENT.role, BUILD_ASSIGNMENT.practices, cwd);
export function buildTestWorkflowPreflight(cwd: string): void { resolveEditor(cwd); qualityCommand(cwd); }
function dryBuild(): BuildReport {
	const parsed = validateEnvelope<BuildReport>("build", JSON.stringify(ENVELOPE_EXAMPLES.build));
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.value!;
}
function redOutput(result: QualityResult): string { return `${result.stdout}${result.stderr}`; }

/** Phases: engineer(request) → agent(editor) → code(test) → agent(editor-fix, bounded) → code(commit) */
export async function buildTestWorkflow(run: Run, input: { args: string[]; dryRun: boolean; cwd: string }, deps: BuildTestDeps = {}): Promise<FinishResult> {
	const request = input.args.join(" ").trim();
	if (!request) throw Object.assign(new Error("build-test flow requires an implementation request"), { exitCode: 2 });
	const persona = deps.persona ?? resolveEditor(input.cwd);
	const baseline = deps.baseline ?? run.repositoryBaseline ?? snapshot(input.cwd);
	const agent = deps.agent ?? runAgentPhase<BuildReport>;
	const tests = deps.tests ?? ((activeRun, options) => runTests(activeRun, options));
	const commit = deps.commit ?? commitAll;
	await run.phase({ name: "request", kind: "engineer", owner: "operator", description: "Preserve the exact implementation outcome the operator asked for" }, phase => phase.log(request));
	let report = await run.phase({ name: "build", kind: "agent", owner: "editor", description: "Implement the requested change before deterministic verification" }, phase => { logAssignment(phase, persona); return input.dryRun ? dryBuild() : agent({ run, persona, task: withAssignment(request, persona), envelope: "build", cwd: input.cwd, gates: [artifactsExist, diffMatchesClaims], gateRetries: 1, permissionPolicy: EDITOR_PERMISSION_POLICY }); });
	let quality = await run.phase({ name: "test", kind: "code", owner: "quality", description: "Measure the implementation with the configured suite before any commit" }, async phase => {
		if (input.dryRun) { phase.log("dry-run: green quality result stubbed"); return { argv: ["dry-run"], exitCode: 0, stdout: "", stderr: "", logPath: run.trace.file, passed: true }; }
		const result = await tests(run, { cwd: input.cwd }); phase.log(result.passed ? "suite passed" : "suite failed", { exitCode: result.exitCode, logPath: result.logPath }); return result;
	});
	for (let attempt = 1; !quality.passed && attempt <= (deps.maxFixAttempts ?? MAX_BUILD_FIX_ATTEMPTS); attempt++) {
		const output = redOutput(quality);
		report = await run.phase({ name: `editor-fix-${attempt}`, kind: "agent", owner: "editor", description: "Correct the implementation using verbatim evidence from the red suite" }, () => input.dryRun ? dryBuild() : agent({
			run, persona, envelope: "build", cwd: input.cwd, gates: [artifactsExist, diffMatchesClaims], gateRetries: 1, permissionPolicy: EDITOR_PERMISSION_POLICY,
			task: withAssignment(`The deterministic test suite is red. Correct the implementation. The suite output below is forwarded verbatim:\n--- BEGIN VERBATIM TEST OUTPUT ---\n${output}\n--- END VERBATIM TEST OUTPUT ---`, persona),
		}));
		quality = await run.phase({ name: `test-after-fix-${attempt}`, kind: "code", owner: "quality", description: "Re-run the same configured suite to decide whether repair succeeded" }, async () => tests(run, { cwd: input.cwd }));
	}
	if (!quality.passed) return run.finish({ accepted: false, reason: `the suite remained red after ${deps.maxFixAttempts ?? MAX_BUILD_FIX_ATTEMPTS} editor fix attempts` });
	await run.phase({ name: "commit", kind: "code", owner: "git", description: "Create one commit only after deterministic verification is green" }, phase => {
		if (input.dryRun) return phase.log("dry-run: commit skipped");
		const hash = commit(report.commit_message, input.cwd, baseline, { writes: persona.writes });
		if (hash) phase.log("verified work committed", { hash });
		else phase.log("no flow-introduced changes to commit");
	});
	return run.finish({ accepted: true });
}
