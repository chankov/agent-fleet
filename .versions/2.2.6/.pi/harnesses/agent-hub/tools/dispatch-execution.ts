import { decideDispatch, recordDispatchRecoveryEvidence, summarizeDispatchOutcome } from "./dispatch-decisions.ts";
import { beginDispatchEvidence, collectDispatchReceipts, completeDispatchEvidence, diagnoseObservation, incompleteObservation, prepareDispatchCompiler, retainDispatchAssessment } from "./dispatch-evidence.ts";
import type { DispatchExecutorDeps, PreparedDispatch, RunData, Tracking } from "./dispatch-execution-types.ts";
import { renderDispatchResult } from "./dispatch-result.ts";
import { privateRequirements } from '../private-config-review.ts';
import { capturePrivateConfig, privateConfigRevision, type PrivateConfigBinding } from '../private-config-current-state.ts';
import { beginReceiptCapture, receiptDeclarationHash } from "../runtime-receipts.ts";
import { captureReviewBaseline, reviewContinuation } from "../review-continuity.ts";
import { reviewInput, reusableReview } from "../review-reuse.ts";
import { captureOperatorState, OperatorScopeObservationError, operatorReviewState, operatorScopeSyntax, unknownOperatorScope, type OperatorStateCandidate } from "../operator-current-state.ts";
import { earlyOperatorScopeDiagnostic, formatScopeDiagnostic, type ScopeDiagnostic } from "../scope-diagnostic.ts";
import { minimalChangeRequirement, preflightDeliverables, type AcceptanceRequirement, type DeliverableContract } from "../acceptance.ts";
import { normalizeResearchContract, withNoProgress } from "../no-progress.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { checkTierPersonaGate, isReviewPersona, parallelInstanceName, reviewBudgetClause } from "../run-budget.js";
import { checkDocsLane } from "../docs-lane.js";
import { checkExternalBlockerGate, extractExternalBlockers } from "../external-blocker.js";
import { checkScope, nestedRevisionScopes, revisionOf, revisionScopes, snapshotRevision, snapshotWorktree } from "../scope-gate.js";
import { findScopeOverlap } from "../scope-overlap.ts";
import { crossCheck, validateBoundAssertionIds } from "../return-contract.js";
import { shouldExtractReturn } from "../return-extract.js";
import { normalizeAgentInput, safeAgentKey, safePathWithin, taskFingerprint } from "../helpers.ts";
import { MAX_AUTO_RESEARCH_QUESTIONS, MAX_AUTO_RESEARCH_ROUNDS } from "../research/runtime.ts";
import type { InputArtifactPreview } from "../context/assertions-artifacts.ts";
import type { DispatchAgentParams, SpawnResearchParams, ToolExecutionResult, ToolExecutor, ToolUpdate } from "./context.ts";
import { evaluateProcessObligations, processAllowsPersona, processPreEffectGate } from "../process-obligations.ts";
import { dispatchAccess, type DispatchAccess } from "../dispatch-access.ts";

type Gate = { reason: string; message: string } | null;
export type { DispatchExecutionState, DispatchExecutorDeps, WriterEntry } from "./dispatch-execution-types.ts";

export function preflightGate(d: DispatchExecutorDeps, persona: string): Gate {
	const s = d.state;
	const blocked = checkExternalBlockerGate({ blockers: s.getExternalBlockers(), acknowledged: s.getExternalBlockerAcknowledged(), askUserAvailable: s.isAskUserAvailable(), marker: s.getExternalBlockerMarker() });
	if (blocked) return blocked;
	const blockedProcess = s.processBlock?.();
	if (blockedProcess) return blockedProcess;
	const process = s.getProcessState?.();
	return process && processAllowsPersona(process, persona) ? null : checkTierPersonaGate(s.getTaskTier(), persona);
}

function refusalCategoryFor(status: string, reason?: string): "not_started" | "operator_cancelled" | "unknown_tool" {
	const values = [status, reason].filter((v): v is string => typeof v === "string").map(v => v.toLowerCase());
	if (values.some(v => v.includes("operator_cancel") || v === "cancelled" || v === "canceled")) return "operator_cancelled";
	if (values.some(v => v.includes("unknown_tool"))) return "unknown_tool";
	return "not_started";
}

/** T7: authoritative state snapshot rendered into refusals. Prompt prose never changes
 *  state; setter/result/gate share one snapshot (task/tier/source). Refusals show the
 *  actual tier/catalog/revision so the operator can correct against reality. */
function refusalSnapshot(d: DispatchExecutorDeps, ctx: ExtensionContext): string {
 try {
  const tier = (d.state as any)?.getTaskTier?.() ?? "unknown";
  const catalog = (d as any)?.getToolCatalogVersion?.() ?? "unknown";
  let revision = "unavailable";
  try { const cwd = ctx.cwd || process.cwd(); revision = revisionOf(cwd, revisionScopes(cwd, (d.state as any)?.getProcessState?.()?.changedFiles ?? [])); } catch {}
  return `Snapshot: tier "${tier}", catalog "${catalog}", revision "${revision}". Prompt prose did not change state.`;
 } catch { return "Snapshot unavailable."; }
}

/** Runtime-owned preflight refusal: never launched a process, never produced effects.
 *  Callers must not infer execution from exitCode alone; started:false is authoritative. */
function refusal(d: DispatchExecutorDeps, agent: string, task: string, status: string, message: string, reason?: string, scopeDiagnostic?: ScopeDiagnostic): ToolExecutionResult {
	d.state.getTurnReport().refusals++; d.state.getSessionTotals().refusals++;
	const recoveryCategory = refusalCategoryFor(status, reason);
	return { content: [{ type: "text", text: scopeDiagnostic ? `${message}\n${formatScopeDiagnostic(scopeDiagnostic)}` : message }], details: { agent, task, status, reason: reason ?? status, recoveryCategory, elapsed: 0, exitCode: 1, fullOutput: "", started: false, notStarted: true, effects: "none", ...(scopeDiagnostic ? { scopeDiagnostic } : {}) } };
}

const RESEARCH_DISPATCH_NAMES = new Set(["researcher", "deep-researcher"]);

function rosterNames(d: DispatchExecutorDeps): string[] {
	return Array.from(d.state.getAgentStates().values()).map(s => s.def.name);
}

function isResearchDispatchName(d: DispatchExecutorDeps, agent: string): boolean {
	if (RESEARCH_DISPATCH_NAMES.has(agent)) return true;
	return d.state.getResearchPersonas().some(p => normalizeAgentInput(p.name) === agent);
}

