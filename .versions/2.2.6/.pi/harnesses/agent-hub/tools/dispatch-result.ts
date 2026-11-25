import type { DispatchDecision, DispatchOutcome } from "./dispatch-decisions.ts";
import type { DispatchEvidence, DispatchReceipts } from "./dispatch-evidence.ts";
import { formatAdvisory } from "../../lib/changed-file-diagnostics.ts";
import { ORCHESTRATOR_CLARIFICATION } from "../../lib/clarification-policy.ts";
import { docsLaneNotice } from "../docs-lane.js";
import { safePathWithin } from "../helpers.ts";
import { activeOrchestrationHandoff } from "../orchestration-activation.ts";
import { MAX_AUTO_RESEARCH_ROUNDS } from "../research/runtime.ts";
import { countReviewFindings, findingBudgetNotice } from "../review-findings.js";
import { blockingFindingCap, isReviewPersona } from "../run-budget.js";
import { formatScopeDiagnostic } from "../scope-diagnostic.ts";
import { checkScope } from "../scope-gate.js";
import { verificationDiagnosticNotice } from "../verification-diagnostics.ts";
import type { DispatchAgentParams, ToolExecutionResult } from "./context.ts";
import type { DispatchExecutionState, DispatchExecutorDeps, PreparedDispatch, RunData, Tracking, WorktreeObservation } from "./dispatch-execution-types.ts";

interface DispatchPresentation {
	evidence: DispatchEvidence;
	receipts: DispatchReceipts;
	decision: DispatchDecision;
	outcome: DispatchOutcome;
	assessmentPath: string | null;
	unresolved: string[];
	blockers: string[];
}

type PresentationPorts = Pick<DispatchExecutorDeps, "contextPressure" | "displayName"> & {
	state: Pick<DispatchExecutionState, "getUserLanguage" | "getSessionDir" | "getTaskTier" | "getProcessState">;
};

