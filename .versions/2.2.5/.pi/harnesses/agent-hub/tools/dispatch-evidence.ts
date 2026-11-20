import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { diagnoseChangedTypeScript, type DiagnosticsResult } from "../../lib/changed-file-diagnostics.ts";
import { readBackDeliverables, type AcceptanceRequirement, type RuntimeResultInput, type VerificationCheckInput } from "../acceptance.ts";
import { retainDeliverable } from "../execution-evidence.ts";
import { safeAgentKey } from "../helpers.ts";
import { privateConfigRevision } from "../private-config-current-state.ts";
import { privateRequirements } from "../private-config-review.ts";
import { correctStructuredReturnForCompiler, crossCheck, deliveryDisposition, extractAssertionIds, parseDeliveredReturn, validateBoundAssertionIds } from "../return-contract.js";
import { anchorRuntimeReceipt, receiptDeclarationHash, reusableRuntimeChecks, type RuntimeReceipt } from "../runtime-receipts.ts";
import { checkScope, diffAgainst, revisionOf, snapshotRevision, worktreeRevision } from "../scope-gate.js";
import { diagnoseToolProtocol, type ToolProtocolDiagnostic } from "../tool-protocol.ts";
import type { DispatchDecision, DispatchOutcome } from "./dispatch-decisions.ts";
import type { DispatchExecutorDeps, DispatchResult, PreparedDispatch, Tracking, WorktreeObservation } from "./dispatch-execution-types.ts";

/** Writable dispatches running now other than this one (registry when available, else the counter). */
function otherActiveWriters(d: DispatchExecutorDeps, p: PreparedDispatch, tracking: Tracking): { agent: string }[] {
	const s = d.state;
	const writers = s.getActiveWriters?.()
		?? Array.from({ length: Math.max(0, s.getActiveWritableDispatches() - (tracking.writable ? 1 : 0)) }, () => ({ agent: "a writable dispatch" }));
	return writers.filter(writer => writer.agent.toLowerCase() !== p.agent.toLowerCase());
}

function writerOverlappedReview(d: DispatchExecutorDeps, tracking: Tracking): boolean {
	return tracking.concurrentAtStart || tracking.writerGeneration !== d.state.getWriterGeneration?.()
		|| tracking.overlapBaseline !== d.state.getWritableOverlapCounter();
}

function observeWorktree(d: DispatchExecutorDeps, tracking: Tracking, ctx: ExtensionContext): WorktreeObservation | null {
	if (!tracking.snapshot) return null;
	const diff = diffAgainst(tracking.snapshot, ctx.cwd || process.cwd());
	if (tracking.isolatedScope && !diff.skipped) {
		// The OS sandbox confined this writer to its scope, and the admission gate let
		// only isolated writers with disjoint scopes run beside it. Changes outside
		// its scope cannot be its own; they are reported, never attributed to it.
		const own = tracking.isolatedScope.length ? checkScope(diff.paths, tracking.isolatedScope).inScope : [];
		return { ...diff, paths: own, foreignPaths: diff.paths.filter(path => !own.includes(path)), concurrentWritableOverlap: false };
	}
	const concurrentWritableOverlap = tracking.concurrentAtStart || d.state.getWritableOverlapCounter() !== tracking.overlapBaseline;
	return { ...diff, concurrentWritableOverlap };
}

export function incompleteObservation(reason: string, overlap: boolean): DiagnosticsResult {
	return { status: "incomplete", reason, changedFiles: [], attribution: overlap ? "uncertain" : "no_observed_overlap", projects: [], uncoveredFiles: [] };
}

