import { randomUUID } from "node:crypto";
import { buildRuntimeResult, type AcceptanceRequirement } from "../acceptance.ts";
import { canonicalExecutor } from "../no-progress.ts";
import { operatorReviewState, operatorStateChecksDiagnostic, operatorStateNextStep, persistOperatorStateProof, type OperatorStateCandidate } from "../operator-current-state.ts";
import { reviewMayClose } from "../orchestration-activation.ts";
import { authorizePlanStatusUpdate } from "../orchestration-route.ts";
import { finishPrivateConfigReview, privateClassification, privateDeclarationHash, type PrivateProofUse } from "../private-config-review.ts";
import { evaluateProcessObligations, noteProcessStage, type ProcessVerdict } from "../process-obligations.ts";
import { retainReviewHistory } from "../review-continuity.ts";
import { countReviewFindings } from "../review-findings.js";
import { retainReview, reviewInput } from "../review-reuse.ts";
import { affirmativeReviewVerdict } from "../review-verdict.ts";
import { basePersonaName, isReviewPersona } from "../run-budget.js";
import { checkScope, reviewableChangedPaths, revisionOf } from "../scope-gate.js";
import { verificationDiagnostics } from "../verification-diagnostics.ts";
import type { DispatchEvidence, DispatchReceipts } from "./dispatch-evidence.ts";
import type { DispatchExecutorDeps, DispatchResult, PreparedDispatch, ReviewRunEvidence, Tracking } from "./dispatch-execution-types.ts";

type RuntimeResult = ReturnType<typeof buildRuntimeResult> & { process?: ProcessVerdict };

interface OperatorStateVerification {
	status: "unproven" | "accepted";
	origin: OperatorStateCandidate["origin"];
	historicalAttribution: OperatorStateCandidate["historicalAttribution"];
	scope: string[];
	revision: string;
	reason?: string;
	failedQualifiers?: string[];
	nextStep?: string;
	evidenceRef?: string;
}

