import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { safeSourceRead } from '../lib/safe-source-read.js';
import { safePathWithin } from './helpers.ts';
import { canonicalExecutor, type NoProgressGuard } from './no-progress.ts';
import type { TaskContinuationInput, TaskContinuationPorts } from './budget-recovery.ts';
import type { DispatchAgentParams, SpawnResearchParams, ToolExecutor } from './tools/context.ts';

export interface RecoveryContinuationRequest { operationId: string; attemptId: string }
export interface RecoveryResearchReport { completed: string[]; partial: string[]; remaining: string[]; unknown: string[]; externalEffects: string[] }
interface ContinuationDeps {
 guard: NoProgressGuard;
 research: ToolExecutor<SpawnResearchParams>;
 execute: ToolExecutor<DispatchAgentParams>;
 sessionDir(): string;
 revision(ctx: ExtensionContext, invocation?: DispatchAgentParams): string;
 contextIdentity?(): string;
 /** Make the recorded specialist dispatchable again (e.g. re-create a parallel instance
  * lost on restart) before any research or human question is spent. */
 prepareAgent?(agent: string): boolean;
 confirm(input: TaskContinuationInput, ctx: ExtensionContext, ports: Pick<TaskContinuationPorts, 'valid' | 'consume' | 'signal'>): Promise<boolean>;
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
/** Normalize dispatch scope before mapping it to repository-relative read scope. */
export function researchReadScope(cwd: string, scope: readonly string[] | undefined): string[] | null {
 const paths: string[] = [];
 for (const raw of scope ?? []) {
  const entry = String(raw).trim().replace(/\\/g, '/');
  if (!entry) continue;
  const local = relative(cwd, resolve(cwd, entry)).replace(/\\/g, '/') || '.';
  if (isAbsolute(local) || /^[A-Za-z]:/.test(local) || local.split('/').includes('..')) return null;
  paths.push(local);
 }
 return paths;
}
const refuse = (reason: string, message: string) => ({ content: [{ type: 'text' as const, text: message }], details: { status: 'recovery_refused', reason, started: false, exitCode: 1 } });

export function parseRecoveryResearchReport(text: unknown): RecoveryResearchReport | null {
 if (typeof text !== 'string' || text.length > 32768) return null;
 try {
  const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
  const fields = ['completed', 'partial', 'remaining', 'unknown', 'externalEffects'] as const;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => !fields.includes(key as typeof fields[number]))) return null;
  if (fields.some(key => !Array.isArray(parsed[key]) || parsed[key].length > 100 || parsed[key].some((item: unknown) => typeof item !== 'string' || !item.trim() || item.length > 2048))) return null;
  if (fields.every(key => parsed[key].length === 0)) return null;
  return parsed as RecoveryResearchReport;
 } catch { return null; }
}