function unknownAgentMessage(agent: string, available: string[], researchHint: boolean): string {
	const roster = available.length ? available.join(", ") : "(none)";
	const research = researchHint
		? `\n\n"${agent}" is a research persona. Call spawn_research with persona "${agent}" instead of dispatch_agent. Do not invent a substitute dispatch.`
		: "";
	const processRole = !researchHint && ["planner", "code-reviewer", "plan-reviewer", "security-auditor"].includes(agent)
		? `Ask the human to install the ${agent} persona (agent-fleet setup, or /af-agents-add ${agent} when its file is present); once installed, dispatching it adds it to the team. This does not change the tier or budget. `
		: "";
	return `Unknown agent "${agent}". dispatch_agent accepts installed agents. Installed agents: ${roster}.${research}\n\nDo not invent a substitute dispatch. ${processRole}Use an installed agent, or spawn_research for a research persona.`;
}

export function validateDispatchAgent(d: DispatchExecutorDeps, agent: string, task: string, ctx?: ExtensionContext): ToolExecutionResult | null {
	const roster = rosterNames(d);
	let onRoster = d.state.getAgentStates().has(agent) || roster.some(name => normalizeAgentInput(name) === agent);
	const available = [...new Set([...roster, ...(d.state.getInstalledAgentNames?.() ?? [])])];
	if (isResearchDispatchName(d, agent)) {
		return refusal(d, agent, task, "research_persona_via_dispatch", unknownAgentMessage(agent, available, true), "research_persona_via_dispatch");
	}
	if (!onRoster) {
		// Every installed agent is dispatchable. The first dispatch adds it to the
		// active team, so backend policy and session reuse keep working per member.
		const added = d.state.addInstalledAgent?.(agent) ?? null;
		if (added?.ok) {
			onRoster = true;
			try { ctx?.ui?.notify?.(`dispatch_agent: ${added.message}`, "info"); } catch { /* observational only */ }
		}
	}
	if (!onRoster) {
		return refusal(d, agent, task, "unknown_agent", unknownAgentMessage(agent, available, false), "unknown_agent");
	}
	return null;
}

function dispatchRequirements(d: DispatchExecutorDeps, access: DispatchAccess, task: string): AcceptanceRequirement[] {
	if (!access.writable) return [];
	// validateBoundAssertionIds returns undefined only for an undefined input (legacy caller marker); the ledger map is always an array,
	// so `?? []` is a type narrowing with no runtime effect — an invalid ledger still throws, an empty ledger still yields an empty set.
	const ledgerIds = validateBoundAssertionIds(d.state.getAssertions().map(assertion => assertion.id)) ?? [];
 const ids = new Set(ledgerIds.filter(id => String(task).split(/[^A-Za-z0-9_-]+/).includes(id)));
	const ledger = d.state.getAssertions().filter(assertion => assertion.id === "AF-MIN-CHANGE" || ids.size === 0 || ids.has(assertion.id)).map(assertion => ({
		id: assertion.id, tag: assertion.tag, text: assertion.text, source: assertion.source,
		reference: assertion.reference, criticalConditions: assertion.criticalConditions, testCommand: assertion.testCommand, compilerCommand: assertion.compilerCommand,
		status: assertion.status as AcceptanceRequirement["status"], evidenceTaskId: assertion.evidenceTaskId,
		evidenceRevision: assertion.evidenceRevision, evidenceRefs: assertion.evidence ? [assertion.evidence] : [],
	}));
	const minimal = minimalChangeRequirement(), inherited = ledger.find(r => r.id === minimal.id);
 if (inherited) inherited.criticalConditions = [...new Set([...(inherited.criticalConditions ?? []), ...(minimal.criticalConditions ?? []), ...(inherited.text !== minimal.text ? [minimal.text] : [])])];
 return inherited ? ledger : [...ledger, minimal];
}

function appendRuntimeAcceptanceContract(task: string, requirements: AcceptanceRequirement[]): string {
	if (!requirements.length) return task;
	const lines = requirements.map(requirement => {
		const origin = [requirement.source, requirement.reference].filter(Boolean).join(" · ");
		const critical = requirement.criticalConditions?.length ? ` Critical: ${requirement.criticalConditions.join("; ")}.` : "";
		return `- ${requirement.id} [${requirement.tag}]: ${requirement.text} (source: ${origin}).${critical}${requirement.compilerCommand ? ` Explicit compiler command: ${JSON.stringify(requirement.compilerCommand)} (execute only through approved bash).` : ""}${requirement.testCommand ? ` Explicit verification command: ${JSON.stringify(requirement.testCommand)} (execute only through approved bash).` : ""}`;
	});
	return `${task}\n\n## Runtime acceptance contract (machine-appended)\nThese requirements survive dispatch and compaction. A claim, file presence, or listed command is not proof; report evidence, while the runtime decides acceptance. Run explicit commands unchanged, one bash call per command, sequentially with no overlapping tool calls. Do not append echo, pipe, redirect, or wrap them; runtime captures exit codes, and altered command strings cannot satisfy the declaration.\n${lines.join("\n")}`;
}

function needsComsWriter(d: DispatchExecutorDeps, agent: string, params: DispatchAgentParams): boolean {
	if (params.backend === "coms") return true;
	if (params.backend === "native" || params.parallel || (params.review_mode && params.review_mode !== "changes")) return false;
	return d.state.mayRouteToComs?.(agent) === true;
}

const SCOPE_GLOB = /[*?[\]{}!]/;

/**
 * Writes run one at a time unless every concurrent writer is OS-isolated to a
 * disjoint exact scope (PHILOSOPHY, 2026-11-11). Inspection has no writer slot.
 * An isolated writer with an empty scope cannot write to the repository.
 */
export function parallelWriterGate(d: DispatchExecutorDeps, agent: string, params: DispatchAgentParams, comsWriter = needsComsWriter(d, agent, params)): ToolExecutionResult | null {
	const s = d.state; const def = s.getAgentStates().get(agent)?.def;
	if (!def || (!dispatchAccess(def, params.review_mode).writable && !comsWriter)) return null;
	const parallel = params.parallel === true;
	const scope = (params.scope || []).map(String).map(entry => entry.trim()).filter(Boolean);
	if (parallel) {
		if (params.backend === "coms") return refusal(d, agent, params.task, "parallel_requires_native", "parallel: true needs the native OS write sandbox; a coms peer cannot be isolated. Use backend auto or native.");
		const glob = scope.find(entry => SCOPE_GLOB.test(entry));
		if (glob) return refusal(d, agent, params.task, "parallel_scope_invalid", `parallel: true needs exact existing files or directories as scope; globs cannot be enforced by the sandbox (${glob}).`);
		if (params.scope_mode === "create") return refusal(d, agent, params.task, "parallel_scope_invalid", "parallel: true needs existing scope paths; create new files inside an existing directory that is in scope.");
	}
	const active = s.getActiveWriters?.()
		?? Array.from({ length: s.getActiveWritableDispatches() }, () => ({ agent: "a writable dispatch", scope: [], isolated: false }));
	if (!active.length) return null;
	const names = active.map(writer => writer.agent).join(", ");
	if (!parallel) return refusal(d, agent, params.task, "writer_active", `${names} is running as a writable dispatch, so writes stay sequential; nothing started or charged. Wait for it to finish, or run writers together by dispatching each with parallel: true and disjoint exact scopes.`);
	const open = active.find(writer => !writer.isolated);
	if (open) return refusal(d, agent, params.task, "writer_active_unisolated", `${open.agent} is running without write isolation, so no other writer may start; nothing started or charged. Wait for it to finish.`);
	for (const writer of active) {
		const overlap = scope.length && writer.scope.length ? findScopeOverlap(scope, writer.scope) : null;
		if (overlap) return refusal(d, agent, params.task, "scope_overlap", `Scope overlaps ${writer.agent}'s running write scope (${overlap.left} ↔ ${overlap.right}); nothing started or charged. Give parallel writers disjoint scopes or wait.`);
	}
	return null;
}

