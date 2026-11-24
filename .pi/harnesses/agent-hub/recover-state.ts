import { randomUUID } from 'node:crypto';
import type { RecoveryCategory } from './recovery-contract.ts';

export interface ContinuationRecord { nonce: string; revision: string; reportRef: string; reportHash: string; settlement: 'runtime' | 'operator_attested'; uncertaintyAttemptId?: string }
export type RecoverEvent =
 | { type: 'start'; operationId: string; attemptId: string; taskId: string; contract: string; executor: string; dispatchId: string }
 | { type: 'complete'; operationId: string; attemptId: string }
 | { type: 'failure'; operationId: string; attemptId: string; category: RecoveryCategory; /** Written by a restoring process for another owner's unfinished attempt. */ interrupted?: true }
 | { type: 'settled'; operationId: string; attemptId: string; evidence: string }
 | { type: 'dispatch'; operationId: string; attemptId: string; dispatchId: string }
 | { type: 'abandon'; operationId: string; attemptId: string; nonce: string }
 | { type: 'grant'; operationId: string; attemptId: string; nonce: string }
 | { type: 'continuation'; operationId: string; attemptId: string; record: ContinuationRecord }
 | { type: 'technical'; operationId: string; attemptId: string; revision: string; status: 'open' | 'cleared'; evidence: string };
/** `interrupted` marks restore-time uncertainty; the original owner may still append its own
 * outcome later (sessions are not locked). That late outcome is retained for inspection only
 * and never turns the uncertainty into settlement or completion. */
type Attempt = { attemptId: string; dispatchId: string; category?: RecoveryCategory; completed?: boolean; settled?: string; continuations?: ContinuationRecord[]; interrupted?: boolean; lateDispatchId?: string; lateOutcome?: RecoveryCategory | 'completed' };
type Operation = { operationId: string; taskId: string; contract: string; executor: string; attempts: Attempt[]; indeterminateGrantUsed: boolean; grantedAttemptId?: string; abandoned?: boolean; technical?: { attemptId: string; status: 'open' | 'cleared'; revision: string; evidence: string } };

/** No-launch successors retain the earlier uncertainty; other outcomes keep their own recovery policy. */
function continuationBasis(op: Operation | undefined, attemptId: string): Attempt | null {
 if (!op || op.attempts.at(-1)?.attemptId !== attemptId) return null;
 for (let index = op.attempts.length - 1; index >= 0; index--) {
  const attempt = op.attempts[index];
  if (attempt.category === 'not_started' || attempt.category === 'invalid_input') continue;
  return attempt.category === 'indeterminate' ? attempt : null;
 }
 return null;
}