/** Compiler discovery starts at each observed repository, never at a non-Git parent. */
export async function diagnoseObservation(d: DispatchExecutorDeps, observation: WorktreeObservation, cwd: string, cacheLane: string, runId: string): Promise<DiagnosticsResult> {
	const diagnose = d.diagnoseChangedTypeScript ?? diagnoseChangedTypeScript;
	const options = { cwd, attribution: observation.concurrentWritableOverlap ? "uncertain" as const : "no_observed_overlap" as const, cacheLane, runId };
	if (!observation.repositories) return diagnose(observation.paths, options);
	const results: DiagnosticsResult[] = [];
	for (const repo of observation.repositories) {
		const paths = observation.paths.filter(path => path.startsWith(`${repo.prefix}/`)).map(path => path.slice(repo.prefix.length + 1));
		if (!paths.some(path => /\.(?:ts|tsx|mts|cts)$/i.test(path))) continue;
		const workspacePath = (path: string) => isAbsolute(path) ? path : `${repo.prefix}/${path}`;
		const unavailable = (reason: string): DiagnosticsResult => ({
			...incompleteObservation(reason, observation.concurrentWritableOverlap), changedFiles: paths.map(workspacePath), uncoveredFiles: paths.map(workspacePath),
			projects: [{ project: repo.root, status: "unavailable", reason, exitCode: null, argv: [], stdout: "", stderr: "", diagnostics: [] }],
		});
		try {
			const result = await diagnose(paths, { ...options, cwd: repo.root });
			results.push({ ...result, changedFiles: result.changedFiles.map(workspacePath), uncoveredFiles: result.uncoveredFiles?.map(workspacePath), projects: result.projects.map(project => ({
				...project, project: workspacePath(project.project), changedFiles: project.changedFiles?.map(workspacePath),
				diagnostics: project.diagnostics.map(diagnostic => ({ ...diagnostic, ...(diagnostic.file ? { file: workspacePath(diagnostic.file) } : {}) })),
			})) });
			// A passing sibling project cannot cover a repository whose compiler
			// verification was incomplete. Retain the unavailable check explicitly.
			if (result.status !== "completed" || result.uncoveredFiles?.length) results.push(unavailable(`${repo.prefix}: ${result.reason ?? "Compiler coverage incomplete"}`));
		} catch (error) { results.push(unavailable(`Compiler observation failed for ${repo.prefix}: ${String(error)}`)); }
	}
	const reasons = [...(observation.gaps ?? []).map(gap => `${gap.scope}: ${gap.reason}`), ...results.filter(result => result.status === "incomplete").map(result => result.reason ?? "Compiler observation incomplete")];
	return { status: reasons.length ? "incomplete" : results.some(result => result.status === "completed") ? "completed" : "skipped",
		reason: reasons.length ? reasons.join("; ") : undefined, attribution: options.attribution,
		changedFiles: [...new Set(results.flatMap(result => result.changedFiles))], projects: results.flatMap(result => result.projects), uncoveredFiles: [...new Set(results.flatMap(result => result.uncoveredFiles ?? []))] };
}

export function beginDispatchEvidence(d: DispatchExecutorDeps, p: PreparedDispatch, result: DispatchResult, tracking: Tracking, ctx: ExtensionContext, sameTaskNow: () => boolean) {
	const s = d.state;
	const ids = validateBoundAssertionIds(p.resumeContract.boundAssertionIds) ?? extractAssertionIds(p.task); const disposition = deliveryDisposition(result.exitCode, result.pending === true);
	// Observe immediately at logical child completion, before Hub-owned artifacts are written.
	const observation = tracking.writable ? observeWorktree(d, tracking, ctx) : null;
	const submission = disposition.delivered ? result.specialistResult : undefined;
 const deliveredReturn = submission
  ? { parsed: submission, notices: crossCheck(submission, ids) }
  : parseDeliveredReturn(result.output, ids, disposition.delivered);
	const parsedReturn: any = deliveredReturn.parsed; const contractNotices: any[] = deliveredReturn.notices;
	const shouldUseDigest = ids.length > 0 || !!parsedReturn; const state = sameTaskNow() ? s.getAgentStates().get(p.agent.toLowerCase()) : undefined;
	const key = safeAgentKey(state?.def.name ?? p.agent); const backendUsed = state?.lastBackend ?? null;
	const failureMetadata = { dispatchId: result.dispatchId ?? null, transcriptPath: result.transcriptPath ?? null,
		agent: p.agent, task: p.task, scope: p.scopeGlobs, exitCode: result.exitCode, diagnostics: result.diagnostics ?? null };
	const artifactOutput = disposition.delivered ? (submission ? result.output + "\n\n## Submitted result\n\n" + JSON.stringify(submission, null, 2) : result.output)
		: `# Dispatch failure\n\n\`\`\`json\n${JSON.stringify(failureMetadata, null, 2)}\n\`\`\`\n\n## Output\n\n${result.output}`;
	const runPath = disposition.artifactKind ? d.artifacts.writeRunArtifact(key, state?.runCount ?? 0, artifactOutput, disposition.artifactKind as any, result.dispatchId, p.sessionDir) : null;
	const returnPath = disposition.delivered ? runPath : null; const failurePath = disposition.delivered ? null : runPath;
	return { ids, disposition, observation, submission, parsedReturn, contractNotices, shouldUseDigest, state, key, backendUsed, runPath, returnPath, failurePath, returnExtracted: false };
}