export function decideDispatch(d: DispatchExecutorDeps, p: PreparedDispatch, result: DispatchResult, tracking: Tracking, evidence: DispatchEvidence, receipts: DispatchReceipts, cwd: string, sameTaskNow: () => boolean) {
	const s = d.state;
	const { disposition, observation, submission, parsedReturn, state, key, backendUsed, runPath, returnPath,
		failurePath, sameTask, compilerEvidencePath, readback, protocolDiagnostic, protocolEvidencePath, executionStatus,
		afterRevision, changes, checks } = evidence;
	const { captureExpected, captureCurrent, exclusive, observations, anchored, reviewOverlapped } = receipts;
	// Each recorded stage is checked over the basis it was recorded with.
	const stageRevision = (scopes: readonly string[]) => scopes.join("\n") === p.revisionScopes.join("\n") ? afterRevision : revisionOf(cwd, [...scopes]);

	const runtimeResult: RuntimeResult = buildRuntimeResult({
		task: { id: p.taskId, current: sameTask && p.taskId === d.noProgress.taskId(), beforeRevision: p.beforeRevision, afterRevision },
		execution: { status: executionStatus, exitCode: result.exitCode, dispatchId: result.dispatchId ?? null },
		changes, requirements: p.requirements, deliverables: readback, checks,
		evidenceRefs: [returnPath ?? undefined, failurePath ?? undefined, compilerEvidencePath ?? undefined, protocolEvidencePath ?? undefined].filter((value): value is string => !!value),
	});
 const diagnosticRevision = exclusive && sameTaskNow() && result.dispatchId && /^[a-f0-9]{64}$/.test(afterRevision) ? afterRevision : undefined;
 const checkDiagnostics = captureExpected && disposition.delivered ? verificationDiagnostics(p.requirements, observations, checks, diagnosticRevision) : null;
	if (submission && (submission.status !== "completed" || submission.requires_user_decision.some(question => question.trim().toLowerCase() !== "none"))) {
  runtimeResult.acceptance = { status: "not_accepted", accepted: false, reasons: [...runtimeResult.acceptance.reasons, "specialist_" + submission.status] };
  runtimeResult.compatibility = { hubAcceptanceStatus: "needs_verification", flowStatus: "rejected" };
 }
 const privateConfigVerification = p.privateConfig ? finishPrivateConfigReview({
  cwd, binding: p.privateConfig, beforeRevision: p.beforeRevision, revision: afterRevision, sameTask: sameTaskNow(), native: backendUsed === 'native',
  reviewerValid: ['code-reviewer','security-auditor'].includes(state?.def.name ?? '') && !String(state?.def.tools ?? '').split(',').some(t => ['edit','write'].includes(t.trim())),
  stillCurrent: () => sameTaskNow() && s.getActiveWritableDispatches() <= (tracking.writable ? 1 : 0) && s.getWritableOverlapCounter() === tracking.overlapBaseline
   && !s.getProcessState?.().changedFiles.length && !s.getProcessState?.().acceptance.evidenceRef && !s.getProcessState?.().review.evidenceRef
   && s.getProcessState?.().runtimeReceipts?.generation === p.privateConfig!.generation && s.getProcessState?.().runtimeReceipts?.epoch === p.privateConfig!.epoch
   && tracking.receiptCapture?.declarationHash === privateDeclarationHash(s.getAssertions() as AcceptanceRequirement[], s.getAcceptedUserInput?.()),
  exclusive, captureCurrent,
  delivered: disposition.delivered, exitCode: result.exitCode, dispatchId: result.dispatchId, submission, protocolDiagnostic, output: result.output, parsedReturn,
  questions: d.extractAskUserQuestions(result.output), research: d.extractNeedsResearch(result.output), verification: runtimeResult.verification, anchored,
  sourceDelta: !!observation?.skipped || !!observation?.paths.length || !!observation?.gaps?.length,
  sourceObligations: !!s.getProcessState?.().changedFiles.length || !!s.getProcessState?.().workOrigin || !!s.getProcessState?.().acceptance.evidenceRef || !!s.getProcessState?.().review.evidenceRef || !!s.getProcessState?.().additions?.some(a => a.status === 'active' && a.reason !== 'irreversible_execution'), returnPath: runPath, writer: d.artifacts.writeRunArtifact, runCount: state?.runCount ?? 0,
 }) : undefined;
 let processVerdict: ProcessVerdict | null = null;
 let reviewEvidence: ReviewRunEvidence | undefined;
 let operatorStateVerification: OperatorStateVerification | undefined = p.operatorCandidate ? {status:'unproven',origin:p.operatorCandidate.origin,historicalAttribution:'not_claimed',scope:p.operatorCandidate.paths,revision:afterRevision} : undefined;
	if (s.getProcessState) {
		let processState = s.getProcessState();
		// Keep earlier task changes in the final review scope, including observed edits from runs that failed verification.
		if (sameTask && tracking.writable && !p.privateConfig && !p.operatorCandidate && observation && !observation.skipped) {
			const paths = reviewableChangedPaths(observation.paths, cwd, p.sessionDir, p.scopeGlobs, p.contract.files.map(file => file.path));
			processState = { ...processState, changedFiles: [...new Set([...processState.changedFiles, ...paths])].sort() };
		}
		if (!p.privateConfig && !p.operatorCandidate && runtimeResult.acceptance.accepted && runtimeResult.verification.evidenceRefs[0]) {
			processState = noteProcessStage(processState, "acceptance", { evidenceRef: runtimeResult.verification.evidenceRefs[0], revision: afterRevision, revisionScopes: p.revisionScopes, changedFiles: processState.changedFiles });
		}
		const stage = p.privateConfig ? null : basePersonaName(p.agent) === "planner" ? "plan" : isReviewPersona(p.agent) ? "review" : null;
		const affirmativeReview = affirmativeReviewVerdict(result.output);
		// Candidate registration happens only after independent review and actual
        // same-revision runtime checks, never from reported past edits.
        const candidateReviewInput=stage==='review'?reviewInput(cwd,p.taskId,p.agent,p.scopeGlobs,operatorReviewState(processState,p.operatorCandidate),s.getAssertions(),p.inputArtifacts,s.getAcceptedUserInput?.()):null;
        // Named, ordered qualifiers: the same conjunction as before, so a refusal can
        // say which one failed. Diagnostics never relax or reorder a gate.
        const reviewQualifiers: Array<[string, boolean]> = [
            ["tool_protocol_error", !protocolDiagnostic],
            ["deliverable_failed", runtimeResult.compatibility.hubAcceptanceStatus !== "deliverable_failed"],
            ["submission_incomplete", !submission || submission.status === "completed"],
            ["blocking_findings", countReviewFindings(result.output).blocking === 0],
            ["assertions_failed", !(parsedReturn?.assertions_failed ?? []).length],
            ["unresolved_questions", !d.extractAskUserQuestions(result.output).length],
            ["needs_research", !d.extractNeedsResearch(result.output).length],
            ["requires_user_decision", !(parsedReturn?.requires_user_decision ?? []).some((entry:unknown)=>String(entry).trim().toLowerCase()!=="none")],
            ["review_input_changed", !p.reviewInput || JSON.stringify(p.reviewInput) === JSON.stringify(candidateReviewInput)],
        ];
        const checksRefusal = p.operatorCandidate ? operatorStateChecksDiagnostic({candidate:p.operatorCandidate,revision:afterRevision,sameTask:sameTaskNow(),native:backendUsed==='native',exclusive,verification:runtimeResult.verification}) : null;
        const candidateQualifiers: Array<[string, boolean]> = p.operatorCandidate ? [
            ...reviewQualifiers,
            ["not_review_stage", stage==='review'],
            ["not_same_task", sameTaskNow()],
            ["not_delivered", disposition.delivered&&result.exitCode===0],
            ["submission_incomplete", !result.specialistResultTool||submission?.status==='completed'],
            ["review_input_missing", !!p.reviewInput],
            ["verdict_not_affirmative", affirmativeReview],
            ["regression_not_closed", reviewMayClose({revision:afterRevision,scope:p.operatorCandidate.paths,output:result.output,evidenceRef:runPath??undefined,declared:!!parsedReturn,wide:processState.scope==='wide'||!!processState.additions?.some(item=>item.status==='active'&&item.reason==='wide_change')})],
            [checksRefusal ?? "runtime_checks", checksRefusal === null],
        ] : [];
        const failedQualifiers = [...new Set(candidateQualifiers.filter(([, ok]) => !ok).map(([code]) => code))];
        const candidateReady = !!p.operatorCandidate && failedQualifiers.length === 0;
        if (p.operatorCandidate && failedQualifiers.length) operatorStateVerification = { ...operatorStateVerification!, reason: failedQualifiers[0], failedQualifiers, nextStep: operatorStateNextStep(failedQualifiers[0]) };
        if(candidateReady&&p.operatorCandidate){
          try {
            const evidenceRef=persistOperatorStateProof({writer:d.artifacts.writeRunArtifact,sessionDir:p.sessionDir,runCount:state?.runCount??0,dispatchId:result.dispatchId||randomUUID(),record:{schema:'agent-fleet.operator-state-verification/v1',...p.operatorCandidate,taskId:p.taskId,checks:runtimeResult.verification.checks,manualAssertions:'not_automatically_proven'}});
            processState=noteProcessStage(processState,'acceptance',{evidenceRef,revision:afterRevision,revisionScopes:p.revisionScopes,changedFiles:p.operatorCandidate.paths,workOrigin:'operator-current-state'});
            operatorStateVerification={...operatorStateVerification!,status:'accepted',evidenceRef};
          } catch { operatorStateVerification={...operatorStateVerification!,reason:'evidence_readback_failed',failedQualifiers:['evidence_readback_failed'],nextStep:operatorStateNextStep('evidence_readback_failed')}; }
        }
		const revisionAvailable = [p.beforeRevision, afterRevision].every(revision => /^[a-f0-9]{64}$/.test(revision));
		const reviewRevisionStable = revisionAvailable && p.beforeRevision === afterRevision;
		if (stage === "review" && disposition.delivered && runPath) {
			const reviewScope = checkScope(processState.changedFiles, p.scopeGlobs);
			const qualifies: Array<[string, boolean]> = [
				["writer_overlap", !reviewOverlapped],
				["revision_unavailable", revisionAvailable],
				["revision_changed", !revisionAvailable || reviewRevisionStable],
				...reviewQualifiers,
				["review_input_missing", !!p.reviewInput],
				["not_same_task", sameTask],
				["operator_state_unproven", !p.operatorCandidate || operatorStateVerification?.status === "accepted"],
				["not_approved", affirmativeReview],
				["incomplete_scope", processState.changedFiles.length > 0 && reviewScope.outOfScope.length === 0],
			];
			const reasons = qualifies.filter(([, ok]) => !ok).map(([reason]) => reason);
			if (!reasons.length && !reviewMayClose({ revision: afterRevision, scope: processState.changedFiles, output: result.output, evidenceRef: runPath, declared: !!parsedReturn, wide: processState.scope === "wide" || !!processState.additions?.some(item => item.status === "active" && item.reason === "wide_change") })) reasons.push("regression_not_closed");
			reviewEvidence = { status: reasons.length ? "preliminary" : "final", scope: p.scopeGlobs, beforeRevision: p.beforeRevision, afterRevision, revisionScopes: p.revisionScopes, evidenceRef: runPath, reasons };
		}
		// A declared plan must read back successfully; a refusal or unresolved
		// decision is not plan evidence. No declaration still permits a retained
		// nonempty plan return. The Hub cannot judge its semantic adequacy.
		const planProduced = stage !== "plan" || ((!submission || submission.status === "completed") && result.output.trim().length > 0
			&& runtimeResult.compatibility.hubAcceptanceStatus !== "deliverable_failed"
			&& !(parsedReturn?.requires_user_decision ?? []).some((entry: unknown) => String(entry).trim().toLowerCase() !== "none")
			&& d.extractNeedsResearch(result.output).length === 0 && d.extractAskUserQuestions(result.output).length === 0);
		if (stage && planProduced && (stage !== "review" || reviewEvidence?.status === "final") && disposition.delivered && result.exitCode === 0 && sameTask && runPath) {
			processState = noteProcessStage(processState, stage, { evidenceRef: runPath, revision: afterRevision, revisionScopes: p.revisionScopes });
            if(stage === "review" && !tracking.writable) processState=retainReview(processState,candidateReviewInput,runPath,cwd);
		}
        if(stage === "review" && disposition.delivered && sameTask && runPath && p.reviewInput && p.reviewBaseline
            && !tracking.writable && !reviewOverlapped && reviewRevisionStable
            && JSON.stringify(p.reviewInput) === JSON.stringify(candidateReviewInput)){
            try {
             const baselineRef=d.artifacts.writeRunArtifact(key+"-review-baseline",state?.runCount??0,JSON.stringify(p.reviewBaseline),"returns",result.dispatchId,p.sessionDir);
             if(baselineRef)processState=retainReviewHistory(processState,p.reviewInput,runPath,baselineRef,cwd);
            } catch { /* Missing optional baseline forces a full review next time. */ }
        }
		const planDeliverable = p.contract.files.map(file => file.path).find(path => /plan/i.test(path));
		if (p.agent === "builder" && planDeliverable && runPath && authorizePlanStatusUpdate({ planPath: planDeliverable, allowedScope: p.scopeGlobs, evidenceRefs: [runPath] }).allowed && sameTask) {
			processState = noteProcessStage(processState, "plan", { evidenceRef: runPath, revision: afterRevision, revisionScopes: p.revisionScopes });
		}
        if (p.privateConfig && privateConfigVerification?.status === 'accepted' && 'evidenceRef' in privateConfigVerification && 'evidenceHash' in privateConfigVerification && 'reviewer' in privateConfigVerification) {
         processState.privateVerification = { origin: 'private-config-current-state', binding: structuredClone(p.privateConfig), revision: afterRevision,
          evidenceRef: privateConfigVerification.evidenceRef as string, evidenceHash: privateConfigVerification.evidenceHash as string, reviewer: privateConfigVerification.reviewer,
          overlap: tracking.overlapBaseline, classification: privateClassification(processState),
          receipts: anchored.map(r => ({ evidenceRef: r.check.evidenceRef, evidenceHash: r.evidenceHash })) };
        }
        const privateUse: PrivateProofUse = { cwd, taskId: d.noProgress.taskId(), sessionDir: s.getSessionDir(), declarationHash: privateDeclarationHash(s.getAssertions() as AcceptanceRequirement[], s.getAcceptedUserInput?.()), activeWriters: s.getActiveWritableDispatches() - (tracking.writable ? 1 : 0), overlap: s.getWritableOverlapCounter() };
		s.setProcessState?.(processState);
		processVerdict = evaluateProcessObligations(processState, { writable: tracking.writable || stage !== null, budgetTier: s.getTaskTier() ?? "small", t2Accepted: !p.privateConfig && !p.operatorCandidate && runtimeResult.acceptance.accepted, currentRevision: stageRevision, ...(p.privateConfig ? { privateUse } : {}) });
		runtimeResult.process = processVerdict;
		if (!processVerdict.accepted) {
			runtimeResult.acceptance = { status: "not_accepted", accepted: false, reasons: [...new Set([...runtimeResult.acceptance.reasons, ...Object.entries(processVerdict.obligations).filter(([, value]) => value.status === "open" || value.status === "unverified").map(([name]) => `process_${name}_open`)])] };
			if (runtimeResult.compatibility.hubAcceptanceStatus !== "deliverable_failed") runtimeResult.compatibility = { hubAcceptanceStatus: "needs_verification", flowStatus: "rejected" };
		}
		s.persistProcessVerdict?.(processState, processVerdict);
		if (s.processBlock?.()) {
			runtimeResult.acceptance = { status: "not_accepted", accepted: false, reasons: [...new Set([...runtimeResult.acceptance.reasons, s.processBlock()!.reason])] };
			runtimeResult.compatibility = { hubAcceptanceStatus: "needs_verification", flowStatus: "rejected" };
		}
	}
	return { runtimeResult, checkDiagnostics, privateConfigVerification, processVerdict, reviewEvidence, operatorStateVerification };
}

