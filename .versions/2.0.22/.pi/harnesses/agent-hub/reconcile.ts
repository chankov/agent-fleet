import type { RecoverState } from './recover-state.ts';
import type { DeliverableReadback } from './acceptance.ts';

/** Technical attribution is independent of parent T2/T11 acceptance. No model text is a check. */
export interface TechnicalEvidence {
 taskId: string; operationId: string; attemptId: string; currentRevision: string; observedRevision: string;
 originalExecutor: string; changedScope: string[]; readback: DeliverableReadback[];
 concurrentWriters: boolean; effectsRef?: string;
 reviewer?: { taskId: string; executor: string; revision: string; completed: boolean; blockingFindings: number; coveredScope: string[]; edited: boolean; evidenceRef: string };
 openRequirements: string[];
}
export function reconcileTechnical(state: RecoverState, input: TechnicalEvidence) {
 const op = state.inspect(input.operationId);
 const attempt = op?.attempts.find(a => a.attemptId === input.attemptId);
 const refuse = (reason: string) => ({ cleared: false as const, reason, acceptance: 'not_accepted' as const });
 if (!op || !attempt?.category || op.abandoned || op.taskId !== input.taskId || op.executor !== input.originalExecutor || op.attempts.at(-1) !== attempt) return refuse('stale_or_unknown_attempt');
 if (!input.currentRevision || input.observedRevision !== input.currentRevision || input.concurrentWriters) return refuse('stale_or_ambiguous_revision');
 if (attempt.category === 'tool_protocol_error' && !input.effectsRef) return refuse('trusted_T3_effects_required');
 const readback = input.readback.filter(file => file.status === 'read' && file.changed === true && !!file.retainedPath && input.changedScope.includes(file.path));
 if (!readback.length || !input.changedScope.length) return refuse('attributable_changed_readback_required');
 const review = input.reviewer;
 if (!review || !review.completed || review.taskId !== op.taskId || review.executor === op.executor || review.revision !== input.currentRevision || review.edited || review.blockingFindings !== 0 || !review.evidenceRef || input.changedScope.some(path => !review.coveredScope.includes(path))) return refuse('independent_current_revision_review_required');
 const evidence = JSON.stringify({ review: review.evidenceRef, readback: readback.map(file => file.retainedPath), effects: input.effectsRef ?? null });
 if (!state.assess(op.operationId, attempt.attemptId, input.currentRevision, 'cleared', evidence)) return refuse('technical_assessment_conflict');
 return { cleared: true as const, technical_block: 'cleared' as const, acceptance: 'not_accepted' as const, execution: 'failed' as const, provenScope: readback.map(file => file.path), openRequirements: [...input.openRequirements], evidence };
}