export function prepareDispatch(d: DispatchExecutorDeps, params: DispatchAgentParams, ctx: ExtensionContext): PreparedDispatch | ToolExecutionResult {
	const s = d.state; const { task, artifacts, scope, review_reason } = params; const agent = normalizeAgentInput(params.agent);
 const privateMode = params.review_mode === 'private-config-current-state';
 const operatorMode = params.review_mode === 'operator-current-state';
 const runChecks = params.review_mode === "run-checks";
 if (!privateMode && (params.private_config_files !== undefined || params.verifier_sources !== undefined)) return refusal(d,agent,task,'private_config_preflight_failed','Private declarations require explicit private-config-current-state mode.');
 if (privateMode) {
  try {
   const tools = String(s.getAgentStates().get(agent)?.def.tools ?? '').split(',').map(t => t.trim());
   if (!['code-reviewer','security-auditor'].includes(agent) || params.backend !== 'native' || params.scope_mode === 'create' || scope?.length || params.deliverables?.length || artifacts?.length || !s.getProcessState || (s.getProcessState().changedFiles.length || s.getProcessState().workOrigin || s.getProcessState().acceptance.evidenceRef || s.getProcessState().review.evidenceRef || s.getProcessState().additions?.some(a => a.status === 'active' && a.reason !== 'irreversible_execution')) || tools.some(t => ['edit','write'].includes(t)) || !tools.includes('bash')) throw Error();
   const declarations = s.getAssertions();
   if (!declarations.some(r => r.id !== 'AF-MIN-CHANGE') || declarations.some(r => !['test','code-grep'].includes(r.tag) || !r.testCommand && !r.compilerCommand)) throw Error();
   capturePrivateConfig(ctx.cwd || process.cwd(), params.private_config_files, params.verifier_sources);
  } catch { return refusal(d,agent,task,'private_config_preflight_failed','Private verification requires exact safe configuration/helper declarations, explicit automated checks and an independent native read-only reviewer; no source obligations, artifacts or Git scope.'); }
 }
 if(operatorMode){try{operatorScopeSyntax(scope);}catch{return refusal(d,agent,task,'operator_state_preflight_failed','Current-state scope must contain 1–128 unique exact files; no aliases/globs.');}}
 if(operatorMode && (!['code-reviewer','security-auditor'].includes(agent)||params.backend!=='native'||params.scope_mode==='create'||params.deliverables?.length||!s.getProcessState))
  return refusal(d,agent,task,'operator_state_preflight_failed','Current-state verification requires a native code/security reviewer, existing exact files and no deliverables.');
	const rosterRefusal = validateDispatchAgent(d, agent, task, ctx);
	if (rosterRefusal) return rosterRefusal;
	const def = s.getAgentStates().get(agent)?.def;
	const access = { ...dispatchAccess(def ?? { tools: "" }, params.review_mode), comsWriter: needsComsWriter(d, agent, params) };
	if (runChecks && (!isReviewPersona(agent) || !access.tools.split(",").some(tool => tool.trim() === "bash") || params.backend === "coms")) {
		return refusal(d, agent, task, "review_checks_requires_native", "run-checks requires a native reviewer configured with bash.");
	}
	if (!access.writable && def?.readOnly && params.deliverables?.length) {
		return refusal(d, agent, task, "read_only_deliverables", "A read-only audit returns its report through submit_result. File deliverables require a separate writer.");
	}
	const writerRefusal = parallelWriterGate(d, agent, params, access.comsWriter);
	if (writerRefusal) return writerRefusal;
	if (s.getAgentStates().get(agent)?.status === "running") return { content: [{ type: "text", text: "Agent is busy; nothing started, queued or charged. Re-invoke explicitly after it is idle." }], details: { status: "busy", reason: "busy", recoveryCategory: "busy", started: false, exitCode: 1 } };
	d.budget.ensureTaskTier();
	const processGate = s.processBlock?.() ?? (s.getProcessState ? processPreEffectGate(s.getProcessState(), "child", agent) : { reason: "process_state_unavailable", message: "Process state is unavailable; child launch fails closed." });
	const preflight = preflightGate(d, agent) ?? processGate ?? (s.getProcessState && processAllowsPersona(s.getProcessState(), agent) ? null : checkDocsLane(agent, scope || [], review_reason));
	if (preflight) return refusal(d, agent, task, preflight.reason, `${preflight.message}\n\n${refusalSnapshot(d, ctx as any)}`, preflight.reason);
	let contract: DeliverableContract;
	try { contract = preflightDeliverables(params, { cwd: ctx.cwd || process.cwd(), sessionDir: s.getSessionDir() }); }
	catch (error) { return refusal(d, agent, task, "scope_preflight_failed", String(error)); }
	const takeSnapshot=()=>snapshotWorktree(ctx.cwd||process.cwd(),(scope||[]).map(String).map(x=>x.trim()).filter(Boolean));
 // The task revision basis (D8, 2026-11-12), read off the snapshot this dispatch takes
 // anyway: [] at a root repository, where every revision is the whole repository as
 // before; otherwise each nested repository holding a declared path or a registered
 // task file, whole.
 const basisPaths=[...(scope||[]).map(String).map(x=>x.trim()).filter(Boolean),...(s.getProcessState?.().changedFiles??[])];
 const basisFor=(snapshot:any):string[]=>snapshot?.nested?nestedRevisionScopes(ctx.cwd||process.cwd(),basisPaths):snapshot?.skipped&&basisPaths.length?revisionScopes(ctx.cwd||process.cwd(),basisPaths):[];
 const revisionFor=(snapshot:any,basis:string[])=>basis.length?revisionOf(ctx.cwd||process.cwd(),basis):snapshotRevision(snapshot);
 let operatorCandidate:OperatorStateCandidate|undefined,operatorSnapshot:any;
 if(operatorMode){
  try {
   const state=s.getAgentStates().get(agent),tools=String(state?.def.tools??'').split(',').map(t=>t.trim());
   if(!state||tools.some(t=>['edit','write'].includes(t)))throw Error('operator_state_writable_tools');
   if(!tools.includes('bash'))throw Error('operator_state_tests_unavailable');
   operatorSnapshot=takeSnapshot();
   operatorCandidate=captureOperatorState({scope,cwd:ctx.cwd||process.cwd(),snapshot:operatorSnapshot,revision:revisionFor(operatorSnapshot,basisFor(operatorSnapshot))});
   const registered = s.getProcessState!().changedFiles;
   const omitted = checkScope(registered, operatorCandidate.paths).outOfScope;
   if (omitted.length) {
    // Preserve the existing admission decision even if optional display history is unavailable.
    let prior: ReturnType<NonNullable<typeof s.getTaskDisplayScope>> | undefined;
    try { prior = s.getTaskDisplayScope?.(); } catch { /* no display provenance */ }
    const diagnostic = earlyOperatorScopeDiagnostic({ taskId: d.noProgress.taskId(), prior, registered, omitted, declared: operatorCandidate.paths });
    return refusal(d, agent, task, 'operator_state_preflight_failed', 'operator_state_incomplete_scope', undefined, diagnostic);
   }
  }catch(e){
   const code=e instanceof Error&&/^operator_state_[a-z_]+$/.test(e.message)?e.message:'operator_state_scope_unavailable';
   const diagnostic=e instanceof OperatorScopeObservationError ? e.diagnostic : code==='operator_state_scope_unavailable' ? unknownOperatorScope() : undefined;
   return refusal(d,agent,task,'operator_state_preflight_failed',code,undefined,diagnostic);
  }
 }
	// One pre-run snapshot is both the revision baseline and a writable run's delta base.
	const beforeSnapshot = operatorSnapshot ?? takeSnapshot();
	const revisionBasis = basisFor(beforeSnapshot);
	const beforeRevision = revisionFor(beforeSnapshot, revisionBasis);
	const reviewConditions = [review_reason ?? "", scope ?? [], params.review_mode ?? "changes", beforeRevision,
		s.getWriterGeneration?.(), s.getActiveWritableDispatches() > 0 || !!s.getActiveWriters?.().length];
	const fingerprint = taskFingerprint(agent, isReviewPersona(agent) ? `${task}\n${JSON.stringify(reviewConditions)}` : task);
	// A consumed continuation permit is the explicit, human-confirmed repeat of an
	// interrupted attempt (e.g. a watchdog stop this turn), not a model re-dispatch.
	if (s.getTurnDispatchFingerprints().has(fingerprint) && !d.noProgress.continuing?.()) return refusal(d, agent, task, "duplicate_refused", `⚠ Duplicate dispatch refused: you already dispatched ${agent} with this task (or a trivial rewording of it) THIS turn. Use the earlier result — re-read its digest/returnPath — or change the task materially (new instructions, corrected inputs) before re-dispatching.`);
	let inputArtifacts: InputArtifactPreview[];
	try { inputArtifacts = d.artifacts.loadInputArtifacts(artifacts, ctx); }
	catch (err: any) { return { content: [{ type: "text", text: `⚠ Dispatch NOT sent and NOT counted — input artifact could not be resolved:\n${err?.message || err}\n\nFix the path and dispatch again.` }], details: { agent, task, status: "artifact_preflight_failed", reason: "artifact_preflight_failed", recoveryCategory: "not_started" as const, elapsed: 0, exitCode: 1, fullOutput: "", started: false, notStarted: true, effects: "none" } }; }
	s.setTurnDispatchCount(s.getTurnDispatchCount() + 1); s.setTaskDispatchCount(s.getTaskDispatchCount() + 1);
	if (isReviewPersona(agent)) s.setTaskReviewRounds(s.getTaskReviewRounds() + 1);
	s.getSessionTotals().dispatches++; d.budget.updateModeStatus();
	const scopeGlobs = (scope || []).map(String).map(x => x.trim()).filter(Boolean);
	try { s.recordDelegation?.({ agent, kind: "specialist", task, scope: scopeGlobs }); } catch { /* the brief is a record, never a gate */ }
	const requirements = privateMode ? privateRequirements(s.getAssertions() as AcceptanceRequirement[]) : dispatchRequirements(d, access, operatorMode ? '' : task);
 const privateConfig: PrivateConfigBinding | undefined = privateMode ? {files: [...params.private_config_files!].sort(), sources: [...params.verifier_sources!].sort(), taskId: d.noProgress.taskId(), sessionDir: s.getSessionDir(), declarationHash: receiptDeclarationHash(requirements, scopeGlobs, s.getAcceptedUserInput?.(), inputArtifacts), captureId: '', generation: '', epoch: 0} : undefined;
	const acceptedTask = appendRuntimeAcceptanceContract(task, requirements) + (privateConfig ? '\n\n## Private configuration current-state review\nReview the declared verifier/helper sources for semantic adequacy and completeness of declared dependencies. Private bodies are NOT input artifacts: never attach, copy, quote or export them. Run each exact declared offline command through approved bash. No activation, notification runtime, sockets, grants, policy changes or journal replay. Return an explicit APPROVE/REJECT and full scoped regression evidence. This private proof cannot satisfy Git source obligations.\nVerifier/helper sources: ' + JSON.stringify(privateConfig.sources) : '') + (operatorCandidate ? '\n\n## Explicit operator-current-state verification\nInspect the exact current candidate; do not modify source or claim historical authorship. Run every explicit automated verification command through approved bash, and report full scoped regression evidence. Manual assertions remain unsupported by automation. Return an explicit APPROVE/REJECT; runtime verifies unchanged scope/revision and actual checks. This does not make your read-only task a changed-task success.' : '');
	const declaredTask = contract.files.length ? `${acceptedTask}\n\n## Expected deliverables (explicit contract)\nProduce these exact files and report their paths. The hub will read them back; a prose claim is not delivery.\n${contract.files.map(file => `- ${file.path}`).join("\n")}` : acceptedTask;
	const agentState = s.getAgentStates().get(agent.toLowerCase());
	const resumeContract = {
  declaredChecks: Object.freeze([...new Set(requirements.flatMap(r => [r.testCommand, r.compilerCommand].filter((c): c is string => !!c)))]),
  ...(privateConfig ? {privateConfig} : {}),
		taskId: d.noProgress.taskId(), instructions: declaredTask, scope: scopeGlobs,
  // No parent ledger is the supported legacy task-text contract, not a bound minimal-only contract.
  boundAssertionIds: s.getAssertions().length ? Object.freeze(validateBoundAssertionIds(requirements.map(requirement => requirement.id))) : undefined,
		deliverables: contract.files.map(file => file.path), artifacts: inputArtifacts.map(artifact => artifact.path),
		model: agentState ? (d.resolvedAgentModel?.(agentState.def, ctx) ?? agentState.def.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null)) : null,
		permissions: access.tools,
	};
 return { access, privateConfig, operatorCandidate, beforeSnapshot, reviewInput: !privateMode && s.getProcessState ? reviewInput(ctx.cwd || process.cwd(), d.noProgress.taskId(), agent, scopeGlobs, operatorReviewState(s.getProcessState(),operatorCandidate), s.getAssertions(), inputArtifacts, s.getAcceptedUserInput?.()) : null, taskToken: d.noProgress.taskToken(), taskId: resumeContract.taskId, beforeRevision, revisionScopes: revisionBasis, requirements, contract, resumeContract, sessionDir: s.getSessionDir(), agent, task: declaredTask, inputArtifacts, scopeGlobs, fingerprint, parallel: params.parallel === true };
}