export type DispatchDecision = ReturnType<typeof decideDispatch>;

export function recordDispatchRecoveryEvidence(d: DispatchExecutorDeps, p: PreparedDispatch, result: DispatchResult, evidence: DispatchEvidence, receipts: DispatchReceipts, decision: DispatchDecision, cwd: string): void {
	const { sameTask, disposition, afterRevision, changes, readback, isSourceReview, observation, protocolEvidencePath, runPath } = evidence;
	const { reviewOverlapped } = receipts;
	const { reviewEvidence, runtimeResult } = decision;
    if (sameTask && result.dispatchId && !disposition.pending) {
        // T2/F3: use the canonical wrapper identity so production reconcile can match.
        // Previously this wrote raw p.agent while the wrapper used canonical([cwd, actor]).
        d.noProgress.recordDispatchEvidence({
            dispatchId: result.dispatchId, taskId: p.taskId, executor: canonicalExecutor(cwd, p.agent), revision: afterRevision, revisionScopes: p.revisionScopes,
            changedScope: changes.attribution === 'certain' ? changes.paths : [], readback,
            concurrentWriters: isSourceReview ? reviewOverlapped : observation?.concurrentWritableOverlap ?? true,
            effectsRef: protocolEvidencePath ?? undefined,
            completed: disposition.delivered && result.exitCode === 0,
            // A nonblocking review (the reconcile contract) approves with zero blocking findings;
            // whether it also lists suggestions is irrelevant.
            blockingFindings: isSourceReview && reviewEvidence?.reasons.every(reason => reason === "regression_not_closed" || reason === "incomplete_scope") ? 0 : -1,
            coveredScope: isReviewPersona(p.agent) && result.exitCode === 0 ? d.noProgress.reviewCoverage(p.taskId).filter(path => checkScope([path], p.scopeGlobs).outOfScope.length === 0) : [],
            edited: p.beforeRevision !== afterRevision || !!observation && (observation.skipped || observation.paths.length > 0),
            evidenceRef: runPath ?? '', openRequirements: runtimeResult.verification.requirements.filter(r => r.status !== 'passed').map(r => r.id),
        });
    }
}