type InitialEvidence = ReturnType<typeof beginDispatchEvidence>;

export function prepareDispatchCompiler(p: PreparedDispatch, tracking: Tracking, evidence: InitialEvidence, cwd: string, isSourceReview: boolean, sameTaskNow: () => boolean) {
	const { observation, disposition, backendUsed } = evidence;
	// Reuse the post-run observation for compiler checks, before running any compiler.
	const compilerInspectedRevision = observation && !observation.skipped && observation.snapshot ? snapshotRevision(observation.snapshot) : isSourceReview ? "unavailable" : worktreeRevision(cwd, [], p.scopeGlobs);
	const eligibleForCompiler = disposition.delivered && tracking.writable && backendUsed === "native" && sameTaskNow();
	if (eligibleForCompiler && observation?.skipped) {
		return { compilerInspectedRevision, observationToCheck: null, compilerDiagnostics: incompleteObservation(`worktree observation unavailable: ${observation.reason ?? "unknown reason"}`, observation.concurrentWritableOverlap) };
	}
	const observationToCheck = eligibleForCompiler && observation && (observation.gaps?.length || observation.paths.some(path => /\.(?:ts|tsx|mts|cts)$/i.test(path))) ? observation : null;
	return { compilerInspectedRevision, observationToCheck, compilerDiagnostics: null };
}