function startTracking(d: DispatchExecutorDeps, prepared: PreparedDispatch, ctx: ExtensionContext): Tracking {
	const s = d.state; const canWrite = prepared.access.writable || prepared.access.comsWriter === true;
	const tracking: Tracking = { writable: canWrite, snapshot: null as any, overlapBaseline: s.getWritableOverlapCounter(), writerGeneration: s.getWriterGeneration?.(), concurrentAtStart: s.getActiveWritableDispatches() > 0 || !!s.getActiveWriters?.().length };
	if (canWrite) {
		tracking.concurrentAtStart = s.getActiveWritableDispatches() > 0;
		if (tracking.concurrentAtStart) s.setWritableOverlapCounter(s.getWritableOverlapCounter() + 1);
		s.setActiveWritableDispatches(s.getActiveWritableDispatches() + 1);
		// Registering an isolated writer is what makes its native launch sandboxed to its scope.
		tracking.release = s.beginWriter?.({ agent: prepared.agent, scope: prepared.scopeGlobs, isolated: prepared.parallel === true });
		tracking.writerGeneration = s.getWriterGeneration?.();
		if (prepared.parallel) tracking.isolatedScope = prepared.scopeGlobs;
		tracking.snapshot = prepared.beforeSnapshot ?? snapshotWorktree(ctx.cwd || process.cwd(), prepared.scopeGlobs);
	}
 try { anchorReceipts(); } catch (error) { tracking.release?.(); throw error; }
	return tracking;
 function anchorReceipts(): void {
 if (canWrite && s.getProcessState && s.setProcessState && s.persistProcessVerdict) {
  const processState = s.getProcessState();
  const started = beginReceiptCapture(processState.runtimeReceipts, { taskId: prepared.taskId, sessionDir: prepared.sessionDir, scope: prepared.scopeGlobs, declarationHash: receiptDeclarationHash(prepared.requirements, prepared.scopeGlobs, s.getAcceptedUserInput?.(), prepared.inputArtifacts) }, !tracking.concurrentAtStart);
  const next = { ...processState, runtimeReceipts: started.state };
  if (prepared.privateConfig) { delete next.privateVerification; next.privateVerificationRequired = true; }
  s.setProcessState(next);
  s.persistProcessVerdict(next, evaluateProcessObligations(next, { writable: true, currentRevision: scopes => revisionOf(ctx.cwd || process.cwd(), [...scopes]), budgetTier: s.getTaskTier() ?? "small" }));
  if (s.processBlock?.()) throw Error("Runtime receipt capture could not be persisted");
  tracking.receiptCapture = started.capture;
  if (prepared.privateConfig) {
   Object.assign(prepared.privateConfig, {captureId: started.capture.captureId, generation: started.capture.generation, epoch: started.capture.epoch});
   prepared.beforeRevision = privateConfigRevision(ctx.cwd || process.cwd(), prepared.beforeRevision, prepared.privateConfig);
   if (prepared.beforeRevision === 'unavailable') throw Error('Private capture unavailable');
  }
 }
 }
}