/** Pure replay plus a validated append seam. The caller owns durable session-entry storage. */
export function createRecoverState(history: readonly RecoverEvent[] = [], append?: (event: RecoverEvent) => void) {
 const operations = new Map<string, Operation>();
 const byContract = new Map<string, string>();
 const active = new Map<string, string>();
 const usedIds = new Set<string>();
 const usedNonces = new Set<string>();
 const key = (taskId: string, contract: string) => JSON.stringify([taskId, contract]);
 const nonempty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
 function apply(event: RecoverEvent) {
  if (!event || !nonempty(event.operationId) || !nonempty(event.attemptId)) throw new Error('Invalid recovery history');
  if (event.type === 'start') {
   if (![event.taskId, event.contract, event.executor, event.dispatchId].every(nonempty) || usedIds.has(event.attemptId) || usedIds.has(event.dispatchId)) throw new Error('Invalid recovery history');
   const k = key(event.taskId, event.contract), existing = byContract.get(k);
   if (existing && existing !== event.operationId || active.has(event.executor) || (operations.has(event.operationId) && existing !== event.operationId)) throw new Error('Invalid recovery history');
   if (!existing) {
    if (usedIds.has(event.operationId)) throw new Error('Invalid recovery history');
    operations.set(event.operationId, { operationId: event.operationId, taskId: event.taskId, contract: event.contract, executor: event.executor, attempts: [], indeterminateGrantUsed: false });
    byContract.set(k, event.operationId); usedIds.add(event.operationId);
   }
   const op = operations.get(event.operationId)!;
   if (op.executor !== event.executor || op.abandoned || (op.attempts.length && !op.attempts.at(-1)?.category && !op.attempts.at(-1)?.completed)) throw new Error('Invalid recovery history');
   op.attempts.push({ attemptId: event.attemptId, dispatchId: event.dispatchId });
   usedIds.add(event.attemptId); usedIds.add(event.dispatchId); active.set(event.executor, event.attemptId);
   return;
  }
  const op = operations.get(event.operationId), attempt = op?.attempts.find(a => a.attemptId === event.attemptId);
  if (!op || !attempt) throw new Error('Invalid recovery history');
  switch (event.type) {
   case 'dispatch':
    if (attempt.interrupted && !attempt.lateDispatchId && !attempt.lateOutcome && nonempty(event.dispatchId) && !usedIds.has(event.dispatchId)) { attempt.lateDispatchId = event.dispatchId; usedIds.add(event.dispatchId); return; }
    if (!nonempty(event.dispatchId) || usedIds.has(event.dispatchId) || attempt.category || attempt.completed || active.get(op.executor) !== attempt.attemptId) throw new Error('Invalid recovery history');
    attempt.dispatchId = event.dispatchId; usedIds.add(event.dispatchId); return;
   case 'abandon':
    if (!attempt.category || op.abandoned || op.attempts.at(-1) !== attempt || !nonempty(event.nonce) || usedNonces.has(event.nonce)) throw new Error('Invalid recovery history');
    usedNonces.add(event.nonce); op.abandoned = true; return;
   case 'complete':
    if (attempt.interrupted && !attempt.lateOutcome) { attempt.lateOutcome = 'completed'; return; }
    if (attempt.category || attempt.completed || active.get(op.executor) !== attempt.attemptId) throw new Error('Invalid recovery history');
    attempt.completed = true; active.delete(op.executor); return;
   case 'failure': {
    const known = ['not_started','invalid_input','resource_exhausted','operator_cancelled','verification_failed','blocked_on_user','tool_protocol_error','unknown_tool','indeterminate'].includes(event.category);
    if (attempt.interrupted && !attempt.lateOutcome && known && !event.interrupted) { attempt.lateOutcome = event.category; return; }
    if (attempt.category || active.get(op.executor) !== attempt.attemptId || !known || (event.interrupted !== undefined && (event.interrupted !== true || event.category !== 'indeterminate'))) throw new Error('Invalid recovery history');
    attempt.category = event.category; if (event.interrupted) attempt.interrupted = true; active.delete(op.executor); return;
   }
   case 'settled':
    if (!attempt.category || attempt.settled || !nonempty(event.evidence)) throw new Error('Invalid recovery history');
    attempt.settled = event.evidence; return;
   case 'grant':
    if (attempt.category !== 'indeterminate' || !attempt.settled || active.has(op.executor) || op.indeterminateGrantUsed || op.attempts.at(-1) !== attempt || !nonempty(event.nonce) || usedNonces.has(event.nonce)) throw new Error('Invalid recovery history');
    usedNonces.add(event.nonce); op.indeterminateGrantUsed = true; op.grantedAttemptId = attempt.attemptId; return;
   case 'continuation': {
    const record = event.record, basis = continuationBasis(op, attempt.attemptId);
    if (!basis || op.abandoned || active.has(op.executor) || !record || ![record.nonce, record.revision, record.reportRef].every(nonempty) || !/^[a-f0-9]{64}$/.test(record.reportHash) || !['runtime', 'operator_attested'].includes(record.settlement) || (record.settlement === 'runtime' && !basis.settled) || (record.uncertaintyAttemptId !== undefined && record.uncertaintyAttemptId !== basis.attemptId) || usedNonces.has(record.nonce)) throw new Error('Invalid recovery history');
    usedNonces.add(record.nonce);
    (attempt.continuations ??= []).push(structuredClone(record)); return;
   }
   case 'technical':
    if (!attempt.category || !nonempty(event.revision) || !nonempty(event.evidence) || !['open','cleared'].includes(event.status) || (op.technical?.attemptId === attempt.attemptId && op.technical.status === 'cleared' && event.status === 'cleared' && op.technical.revision === event.revision)) throw new Error('Invalid recovery history');
    op.technical = { attemptId: attempt.attemptId, status: event.status, revision: event.revision, evidence: event.evidence }; return;
   default: throw new Error('Invalid recovery history');
  }
 }
 for (const event of history) apply(event);
 let uncertainAppend = false;
 function record(event: RecoverEvent): boolean {
  // An append that throws may already have committed. Refuse every further mutation
  // until the owner reloads durable history into a replacement state.
  if (uncertainAppend) return false;
  try { createRecoverState([...historySnapshot(), event]); } catch { return false; }
  try { append?.(event); } catch { uncertainAppend = true; return false; }
  apply(event); journal.push(event); return true;
 }
 const journal: RecoverEvent[] = [...history];
 const historySnapshot = () => journal;
 return {
  start(taskId: string, contract: string, executor: string, dispatchId: string) {
   if (![taskId, contract, executor, dispatchId].every(nonempty) || active.has(executor)) return null;
   const operationId = byContract.get(key(taskId, contract)) ?? randomUUID(), attemptId = randomUUID();
   return record({ type: 'start', taskId, contract, executor, dispatchId, operationId, attemptId }) ? { operationId, attemptId } : null;
  },
  bindDispatch(operationId: string, attemptId: string, dispatchId: string) { return record({ type: 'dispatch', operationId, attemptId, dispatchId }); },
  abandon(operationId: string, attemptId: string, nonce: string) { return record({ type: 'abandon', operationId, attemptId, nonce }); },
  byDispatch(dispatchId: string) { for (const op of operations.values()) if (op.attempts.some(a => a.dispatchId === dispatchId || a.lateDispatchId === dispatchId)) return this.inspect(op.operationId); return null; },
  complete(operationId: string, attemptId: string) { return record({ type: 'complete', operationId, attemptId }); },
  fail(operationId: string, attemptId: string, category: RecoveryCategory) { return record({ type: 'failure', operationId, attemptId, category }); },
  /** Restore-only: another owner's unfinished attempt becomes uncertainty without settlement. */
  interrupt(operationId: string, attemptId: string) { return record({ type: 'failure', operationId, attemptId, category: 'indeterminate', interrupted: true }); },
  settle(operationId: string, attemptId: string, evidence: string) { return record({ type: 'settled', operationId, attemptId, evidence }); },
  grant(operationId: string, attemptId: string, nonce: string) { return record({ type: 'grant', operationId, attemptId, nonce }); },
  continuationBasis(operationId: string, attemptId: string) { return structuredClone(continuationBasis(operations.get(operationId), attemptId)); },
  recordContinuation(operationId: string, attemptId: string, continuation: ContinuationRecord) {
   const basis = continuationBasis(operations.get(operationId), attemptId);
   return !!basis && record({ type: 'continuation', operationId, attemptId, record: { ...structuredClone(continuation), uncertaintyAttemptId: basis.attemptId } });
  },
  assess(operationId: string, attemptId: string, revision: string, status: 'open' | 'cleared', evidence: string) { return record({ type: 'technical', operationId, attemptId, revision, status, evidence }); },
  events(): RecoverEvent[] { return structuredClone(journal); },
  activeAttempt(executor: string) {
   const attemptId = active.get(executor);
   if (!attemptId) return null;
   for (const op of operations.values()) if (op.executor === executor && op.attempts.at(-1)?.attemptId === attemptId) return { operationId: op.operationId, attemptId };
   return null;
  },
  inspect(operationId: string): Readonly<Operation> | null {
   const op = operations.get(operationId);
   return op ? structuredClone(op) : null;
  },
  findContract(contract: string) {
   for (let i = journal.length - 1; i >= 0; i--) {
    const event = journal[i];
    if (event.type === 'start' && event.contract === contract) return this.inspect(event.operationId);
   }
   return null;
  },
  find(taskId: string, contract: string) { const id = byContract.get(key(taskId, contract)); return id ? this.inspect(id) : null; },
 };
}
export type RecoverState = ReturnType<typeof createRecoverState>;