export function completeDispatchEvidence(d: DispatchExecutorDeps, p: PreparedDispatch, result: DispatchResult, tracking: Tracking, initial: InitialEvidence, compiler: ReturnType<typeof prepareDispatchCompiler>, compilerDiagnostics: DiagnosticsResult | null, cwd: string, isSourceReview: boolean, sameTaskNow: () => boolean) {
	const s = d.state;
	const { ids, disposition, observation, state, key, backendUsed, returnPath } = initial;
	const { compilerInspectedRevision, observationToCheck } = compiler;
	const compilerRan = observationToCheck !== null;
	let { parsedReturn, contractNotices } = initial;
	let compilerEvidencePath: string | null = null;
	let compilerEvidenceError: string | null = null;
	if (observation && !tracking.isolatedScope) {
		observation.concurrentWritableOverlap = observation.concurrentWritableOverlap || tracking.concurrentAtStart || s.getWritableOverlapCounter() !== tracking.overlapBaseline;
		if (compilerDiagnostics && observation.concurrentWritableOverlap) compilerDiagnostics = { ...compilerDiagnostics, attribution: "uncertain" };
	}
	const sameTask = sameTaskNow();
	if (sameTask && compilerDiagnostics) {
		const correction = correctStructuredReturnForCompiler(parsedReturn, ids, compilerDiagnostics);
		parsedReturn = correction.parsed;
		contractNotices = [...crossCheck(parsedReturn, ids), ...correction.demotedIds.map(id => ({ type: "compiler_diagnostics", id }))];
	}
	const assessmentId = result.dispatchId ?? randomUUID();
	if (compilerDiagnostics && compilerDiagnostics.status !== "skipped") {
		try {
			compilerEvidencePath = d.artifacts.writeRunArtifact(`${key}-compiler`, state?.runCount ?? 0,
				`# Compiler diagnostics\n\n\`\`\`json\n${JSON.stringify(compilerDiagnostics, null, 2)}\n\`\`\`\n`, "evidence", assessmentId, p.sessionDir);
		} catch (error) { compilerEvidenceError = String(error); }
	}
	const readback = disposition.pending ? [] : readBackDeliverables(p.contract, { cwd, sessionDir: p.sessionDir },
		(index, bytes) => retainDeliverable(p.sessionDir, assessmentId, index, bytes));
	let protocolDiagnostic: ToolProtocolDiagnostic | null = null; let protocolEvidencePath: string | null = null;
	if (disposition.delivered && backendUsed === "native") {
		protocolDiagnostic = diagnoseToolProtocol({
			output: result.output,
			toolEvents: result.toolEvents ?? [],
			deliverables: readback,
			origin: { kind: "task", taskId: p.taskId, dispatchId: result.dispatchId ?? assessmentId },
			effectiveConfiguration: {
				backend: backendUsed,
				model: result.diagnostics?.modelUsed ?? state?.def.model ?? null,
				tools: result.diagnostics?.effectiveTools ?? String(state?.def.tools ?? "").split(",").map(tool => tool.trim()).filter(Boolean),
			},
			evidenceRefs: [returnPath ?? undefined, ...readback.map(item => item.retainedPath)].filter((value): value is string => !!value),
		});
		if (protocolDiagnostic) {
			protocolEvidencePath = d.artifacts.writeRunArtifact(`${key}-tool-protocol`, state?.runCount ?? 0,
				JSON.stringify(protocolDiagnostic, null, 2), "evidence", randomUUID(), p.sessionDir);
			protocolDiagnostic.evidenceRefs = [...new Set([...protocolDiagnostic.evidenceRefs, protocolEvidencePath])];
		}
	}
	const executionStatus: RuntimeResultInput["execution"]["status"] = disposition.pending ? "pending" : disposition.delivered ? "completed" : "failed";
	// A review's revision must still match after any awaited return extraction or compiler work.
	const repositoryAfterRevision = isSourceReview || p.revisionScopes.length ? revisionOf(cwd, p.revisionScopes) : compilerRan ? worktreeRevision(cwd, [], p.scopeGlobs) : compilerInspectedRevision;
 const afterRevision = p.privateConfig ? privateConfigRevision(cwd, repositoryAfterRevision, p.privateConfig) : repositoryAfterRevision;
	const changes = !tracking.writable || !observation
		? { status: "unknown" as const, paths: [] as string[], attribution: "not_observed" as const }
		: observation.skipped
			? { status: "unknown" as const, paths: [] as string[], attribution: "not_observed" as const }
			: { status: observation.paths.length ? "changed" as const : "unchanged" as const, paths: observation.paths, attribution: observation.concurrentWritableOverlap || observation.gaps?.length ? "uncertain" as const : "certain" as const };
	const checks: VerificationCheckInput[] = (compilerDiagnostics?.projects ?? []).map(project => ({
		producer: "runtime", kind: "compilation", taskId: p.taskId, command: [...(project.argv ?? [])], exitCode: project.exitCode,
		inspectedRevision: compilerInspectedRevision, evidenceRef: compilerEvidencePath ?? "",
		requirementIds: ["AF-MIN-CHANGE"],
	}));
	return { ...initial, parsedReturn, contractNotices, sameTask, isSourceReview, compilerDiagnostics, compilerEvidencePath, compilerEvidenceError, assessmentId, readback, protocolDiagnostic, protocolEvidencePath, executionStatus, afterRevision, changes, checks };
}

export type DispatchEvidence = ReturnType<typeof completeDispatchEvidence>;

