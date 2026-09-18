import { retainDeliverable } from "../execution-evidence.ts";
import { buildRuntimeResult, minimalChangeRequirement, preflightDeliverables, readBackDeliverables, type AcceptanceRequirement, type DeliverableContract, type VerificationCheckInput } from "../acceptance.ts";
import { normalizeResearchContract, withNoProgress, type NoProgressGuard } from "../no-progress.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { blockingFindingCap, checkReviewRoundCap, checkTaskBudget, checkTierPersonaGate, checkTurnBudget, isReviewPersona, remainingTaskResearch, reviewBudgetClause, reviewRoundCap } from "../run-budget.js";
import { countReviewFindings, findingBudgetNotice } from "../review-findings.js";
import { checkDocsLane, docsLaneNotice } from "../docs-lane.js";
import { checkExternalBlockerGate, extractExternalBlockers } from "../external-blocker.js";
import type { BudgetRecovery } from "../budget-recovery.ts";
import { checkScope, diffAgainst, snapshotWorktree, worktreeRevision } from "../scope-gate.js";
import { diagnoseChangedTypeScript, formatAdvisory, type DiagnosticsResult } from "../../lib/changed-file-diagnostics.ts";
import { correctStructuredReturnForCompiler, crossCheck, deliveryDisposition, extractAssertionIds, parseDeliveredReturn } from "../return-contract.js";
import { shouldExtractReturn } from "../return-extract.js";
import { normalizeAgentInput, safeAgentKey, safePathWithin, taskFingerprint } from "../helpers.ts";
import { MAX_AUTO_RESEARCH_QUESTIONS, MAX_AUTO_RESEARCH_ROUNDS, type ResearchAgentDef, type ResearchRuntime } from "../research/runtime.ts";
import type { BudgetContext, SessionTotals, TurnReport } from "../context/budgets.ts";
import type { AssertionsArtifactsContext, InputArtifactPreview } from "../context/assertions-artifacts.ts";
import type { DispatchAgentParams, SpawnResearchParams, ToolExecutionResult, ToolExecutor, ToolUpdate } from "./context.ts";
import type { AgentState } from "../types.ts";
import { diagnoseToolProtocol, type ToolProtocolDiagnostic } from "../tool-protocol.ts";
import type { TaskResumeInput } from "../task-resume-contract.ts";

type Gate = { reason: string; message: string } | null;
type DispatchResult = import("../dispatch-native-types.ts").NativeDispatchResult;

export interface DispatchExecutionState {
	getTurnDispatchCount(): number; setTurnDispatchCount(value: number): void;
	getTurnResearchCount(): number; setTurnResearchCount(value: number): void;
	getTaskDispatchCount(): number; setTaskDispatchCount(value: number): void;
	getTaskResearchCount(): number; setTaskResearchCount(value: number): void;
	getTaskReviewRounds(): number; setTaskReviewRounds(value: number): void;
	getTaskTier(): string | null;
	getTurnReport(): TurnReport;
	getSessionTotals(): SessionTotals;
	getTurnDispatchFingerprints(): Set<string>;
	getExternalBlockers(): Array<{ agent: string; what: string }>;
	getExternalBlockerAcknowledged(): boolean; setExternalBlockerAcknowledged(value: boolean): void;
	getExternalBlockerRefusedOnce(): boolean; setExternalBlockerRefusedOnce(value: boolean): void;
	isAskUserAvailable(): boolean;
	getUserLanguage(): string;
	getSessionDir(): string;
	getAgentStates(): Map<string, AgentState>;
	getAssertions(): Array<{ id: string; tag: string; text: string; source: string; reference?: string; criticalConditions?: string[]; testCommand?: string; status: string; evidence?: string; evidenceTaskId?: string; evidenceRevision?: string }>;
	getResearchPersonas(): ResearchAgentDef[];
	getActiveWritableDispatches(): number; setActiveWritableDispatches(value: number): void;
	getWritableOverlapCounter(): number; setWritableOverlapCounter(value: number): void;
}

export interface DispatchExecutorDeps {
	noProgress: NoProgressGuard;
	state: DispatchExecutionState;
	budget: BudgetContext;
	budgetRecovery: BudgetRecovery;
	artifacts: AssertionsArtifactsContext;
	research: ResearchRuntime<any>;
	provisionalCapabilityRefusal(pack: "fleet"): ToolExecutionResult | null;
	dispatchAgent(agent: string, task: string, ctx: ExtensionContext, artifacts: InputArtifactPreview[], scope: string[], watchdog?: boolean, backend?: "auto" | "native" | "coms", resume?: boolean, resumeContract?: Omit<TaskResumeInput, "previous">): Promise<DispatchResult>;
	runReturnExtraction(path: string, ids: string[], ctx: ExtensionContext): Promise<any>;
	extractNeedsResearch(output: string): string[];
	extractAskUserQuestions(output: string): string[];
	contextPressure(percent: number): boolean;
	displayName(name: string): string;
	getToolCatalogVersion?(): string;
	resolvedAgentModel?(def: AgentState["def"], ctx: ExtensionContext): string | undefined;
	diagnoseChangedTypeScript?: typeof diagnoseChangedTypeScript;
}

interface PreparedDispatch { taskToken: object; taskId: string; beforeRevision: string; requirements: AcceptanceRequirement[]; contract: DeliverableContract; resumeContract: Omit<TaskResumeInput, "previous">; sessionDir: string; agent: string; task: string; inputArtifacts: InputArtifactPreview[]; scopeGlobs: string[]; fingerprint: string; }
interface RunData { result: DispatchResult; billed: number; out: number; researchRounds: { questions: string[]; files: string[] }[]; autoResearchTaskCapped: boolean; }
interface Tracking { writable: boolean; snapshot: any; overlapBaseline: number; concurrentAtStart: boolean; }
interface WorktreeObservation { skipped: boolean; reason?: string; paths: string[]; concurrentWritableOverlap: boolean; }