async function runWithAutoResearch(d: DispatchExecutorDeps, p: PreparedDispatch, params: DispatchAgentParams, ctx: ExtensionContext, onUpdate: ToolUpdate, signal?: AbortSignal): Promise<RunData> {
	const findingClause = reviewBudgetClause(d.state.getTaskTier(), p.agent); const dispatchedTask = findingClause ? `${p.task}\n\n${findingClause}` : p.task;
	let result = await d.dispatchAgent(p.agent, dispatchedTask, ctx, p.inputArtifacts, p.scopeGlobs, params.watchdog, params.backend ?? "auto", false, p.resumeContract, p.revisionScopes, p.access);
	let billed = result.billed ?? 0; let out = result.out ?? 0; const researchRounds: RunData["researchRounds"] = [];
	while (result.exitCode === 0 && !signal?.aborted && researchRounds.length < MAX_AUTO_RESEARCH_ROUNDS && p.taskToken === d.noProgress.taskToken() && p.sessionDir === d.state.getSessionDir()) {
		const questions = d.extractNeedsResearch(result.output).slice(0, MAX_AUTO_RESEARCH_QUESTIONS); if (!questions.length) break;
		d.state.setTaskResearchCount(d.state.getTaskResearchCount() + questions.length); d.budget.updateModeStatus();
		onUpdate?.({ content: [{ type: "text", text: `${p.agent} paused for research (${questions.length} question(s)) — spawning read-only helpers...` }], details: { agent: p.agent, task: p.task, status: "researching" } });
		const findingsDir = safePathWithin(p.sessionDir, "findings"); mkdirSync(findingsDir, { recursive: true }); const key = safeAgentKey(d.state.getAgentStates().get(p.agent.toLowerCase())?.def.name ?? p.agent);
		const answered = await Promise.all(questions.map(async question => {
			const def = d.research.anonymousDef(); const state = d.research.createState(def, false, d.research.resolveModel(def, undefined, ctx));
			const response = await d.research.spawn(state, question, ctx, [], signal); const file = safePathWithin(findingsDir, `${key}-${response.dispatchId ?? randomUUID()}.md`);
			writeFileSync(file, `# Research findings r${state.id}\n\n**Question:** ${question}\n\n${response.exitCode === 0 ? response.output : `(research helper failed, exit ${response.exitCode})\n\n${response.output}`}\n`, { encoding: "utf-8", flag: "wx" }); return { question, file };
		}));
		researchRounds.push({ questions, files: answered.map(a => a.file) });
		const resume = "Research findings for your NEEDS_RESEARCH questions are ready. Read each file with your read tool, then continue from where you paused:\n" + answered.map((a, i) => `${i + 1}. ${a.question}\n   → ${a.file}`).join("\n");
		if (signal?.aborted || p.taskToken !== d.noProgress.taskToken() || p.sessionDir !== d.state.getSessionDir()) break;
		result = await d.dispatchAgent(p.agent, resume, ctx, p.inputArtifacts, p.scopeGlobs, params.watchdog, params.backend ?? "auto", true, p.resumeContract, p.revisionScopes, p.access); billed += result.billed ?? 0; out += result.out ?? 0;
	}
	return { result, billed, out, researchRounds };
}