export function collectDispatchReceipts(d: DispatchExecutorDeps, p: PreparedDispatch, result: DispatchResult, tracking: Tracking, evidence: DispatchEvidence, sameTaskNow: () => boolean, currentRequirements: () => AcceptanceRequirement[]) {
	const s = d.state;
	const { state, key, backendUsed, afterRevision, checks, isSourceReview } = evidence;
    const receiptCapture = tracking.receiptCapture;
    const receiptState = s.getProcessState?.().runtimeReceipts;
    // Stream integrity is independent of observations: an empty check list is not proof of a clean capture.
    // When native capture is expected, a missing integrity value fails closed; only an explicit "complete" is clean.
    const captureExpected = backendUsed === "native" && (tracking.writable || !!p.operatorCandidate || !!p.privateConfig);
    const captureIntegrity = result.lifecycle?.runtimeCaptureIntegrity;
    const captureClean = captureExpected ? captureIntegrity === "complete" : captureIntegrity !== "tainted";
    // Only declared evidence producers govern receipt exclusivity. Preparatory
    // bash inspections can overlap reads without overlapping any evidence run.
    // Source revision, stream integrity and concurrent-writer gates still apply.
    const evidenceCommands = new Set(p.requirements.flatMap(requirement =>
      [requirement.testCommand, requirement.compilerCommand].filter(Boolean)));
	const otherWriters = isSourceReview ? otherActiveWriters(d, p, tracking) : [];
	const reviewOverlapped = isSourceReview && (otherWriters.length > 0 || writerOverlappedReview(d, tracking));
	const exclusive = captureClean && !(result.runtimeTests ?? []).some(record => evidenceCommands.has(record.command) && record.exclusive === false) && !reviewOverlapped && !tracking.concurrentAtStart && s.getWritableOverlapCounter() === tracking.overlapBaseline && s.getActiveWritableDispatches() <= (tracking.writable ? 1 : 0);
    const captureCurrent = !!receiptCapture && !!receiptState && sameTaskNow() && receiptCapture.taskId === d.noProgress.taskId()
      && receiptState.pending.length === 1 && receiptState.pending[0] === receiptCapture.captureId
      && receiptCapture.sessionDir === s.getSessionDir() && receiptCapture.generation === receiptState.generation && receiptCapture.epoch === receiptState.epoch
      && receiptCapture.declarationHash === receiptDeclarationHash(p.privateConfig ? privateRequirements(s.getAssertions() as AcceptanceRequirement[]) : currentRequirements(), p.scopeGlobs, s.getAcceptedUserInput?.(), p.inputArtifacts);
    const observations = backendUsed === "native" && (tracking.writable || !!p.operatorCandidate || !!p.privateConfig) ? result.runtimeTests ?? [] : [];
    // A newer failure/unknown result for a command supersedes its success, even
    // when the unknown observer result could not construct a success receipt.
    const latest = new Map(observations.map(record => [record.command, record]));
    if (receiptCapture && receiptState) {
      const retained = !p.privateConfig && captureCurrent && exclusive && p.beforeRevision === afterRevision && backendUsed === "native" ? reusableRuntimeChecks(receiptState, receiptCapture, afterRevision) : [];
      checks.push(...retained.filter(check => !latest.has(check.command[0])));
    }
    const anchored: RuntimeReceipt[] = [];
    for (const record of latest.values()) for (const kind of ["test", "code-grep", "compilation"] as const) {
        const covered = p.requirements.filter(requirement => ["test", "code-grep"].includes(requirement.tag) && requirement.source && (kind === "compilation" ? requirement.compilerCommand === record.command : requirement.tag === kind && requirement.testCommand === record.command));
        if (!covered.length) continue;
        const coverage = covered.map(requirement => ({ id: requirement.id, source: requirement.source, text: requirement.text, reference: requirement.reference, criticalConditions: requirement.criticalConditions ?? [] }));
        const serialized = JSON.stringify({
            schema: "agent-fleet.runtime-test-evidence/v1", observation: record,
            declaration: { taskId: p.taskId, dispatchId: result.dispatchId, kind, coverage },
            ...(receiptCapture ? { capture: receiptCapture } : {}),
            evaluationSource: "agent-fleet.runtime-result/v1 verification.checks and verification.requirements",
        }, null, 2);
        const evidenceRef = d.artifacts.writeRunArtifact(`${key}-test-check`, state?.runCount ?? 0, serialized, "evidence", randomUUID(), p.sessionDir);
        // Fresh observations follow the same rule as the parser-owned exclusive flag: anything other than an explicit
        // "complete" capture stream (tainted, or a missing value) makes the record ineligible for acceptance.
        const check: VerificationCheckInput = { producer: "runtime", kind, command: [record.command], exitCode: record.exitCode,
            inspectedRevision: record.exclusive === false || captureIntegrity !== "complete" ? "unavailable" : record.beforeRevision === record.afterRevision ? record.afterRevision : "changed-during-check",
            evidenceRef, requirementIds: [...new Set(["AF-MIN-CHANGE", ...covered.map(requirement => requirement.id)])], taskId: p.taskId, coverage };
        checks.push(check);
        if (captureCurrent && exclusive && record.producer === "agent-fleet.runtime-test/v1" && record.exclusive !== false && result.dispatchId && record.exitCode === 0 && record.beforeRevision === afterRevision && record.afterRevision === afterRevision && /^[a-f0-9]{64}$/.test(afterRevision)) {
          try { anchored.push(anchorRuntimeReceipt(receiptCapture!, check, result.dispatchId, serialized)); } catch { /* No anchor => no continuation. */ }
        }
    }
    if (receiptCapture && receiptState && sameTaskNow()) {
      // Retention is not reuse: a clean unrelated inspection must not erase
      // anchors merely because its declaration/scope cannot borrow them. Reuse
      // still validates the exact contract, revision and evidence bytes above.
      // New observations (including failures/unknowns) supersede that command.
      const records = captureCurrent && exclusive && p.beforeRevision === afterRevision && backendUsed === "native"
        ? [...receiptState.records.filter(r => !latest.has(r.check.command[0])), ...anchored].slice(-64) : [];
      const next = { ...s.getProcessState!(), runtimeReceipts: { ...receiptState, pending: receiptState.pending.filter(id => id !== receiptCapture.captureId), records } };
      s.setProcessState?.(next);
      // The ordinary finish path below journals this state through processAuditRecord.
    }
	return { captureExpected, captureCurrent, exclusive, observations, anchored, otherWriters, reviewOverlapped };
}

