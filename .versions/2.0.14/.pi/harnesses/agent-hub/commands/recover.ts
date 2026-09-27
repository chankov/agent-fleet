import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { CommandContext } from './context.ts';
import type { NoProgressGuard } from '../no-progress.ts';
import { confirmRecoverAction, type RecoverAuthorizationPorts } from '../budget-recovery.ts';
import { renderNextInvocation, renderRecoverCommands } from '../recover-policy.ts';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export type RecoverRequest = { action: 'inspect'; operationId: string } | { action: 'retry' | 'reconcile' | 'abandon'; operationId: string; attemptId: string };
export function parseRecoverArgs(args: string): RecoverRequest | null {
 const words = args.trim().split(/\s+/);
 if (words[0] === 'inspect' && words.length === 2 && ID.test(words[1])) return { action: 'inspect', operationId: words[1] };
 if (['retry', 'reconcile', 'abandon'].includes(words[0]) && words.length === 3 && ID.test(words[1]) && ID.test(words[2])) return { action: words[0] as 'retry' | 'reconcile' | 'abandon', operationId: words[1], attemptId: words[2] };
 return null;
}

export interface RecoverHandlerDeps {
 noProgress: NoProgressGuard;
 currentRevision: (cwd: string) => string;
 confirm: typeof confirmRecoverAction;
 askPorts: (op: NonNullable<ReturnType<NoProgressGuard['inspect']>>, attempt: NonNullable<NonNullable<ReturnType<NoProgressGuard['inspect']>>['attempts']>[number], action: 'retry' | 'abandon') => RecoverAuthorizationPorts;
}

/** Production recover command body. Never dispatches work. */
export async function runRecoverCommand(args: string, ctx: ExtensionContext, deps: RecoverHandlerDeps): Promise<void> {
 const request = parseRecoverArgs(args);
 if (!request) { ctx.ui.notify("Usage: /af-recover inspect <operationId> | retry|reconcile|abandon <operationId> <attemptId>", "error"); return; }
 const op = deps.noProgress.inspect(request.operationId);
 if (!op) { ctx.ui.notify("Unknown operation; nothing changed.", "error"); return; }
 if (request.action === "inspect") {
  const last = op.attempts.at(-1);
  const commands = last ? renderRecoverCommands(deps.noProgress, op.operationId, last.attemptId) : null;
  const missing = !last?.category ? 'pending or unknown process; settle before recovery' : last.category === 'indeterminate' && !last.settled ? 'independent process settlement' : !deps.noProgress.isIdle(op.executor) ? 'executor idle' : op.abandoned ? 'operation abandoned' : !deps.noProgress.invocation(op.operationId) ? 'validated original invocation' : 'category-specific evidence and existing budget/safety gates';
  ctx.ui.notify(JSON.stringify({ operationId: op.operationId, taskId: op.taskId, attempts: op.attempts.map(a => ({ attemptId: a.attemptId, dispatchId: a.dispatchId, category: a.category ?? 'pending', settled: !!a.settled })), technical_block: op.technical?.status ?? 'open', abandoned: !!op.abandoned, indeterminateGrantUsed: op.indeterminateGrantUsed, missingPrerequisites: missing, commands }), 'info'); return;
 }
 const attempt = op.attempts.find(a => a.attemptId === request.attemptId);
 if (!attempt || op.attempts.at(-1)?.attemptId !== attempt.attemptId || !attempt.category) { ctx.ui.notify("Unknown, live or stale attempt; nothing changed.", "error"); return; }
 if (request.action === "reconcile") {
  const cwd = ctx.cwd || process.cwd();
  const outcome = deps.noProgress.reconcile(op.operationId, attempt.attemptId, deps.currentRevision(cwd), { cwd, sessionDir: cwd });
  ctx.ui.notify(JSON.stringify({ ...outcome, nextCommands: renderRecoverCommands(deps.noProgress, op.operationId, attempt.attemptId) }), outcome.cleared ? "info" : "warning"); return;
 }
 if (request.action === "retry" && !deps.noProgress.canAuthorize(op.operationId, attempt.attemptId)) { ctx.ui.notify("Retry refused: only a settled, idle indeterminate or ungranted cancellation is authorizable.", "error"); return; }
 if (request.action === "abandon" && (op.abandoned || !deps.noProgress.isIdle(op.executor))) { ctx.ui.notify("Abandon refused: operation already abandoned or executor busy.", "error"); return; }
 const authorized = await deps.confirm({ taskId: deps.noProgress.taskId(), operationId: op.operationId, attemptId: attempt.attemptId, action: request.action, category: attempt.category }, ctx, deps.askPorts(op, attempt, request.action));
 if (!authorized) { ctx.ui.notify("Human approval denied, stale, concurrent, or duplicate; no permission granted.", "error"); return; }
 const next = renderNextInvocation(deps.noProgress, op.operationId);
 ctx.ui.notify(request.action === "abandon" ? "Operation abandoned; parent obligations remain open." : `One-use permission recorded; no work was started. ${next ? `Next explicit original-contract invocation: ${next}` : 'Original validated invocation unavailable; re-establish the contract before dispatching.'} Existing budgets and safety gates apply. ${renderRecoverCommands(deps.noProgress, op.operationId, attempt.attemptId) ?? ''}`, "info");
}

export function registerRecover(pi: ExtensionAPI, commandCtx: CommandContext) {
 pi.registerCommand("af-recover", { description: 'Inspect, authorize retry, reconcile technical evidence or abandon an operation; never dispatches work.', handler: async (args, ctx) => commandCtx.handleRecover(args, ctx) });
}