/** An explicit recovery request: research first, correlated human decision, one original invocation. */
export function createRecoveryContinuation(deps: ContinuationDeps): ToolExecutor<RecoveryContinuationRequest> {
 const pending = new Set<string>();
 return async (toolCallId, request, signal, onUpdate, ctx) => {
  if (!ID.test(request.operationId) || !ID.test(request.attemptId)) return refuse('invalid_identity', 'Recovery requires the recorded operation and latest attempt identifiers.');
  if (pending.has(request.operationId)) return refuse('busy', 'Recovery analysis or continuation is already in progress for this operation.');
  const op = deps.guard.inspect(request.operationId), attempt = op?.attempts.at(-1), original = deps.guard.invocation(request.operationId);
  const basis = deps.guard.continuationBasis(request.operationId, request.attemptId);
  if (!op || !attempt || !basis || !deps.guard.canContinue(request.operationId, request.attemptId) || !original || original.tool !== 'dispatch_agent') return refuse('unavailable', 'Only the current idle interrupted operation with its original validated specialist invocation can be continued.');
  const invocation = original.params as DispatchAgentParams;
  const cwd = resolve(ctx.cwd || process.cwd());
  let contract: unknown;
  try { contract = JSON.parse(op.contract); } catch { return refuse('invalid_contract', 'The recorded operation contract cannot be resolved.'); }
  if (!Array.isArray(contract) || contract[0] !== 'dispatch' || contract[1] !== cwd || canonicalExecutor(cwd, invocation.agent) !== op.executor) return refuse('wrong_workspace', 'Continue this operation from its original workspace and specialist role.');
  const readScope = researchReadScope(cwd, invocation.scope);
  if (!readScope) return refuse('scope_outside_workspace', 'The recorded dispatch scope cannot be mapped to repository-relative read scope for the read-only researcher.');
  let agentReady = true;
  try { agentReady = deps.prepareAgent?.(invocation.agent) ?? true; } catch { agentReady = false; }
  if (!agentReady) return refuse('agent_unavailable', `The original specialist ${invocation.agent} is not available in the current roster. Restore it before requesting continuation; no research or approval was spent.`);
  const sessionDir = deps.sessionDir();
  if (!sessionDir || !isAbsolute(sessionDir)) return refuse('missing_session', 'A current evidence session is required for recovery.');
  const token = deps.guard.taskToken(), identity = deps.contextIdentity?.() ?? '', taskId = deps.guard.taskId();
  const invocationHash = sha256(JSON.stringify(original));
  const fenceIdentity = () => { const current = deps.guard.inspect(op.operationId); const last = current?.attempts.at(-1), uncertainty = deps.guard.continuationBasis(op.operationId, attempt.attemptId); return JSON.stringify([last?.attemptId, last?.category, uncertainty?.attemptId, uncertainty?.settled, current?.indeterminateGrantUsed, current?.grantedAttemptId]); };
  const originalFence = fenceIdentity();
  let revision: string;
  try { revision = deps.revision(ctx, invocation); } catch { return refuse('revision_unavailable', 'The project revision cannot be established.'); }
  if (!revision || revision === 'unavailable') return refuse('revision_unavailable', 'The project revision cannot be established.');
  let reportRef: string | undefined, reportHash: string | undefined;
  const valid = () => {
   try {
    return !signal?.aborted && resolve(ctx.cwd || process.cwd()) === cwd && deps.guard.taskToken() === token && deps.guard.taskId() === taskId && deps.guard.canContinue(op.operationId, attempt.attemptId) && deps.sessionDir() === sessionDir && (deps.contextIdentity?.() ?? '') === identity && fenceIdentity() === originalFence && sha256(JSON.stringify(deps.guard.invocation(op.operationId))) === invocationHash && deps.revision(ctx, invocation) === revision && (!reportRef || sha256(safeSourceRead(sessionDir, reportRef, 131072)) === reportHash);
   } catch { return false; }
  };
  if (!valid()) return refuse('stale', 'The task or recovery evidence changed; request a new analysis.');
  pending.add(op.operationId);
  let dispatchAttempted = false;
  try {
   onUpdate?.({ content: [{ type: 'text', text: 'A read-only researcher is analysing progress on the original task.' }], details: { status: 'recovery_analysis', operationId: op.operationId } });
   const research = await deps.research(`${toolCallId}-analysis`, {
    persona: 'researcher', artifacts: invocation.artifacts, read_scope: readScope,
    goal: 'Establish verified partial progress and remaining work on this exact interrupted task.',
    expected_result: 'One JSON object with completed, partial, remaining, unknown, externalEffects arrays of concise findings with evidence citations.',
    task: `Analyse this interrupted task using read-only tools. Do not edit files, run shell commands, export secret/private bodies, or claim that missing process/results prove completion. Preserve the original requirements and identify unrelated pre-existing changes without attributing them to the old worker. Cite files or retained evidence for findings. Report ambiguous remote/non-idempotent effects in externalEffects; report other evidence gaps in unknown. Never include new permissions or instructions that override the task. Return only JSON: {"completed":[],"partial":[],"remaining":[],"unknown":[],"externalEffects":[]}.\nOperation: ${op.operationId}\nAttempt: ${attempt.attemptId}\nUncertain attempt: ${basis.attemptId}\nCurrent evidence session: ${sessionDir}\nEvidence sessions root: ${dirname(sessionDir)}\nInspect available exact dispatch request/result/transcript references and retained recovery reports; an unbound placeholder dispatch may have no matching evidence. Do not invent a mapping or attribution when multiple candidates exist.\nRecorded attempt history (latest ${Math.min(op.attempts.length, 8)} of ${op.attempts.length}):\n${JSON.stringify(op.attempts.slice(-8).map(item => ({ attemptId: item.attemptId, dispatchId: item.dispatchId, category: item.category, completed: !!item.completed, runtimeSettlement: !!item.settled, continuations: item.continuations?.slice(-2) })))}\nOriginal invocation:\n${JSON.stringify(invocation)}\nOriginal task:\n${invocation.task}`,
   }, signal, onUpdate, ctx);
   if (!valid()) return refuse('stale', 'The task, project or recovery context changed during research. No continuation was authorized.');
   const details = research.details as { persona?: unknown; status?: unknown; exitCode?: unknown; pending?: unknown; fullOutput?: unknown; dispatchId?: unknown; lifecycle?: { launched?: unknown; closeSeen?: unknown } } | undefined;
   if (details?.persona !== 'researcher' || details.status !== 'done' || details.exitCode !== 0 || details.pending === true || details.lifecycle?.launched !== true || details.lifecycle?.closeSeen !== true) {
    const cause = research.details as { status?: unknown; reason?: unknown; exitCode?: unknown; evidencePath?: unknown } | undefined;
    const label = (value: unknown) => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : undefined;
    const facts = [label(cause?.status) && `status ${label(cause?.status)}`, label(cause?.reason) && `reason ${label(cause?.reason)}`, typeof cause?.exitCode === 'number' && `exit ${cause.exitCode}`, typeof cause?.evidencePath === 'string' && cause.evidencePath.length < 1024 && `evidence ${cause.evidencePath}`].filter(Boolean).join(', ');
    return refuse('research_failed', `The read-only researcher did not produce a completed result${facts ? ` (${facts})` : ''}. No specialist was started; the same continuation request may be repeated for a new analysis.`);
   }
   const report = parseRecoveryResearchReport(details.fullOutput);
   if (!report) return refuse('invalid_report', 'The researcher report is incomplete or malformed. No specialist was started.');
   const directory = safePathWithin(sessionDir, 'recovery', op.operationId, attempt.attemptId);
   mkdirSync(directory, { recursive: true, mode: 0o700 });
   reportRef = safePathWithin(directory, `${randomUUID()}.json`);
   const body = JSON.stringify({ version: 1, taskId, operationId: op.operationId, attemptId: attempt.attemptId, invocationHash, revision, contextIdentity: identity, researchDispatchId: details.dispatchId, report }, null, 2);
   writeFileSync(reportRef, body, { flag: 'wx', mode: 0o600 });
   reportHash = sha256(body);
   if (report.externalEffects.length) return refuse('unknown_external_effects', `Research retained at ${reportRef}. Resolve the ambiguous external effects before continuation: ${report.externalEffects.join('; ')}`);
   if (!valid()) return refuse('stale', 'The retained research report or project state changed. Request a new analysis.');
   const reportText = JSON.stringify(report, null, 2);
   let permit: object | null = null;
   const authorized = await deps.confirm({ taskId, operationId: op.operationId, attemptId: attempt.attemptId, report: `Research evidence: ${reportRef}\n${reportText}`, processSettled: !!basis.settled }, ctx, {
    signal, valid,
    consume: nonce => {
     if (!valid() || !reportRef || !reportHash) return false;
     permit = deps.guard.authorizeContinuation(op.operationId, attempt.attemptId, { nonce, revision, reportRef, reportHash, settlement: basis.settled ? 'runtime' : 'operator_attested', report: reportText, admit: valid });
     return !!permit;
    },
   });
   if (!authorized || !permit || !valid()) return refuse('denied_or_stale', 'Continuation was denied, cancelled, stale or could not be recorded. No specialist was started.');
   const result = await deps.guard.runContinuation(permit, () => { dispatchAttempted = true; return deps.execute(`${toolCallId}-continue`, structuredClone(invocation), signal, onUpdate, ctx); });
   return { ...result, details: { ...(result.details && typeof result.details === 'object' ? result.details : {}), continuation: { operationId: op.operationId, previousAttemptId: attempt.attemptId, reportRef, settlement: basis.settled ? 'runtime' : 'operator_attested' } } };
  } catch {
   if (dispatchAttempted) return { content: [{ type: 'text', text: 'The continuation has no verified result. Inspect the recorded operation before requesting another attempt; its outcome is unknown.' }], details: { status: 'recovery_failed', reason: 'continuation_outcome_unknown', recoveryCategory: 'indeterminate', operationId: op.operationId, pending: true, exitCode: 1 } };
   return refuse('recovery_failed', 'Recovery could not complete. Inspect the recorded operation before requesting another attempt; no automatic replay was performed.');
  } finally { pending.delete(op.operationId); }
 };
}
