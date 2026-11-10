import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { minimalChangeRequirement, type AcceptanceRequirement } from './acceptance.ts';
import { receiptDeclarationHash, runtimeReceiptEvidenceCurrent } from './runtime-receipts.ts';
import type { ProcessObligationState } from './process-obligations.ts';
import { affirmativeReviewVerdict } from './review-verdict.ts';
import { countReviewFindings } from './review-findings.js';
import { reviewMayClose } from './orchestration-activation.ts';
import { persistOperatorStateProof, type OperatorEvidenceWriter } from './operator-current-state.ts';
import { worktreeRevision } from './scope-gate.js';
import { capturePrivateConfig, privateConfigRevision, type PrivateConfigBinding } from './private-config-current-state.ts';
import type { RuntimeReceipt } from './runtime-receipts.ts';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface PrivateProcessProof {
 origin: 'private-config-current-state'; binding: PrivateConfigBinding; revision: string;
 evidenceRef: string; evidenceHash: string; overlap: number; classification: string;
 reviewer: { evidenceRef: string; evidenceHash: string };
 receipts: { evidenceRef: string; evidenceHash: string }[];
}
/** Live parent state, never tool parameters or a persisted validity boolean. */
export interface PrivateProofUse {
 cwd: string; taskId: string; sessionDir: string; declarationHash: string;
 activeWriters: number; overlap: number;
}
export function privateRequirements(assertions: AcceptanceRequirement[]): AcceptanceRequirement[] {
 const ledger = assertions.map(r => ({ ...r })), minimal = minimalChangeRequirement(), inherited = ledger.find(r => r.id === minimal.id);
 if (inherited) inherited.criticalConditions = [...new Set([...(inherited.criticalConditions ?? []), ...(minimal.criticalConditions ?? []), ...(inherited.text !== minimal.text ? [minimal.text] : [])])];
 return inherited ? ledger : [...ledger, minimal];
}
export function privateDeclarationHash(assertions: AcceptanceRequirement[], acceptedInput?: string): string {
 return receiptDeclarationHash(privateRequirements(assertions), [], acceptedInput);
}
export function privateClassification(state: ProcessObligationState): string {
 return digest(JSON.stringify([state.risk, state.scope, state.reassessments, state.additions ?? []]));
}
function proofBytes(sessionDir: string, path: string, kind: 'evidence' | 'returns' = 'evidence'): Buffer {
 const root = resolve(realpathSync(sessionDir), 'artifacts', kind), file = resolve(path), rel = relative(root, file);
 if (!rel || rel.startsWith('..') || isAbsolute(rel) || realpathSync(root) !== root || realpathSync(file) !== file) throw Error();
 const stat = lstatSync(file);
 if (!stat.isFile() || stat.size > 256 * 1024) throw Error();
 return readFileSync(file);
}
/** Private closure is deliberately separate from Git stages and requires live revalidation at every use. */
export function privateProcessProofCurrent(state: ProcessObligationState, use?: PrivateProofUse): boolean {
 try {
  const p = state.privateVerification, receipts = state.runtimeReceipts;
  if (!p || !use || p.origin !== 'private-config-current-state' || !receipts || state.changedFiles.length || state.workOrigin
   || state.acceptance.evidenceRef || state.review.evidenceRef || state.additions?.some(a => a.status === 'active' && a.reason !== 'irreversible_execution') || use.activeWriters !== 0 || p.overlap !== use.overlap
   || p.classification !== privateClassification(state) || p.binding.taskId !== use.taskId || p.binding.sessionDir !== use.sessionDir
   || p.binding.declarationHash !== use.declarationHash || receipts.generation !== p.binding.generation || receipts.epoch !== p.binding.epoch
   || receipts.pending.length || !p.receipts.length || p.revision === 'unavailable'
   || privateConfigRevision(use.cwd, worktreeRevision(use.cwd, []), p.binding) !== p.revision
   || digest(proofBytes(use.sessionDir, p.evidenceRef)) !== p.evidenceHash
   || digest(proofBytes(use.sessionDir, p.reviewer.evidenceRef, 'returns')) !== p.reviewer.evidenceHash) return false;
  return p.receipts.every(ref => receipts.records.some(r => r.captureId === p.binding.captureId && r.taskId === use.taskId
   && r.generation === p.binding.generation && r.epoch === p.binding.epoch && r.sessionDir === use.sessionDir
   && r.declarationHash === use.declarationHash && r.check.inspectedRevision === p.revision
   && r.check.evidenceRef === ref.evidenceRef && r.evidenceHash === ref.evidenceHash && runtimeReceiptEvidenceCurrent(r)));
 } catch { return false; }
}