export function renderDispatchResult(d: PresentationPorts, p: PreparedDispatch, params: DispatchAgentParams, run: RunData, tracking: Tracking, presentation: DispatchPresentation): ToolExecutionResult {
	const { result, researchRounds } = run;
	const s = d.state;
	const { evidence, receipts, decision, outcome, assessmentPath, unresolved, blockers } = presentation;
	const {
		disposition, submission, state, backendUsed, sameTask, isSourceReview, observation,
		parsedReturn, contractNotices, shouldUseDigest, returnExtracted, returnPath, failurePath,
		compilerDiagnostics, compilerEvidencePath, compilerEvidenceError, protocolDiagnostic, protocolEvidencePath,
		afterRevision, changes, readback, executionStatus,
	} = evidence;
	const { otherWriters, reviewOverlapped } = receipts;
	const { reviewEvidence, operatorStateVerification, privateConfigVerification, processVerdict, runtimeResult, checkDiagnostics } = decision;
	const { acceptanceStatus, accepted, questions, contractGap, blockedOnUser, status } = outcome;
	const answered = researchRounds.reduce((n, r) => n + r.questions.length, 0);
	const notices: string[] = [];
 const checkNotice = checkDiagnostics && verificationDiagnosticNotice(checkDiagnostics);
 if (checkNotice) notices.push(checkNotice);
 for (const requirement of runtimeResult.verification.requirements) {
  for (const stale of requirement.staleChecks ?? []) {
   notices.push(`Stale verification for ${requirement.id}: inspected revision ${stale.inspectedRevision}; final revision ${stale.finalRevision}. Paths changed since check: ${stale.changedPathCount ?? "unknown"}. Finish all edits first, then in a separately authorized attempt rerun this exact command unchanged: ${JSON.stringify(stale.command)}. No retry was started.`);
  }
 }
	if (operatorStateVerification && operatorStateVerification.status !== "accepted" && operatorStateVerification.reason) notices.push(`Current-state review did not register the candidate: ${operatorStateVerification.reason}${(operatorStateVerification.failedQualifiers?.length ?? 0) > 1 ? ` (also: ${operatorStateVerification.failedQualifiers!.slice(1).join(", ")})` : ""}. ${operatorStateVerification.nextStep} Manual assertions stay open; nothing was marked proven.`);
	if (!sameTask) notices.push("Late result from a prior task/session: evidence retained in its original namespace; current-task counters and blockers were not changed.");
	if (disposition.delivered) notices.push(accepted
		? `Execution and current-state verification accepted by the runtime contract. Acceptance check: ${assessmentPath}`
		: protocolDiagnostic
			? `Tool protocol error: ${protocolDiagnostic.message} Evidence: ${protocolEvidencePath}. No text was executed and no retry was started.`
			: `Execution completed, NOT accepted. ${acceptanceStatus === "deliverable_failed" ? "Expected deliverable readback failed." : "Verification is missing, failed, stale, unsupported, or attribution-uncertain; file presence, exit 0, and claims are not proof."} Acceptance check: ${assessmentPath}`);
	if (readback.some(file => file.changed === false)) notices.push("Some deliverables already existed unchanged. Do not attribute their creation to this execution.");
	if (sameTask && blockers.length) notices.push(`⛔ ${p.agent} reported an EXTERNAL BLOCKER — something outside the fleet's reach is missing:\n${blockers.map((w, i) => `  ${i + 1}. ${w}`).join("\n")}\nThe next dispatch/research call is refused until you escalate this to the human. Do not build a substitute for the missing fact.`);
	if (questions.length) notices.push(`⚠ ${questions.length} ASK_USER question(s) raised by ${p.agent}. Orchestrator triage required. ${ORCHESTRATOR_CLARIFICATION} Dispatch ID: ${result.dispatchId ?? "<dispatchId>"}. Human escalation language: ${s.getUserLanguage()}. Questions:\n${questions.map((q, i) => `  ${i + 1}. ${q}`).join("\n")}`);
	notices.push("Orchestration handoff is in details.orchestration. Start from its manifest; reread a file only when it is missing, stale, or conflicting. A wide review closes only with a full regression marker. Model routing was not changed.");
	if (researchRounds.length) notices.push(`ℹ ${p.agent} auto-paused for research ${researchRounds.length} round(s); ${answered} question(s) answered by read-only helpers. Findings were saved under ${safePathWithin(s.getSessionDir(), "findings")} and read by the agent directly — they are NOT inlined here.`);
	if (unresolved.length && researchRounds.length >= MAX_AUTO_RESEARCH_ROUNDS) notices.push(`⚠ ${p.agent} still requests research (${unresolved.length} question(s)) but the auto-research budget is exhausted. Run spawn_research yourself and re-dispatch with the findings, or simplify the task.`);
	if (returnPath) notices.push(`Full specialist output: ${returnPath}`);
	if (reviewEvidence?.status === "preliminary") {
		if (otherWriters.length) notices.push(`Area review: ${otherWriters.map(writer => writer.agent).join(", ")} was still writing. Run a final review of the whole change after writes finish.`);
		else if (reviewOverlapped) notices.push("Area review: a writer overlapped this inspection. Run a final review of the whole change after writes finish.");
		notices.push(`Preliminary review (${reviewEvidence.reasons.join(", ")}). Report and revision evidence: ${assessmentPath}`);
		if (reviewEvidence.scopeDiagnostic) notices.push(formatScopeDiagnostic(reviewEvidence.scopeDiagnostic));
	}
	if (tracking.isolatedScope) notices.push(`Parallel writer: OS-sandboxed to ${tracking.isolatedScope.join(", ") || "no repository paths"}; only changes inside that scope are attributed to ${p.agent}.${observation?.foreignPaths?.length ? ` Changes outside it during the run (not attributed): ${observation.foreignPaths.slice(0, 12).join(", ")}${observation.foreignPaths.length > 12 ? " …" : ""}.` : ""} Run the full checks once no writer is active.`);
	if (disposition.pending) notices.push("⏳ DELIVERY PENDING — no result or assertion evidence is available yet, and no return/failure artifact was written. Use the msg_id above with coms_get/coms_await; do not re-dispatch.");
	if (failurePath) notices.push(`⚠ DELIVERY FAILURE (exit ${result.exitCode}) — no specialist result was returned. The error output is at ${failurePath}; it is NOT a return and carries no assertion evidence. The work may or may not have happened — check the artifacts the task was supposed to produce before re-dispatching.`);
	if (compilerDiagnostics && compilerDiagnostics.status !== "skipped") {
		const advisory = formatAdvisory(compilerDiagnostics);
		const evidence = compilerEvidencePath ? `Full compiler evidence: ${compilerEvidencePath}` : `Compiler evidence artifact unavailable: ${compilerEvidenceError ?? "unknown error"}`;
		if (advisory) notices.push(`${advisory}\n${evidence}`);
		else if (compilerDiagnostics.projects.length) notices.push(`Compiler diagnostics completed with no errors. ${evidence}`);
	}
	const corrected = p.inputArtifacts.filter(a => a.resolvedFromKind); if (corrected.length) notices.push(`ℹ Artifact path corrected: ${corrected.map(a => `"${a.input}" → ${a.displayPath}`).join("; ")}. Use the corrected path from now on.`);
	if (state && d.contextPressure(state.contextPct)) notices.push(`⚠ ${d.displayName(state.def.name)} context at ${Math.ceil(state.contextPct)}% — consider /af-agents-restart ${state.def.name} (state lives in the artifacts/ledger, a restart is cheap).`);
	const scopeViolations = scopeResult(p, observation); const scopeNotice = scopeNoticeText(scopeViolations); if (scopeNotice) notices.push(scopeNotice.trim());
	const reviewForHandoff = isSourceReview ? reviewEvidence ?? { status: "preliminary" as const, beforeRevision: p.beforeRevision } : undefined;
	const finding = isReviewPersona(p.agent) ? findingBudgetNotice(p.agent, blockingFindingCap(s.getTaskTier()), countReviewFindings(result.output)) || "" : ""; if (finding) notices.push(finding.trim());
	const docs = docsLaneNotice(p.agent, p.scopeGlobs, processVerdict?.obligations?.review?.status === "open"); if (docs) notices.push(docs);
	const contract = contractNoticeText(contractNotices); const extraction = returnExtracted ? "ℹ The specialist declared no structured return. The block below was EXTRACTED from its report by a cheap read-only pass — weaker than a declared return. Verify the named evidence before you gate on it." : "";
	const digest = shouldUseDigest ? [extraction, structuredReturnDigest(parsedReturn) || "Structured return: (none parsed)", contract].filter(Boolean).join("\n\n") : (result.output.length > 8000 ? `${result.output.slice(0, 8000)}\n\n... [truncated]` : result.output);
	return {
		content: [{ type: "text", text: `[${p.agent}] Specialist: ${submission?.status ?? executionStatus}; task accepted: ${accepted ? "yes" : "no"}. ${status} in ${Math.round(result.elapsed / 1000)}s${notices.length ? `\n\n${notices.join("\n\n")}` : ""}${processVerdict ? `\n\nProcess: ${processVerdict.explanation}` : ""}\n\n${digest}` }],
		details: {
			agent: p.agent,
			task: p.task,
			status,
			specialistCompletion: submission?.status ?? (executionStatus === "completed" ? "reported_unstructured" : executionStatus),
			resultProtocol: submission ? "submit_result" : result.specialistResultTool ? "submission_missing" : "legacy",
			taskAccepted: accepted,
			...(protocolDiagnostic
				? {
					recoveryCategory: "tool_protocol_error",
					reason: protocolDiagnostic.message,
					protocolDiagnostic,
					protocolEvidencePath,
					protocolEffectsEvidenceRef: protocolEvidencePath,
				}
				: blockedOnUser
					? {
						recoveryCategory: "blocked_on_user",
						reason: "waiting for a sourced clarification answer",
						protocolDiagnostic: null,
						protocolEvidencePath: null,
					}
					: { protocolDiagnostic: null, protocolEvidencePath: null }),
			contractGap,
			executionStatus,
			acceptanceStatus,
			accepted,
			runtimeResult,
			processVerdict,
			...(reviewEvidence ? { reviewEvidence } : {}),
			...(operatorStateVerification?{operatorStateVerification}:{}),
			...(privateConfigVerification?{privateConfigVerification}:{}),
			taskIdentity: runtimeResult.task,
			changeResult: runtimeResult.changes,
			verificationResult: runtimeResult.verification,
			verificationDiagnostics: checkDiagnostics,
			staleTask: !sameTask,
			deliverableReadback: readback,
			scopeRoots: p.contract.scopeRoots,
			assessmentPath,
			backendRequested: params.backend ?? "auto",
			backendUsed,
			elapsed: result.elapsed,
			exitCode: result.exitCode,
			fullOutput: result.output,
			dispatchId: result.dispatchId ?? null,
			transcriptPath: result.transcriptPath ?? null,
			diagnostics: result.diagnostics ?? null,
			evidencePath: result.evidencePath ?? null,
			lifecycle: (result as any).lifecycle ?? null,
			termination: (result as any).termination ?? (result.diagnostics as any)?.termination ?? null,
			spawnError: (result.diagnostics as any)?.spawnError ?? null,
			compilerDiagnostics,
			compilerEvidencePath,
			structuredReturn: parsedReturn,
			returnExtracted,
			pending: disposition.pending,
			returnPath,
			failurePath,
			contractNotices,
			questions,
			orchestration: activeOrchestrationHandoff({
				agent: p.agent,
				task: p.task,
				scope: p.scopeGlobs,
				revision: afterRevision,
				changes: changes.attribution === "certain" ? changes.paths : [],
				exitCode: result.exitCode,
				questions,
				evidenceRefs: runtimeResult.verification.evidenceRefs,
				review: reviewForHandoff,
				approvedPlan: !!s.getProcessState?.().plan?.evidenceRef,
				risk: s.getProcessState?.().risk === "high" ? "high" : "low",
				scopeBreadth: s.getProcessState?.().scope === "wide" ? "wide" : "narrow",
				sharedCode: false,
				model: backendUsed ?? undefined,
				elapsedMs: result.elapsed,
			}),
			researchRounds,
			scopeViolations,
			sessionReset: result.sessionReset ?? null,
			artifacts: p.inputArtifacts.map(a => ({ path: a.path, displayPath: a.displayPath, preview: a.preview, resolvedFromKind: a.resolvedFromKind ?? null })),
		},
	};
}