async function finishDispatch(d: DispatchExecutorDeps, p: PreparedDispatch, params: DispatchAgentParams, run: RunData, tracking: Tracking, ctx: ExtensionContext, onUpdate: ToolUpdate): Promise<ToolExecutionResult> {
	const s = d.state;
	const { result } = run;
	const cwd = ctx.cwd || process.cwd();
	const isSourceReview = !p.privateConfig && isReviewPersona(p.agent);
	const sameTaskNow = () => p.taskToken === d.noProgress.taskToken() && p.sessionDir === s.getSessionDir();
	const initial = beginDispatchEvidence(d, p, result, tracking, ctx, sameTaskNow);
	// Keep the extraction and compiler awaits here so the subsequent evidence
	// observes the task, revision and writer state at the original boundaries.
	const { returnPath, ids } = initial;
	if (returnPath && (!result.specialistResultTool || d.returnExtractionAssist?.() === true) && shouldExtractReturn(initial.parsedReturn, ids)) {
		onUpdate?.({ content: [{ type: "text", text: `${p.agent} returned no structured block — extracting it from the report...` }], details: { agent: p.agent, task: p.task, status: "extracting_return" } });
		const recovered = await d.runReturnExtraction(returnPath, ids, ctx);
		if (recovered) { initial.parsedReturn = recovered; initial.contractNotices = crossCheck(recovered, ids); initial.returnExtracted = true; }
	}
	const compiler = prepareDispatchCompiler(p, tracking, initial, cwd, isSourceReview, sameTaskNow);
	let { compilerDiagnostics } = compiler;
	const { observationToCheck } = compiler;
	if (observationToCheck) {
		try {
			compilerDiagnostics = await diagnoseObservation(d, observationToCheck, cwd, initial.key, result.dispatchId ?? randomUUID());
		} catch (error) {
			compilerDiagnostics = incompleteObservation(`compiler diagnostics failed safely: ${String(error)}`, observationToCheck.concurrentWritableOverlap);
		}
	}
	const evidence = completeDispatchEvidence(d, p, result, tracking, initial, compiler, compilerDiagnostics, cwd, isSourceReview, sameTaskNow);
	const receipts = collectDispatchReceipts(
		d, p, result, tracking, evidence, sameTaskNow, () => dispatchRequirements(d, p.access, p.operatorCandidate ? "" : params.task),
	);
	const decision = decideDispatch(d, p, result, tracking, evidence, receipts, cwd, sameTaskNow);
	recordDispatchRecoveryEvidence(d, p, result, evidence, receipts, decision, cwd);
	const outcome = summarizeDispatchOutcome(d, p, result, evidence, decision);
	const assessmentPath = retainDispatchAssessment(d, p, result, evidence, decision, outcome);
	const { sameTask } = evidence;
	const { status } = outcome;
	if (sameTask && [0, 124, 125].includes(result.exitCode)) s.getTurnDispatchFingerprints().add(p.fingerprint);
	if (sameTask) {
		s.getTurnReport().dispatches.push({ agent: p.agent, status, elapsed: result.elapsed, billed: run.billed, out: run.out });
		s.getSessionTotals().billed += run.billed;
		s.getSessionTotals().out += run.out;
	}
	const unresolved = d.extractNeedsResearch(result.output);
	const blockers = extractExternalBlockers(result.output);
	if (sameTask && blockers.length) {
		for (const what of blockers) if (!s.getExternalBlockers().some(b => b.what === what)) s.getExternalBlockers().push({ agent: p.agent, what });
		s.markExternalBlockersPending();
	}
	return renderDispatchResult(d, p, params, run, tracking, { evidence, receipts, decision, outcome, assessmentPath, unresolved, blockers });
}

function dispatchExecutionConditions(d: DispatchExecutorDeps, params: DispatchAgentParams, ctx: ExtensionContext): Record<string, unknown> {
	const state = d.state.getAgentStates().get(normalizeAgentInput(params.agent));
	return {
		model: (state ? d.resolvedAgentModel?.(state.def, ctx) : undefined) ?? state?.def.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null),
		backend: params.backend ?? "auto",
        externalBlockerAcknowledged: d.state.getExternalBlockerAcknowledged(),
	};
}

function researchExecutionConditions(d: DispatchExecutorDeps, params: SpawnResearchParams, ctx: ExtensionContext): Record<string, unknown> {
	const persona = params.persona ? d.state.getResearchPersonas().find(item => item.name.toLowerCase() === params.persona!.toLowerCase()) : undefined;
	try {
		const def = persona ?? d.research.anonymousDef();
		return { model: d.research.resolveModel(def, persona ? undefined : params.model, ctx), tools: "read,grep,find,ls", externalBlockerAcknowledged: d.state.getExternalBlockerAcknowledged() };
	} catch {
		return { model: params.model ?? null, tools: "read,grep,find,ls", externalBlockerAcknowledged: d.state.getExternalBlockerAcknowledged() };
	}
}

export function structuredResearchPrompt(params: SpawnResearchParams): string {
	const contract = normalizeResearchContract(params);
	if (!contract.readScope.length && !contract.goal && !contract.expectedResult) return params.task;
	return [params.task, "", "## Structured research contract",
		contract.readScope.length ? `Read scope:\n${contract.readScope.map(path => `- ${path}`).join("\n")}` : "Read scope: not declared",
		contract.goal ? `Goal: ${contract.goal}` : "Goal: not declared",
		contract.expectedResult ? `Expected result: ${contract.expectedResult}` : "Expected result: not declared",
	].join("\n");
}

/**
 * A persona runs one dispatch at a time (one session, one executor). A second
 * `parallel: true` dispatch to a persona that is already writing gets its own
 * instance (builder--p2, builder--p3, ...) with a separate session and executor.
 * Claims are counted synchronously, so concurrent tool calls cannot pick the same
 * instance and a refused duplicate cannot free another call's claim. Nothing else
 * changes: the parallel writer gate still decides whether each one may run.
 */