export type DispatchReceipts = ReturnType<typeof collectDispatchReceipts>;

export function retainDispatchAssessment(d: DispatchExecutorDeps, p: PreparedDispatch, result: DispatchResult, evidence: DispatchEvidence, decision: DispatchDecision, outcome: DispatchOutcome): string | null {
	const { runtimeResult, checkDiagnostics, reviewEvidence } = decision;
	const { acceptanceStatus, accepted } = outcome;
	const { ids, parsedReturn, contractNotices, compilerEvidencePath, protocolDiagnostic, protocolEvidencePath,
		executionStatus, readback, disposition, key, state, assessmentId } = evidence;
	const assessment = { ...runtimeResult, verificationDiagnostics: checkDiagnostics, ...(reviewEvidence ? { reviewEvidence } : {}),
		executionStatus, acceptanceStatus, accepted, dispatchId: result.dispatchId ?? null, readback, scopeRoots: p.contract.scopeRoots,
		assertions: ids, structuredReturn: parsedReturn, contractNotices, compilerDiagnostics: evidence.compilerDiagnostics, compilerEvidencePath, protocolDiagnostic, protocolEvidencePath };
	return disposition.pending ? null : d.artifacts.writeRunArtifact(`${key}-acceptance`, state?.runCount ?? 0, JSON.stringify(assessment, null, 2), "evidence", assessmentId, p.sessionDir);
}