function scopeResult(p: PreparedDispatch, observation: WorktreeObservation | null): any {
	if (!observation || p.scopeGlobs.length === 0) return null;
	if (observation.skipped) return { skipped: true, reason: observation.reason, gaps: observation.gaps, declaredScope: p.scopeGlobs, concurrentWritableOverlap: observation.concurrentWritableOverlap };
	return { ...checkScope(observation.paths, p.scopeGlobs), changedPaths: observation.paths, declaredScope: p.scopeGlobs, concurrentWritableOverlap: observation.concurrentWritableOverlap, gaps: observation.gaps, repositories: observation.repositories };
}

function scopeNoticeText(v: any): string {
 if (!v) return "";
 const gaps = v.gaps?.length ? `\n\n⚠ Git observation gaps: ${v.gaps.map((gap: { scope: string; reason: string }) => `${gap.scope}: ${gap.reason}`).join("; ")}. Other observed scopes remain available; coverage is incomplete.` : "";
 if (v.skipped) return `\n\n⚠ Scope gate skipped: ${v.reason || "not a git worktree"}.${gaps}`;
 if (!v.outOfScope?.length) return gaps;
 const overlap = v.concurrentWritableOverlap ? " Concurrent writable dispatches overlapped this run, so attribution is approximate." : "";
 return `${gaps}\n\n⚠ Scope advisory: changed outside declared scope: ${v.outOfScope.join(", ")}. Review these paths and decide whether to accept them or explicitly order cleanup; the hub did not revert anything.${overlap}`;
}
function structuredReturnDigest(parsed: any): string { if (!parsed)
    return ""; const lines = ["Structured return (parsed):"]; if (parsed.summary)
    lines.push(parsed.summary); if (parsed.evidence?.length)
    lines.push("Evidence references: " + parsed.evidence.map((ref: any) => ref.path).join(", ")); for (const key of ["assertions_proven", "assertions_unproven", "assertions_failed"]) {
    const entries = parsed[key] || [];
    if (!entries.length)
        continue;
    lines.push(`${key}:`);
    for (const entry of entries) {
        const evidence = entry.evidence ? ` — evidence: ${entry.evidence}` : "";
        const reason = entry.reason ? ` — reason: ${entry.reason}` : "";
        const note = entry.note || (entry.evidence ? "" : "(no note)");
        lines.push(`- ${entry.id}${note ? `: ${note}` : ""}${evidence}${reason}`);
    }
} for (const key of ["changed_files", "tests_run", "open_risks", "requires_user_decision"]) {
    const entries = parsed[key] || [];
    if (entries.length)
        lines.push(`${key}: ${entries.slice(0, 5).join("; ")}${entries.length > 5 ? " …" : ""}`);
} return lines.join("\n"); }
function contractNoticeText(notices: any[]): string { if (!notices?.length)
    return ""; const lines = ["⚠ Structured return contract notices:"]; const missing = notices.filter(n => n.type === "missing").map(n => n.id); const noStructured = notices.find(n => n.type === "no_structured_return"); if (noStructured)
    lines.push(`- no_structured_return: no parseable structured return for dispatched assertions ${(noStructured.ids || []).join(", ")} — treat all as unproven; full output is on disk.`); if (missing.length)
    lines.push(`- missing: return does not cover ${missing.join(", ")} — treat as unproven.`); for (const n of notices.filter(n => n.type === "proven_without_evidence"))
    lines.push(`- proven_without_evidence: ${n.id} claimed proven without named evidence — demoted to unproven.`); for (const n of notices.filter(n => n.type === "compiler_diagnostics"))
    lines.push(`- compiler_diagnostics: ${n.id} was claimed proven but a completed compiler check found an error in an observed changed file — demoted to unproven with original evidence retained.`); return lines.join("\n"); }