export function preflightGate(d: DispatchExecutorDeps, persona: string): Gate {
	const s = d.state;
	const blocked = checkExternalBlockerGate({ blockers: s.getExternalBlockers(), acknowledged: s.getExternalBlockerAcknowledged(), askUserAvailable: s.isAskUserAvailable(), refusedOnce: s.getExternalBlockerRefusedOnce() });
	if (blocked) { s.setExternalBlockerRefusedOnce(true); return blocked; }
	return checkTierPersonaGate(s.getTaskTier(), persona);
}

function refusal(d: DispatchExecutorDeps, agent: string, task: string, status: string, message: string, reason?: string): ToolExecutionResult {
	d.state.getTurnReport().refusals++; d.state.getSessionTotals().refusals++;
	return { content: [{ type: "text", text: message }], details: { agent, task, status, reason: reason ?? status, elapsed: 0, exitCode: 1, fullOutput: "" } };
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
	return `Unknown agent "${agent}". dispatch_agent only accepts the active roster. Available agents: ${roster}.${research}\n\nDo not invent a substitute dispatch. Use an available agent, or spawn_research for a research persona.`;
}

export function validateDispatchAgent(d: DispatchExecutorDeps, agent: string, task: string): ToolExecutionResult | null {
	const available = rosterNames(d);
	const onRoster = d.state.getAgentStates().has(agent) || available.some(name => normalizeAgentInput(name) === agent);
	if (isResearchDispatchName(d, agent)) {
		return refusal(d, agent, task, "research_persona_via_dispatch", unknownAgentMessage(agent, available, true), "research_persona_via_dispatch");
	}
	if (!onRoster) {
		return refusal(d, agent, task, "unknown_agent", unknownAgentMessage(agent, available, false), "unknown_agent");
	}
	return null;
}

function dispatchRequirements(d: DispatchExecutorDeps, agent: string, task: string): AcceptanceRequirement[] {
	const state = d.state.getAgentStates().get(agent.toLowerCase());
	if (!state || !hasWriteCapability(state.def.tools)) return [];
	const ids = new Set(extractAssertionIds(task));
	const ledger = d.state.getAssertions().filter(assertion => ids.size === 0 || ids.has(assertion.id)).map(assertion => ({
		id: assertion.id, tag: assertion.tag, text: assertion.text, source: assertion.source,
		reference: assertion.reference, criticalConditions: assertion.criticalConditions, testCommand: assertion.testCommand,
		status: assertion.status as AcceptanceRequirement["status"], evidenceTaskId: assertion.evidenceTaskId,
		evidenceRevision: assertion.evidenceRevision, evidenceRefs: assertion.evidence ? [assertion.evidence] : [],
	}));
	return [...ledger, minimalChangeRequirement()];
}

function appendRuntimeAcceptanceContract(task: string, requirements: AcceptanceRequirement[]): string {
	if (!requirements.length) return task;
	const lines = requirements.map(requirement => {
		const origin = [requirement.source, requirement.reference].filter(Boolean).join(" · ");
		const critical = requirement.criticalConditions?.length ? ` Critical: ${requirement.criticalConditions.join("; ")}.` : "";
		return `- ${requirement.id} [${requirement.tag}]: ${requirement.text} (source: ${origin}).${critical}${requirement.testCommand ? ` Explicit verification command: ${JSON.stringify(requirement.testCommand)} (execute only through approved bash).` : ""}`;
	});
	return `${task}\n\n## Runtime acceptance contract (machine-appended)\nThese requirements survive dispatch and compaction. A claim, file presence, or listed command is not proof; report evidence, while the runtime decides acceptance.\n${lines.join("\n")}`;
}

export function prepareDispatch(d: DispatchExecutorDeps, params: DispatchAgentParams, ctx: ExtensionContext): PreparedDispatch | ToolExecutionResult {
	const s = d.state; const { task, artifacts, scope, review_reason } = params; const agent = normalizeAgentInput(params.agent);
	const rosterRefusal = validateDispatchAgent(d, agent, task);
	if (rosterRefusal) return rosterRefusal;
	if (s.getAgentStates().get(agent)?.status === "running") return { content: [{ type: "text", text: "Agent is busy; nothing started, queued or charged. Re-invoke explicitly after it is idle." }], details: { status: "busy", reason: "busy", recoveryCategory: "busy", started: false, exitCode: 1 } };
	d.budget.ensureTaskTier();
	const preflight = preflightGate(d, agent) ?? checkReviewRoundCap(s.getTaskTier(), agent, s.getTaskReviewRounds()) ?? checkDocsLane(agent, scope || [], review_reason);
	if (preflight) return refusal(d, agent, task, preflight.reason, preflight.message, preflight.reason);
	const taskRefusal = checkTaskBudget("dispatch", d.budget.taskCounters(), d.budget.currentTaskBudget(), d.budget.taskActiveElapsedMs(), s.getTaskTier());
	if (taskRefusal) return refusal(d, agent, task, "task_budget_refused", taskRefusal.message, taskRefusal.reason);
	const turnRefusal = checkTurnBudget("dispatch", { dispatches: s.getTurnDispatchCount(), research: s.getTurnResearchCount() }, d.budget.currentBudget(), d.budget.turnBudgetActiveElapsedMs(), s.getTaskTier());
	if (turnRefusal) return refusal(d, agent, task, "budget_refused", turnRefusal.message, turnRefusal.reason);
	let contract: DeliverableContract;
	try { contract = preflightDeliverables(params, { cwd: ctx.cwd || process.cwd(), sessionDir: s.getSessionDir() }); }
	catch (error) { return refusal(d, agent, task, "scope_preflight_failed", String(error)); }
	const fingerprint = taskFingerprint(agent, task);
	if (s.getTurnDispatchFingerprints().has(fingerprint)) return refusal(d, agent, task, "duplicate_refused", `⚠ Duplicate dispatch refused: you already dispatched ${agent} with this task (or a trivial rewording of it) THIS turn. Use the earlier result — re-read its digest/returnPath — or change the task materially (new instructions, corrected inputs) before re-dispatching.`);
	let inputArtifacts: InputArtifactPreview[];
	try { inputArtifacts = d.artifacts.loadInputArtifacts(artifacts, ctx); }
	catch (err: any) { return { content: [{ type: "text", text: `⚠ Dispatch NOT sent and NOT counted against the turn budget — input artifact could not be resolved:\n${err?.message || err}\n\nFix the path and dispatch again.` }], details: { agent, task, status: "artifact_preflight_failed", elapsed: 0, exitCode: 1, fullOutput: "" } }; }
	s.setTurnDispatchCount(s.getTurnDispatchCount() + 1); s.setTaskDispatchCount(s.getTaskDispatchCount() + 1);
	if (isReviewPersona(agent)) s.setTaskReviewRounds(s.getTaskReviewRounds() + 1);
	s.getSessionTotals().dispatches++; d.budget.updateModeStatus();
	const scopeGlobs = (scope || []).map(String).map(x => x.trim()).filter(Boolean);
	const requirements = dispatchRequirements(d, agent, task);
	const acceptedTask = appendRuntimeAcceptanceContract(task, requirements);
	const declaredTask = contract.files.length ? `${acceptedTask}\n\n## Expected deliverables (explicit contract)\nProduce these exact files and report their paths. The hub will read them back; a prose claim is not delivery.\n${contract.files.map(file => `- ${file.path}`).join("\n")}` : acceptedTask;
	const agentState = s.getAgentStates().get(agent.toLowerCase());
	const resumeContract = {
		taskId: d.noProgress.taskId(), instructions: declaredTask, scope: scopeGlobs,
		deliverables: contract.files.map(file => file.path), artifacts: inputArtifacts.map(artifact => artifact.path),
		model: agentState ? (d.resolvedAgentModel?.(agentState.def, ctx) ?? agentState.def.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null)) : null,
		permissions: agentState?.def.tools ?? "",
	};
	return { taskToken: d.noProgress.taskToken(), taskId: resumeContract.taskId, beforeRevision: worktreeRevision(ctx.cwd || process.cwd(), []), requirements, contract, resumeContract, sessionDir: s.getSessionDir(), agent, task: declaredTask, inputArtifacts, scopeGlobs, fingerprint };
}