/** No proof reuse for review: every success requires this dispatch's anchored native receipts. */
export function finishPrivateConfigReview(input: {
 stillCurrent: () => boolean; cwd: string; binding: PrivateConfigBinding; revision: string; beforeRevision: string; sameTask: boolean;
 native: boolean; reviewerValid: boolean; exclusive: boolean; captureCurrent: boolean; delivered: boolean;
 exitCode: number; dispatchId?: string; submission: any; protocolDiagnostic: unknown;
 output: string; parsedReturn: any; questions: string[]; research: string[];
 verification: any; anchored: RuntimeReceipt[]; sourceDelta: boolean; sourceObligations: boolean;
 returnPath?: string | null; writer: OperatorEvidenceWriter; runCount: number;
}) {
 const result = { status: 'unproven' as const, origin: 'private-config-current-state' as const, historicalAttribution: 'not_claimed' as const, revision: input.revision };
 const requirements = input.verification?.requirements ?? [], checks = input.verification?.checks ?? [];
 const ready = input.sameTask && input.native && input.reviewerValid && input.exclusive && input.captureCurrent && input.delivered && input.exitCode === 0
  && !!input.dispatchId && !input.protocolDiagnostic && input.submission?.status === 'completed'
  && !input.sourceDelta && !input.sourceObligations && input.revision !== 'unavailable' && input.revision === input.beforeRevision
  && affirmativeReviewVerdict(input.output) && countReviewFindings(input.output).blocking === 0
  && !input.questions.length && !input.research.length && !!input.parsedReturn
  && !(input.parsedReturn.assertions_failed ?? []).length && !(input.parsedReturn.assertions_unproven ?? []).length
  && !(input.submission.requires_user_decision ?? []).some((q: string) => q.trim().toLowerCase() !== 'none')
  && requirements.some((r: any) => r.id !== 'AF-MIN-CHANGE') && requirements.some((r: any) => r.id === 'AF-MIN-CHANGE')
  && requirements.every((r: any) => ['test', 'code-grep'].includes(r.tag) && r.status === 'passed' && r.evidenceRefs?.length)
  && checks.length > 0 && checks.every((c: any) => c.producer === 'runtime' && c.status === 'passed'
   && input.anchored.some(a => a.captureId === input.binding.captureId && a.originDispatchId === input.dispatchId && a.check.evidenceRef === c.evidenceRef))
  && reviewMayClose({ revision: input.revision, scope: input.binding.sources, output: input.output, evidenceRef: input.returnPath ?? undefined, declared: true, wide: true });
 if (!ready) return result;
 try {
  const current = () => input.stillCurrent() && privateConfigRevision(input.cwd, worktreeRevision(input.cwd, []), input.binding) === input.beforeRevision;
  if (!current()) return result;
  const reviewer = { evidenceRef: input.returnPath!, evidenceHash: digest(proofBytes(input.binding.sessionDir, input.returnPath!, 'returns')) };
  const evidenceRef = persistOperatorStateProof({ writer: input.writer, sessionDir: input.binding.sessionDir, runCount: input.runCount, dispatchId: input.dispatchId!, record: {
   schema: 'agent-fleet.private-config-verification/v1', ...result, status: 'accepted', binding: input.binding,
   snapshot: capturePrivateConfig(input.cwd, input.binding.files, input.binding.sources),
   checks, reviewer: { backend: 'native', dispatchId: input.dispatchId, ...reviewer },
   activation: 'not_performed', sourceObligations: 'not_covered',
  } });
  return current() ? { ...result, status: 'accepted' as const, evidenceRef, reviewer, evidenceHash: digest(proofBytes(input.binding.sessionDir, evidenceRef)) } : result;
 } catch { return { ...result, reason: 'evidence_readback_failed' }; }
}