export function routeParallelInstance(d: DispatchExecutorDeps, params: DispatchAgentParams, reserved: Map<string, number>): { params: DispatchAgentParams; release: () => void } {
	const base = normalizeAgentInput(params.agent);
	const busy = (name: string) => (reserved.get(name) ?? 0) > 0 || d.state.getAgentStates().get(name)?.status === "running"
		|| (d.state.getActiveWriters?.() ?? []).some(writer => writer.agent.toLowerCase() === name);
	let agent = base;
	if (params.parallel === true && busy(base) && d.state.addAgentInstance) {
		for (let n = 2; n <= 16; n++) {
			const candidate = parallelInstanceName(base, n);
			if (busy(candidate)) continue;
			try { if (d.state.addAgentInstance(base, candidate)) agent = candidate; } catch { /* stay on the base; the gate explains */ }
			break;
		}
	}
	reserved.set(agent, (reserved.get(agent) ?? 0) + 1);
	let released = false;
	return { params: agent === base ? params : { ...params, agent }, release: () => {
		if (released) return;
		released = true;
		const left = (reserved.get(agent) ?? 1) - 1;
		if (left > 0) reserved.set(agent, left); else reserved.delete(agent);
	} };
}

export function createDispatchExecutor(d: DispatchExecutorDeps): ToolExecutor<DispatchAgentParams> {
	const reserved = new Map<string, number>();
	const guarded = createGuardedDispatchExecutor(d);
	return async (id, params, signal, onUpdate, ctx) => {
		const routed = routeParallelInstance(d, params, reserved);
		try { return await guarded(id, routed.params, signal, onUpdate, ctx); }
		finally { routed.release(); }
	};
}