function startTracking(d: DispatchExecutorDeps, prepared: PreparedDispatch, ctx: ExtensionContext): Tracking {
	const s = d.state; const state = s.getAgentStates().get(prepared.agent.toLowerCase()); const canWrite = !!state && hasWriteCapability(state.def.tools);
	const tracking = { writable: canWrite, snapshot: null as any, overlapBaseline: s.getWritableOverlapCounter(), concurrentAtStart: false };
	if (canWrite) {
		tracking.concurrentAtStart = s.getActiveWritableDispatches() > 0;
		if (tracking.concurrentAtStart) s.setWritableOverlapCounter(s.getWritableOverlapCounter() + 1);
		s.setActiveWritableDispatches(s.getActiveWritableDispatches() + 1);
		tracking.snapshot = snapshotWorktree(ctx.cwd || process.cwd());
	}
	return tracking;
}

async function runWithAutoResearch(d: DispatchExecutorDeps, p: PreparedDispatch, params: DispatchAgentParams, ctx: ExtensionContext, onUpdate: ToolUpdate): Promise<RunData> {
	const findingClause = reviewBudgetClause(d.state.getTaskTier(), p.agent); const dispatchedTask = findingClause ? `${p.task}\n\n${findingClause}` : p.task;
	let result = await d.dispatchAgent(p.agent, dispatchedTask, ctx, p.inputArtifacts, p.scopeGlobs, params.watchdog, params.backend ?? "auto", false, p.resumeContract);
	let billed = result.billed ?? 0; let out = result.out ?? 0; const researchRounds: RunData["researchRounds"] = []; let autoResearchTaskCapped = false;
	while (result.exitCode === 0 && researchRounds.length < MAX_AUTO_RESEARCH_ROUNDS && p.taskToken === d.noProgress.taskToken() && p.sessionDir === d.state.getSessionDir()) {
		const left = remainingTaskResearch(d.budget.currentTaskBudget(), d.budget.taskCounters()); if (left === 0) { autoResearchTaskCapped = true; break; }
		const questions = d.extractNeedsResearch(result.output).slice(0, left == null ? MAX_AUTO_RESEARCH_QUESTIONS : Math.min(MAX_AUTO_RESEARCH_QUESTIONS, left)); if (!questions.length) break;
		d.state.setTaskResearchCount(d.state.getTaskResearchCount() + questions.length); d.budget.updateModeStatus();
		onUpdate?.({ content: [{ type: "text", text: `${p.agent} paused for research (${questions.length} question(s)) — spawning read-only helpers...` }], details: { agent: p.agent, task: p.task, status: "researching" } });
		const findingsDir = safePathWithin(p.sessionDir, "findings"); mkdirSync(findingsDir, { recursive: true }); const key = safeAgentKey(d.state.getAgentStates().get(p.agent.toLowerCase())?.def.name ?? p.agent);
		const answered = await Promise.all(questions.map(async question => {
			const def = d.research.anonymousDef(); const state = d.research.createState(def, false, d.research.resolveModel(def, undefined, ctx));
			const response = await d.research.spawn(state, question, ctx); const file = safePathWithin(findingsDir, `${key}-${response.dispatchId ?? randomUUID()}.md`);
			writeFileSync(file, `# Research findings r${state.id}\n\n**Question:** ${question}\n\n${response.exitCode === 0 ? response.output : `(research helper failed, exit ${response.exitCode})\n\n${response.output}`}\n`, { encoding: "utf-8", flag: "wx" }); return { question, file };
		}));
		researchRounds.push({ questions, files: answered.map(a => a.file) });
		const resume = "Research findings for your NEEDS_RESEARCH questions are ready. Read each file with your read tool, then continue from where you paused:\n" + answered.map((a, i) => `${i + 1}. ${a.question}\n   → ${a.file}`).join("\n");
		if (p.taskToken !== d.noProgress.taskToken() || p.sessionDir !== d.state.getSessionDir()) break;
		result = await d.dispatchAgent(p.agent, resume, ctx, p.inputArtifacts, p.scopeGlobs, params.watchdog, params.backend ?? "auto", true, p.resumeContract); billed += result.billed ?? 0; out += result.out ?? 0;
	}
	return { result, billed, out, researchRounds, autoResearchTaskCapped };
}