export function summarizeDispatchOutcome(d: DispatchExecutorDeps, p: PreparedDispatch, result: DispatchResult, evidence: DispatchEvidence, decision: DispatchDecision) {
	const { runtimeResult } = decision;
	const { submission, parsedReturn, protocolDiagnostic, executionStatus, disposition } = evidence;
	const accepted = !p.operatorCandidate && runtimeResult.acceptance.accepted;
	const acceptanceStatus = runtimeResult.compatibility.hubAcceptanceStatus;
	const questions = [...new Set([...d.extractAskUserQuestions(result.output), ...(submission?.requires_user_decision ?? []).filter(question => question.trim().toLowerCase() !== "none")])];
	const contractGap = acceptanceStatus === "deliverable_failed" ? "missing_deliverable" : !parsedReturn && questions.length ? "missing_structured_return" : null;
	const blockedOnUser = questions.length > 0 && !protocolDiagnostic && executionStatus === "completed";
	const status = protocolDiagnostic ? "tool_protocol_error" : blockedOnUser ? "blocked_on_user" : accepted ? "accepted" : executionStatus === "completed" && (runtimeResult.verification.status === "failed" || acceptanceStatus === "deliverable_failed") ? "verification_failed" : executionStatus === "completed" ? "completed_unverified" : disposition.status;
	return { accepted, acceptanceStatus, questions, contractGap, blockedOnUser, status };
}

export type DispatchOutcome = ReturnType<typeof summarizeDispatchOutcome>;
