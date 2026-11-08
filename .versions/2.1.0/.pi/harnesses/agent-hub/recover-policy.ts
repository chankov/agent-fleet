import { recoveryDecision, type RecoveryCategory, type RecoveryConditions } from './recovery-contract.ts';
import type { RecoverState } from './recover-state.ts';
import type { NoProgressGuard } from './no-progress.ts';

/** Policy assessment is inert: it cannot grant, dispatch, renew budgets or launch a process. */
export function assessRecovery(category: RecoveryCategory, conditions: RecoveryConditions) {
 return recoveryDecision(category, conditions);
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
/** Render only code-owned command grammar from validated IDs, never model-supplied prose. */
export function renderRecoveryInvocation(state: RecoverState, operationId: string, attemptId: string, command: 'inspect' | 'retry' | 'reconcile' | 'abandon' = 'retry'): string | null {
 if (!ID.test(operationId) || !ID.test(attemptId)) return null;
 const operation = state.inspect(operationId);
 if (!operation || !operation.attempts.some(attempt => attempt.attemptId === attemptId)) return null;
 return command === 'inspect' ? `/af-recover inspect ${operationId}` : `/af-recover ${command} ${operationId} ${attemptId}`;
}
/** Human-facing invocation; the tool call is a template, never executed here.
 *  T6: abandoned operations never render a replay template; missing/invalid contracts
 *  return null so callers can emit their distinct reason (see invocationStatus). */
export function renderNextInvocation(guard: NoProgressGuard, operationId: string): string | null {
 const operation = guard.inspect(operationId), invocation = guard.invocation(operationId);
 if (!operation || !invocation || operation.abandoned || !ID.test(operationId)) return null;
 const status = (guard as any).invocationStatus?.(operationId);
 if (status && status.status !== 'available') return null;
 return `${invocation.tool}(${JSON.stringify(invocation.params)})`;
}
/** T6: distinct invocation-availability reason for exact recovery responses. */
export function describeInvocationAvailability(guard: NoProgressGuard, operationId: string): string {
 const status = (guard as any).invocationStatus?.(operationId);
 if (!status) {
  const operation = guard.inspect(operationId);
  if (!operation) return 'missing_original_runtime_invocation: unknown operation';
  if (operation.abandoned) return 'abandoned_operation: abandon closed the operation; parent obligations remain open';
  if (!guard.invocation(operationId)) return 'missing_original_runtime_invocation: no validated contract was persisted';
  return 'unknown_process: pending or unsettled process';
 }
 if (status.status === 'available') return 'available';
 return `${status.reason}: ${(status.nextActions ?? []).join('; ')}`;
}
export function renderRecoverCommands(guard: NoProgressGuard, operationId: string, attemptId: string): string | null {
 const op = guard.inspect(operationId);
 if (!op || !ID.test(operationId) || !ID.test(attemptId) || !op.attempts.some(a => a.attemptId === attemptId)) return null;
 return [`/af-recover inspect ${operationId}`, `/af-recover retry ${operationId} ${attemptId}`, `/af-recover reconcile ${operationId} ${attemptId}`, `/af-recover abandon ${operationId} ${attemptId}`].join('; ');
}