function observeWorktree(d: DispatchExecutorDeps, tracking: Tracking, ctx: ExtensionContext): WorktreeObservation | null {
	if (!tracking.snapshot) return null;
	const diff = diffAgainst(tracking.snapshot, ctx.cwd || process.cwd());
	const concurrentWritableOverlap = tracking.concurrentAtStart || d.state.getWritableOverlapCounter() !== tracking.overlapBaseline;
	return diff.skipped
		? { skipped: true, reason: diff.reason, paths: [], concurrentWritableOverlap }
		: { skipped: false, paths: diff.paths, concurrentWritableOverlap };
}

function scopeResult(p: PreparedDispatch, observation: WorktreeObservation | null): any {
	if (!observation || p.scopeGlobs.length === 0) return null;
	if (observation.skipped) return { skipped: true, reason: observation.reason, declaredScope: p.scopeGlobs, concurrentWritableOverlap: observation.concurrentWritableOverlap };
	return { ...checkScope(observation.paths, p.scopeGlobs), changedPaths: observation.paths, declaredScope: p.scopeGlobs, concurrentWritableOverlap: observation.concurrentWritableOverlap };
}

function incompleteObservation(reason: string, overlap: boolean): DiagnosticsResult {
	return { status: "incomplete", reason, changedFiles: [], attribution: overlap ? "uncertain" : "no_observed_overlap", projects: [], uncoveredFiles: [] };
}