function createGuardedDispatchExecutor(d: DispatchExecutorDeps): ToolExecutor<DispatchAgentParams> {
	return withNoProgress(d, "dispatch", async (_id, params, signal, onUpdate, ctx) => {
		const capability = d.provisionalCapabilityRefusal("fleet"); if (capability) return capability;
		const agent = normalizeAgentInput(params.agent);
		const invalid = validateDispatchAgent(d, agent, params.task, ctx); if (invalid) return invalid;
		if (d.state.getAgentStates().get(agent)?.status === "running") return { content: [{ type: "text", text: "Agent is busy; nothing started, queued or charged. Re-invoke explicitly after it is idle." }], details: { status: "busy", reason: "busy", recoveryCategory: "busy", started: false, exitCode: 1 } };
		d.budget.ensureTaskTier();
		const processGate = d.state.processBlock?.() ?? (d.state.getProcessState ? processPreEffectGate(d.state.getProcessState(), "child", agent) : { reason: "process_state_unavailable", message: "Process state is unavailable; child launch fails closed." });
		const preflight = preflightGate(d, agent) ?? processGate ?? (d.state.getProcessState && processAllowsPersona(d.state.getProcessState(), agent) ? null : checkDocsLane(agent, params.scope || [], params.review_reason));
		if (preflight) return refusal(d, agent, params.task, preflight.reason, `${preflight.message}\n\n${refusalSnapshot(d, ctx)}`);
		try { preflightDeliverables(params, { cwd: ctx.cwd || process.cwd(), sessionDir: d.state.getSessionDir() }); }
		catch (error) { return refusal(d, agent, params.task, "scope_preflight_failed", String(error)); }
		if (signal?.aborted) return refusal(d, agent, params.task, "cancelled", "Operation cancelled before dispatch.");
        if (isReviewPersona(agent) && (!params.review_mode || params.review_mode === "changes") && !needsComsWriter(d, agent, params) && !params.review_reason && !params.deliverables?.length && !/(?:USER|ORCHESTRATOR)_ANSWER:/.test(params.task) && !d.state.getActiveWritableDispatches() && !d.state.getActiveWriters?.().length && d.state.getProcessState) {
            const state=d.state.getProcessState();
            let cached=null;
            try { cached=reusableReview(state,reviewInput(ctx.cwd,d.noProgress.taskId(),agent,params.scope??[],state,d.state.getAssertions(),d.artifacts.loadInputArtifacts(params.artifacts,ctx),d.state.getAcceptedUserInput?.()),ctx.cwd); } catch { /* incomplete evidence must run the normal path */ }
            if(cached){
                const verdict=evaluateProcessObligations(state,{writable:true,budgetTier:d.state.getTaskTier()??"small",currentRevision:(scopes:readonly string[])=>revisionOf(ctx.cwd,[...scopes])});
                d.state.persistProcessVerdict?.(state,verdict);
                if(d.state.processBlock?.())return refusal(d,agent,params.task,"process_state_corrupt","Review reuse could not persist current evidence.");
                return {content:[{type:"text",text:`Independent ${agent} review already covers this unchanged scope and requirements. Reused evidence: ${cached.evidenceRef}. No child launched. New review focus requires review_reason.`}],details:{status:"review_reused",reused:true,started:false,notStarted:true,exitCode:0,elapsed:0,returnPath:cached.evidenceRef,processVerdict:verdict,accepted:verdict.accepted}};
            }
        }
        if(params.review_mode !== 'private-config-current-state' && isReviewPersona(agent) && d.state.getProcessState){
            const state=d.state.getProcessState();
            if(state.review.evidenceRef){
                const next={...state,review:{...state.review,evidenceRef:null,revision:null},reviews:(state.reviews??[]).filter(r=>r.agent!==agent)};
                d.state.setProcessState?.(next);d.state.persistProcessVerdict?.(next,evaluateProcessObligations(next,{writable:true,currentRevision:scopes=>revisionOf(ctx.cwd || process.cwd(),[...scopes]),budgetTier:d.state.getTaskTier()??"small"}));
                if(d.state.processBlock?.())return refusal(d,agent,params.task,"process_state_corrupt","Fresh review invalidation could not be persisted.");
            }
        }
		const prepared = prepareDispatch(d, params, ctx); if (!("agent" in prepared)) return prepared;
        if (!prepared.privateConfig && isReviewPersona(agent) && d.state.getProcessState) {
            const state=d.state.getProcessState();
            prepared.reviewBaseline=captureReviewBaseline(ctx.cwd,prepared.reviewInput??null,state);
            const continuation=reviewContinuation(state,prepared.reviewInput??null,prepared.reviewBaseline,ctx.cwd,!!params.review_reason);
            prepared.task+=continuation;
            if(continuation)prepared.task+="\nRecorded verification evidence (check its revision and applicability; not automatic proof of a fix): "+JSON.stringify(state.acceptance);
            prepared.resumeContract.instructions=prepared.task;
        }
        let tracking: Tracking;
        try { tracking = startTracking(d, prepared, ctx); }
        catch { d.state.setActiveWritableDispatches(Math.max(0, d.state.getActiveWritableDispatches() - 1)); return refusal(d, agent, params.task, "receipt_capture_failed", "Runtime receipt capture could not be durably anchored; no child launched."); }
		// Esc aborts the tool call; without this the child kept running and the hub stayed "streaming" until it finished on its own.
		const stopOnAbort = () => { try { d.cancelRunningDispatch?.(prepared.agent); } catch { /* the run still settles through its own path */ } };
		signal?.addEventListener("abort", stopOnAbort, { once: true });
		try { onUpdate?.({ content: [{ type: "text", text: `Dispatching to ${prepared.agent}...` }], details: { agent: prepared.agent, task: prepared.task, status: "dispatching" } }); return await finishDispatch(d, prepared, params, await runWithAutoResearch(d, prepared, params, ctx, onUpdate, signal), tracking, ctx, onUpdate); }
		catch (err: any) { return { content: [{ type: "text", text: `Error dispatching to ${prepared.agent}: ${err?.message || err}` }], details: { agent: prepared.agent, task: prepared.task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" } }; }
		finally { signal?.removeEventListener("abort", stopOnAbort); tracking.release?.(); if (tracking.writable) d.state.setActiveWritableDispatches(Math.max(0, d.state.getActiveWritableDispatches() - 1)); }
	}, (params, ctx) => dispatchExecutionConditions(d, params, ctx));
}

export function createResearchExecutor(d: DispatchExecutorDeps): ToolExecutor<SpawnResearchParams> {
	return withNoProgress(d, "research", researchExecution(d), (params, ctx) => researchExecutionConditions(d, params, ctx));
}

/** Recovery analysis is read-only and each run is an explicit operator request bounded by the
 * coordinator. It must not inherit the research no-progress fence: a crashed analysis would
 * otherwise permanently refuse every later re-analysis of the same interrupted task. */
export function createRecoveryResearchExecutor(d: DispatchExecutorDeps): ToolExecutor<SpawnResearchParams> {
	const execute = researchExecution(d);
	return async (id, params, signal, onUpdate, ctx) => {
		try { normalizeResearchContract(params); }
		catch (error) { return { content: [{ type: "text", text: String(error) }], details: { status: "invalid_input", reason: "invalid_read_scope", recoveryCategory: "invalid_input", started: false, exitCode: 1 } }; }
		return execute(id, params, signal, onUpdate, ctx);
	};
}

function researchExecution(d: DispatchExecutorDeps): ToolExecutor<SpawnResearchParams> {
	return async (_id, params, signal, onUpdate, ctx) => {
		const capability = d.provisionalCapabilityRefusal("fleet"); if (capability) return capability; const s = d.state; d.budget.ensureTaskTier();
		const preflight = preflightGate(d, params.persona || ""); if (preflight) return refusal(d, "", params.task, preflight.reason, `${preflight.message}\n\n${refusalSnapshot(d, ctx)}`, preflight.reason);
		if (signal?.aborted) return refusal(d, "", params.task, "cancelled", "Operation cancelled before research.");
		let def: any; let persona = false;
		if (params.persona) { def = s.getResearchPersonas().find(x => x.name.toLowerCase() === params.persona!.toLowerCase()); if (!def) return { content: [{ type: "text", text: `No research persona "${params.persona}". Available: ${s.getResearchPersonas().map(x => x.name).join(", ") || "(none defined)"}. Omit \`persona\` for an ad-hoc helper. (Nothing started or counted.)` }], details: { status: "not_started", reason: "unknown_agent", recoveryCategory: "not_started" as const, started: false, notStarted: true, effects: "none", exitCode: 1 } }; persona = true; } else def = d.research.anonymousDef();
		const model = d.research.resolveModel(def, persona ? undefined : params.model, ctx); let artifacts: InputArtifactPreview[];
		try { artifacts = d.artifacts.loadInputArtifacts(params.artifacts, ctx); } catch (err: any) { return { content: [{ type: "text", text: `⚠ Research NOT spawned and NOT counted — input artifact could not be resolved:\n${err?.message || err}\n\nFix the path and try again.` }], details: { status: "artifact_preflight_failed", reason: "artifact_preflight_failed", recoveryCategory: "not_started" as const, started: false, notStarted: true, effects: "none", exitCode: 1 } }; }
		s.setTurnResearchCount(s.getTurnResearchCount() + 1); s.setTaskResearchCount(s.getTaskResearchCount() + 1); s.getTurnReport().research++; s.getSessionTotals().research++; d.budget.updateModeStatus();
		const taskToken=d.noProgress.taskToken(),sessionDir=s.getSessionDir();
  const admit=()=>taskToken===d.noProgress.taskToken()&&sessionDir===s.getSessionDir()&&!signal?.aborted&&!d.provisionalCapabilityRefusal('fleet')&&!preflightGate(d,params.persona||'');
  const state = d.research.createState(def, persona, model);
  try { s.recordDelegation?.({ agent: persona ? def.name : "research", kind: "research", task: params.task, scope: params.read_scope ?? [], researchId: state.id }); } catch { /* the brief is a record, never a gate */ }
  onUpdate?.({ content: [{ type: "text", text: `Spawning research helper r${state.id}...` }], details: { handle: `r${state.id}`, persona: persona ? def.name : null, status: "spawning" } });
		try { const result = await d.research.spawn(state, structuredResearchPrompt(params), ctx, artifacts, signal, {readScope:normalizeResearchContract(params).readScope,admit}); const status = result.termination ? result.termination.reason : result.exitCode === 0 ? "done" : "error"; const output = result.output.length > 8000 ? `${result.output.slice(0, 8000)}\n\n... [truncated]` : result.output; return { content: [{ type: "text", text: `[research r${state.id} · ${persona ? d.displayName(def.name) : "ad-hoc"} · read-only] ${status} in ${Math.round(result.elapsed / 1000)}s\n\n${output}${result.evidencePath ? `\n\nFull execution evidence: ${result.evidencePath}` : ""}` }], details: { handle: `r${state.id}`, persona: persona ? def.name : null, model, status, elapsed: result.elapsed, exitCode: result.exitCode, fullOutput: result.output, dispatchId: result.dispatchId, evidencePath: result.evidencePath, transcriptPath: result.transcriptPath, termination: result.termination, lifecycle: (result as any).lifecycle ?? null, researchContract: normalizeResearchContract(params), artifacts: artifacts.map(a => ({ path: a.path, displayPath: a.displayPath, preview: a.preview, resolvedFromKind: a.resolvedFromKind ?? null })) } }; }
		catch (err: any) { return { content: [{ type: "text", text: `Error spawning research helper: ${err?.message || err}` }], details: { handle: `r${state.id}`, model, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" } }; }
	};
}
