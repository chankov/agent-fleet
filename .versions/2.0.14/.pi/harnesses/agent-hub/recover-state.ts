import { randomUUID } from 'node:crypto';
import type { RecoveryCategory } from './recovery-contract.ts';

export type RecoverEvent =
 | { type: 'start'; operationId: string; attemptId: string; taskId: string; contract: string; executor: string; dispatchId: string }
 | { type: 'complete'; operationId: string; attemptId: string }
 | { type: 'failure'; operationId: string; attemptId: string; category: RecoveryCategory }
 | { type: 'settled'; operationId: string; attemptId: string; evidence: string }
 | { type: 'dispatch'; operationId: string; attemptId: string; dispatchId: string }
 | { type: 'abandon'; operationId: string; attemptId: string; nonce: string }
 | { type: 'grant'; operationId: string; attemptId: string; nonce: string }
 | { type: 'technical'; operationId: string; attemptId: string; revision: string; status: 'open' | 'cleared'; evidence: string };
type Attempt = { attemptId: string; dispatchId: string; category?: RecoveryCategory; completed?: boolean; settled?: string }; 
type Operation = { operationId: string; taskId: string; contract: string; executor: string; attempts: Attempt[]; indeterminateGrantUsed: boolean; grantedAttemptId?: string; abandoned?: boolean; technical?: { status: 'open' | 'cleared'; revision: string; evidence: string } };

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
    if (!nonempty(event.dispatchId) || usedIds.has(event.dispatchId) || attempt.category || attempt.completed || active.get(op.executor) !== attempt.attemptId) throw new Error('Invalid recovery history');
    attempt.dispatchId = event.dispatchId; usedIds.add(event.dispatchId); return;
   case 'abandon':
    if (!attempt.category || op.abandoned || op.attempts.at(-1) !== attempt || !nonempty(event.nonce) || usedNonces.has(event.nonce)) throw new Error('Invalid recovery history');
    usedNonces.add(event.nonce); op.abandoned = true; return;
   case 'complete':
    if (attempt.category || attempt.completed || active.get(op.executor) !== attempt.attemptId) throw new Error('Invalid recovery history');
    attempt.completed = true; active.delete(op.executor); return;
   case 'failure':
    if (attempt.category || active.get(op.executor) !== attempt.attemptId || !['invalid_input','resource_exhausted','operator_cancelled','verification_failed','tool_protocol_error','unknown_tool','indeterminate'].includes(event.category)) throw new Error('Invalid recovery history');
    attempt.category = event.category; active.delete(op.executor); return;
   case 'settled':
    if (!attempt.category || attempt.settled || !nonempty(event.evidence)) throw new Error('Invalid recovery history');
    attempt.settled = event.evidence; return;
   case 'grant':
    if (attempt.category !== 'indeterminate' || !attempt.settled || active.has(op.executor) || op.indeterminateGrantUsed || op.attempts.at(-1) !== attempt || !nonempty(event.nonce) || usedNonces.has(event.nonce)) throw new Error('Invalid recovery history');
    usedNonces.add(event.nonce); op.indeterminateGrantUsed = true; op.grantedAttemptId = attempt.attemptId; return;
   case 'technical':
    if (!attempt.category || !nonempty(event.revision) || !nonempty(event.evidence) || !['open','cleared'].includes(event.status) || (op.technical?.status === 'cleared' && event.status === 'cleared' && op.technical.revision === event.revision)) throw new Error('Invalid recovery history');
    op.technical = { status: event.status, revision: event.revision, evidence: event.evidence }; return;
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
  byDispatch(dispatchId: string) { for (const op of operations.values()) if (op.attempts.some(a => a.dispatchId === dispatchId)) return this.inspect(op.operationId); return null; },
  complete(operationId: string, attemptId: string) { return record({ type: 'complete', operationId, attemptId }); },
  fail(operationId: string, attemptId: string, category: RecoveryCategory) { return record({ type: 'failure', operationId, attemptId, category }); },
  settle(operationId: string, attemptId: string, evidence: string) { return record({ type: 'settled', operationId, attemptId, evidence }); },
  grant(operationId: string, attemptId: string, nonce: string) { return record({ type: 'grant', operationId, attemptId, nonce }); },
  assess(operationId: string, attemptId: string, revision: string, status: 'open' | 'cleared', evidence: string) { return record({ type: 'technical', operationId, attemptId, revision, status, evidence }); },
  events(): RecoverEvent[] { return structuredClone(journal); },
  inspect(operationId: string): Readonly<Operation> | null {
   const op = operations.get(operationId);
   return op ? structuredClone(op) : null;
  },
  findContract(contract: string) { for (const op of operations.values()) if (op.contract === contract) return this.inspect(op.operationId); return null; },
  find(taskId: string, contract: string) { const id = byContract.get(key(taskId, contract)); return id ? this.inspect(id) : null; },
 };
}
export type RecoverState = ReturnType<typeof createRecoverState>;
