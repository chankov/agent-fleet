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
/** Human-facing invocation; the tool call is a template, never executed here. */
export function renderNextInvocation(guard: NoProgressGuard, operationId: string): string | null {
 const operation = guard.inspect(operationId), invocation = guard.invocation(operationId);
 if (!operation || !invocation || operation.abandoned || !ID.test(operationId)) return null;
 return `${invocation.tool}(${JSON.stringify(invocation.params)})`;
}
export function renderRecoverCommands(guard: NoProgressGuard, operationId: string, attemptId: string): string | null {
 const op = guard.inspect(operationId);
 if (!op || !ID.test(operationId) || !ID.test(attemptId) || !op.attempts.some(a => a.attemptId === attemptId)) return null;
 return [`/af-recover inspect ${operationId}`, `/af-recover retry ${operationId} ${attemptId}`, `/af-recover reconcile ${operationId} ${attemptId}`, `/af-recover abandon ${operationId} ${attemptId}`].join('; ');
}