async function finishDispatch(d: DispatchExecutorDeps, p: PreparedDispatch, params: DispatchAgentParams, run: RunData, tracking: Tracking, ctx: ExtensionContext, onUpdate: ToolUpdate): Promise<ToolExecutionResult> {
	const s = d.state; const { result, researchRounds } = run; const cwd = ctx.cwd || process.cwd();
	const sameTaskNow = () => p.taskToken === d.noProgress.taskToken() && p.sessionDir === s.getSessionDir();
	const ids = extractAssertionIds(p.task); const disposition = deliveryDisposition(result.exitCode, result.pending === true);
	// Observe immediately at logical child completion, before Hub-owned artifacts are written.
	const observation = tracking.writable ? observeWorktree(d, tracking, ctx) : null;
	const deliveredReturn = parseDeliveredReturn(result.output, ids, disposition.delivered);
	let parsedReturn: any = deliveredReturn.parsed; let contractNotices: any[] = deliveredReturn.notices;
	const shouldUseDigest = ids.length > 0 || !!parsedReturn; const state = sameTaskNow() ? s.getAgentStates().get(p.agent.toLowerCase()) : undefined;
	const key = safeAgentKey(state?.def.name ?? p.agent); const backendUsed = state?.lastBackend ?? null;
	const failureMetadata = { dispatchId: result.dispatchId ?? null, transcriptPath: result.transcriptPath ?? null,
		agent: p.agent, task: p.task, scope: p.scopeGlobs, exitCode: result.exitCode, diagnostics: result.diagnostics ?? null };
	const artifactOutput = disposition.delivered ? result.output
		: `# Dispatch failure\n\n\`\`\`json\n${JSON.stringify(failureMetadata, null, 2)}\n\`\`\`\n\n## Output\n\n${result.output}`;
	const runPath = disposition.artifactKind ? d.artifacts.writeRunArtifact(key, state?.runCount ?? 0, artifactOutput, disposition.artifactKind as any, result.dispatchId, p.sessionDir) : null;
	const returnPath = disposition.delivered ? runPath : null; const failurePath = disposition.delivered ? null : runPath; let returnExtracted = false;
	if (returnPath && shouldExtractReturn(parsedReturn, ids)) {
		onUpdate?.({ content: [{ type: "text", text: `${p.agent} returned no structured block — extracting it from the report...` }], details: { agent: p.agent, task: p.task, status: "extracting_return" } });
		const recovered = await d.runReturnExtraction(returnPath, ids, ctx);
		if (recovered) { parsedReturn = recovered; contractNotices = crossCheck(recovered, ids); returnExtracted = true; }
	}

	// The one shared post-run delta feeds both scope reporting and compiler selection.
	let compilerDiagnostics: DiagnosticsResult | null = null; let compilerEvidencePath: string | null = null; let compilerEvidenceError: string | null = null;
	const compilerInspectedRevision = worktreeRevision(cwd, []);
	const eligibleForCompiler = disposition.delivered && tracking.writable && backendUsed === "native" && sameTaskNow();
	if (eligibleForCompiler && observation?.skipped) {
		compilerDiagnostics = incompleteObservation(`worktree observation unavailable: ${observation.reason ?? "unknown reason"}`, observation.concurrentWritableOverlap);
	} else if (eligibleForCompiler && observation && observation.paths.some(path => /\.(?:ts|tsx|mts|cts)$/i.test(path))) {
		try {
			compilerDiagnostics = await (d.diagnoseChangedTypeScript ?? diagnoseChangedTypeScript)(observation.paths, {
				cwd,
				attribution: observation.concurrentWritableOverlap ? "uncertain" : "no_observed_overlap",
				cacheLane: key,
				runId: result.dispatchId ?? randomUUID(),
			});
		} catch (error) {
			compilerDiagnostics = incompleteObservation(`compiler diagnostics failed safely: ${String(error)}`, observation.concurrentWritableOverlap);
		}
	}
	if (observation) {
		observation.concurrentWritableOverlap = observation.concurrentWritableOverlap || tracking.concurrentAtStart || s.getWritableOverlapCounter() !== tracking.overlapBaseline;
		if (compilerDiagnostics && observation.concurrentWritableOverlap) compilerDiagnostics = { ...compilerDiagnostics, attribution: "uncertain" };
	}
	const sameTask = sameTaskNow();
	if (sameTask && compilerDiagnostics) {
		const correction = correctStructuredReturnForCompiler(parsedReturn, ids, compilerDiagnostics);
		parsedReturn = correction.parsed;
		contractNotices = [...crossCheck(parsedReturn, ids), ...correction.demotedIds.map(id => ({ type: "compiler_diagnostics", id }))];
	}
	const assessmentId = result.dispatchId ?? randomUUID();
	if (compilerDiagnostics && compilerDiagnostics.status !== "skipped") {
		try {
			compilerEvidencePath = d.artifacts.writeRunArtifact(`${key}-compiler`, state?.runCount ?? 0,
				`# Compiler diagnostics\n\n\`\`\`json\n${JSON.stringify(compilerDiagnostics, null, 2)}\n\`\`\`\n`, "evidence", assessmentId, p.sessionDir);
		} catch (error) { compilerEvidenceError = String(error); }
	}
	const readback = disposition.pending ? [] : readBackDeliverables(p.contract, { cwd, sessionDir: p.sessionDir },
		(index, bytes) => retainDeliverable(p.sessionDir, assessmentId, index, bytes));
	let protocolDiagnostic: ToolProtocolDiagnostic | null = null; let protocolEvidencePath: string | null = null;
	if (disposition.delivered && backendUsed === "native") {
		protocolDiagnostic = diagnoseToolProtocol({
			output: result.output,
			toolEvents: result.toolEvents ?? [],
			deliverables: readback,
			origin: { kind: "task", taskId: p.taskId, dispatchId: result.dispatchId ?? assessmentId },
			effectiveConfiguration: {
				backend: backendUsed,
				model: result.diagnostics?.modelUsed ?? state?.def.model ?? null,
				tools: result.diagnostics?.effectiveTools ?? String(state?.def.tools ?? "").split(",").map(tool => tool.trim()).filter(Boolean),
			},
			evidenceRefs: [returnPath ?? undefined, ...readback.map(item => item.retainedPath)].filter((value): value is string => !!value),
		});
		if (protocolDiagnostic) {
			protocolEvidencePath = d.artifacts.writeRunArtifact(`${key}-tool-protocol`, state?.runCount ?? 0,
				JSON.stringify(protocolDiagnostic, null, 2), "evidence", randomUUID(), p.sessionDir);
			protocolDiagnostic.evidenceRefs = [...new Set([...protocolDiagnostic.evidenceRefs, protocolEvidencePath])];
		}
	}
	const executionStatus = disposition.pending ? "pending" : disposition.delivered ? "completed" : "failed";
	const afterRevision = worktreeRevision(cwd, []);
	const changes = !tracking.writable || !observation
		? { status: "unknown" as const, paths: [] as string[], attribution: "not_observed" as const }
		: observation.skipped
			? { status: "unknown" as const, paths: [] as string[], attribution: "not_observed" as const }
			: { status: observation.paths.length ? "changed" as const : "unchanged" as const, paths: observation.paths, attribution: observation.concurrentWritableOverlap ? "uncertain" as const : "certain" as const };
	const checks: VerificationCheckInput[] = (compilerDiagnostics?.projects ?? []).map(project => ({
		producer: "runtime", kind: "compilation", taskId: p.taskId, command: [...(project.argv ?? [])], exitCode: project.exitCode,
		inspectedRevision: compilerInspectedRevision, evidenceRef: compilerEvidencePath ?? "",
		requirementIds: ["AF-MIN-CHANGE"],
	}));
    for (const record of backendUsed === "native" && tracking.writable ? result.runtimeTests ?? [] : []) for (const kind of ["test", "code-grep"] as const) {
        const covered = p.requirements.filter(requirement => requirement.tag === kind && requirement.source && requirement.testCommand === record.command);
        if (!covered.length) continue;
        const evidenceRef = d.artifacts.writeRunArtifact(`${key}-test-check`, state?.runCount ?? 0, JSON.stringify({ taskId: p.taskId, dispatchId: result.dispatchId, record, requirements: covered }, null, 2), "evidence", randomUUID(), p.sessionDir);
        checks.push({ producer: "runtime", kind, command: [record.command], exitCode: record.exitCode,
            inspectedRevision: record.beforeRevision === record.afterRevision ? record.afterRevision : "changed-during-check",
            evidenceRef, requirementIds: ["AF-MIN-CHANGE", ...covered.map(requirement => requirement.id)], taskId: p.taskId,
            coverage: covered.map(requirement => ({ id: requirement.id, source: requirement.source, text: requirement.text, reference: requirement.reference, criticalConditions: requirement.criticalConditions ?? [] })),
        });
    }
	const runtimeResult = buildRuntimeResult({
		task: { id: p.taskId, current: sameTask && p.taskId === d.noProgress.taskId(), beforeRevision: p.beforeRevision, afterRevision },
		execution: { status: executionStatus, exitCode: result.exitCode, dispatchId: result.dispatchId ?? null },
		changes, requirements: p.requirements, deliverables: readback, checks,
		evidenceRefs: [returnPath ?? undefined, failurePath ?? undefined, compilerEvidencePath ?? undefined, protocolEvidencePath ?? undefined].filter((value): value is string => !!value),
	});
	const accepted = runtimeResult.acceptance.accepted;
	const acceptanceStatus = runtimeResult.compatibility.hubAcceptanceStatus;
	const status = protocolDiagnostic ? "tool_protocol_error" : accepted ? "accepted" : executionStatus === "completed" && (runtimeResult.verification.status === "failed" || acceptanceStatus === "deliverable_failed") ? "verification_failed" : executionStatus === "completed" ? "completed_unverified" : disposition.status;
	const assessment = { ...runtimeResult,
		executionStatus, acceptanceStatus, accepted, dispatchId: result.dispatchId ?? null, readback, scopeRoots: p.contract.scopeRoots,
		assertions: ids, structuredReturn: parsedReturn, contractNotices, compilerDiagnostics, compilerEvidencePath, protocolDiagnostic, protocolEvidencePath };
	const assessmentPath = disposition.pending ? null : d.artifacts.writeRunArtifact(`${key}-acceptance`, state?.runCount ?? 0, JSON.stringify(assessment, null, 2), "evidence", assessmentId, p.sessionDir);
	if (sameTask && [0, 124, 125].includes(result.exitCode)) s.getTurnDispatchFingerprints().add(p.fingerprint);
	if (sameTask) { s.getTurnReport().dispatches.push({ agent: p.agent, status, elapsed: result.elapsed, billed: run.billed, out: run.out }); s.getSessionTotals().billed += run.billed; s.getSessionTotals().out += run.out; }
	const questions = d.extractAskUserQuestions(result.output); const unresolved = d.extractNeedsResearch(result.output); const answered = researchRounds.reduce((n, r) => n + r.questions.length, 0);
	const notices: string[] = [];
	if (!sameTask) notices.push("Late result from a prior task/session: evidence retained in its original namespace; current-task counters and blockers were not changed.");
	if (disposition.delivered) notices.push(accepted
		? `Execution and current-state verification accepted by the runtime contract. Acceptance check: ${assessmentPath}`
		: protocolDiagnostic
			? `Tool protocol error: ${protocolDiagnostic.message} Evidence: ${protocolEvidencePath}. No text was executed and no retry was started.`
			: `Execution completed, NOT accepted. ${acceptanceStatus === "deliverable_failed" ? "Expected deliverable readback failed." : "Verification is missing, failed, stale, unsupported, or attribution-uncertain; file presence, exit 0, and claims are not proof."} Acceptance check: ${assessmentPath}`);
	if (readback.some(file => file.changed === false)) notices.push("Some deliverables already existed unchanged. Do not attribute their creation to this execution.");
	const blockers = extractExternalBlockers(result.output); if (sameTask && blockers.length) { for (const what of blockers) if (!s.getExternalBlockers().some(b => b.what === what)) s.getExternalBlockers().push({ agent: p.agent, what }); s.setExternalBlockerAcknowledged(false); s.setExternalBlockerRefusedOnce(false); notices.push(`⛔ ${p.agent} reported an EXTERNAL BLOCKER — something outside the fleet's reach is missing:\n${blockers.map((w, i) => `  ${i + 1}. ${w}`).join("\n")}\nThe next dispatch/research call is refused until you escalate this to the human. Do not build a substitute for the missing fact.`); }
	if (questions.length) notices.push(`⚠ ${questions.length} ASK_USER question(s) raised by ${p.agent}. You MUST call ask_user for each (in ${s.getUserLanguage()}) before re-dispatching:\n${questions.map((q, i) => `  ${i + 1}. ${q}`).join("\n")}`);
	if (researchRounds.length) notices.push(`ℹ ${p.agent} auto-paused for research ${researchRounds.length} round(s); ${answered} question(s) answered by read-only helpers. Findings were saved under ${safePathWithin(s.getSessionDir(), "findings")} and read by the agent directly — they are NOT inlined here.`);
	if (unresolved.length && researchRounds.length >= MAX_AUTO_RESEARCH_ROUNDS) notices.push(`⚠ ${p.agent} still requests research (${unresolved.length} question(s)) but the auto-research budget is exhausted. Run spawn_research yourself and re-dispatch with the findings, or simplify the task.`);
	if (run.autoResearchTaskCapped) notices.push(`⚠ ${p.agent} paused for research, but the TASK research envelope is spent (${s.getTaskResearchCount()}/${d.budget.currentTaskBudget().maxResearch}) — no helper was spawned and the specialist was not resumed. Its questions are unanswered. Narrow the task so it can proceed on what it has, or call set_task_tier with new_task: true if this is genuinely different work.`);
	if (returnPath) notices.push(`Full specialist output: ${returnPath}`);
	if (disposition.pending) notices.push("⏳ DELIVERY PENDING — no result or assertion evidence is available yet, and no return/failure artifact was written. Use the msg_id above with coms_get/coms_await; do not re-dispatch.");
	if (failurePath) notices.push(`⚠ DELIVERY FAILURE (exit ${result.exitCode}) — no specialist result was returned. The error output is at ${failurePath}; it is NOT a return and carries no assertion evidence. The work may or may not have happened — check the artifacts the task was supposed to produce before re-dispatching.`);
	if (compilerDiagnostics && compilerDiagnostics.status !== "skipped") {
		const advisory = formatAdvisory(compilerDiagnostics);
		const evidence = compilerEvidencePath ? `Full compiler evidence: ${compilerEvidencePath}` : `Compiler evidence artifact unavailable: ${compilerEvidenceError ?? "unknown error"}`;
		if (advisory) notices.push(`${advisory}\n${evidence}`);
		else if (compilerDiagnostics.projects.length) notices.push(`Compiler diagnostics completed with no errors. ${evidence}`);
	}
	const corrected = p.inputArtifacts.filter(a => a.resolvedFromKind); if (corrected.length) notices.push(`ℹ Artifact path corrected: ${corrected.map(a => `"${a.input}" → ${a.displayPath}`).join("; ")}. Use the corrected path from now on.`);
	if (state && d.contextPressure(state.contextPct)) notices.push(`⚠ ${d.displayName(state.def.name)} context at ${Math.ceil(state.contextPct)}% — consider /af-agents-restart ${state.def.name} (state lives in the artifacts/ledger, a restart is cheap).`);
	const scopeViolations = scopeResult(p, observation); const scopeNotice = scopeNoticeText(scopeViolations); if (scopeNotice) notices.push(scopeNotice.trim());
	const finding = isReviewPersona(p.agent) ? findingBudgetNotice(p.agent, blockingFindingCap(s.getTaskTier()), countReviewFindings(result.output), s.getTaskReviewRounds(), reviewRoundCap(s.getTaskTier())) || "" : ""; if (finding) notices.push(finding.trim());
	const docs = docsLaneNotice(p.agent, p.scopeGlobs); if (docs) notices.push(docs);
	const contract = contractNoticeText(contractNotices); const extraction = returnExtracted ? "ℹ The specialist declared no structured return. The block below was EXTRACTED from its report by a cheap read-only pass — weaker than a declared return. Verify the named evidence before you gate on it." : "";
	const digest = shouldUseDigest ? [extraction, structuredReturnDigest(parsedReturn) || "Structured return: (none parsed)", contract].filter(Boolean).join("\n\n") : (result.output.length > 8000 ? `${result.output.slice(0, 8000)}\n\n... [truncated]` : result.output);
	return { content: [{ type: "text", text: `[${p.agent}] ${status} in ${Math.round(result.elapsed / 1000)}s${notices.length ? `\n\n${notices.join("\n\n")}` : ""}\n\n${digest}` }], details: { agent: p.agent, task: p.task, status, ...(protocolDiagnostic ? { recoveryCategory: "tool_protocol_error", reason: protocolDiagnostic.message, protocolDiagnostic, protocolEvidencePath, protocolEffectsEvidenceRef: protocolEvidencePath } : { protocolDiagnostic: null, protocolEvidencePath: null }), executionStatus, acceptanceStatus, accepted, runtimeResult, taskIdentity: runtimeResult.task, changeResult: runtimeResult.changes, verificationResult: runtimeResult.verification, staleTask: !sameTask, deliverableReadback: readback, scopeRoots: p.contract.scopeRoots, assessmentPath, backendRequested: params.backend ?? "auto", backendUsed, elapsed: result.elapsed, exitCode: result.exitCode, fullOutput: result.output, dispatchId: result.dispatchId ?? null, transcriptPath: result.transcriptPath ?? null, diagnostics: result.diagnostics ?? null, evidencePath: result.evidencePath ?? null, compilerDiagnostics, compilerEvidencePath, structuredReturn: parsedReturn, returnExtracted, pending: disposition.pending, returnPath, failurePath, contractNotices, questions, researchRounds, scopeViolations, sessionReset: result.sessionReset ?? null, artifacts: p.inputArtifacts.map(a => ({ path: a.path, displayPath: a.displayPath, preview: a.preview, resolvedFromKind: a.resolvedFromKind ?? null })) } };
}

