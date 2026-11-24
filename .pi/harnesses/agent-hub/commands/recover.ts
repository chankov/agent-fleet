import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { CommandContext } from './context.ts';
import type { NoProgressGuard } from '../no-progress.ts';
import { confirmRecoverAction, type RecoverAuthorizationPorts } from '../budget-recovery.ts';
import { describeInvocationAvailability, renderNextInvocation, renderRecoverCommands } from '../recover-policy.ts';
import type { ToolExecutor } from '../tools/context.ts';
import type { RecoveryContinuationRequest } from '../recovery-continuation.ts';
import { randomUUID } from 'node:crypto';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export type RecoverRequest = { action: 'inspect'; operationId: string } | { action: 'continue' | 'retry' | 'reconcile' | 'abandon'; operationId: string; attemptId: string };
export function parseRecoverArgs(args: string): RecoverRequest | null {
 const words = args.trim().split(/\s+/);
 if (words[0] === 'inspect' && words.length === 2 && ID.test(words[1])) return { action: 'inspect', operationId: words[1] };
 if (['continue', 'retry', 'reconcile', 'abandon'].includes(words[0]) && words.length === 3 && ID.test(words[1]) && ID.test(words[2])) return { action: words[0] as 'continue' | 'retry' | 'reconcile' | 'abandon', operationId: words[1], attemptId: words[2] };
 return null;
}

export interface RecoverHandlerDeps {
 noProgress: NoProgressGuard;
 continueTask?: ToolExecutor<RecoveryContinuationRequest>;
 /** Record a command-run continuation outcome in the conversation so the dispatcher sees it. */
 reportContinuation?: (text: string, details: unknown) => void;
 /** The revision over a dispatch's recorded basis ([] is the whole root repository). */
 currentRevision: (cwd: string) => string | ((scopes: readonly string[]) => string);
 confirm: typeof confirmRecoverAction;
 askPorts: (op: NonNullable<ReturnType<NoProgressGuard['inspect']>>, attempt: NonNullable<NonNullable<ReturnType<NoProgressGuard['inspect']>>['attempts']>[number], action: 'retry' | 'abandon') => RecoverAuthorizationPorts;
}

/** Existing actions are inert; explicit continue runs the researcher-led coordinator. */
export async function runRecoverCommand(args: string, ctx: ExtensionContext, deps: RecoverHandlerDeps): Promise<void> {
 const request = parseRecoverArgs(args);
 if (!request) { ctx.ui.notify("Usage: /af-recover inspect <operationId> | continue|retry|reconcile|abandon <operationId> <attemptId>", "error"); return; }
 const op = deps.noProgress.inspect(request.operationId);
 if (!op) { ctx.ui.notify("Unknown operation; nothing changed.", "error"); return; }
 if (request.action === "inspect") {
  const last = op.attempts.at(-1);
  const commands = last ? renderRecoverCommands(deps.noProgress, op.operationId, last.attemptId) : null;
  // T6: proven no-launch history needs no slash reset; each missing prerequisite is distinct.
  const uncertainty = last && deps.noProgress.continuationBasis(op.operationId, last.attemptId);
  const invocationDetail = last?.completed ? 'completed_execution: normal parent acceptance still applies' : describeInvocationAvailability(deps.noProgress, op.operationId, uncertainty?.attemptId ?? last?.attemptId);
  const missing = last?.completed ? 'none: latest execution completed; normal parent acceptance still applies'
   : !last?.category ? 'pending_or_unknown_process: settle the live process before recovery; independent inspection is allowed'
   : uncertainty && uncertainty.attemptId !== last.attemptId ? 'retained_indeterminate_fence: correct the no-launch prerequisite, then request continue with fresh research and approval'
   : last.category === 'not_started' ? 'none: preflight refused before launch with no effects; correct inputs/prerequisites and re-invoke explicitly (no slash reset, no grant, no reconcile)'
   : last.category === 'indeterminate' && !last.settled ? 'independent_process_settlement: missing close/termination facts for legacy retry; continue can collect a separately recorded operator stop attestation after research'
   : !deps.noProgress.isIdle(op.executor) ? 'executor_idle'
   : op.abandoned ? 'operation_abandoned: abandon closed the operation; parent obligations remain open'
   : invocationDetail !== 'available' ? invocationDetail
   : 'category-specific evidence and existing budget/safety gates';
  ctx.ui.notify(JSON.stringify({ operationId: op.operationId, taskId: op.taskId, attempts: op.attempts.map(a => ({ attemptId: a.attemptId, dispatchId: a.dispatchId, category: a.category ?? (a.completed ? 'completed' : 'pending'), settled: !!a.settled, ...(a.interrupted ? { interrupted: true, ...(a.lateOutcome ? { lateOutcome: a.lateOutcome } : {}) } : {}), ...(a.continuations?.length ? { continuations: a.continuations } : {}) })), technical_block: op.technical?.status ?? 'open', abandoned: !!op.abandoned, indeterminateGrantUsed: op.indeterminateGrantUsed, missingPrerequisites: missing, invocationAvailability: invocationDetail, commands }), 'info'); return;
 }
 const attempt = op.attempts.find(a => a.attemptId === request.attemptId);
 if (!attempt || op.attempts.at(-1)?.attemptId !== attempt.attemptId || !attempt.category) { ctx.ui.notify("Unknown, live or stale attempt; nothing changed.", "error"); return; }
 if (request.action === 'continue') {
  if (!deps.continueTask) { ctx.ui.notify('Research-led continuation is unavailable in this runtime.', 'error'); return; }
  const result = await deps.continueTask(`recover-${randomUUID()}`, { operationId: op.operationId, attemptId: attempt.attemptId }, ctx.signal, undefined, ctx);
  const details = result.details as { exitCode?: number; status?: unknown } | undefined;
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  ctx.ui.notify(text, details?.exitCode === 0 ? 'info' : 'warning');
  // A refusal before any specialist launch changes nothing the dispatcher must know about.
  if (details?.status !== 'recovery_refused') { try { deps.reportContinuation?.(`/af-recover continue ${op.operationId} ${attempt.attemptId}\n\n${text}`, result.details); } catch { /* the notification above already reported it */ } }
  return;
 }
 if (request.action === "reconcile") {
  const cwd = ctx.cwd || process.cwd();
  const outcome = deps.noProgress.reconcile(op.operationId, attempt.attemptId, deps.currentRevision(cwd), { cwd, sessionDir: cwd });
  ctx.ui.notify(JSON.stringify({ ...outcome, nextCommands: renderRecoverCommands(deps.noProgress, op.operationId, attempt.attemptId) }), outcome.cleared ? "info" : "warning"); return;
 }
 if (request.action === "retry" && !deps.noProgress.canAuthorize(op.operationId, attempt.attemptId)) { ctx.ui.notify("Retry refused: only a settled, idle indeterminate or ungranted cancellation is authorizable.", "error"); return; }
 if (request.action === "abandon" && (op.abandoned || !deps.noProgress.isIdle(op.executor))) { ctx.ui.notify("Abandon refused: operation already abandoned or executor busy.", "error"); return; }
 const authorized = await deps.confirm({ taskId: deps.noProgress.taskId(), operationId: op.operationId, attemptId: attempt.attemptId, action: request.action, category: attempt.category }, ctx, deps.askPorts(op, attempt, request.action));
 if (!authorized) { ctx.ui.notify("Human approval denied, stale, concurrent, or duplicate; no permission granted.", "error"); return; }
 const next = renderNextInvocation(deps.noProgress, op.operationId, attempt.attemptId);
 const invocationDetail = describeInvocationAvailability(deps.noProgress, op.operationId, attempt.attemptId);
 ctx.ui.notify(request.action === "abandon" ? "Operation abandoned; parent obligations remain open." : `One-use permission recorded; no work was started. ${next ? `Next explicit original-contract invocation: ${next}` : `Original validated invocation unavailable (${invocationDetail}); re-establish the contract before dispatching.`} Existing budgets and safety gates apply. ${renderRecoverCommands(deps.noProgress, op.operationId, attempt.attemptId) ?? ''}`, "info");
}

export function registerRecover(pi: ExtensionAPI, commandCtx: CommandContext) {
 pi.registerCommand("af-recover", { description: 'Inspect, analyse and continue an interrupted task, authorize retry, reconcile evidence or abandon. Continue requires research and one human decision.', handler: async (args, ctx) => commandCtx.handleRecover(args, ctx) });
}