function dispatchExecutionConditions(d: DispatchExecutorDeps, params: DispatchAgentParams, ctx: ExtensionContext): Record<string, unknown> {
	const state = d.state.getAgentStates().get(normalizeAgentInput(params.agent));
	return {
		model: (state ? d.resolvedAgentModel?.(state.def, ctx) : undefined) ?? state?.def.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null),
		backend: params.backend ?? "auto",
	};
}

function researchExecutionConditions(d: DispatchExecutorDeps, params: SpawnResearchParams, ctx: ExtensionContext): Record<string, unknown> {
	const persona = params.persona ? d.state.getResearchPersonas().find(item => item.name.toLowerCase() === params.persona!.toLowerCase()) : undefined;
	try {
		const def = persona ?? d.research.anonymousDef();
		return { model: d.research.resolveModel(def, persona ? undefined : params.model, ctx), tools: "read,grep,find,ls" };
	} catch {
		return { model: params.model ?? null, tools: "read,grep,find,ls" };
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

export function createDispatchExecutor(d: DispatchExecutorDeps): ToolExecutor<DispatchAgentParams> {
	return withNoProgress(d, "dispatch", async (_id, params, signal, onUpdate, ctx) => {
		const capability = d.provisionalCapabilityRefusal("fleet"); if (capability) return capability;
		const agent = normalizeAgentInput(params.agent);
		const invalid = validateDispatchAgent(d, agent, params.task); if (invalid) return invalid;
		if (d.state.getAgentStates().get(agent)?.status === "running") return { content: [{ type: "text", text: "Agent is busy; nothing started, queued or charged. Re-invoke explicitly after it is idle." }], details: { status: "busy", reason: "busy", recoveryCategory: "busy", started: false, exitCode: 1 } };
		d.budget.ensureTaskTier();
		const preflight = preflightGate(d, agent) ?? checkReviewRoundCap(d.state.getTaskTier(), agent, d.state.getTaskReviewRounds()) ?? checkDocsLane(agent, params.scope || [], params.review_reason);
		if (preflight) return refusal(d, agent, params.task, preflight.reason, preflight.message);
		try { preflightDeliverables(params, { cwd: ctx.cwd || process.cwd(), sessionDir: d.state.getSessionDir() }); }
		catch (error) { return refusal(d, agent, params.task, "scope_preflight_failed", String(error)); }
		const budgetBlock = await d.budgetRecovery.ensure("dispatch", `${agent}: ${params.task}`, ctx, signal);
		if (budgetBlock) return refusal(d, agent, params.task, budgetBlock.reason, budgetBlock.message);
		if (signal?.aborted) return refusal(d, agent, params.task, "cancelled", "Operation cancelled before dispatch.");
		const prepared = prepareDispatch(d, params, ctx); if (!("agent" in prepared)) return prepared;
		const tracking = startTracking(d, prepared, ctx);
		try { onUpdate?.({ content: [{ type: "text", text: `Dispatching to ${prepared.agent}...` }], details: { agent: prepared.agent, task: prepared.task, status: "dispatching" } }); return await finishDispatch(d, prepared, params, await runWithAutoResearch(d, prepared, params, ctx, onUpdate), tracking, ctx, onUpdate); }
		catch (err: any) { return { content: [{ type: "text", text: `Error dispatching to ${prepared.agent}: ${err?.message || err}` }], details: { agent: prepared.agent, task: prepared.task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" } }; }
		finally { if (tracking.writable) d.state.setActiveWritableDispatches(Math.max(0, d.state.getActiveWritableDispatches() - 1)); }
	}, (params, ctx) => dispatchExecutionConditions(d, params, ctx));
}

export function createResearchExecutor(d: DispatchExecutorDeps): ToolExecutor<SpawnResearchParams> {
	return withNoProgress(d, "research", async (_id, params, signal, onUpdate, ctx) => {
		const capability = d.provisionalCapabilityRefusal("fleet"); if (capability) return capability; const s = d.state; d.budget.ensureTaskTier();
		const preflight = preflightGate(d, params.persona || ""); if (preflight) return refusal(d, "", params.task, preflight.reason, preflight.message, preflight.reason);
		const budgetBlock = await d.budgetRecovery.ensure("research", params.task, ctx, signal);
		if (budgetBlock) return refusal(d, "", params.task, budgetBlock.reason, budgetBlock.message);
		if (signal?.aborted) return refusal(d, "", params.task, "cancelled", "Operation cancelled before research.");
		const taskRefusal = checkTaskBudget("research", d.budget.taskCounters(), d.budget.currentTaskBudget(), d.budget.taskActiveElapsedMs(), s.getTaskTier());
		if (taskRefusal) return refusal(d, "", params.task, "task_budget_refused", taskRefusal.message, taskRefusal.reason);
		const turnRefusal = checkTurnBudget("research", { dispatches: s.getTurnDispatchCount(), research: s.getTurnResearchCount() }, d.budget.currentBudget(), d.budget.turnBudgetActiveElapsedMs(), s.getTaskTier());
		if (turnRefusal) return refusal(d, "", params.task, "budget_refused", turnRefusal.message, turnRefusal.reason);
		let def: any; let persona = false;
		if (params.persona) { def = s.getResearchPersonas().find(x => x.name.toLowerCase() === params.persona!.toLowerCase()); if (!def) return { content: [{ type: "text", text: `No research persona "${params.persona}". Available: ${s.getResearchPersonas().map(x => x.name).join(", ") || "(none defined)"}. Omit \`persona\` for an ad-hoc helper. (Not counted against the turn budget.)` }], details: { status: "error" } }; persona = true; } else def = d.research.anonymousDef();
		const model = d.research.resolveModel(def, persona ? undefined : params.model, ctx); let artifacts: InputArtifactPreview[];
		try { artifacts = d.artifacts.loadInputArtifacts(params.artifacts, ctx); } catch (err: any) { return { content: [{ type: "text", text: `⚠ Research NOT spawned and NOT counted against the turn budget — input artifact could not be resolved:\n${err?.message || err}\n\nFix the path and try again.` }], details: { status: "artifact_preflight_failed" } }; }
		s.setTurnResearchCount(s.getTurnResearchCount() + 1); s.setTaskResearchCount(s.getTaskResearchCount() + 1); s.getTurnReport().research++; s.getSessionTotals().research++; d.budget.updateModeStatus();
		const state = d.research.createState(def, persona, model); onUpdate?.({ content: [{ type: "text", text: `Spawning research helper r${state.id}...` }], details: { handle: `r${state.id}`, persona: persona ? def.name : null, status: "spawning" } });
		try { const result = await d.research.spawn(state, structuredResearchPrompt(params), ctx, artifacts, signal); const status = result.termination ? result.termination.reason : result.exitCode === 0 ? "done" : "error"; const output = result.output.length > 8000 ? `${result.output.slice(0, 8000)}\n\n... [truncated]` : result.output; return { content: [{ type: "text", text: `[research r${state.id} · ${persona ? d.displayName(def.name) : "ad-hoc"} · read-only] ${status} in ${Math.round(result.elapsed / 1000)}s\n\n${output}${result.evidencePath ? `\n\nFull execution evidence: ${result.evidencePath}` : ""}` }], details: { handle: `r${state.id}`, persona: persona ? def.name : null, model, status, elapsed: result.elapsed, exitCode: result.exitCode, fullOutput: result.output, dispatchId: result.dispatchId, evidencePath: result.evidencePath, transcriptPath: result.transcriptPath, termination: result.termination, researchContract: normalizeResearchContract(params), artifacts: artifacts.map(a => ({ path: a.path, displayPath: a.displayPath, preview: a.preview, resolvedFromKind: a.resolvedFromKind ?? null })) } }; }
		catch (err: any) { return { content: [{ type: "text", text: `Error spawning research helper: ${err?.message || err}` }], details: { handle: `r${state.id}`, model, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" } }; }
	}, (params, ctx) => researchExecutionConditions(d, params, ctx));
}

function hasWriteCapability(tools: string): boolean { const set = new Set(String(tools || "").split(",").map(x => x.trim()).filter(Boolean)); return ["write", "edit", "bash"].some(x => set.has(x)); }
function scopeNoticeText(v: any): string { if (!v) return ""; if (v.skipped) return `\n\n⚠ Scope gate skipped: ${v.reason || "not a git worktree"}.`; if (!v.outOfScope?.length) return ""; const overlap = v.concurrentWritableOverlap ? " Concurrent writable dispatches overlapped this run, so attribution is approximate." : ""; return `\n\n⚠ Scope advisory: changed outside declared scope: ${v.outOfScope.join(", ")}. Review these paths and decide whether to accept them or explicitly order cleanup; the hub did not revert anything.${overlap}`; }
function structuredReturnDigest(parsed: any): string { if (!parsed) return ""; const lines = ["Structured return (parsed):"]; for (const key of ["assertions_proven", "assertions_unproven", "assertions_failed"]) { const entries = parsed[key] || []; if (!entries.length) continue; lines.push(`${key}:`); for (const entry of entries) { const evidence = entry.evidence ? ` — evidence: ${entry.evidence}` : ""; const reason = entry.reason ? ` — reason: ${entry.reason}` : ""; const note = entry.note || (entry.evidence ? "" : "(no note)"); lines.push(`- ${entry.id}${note ? `: ${note}` : ""}${evidence}${reason}`); } } for (const key of ["changed_files", "tests_run", "open_risks", "requires_user_decision"]) { const entries = parsed[key] || []; if (entries.length) lines.push(`${key}: ${entries.slice(0, 5).join("; ")}${entries.length > 5 ? " …" : ""}`); } return lines.join("\n"); }
function contractNoticeText(notices: any[]): string { if (!notices?.length) return ""; const lines = ["⚠ Structured return contract notices:"]; const missing = notices.filter(n => n.type === "missing").map(n => n.id); const noStructured = notices.find(n => n.type === "no_structured_return"); if (noStructured) lines.push(`- no_structured_return: no parseable structured return for dispatched assertions ${(noStructured.ids || []).join(", ")} — treat all as unproven; full output is on disk.`); if (missing.length) lines.push(`- missing: return does not cover ${missing.join(", ")} — treat as unproven.`); for (const n of notices.filter(n => n.type === "proven_without_evidence")) lines.push(`- proven_without_evidence: ${n.id} claimed proven without named evidence — demoted to unproven.`); for (const n of notices.filter(n => n.type === "compiler_diagnostics")) lines.push(`- compiler_diagnostics: ${n.id} was claimed proven but a completed compiler check found an error in an observed changed file — demoted to unproven with original evidence retained.`); return lines.join("\n"); }
