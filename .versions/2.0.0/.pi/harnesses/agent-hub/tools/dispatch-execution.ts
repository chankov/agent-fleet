import { mkdirSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { blockingFindingCap, checkReviewRoundCap, checkTaskBudget, checkTierPersonaGate, checkTurnBudget, isReviewPersona, remainingTaskResearch, reviewBudgetClause, reviewRoundCap } from "../run-budget.js";
import { countReviewFindings, findingBudgetNotice } from "../review-findings.js";
import { checkDocsLane, docsLaneNotice } from "../docs-lane.js";
import { checkExternalBlockerGate, extractExternalBlockers } from "../external-blocker.js";
import { budgetContinuationInstruction } from "../budget-continuation.ts";
import { checkScope, diffAgainst, snapshotWorktree } from "../scope-gate.js";
import { crossCheck, deliveryDisposition, extractAssertionIds, parseDeliveredReturn } from "../return-contract.js";
import { shouldExtractReturn } from "../return-extract.js";
import { normalizeAgentInput, safeAgentKey, safePathWithin, taskFingerprint } from "../helpers.ts";
import { MAX_AUTO_RESEARCH_QUESTIONS, MAX_AUTO_RESEARCH_ROUNDS, type ResearchAgentDef, type ResearchRuntime } from "../research/runtime.ts";
import type { BudgetContext, SessionTotals, TurnReport } from "../context/budgets.ts";
import type { AssertionsArtifactsContext, InputArtifactPreview } from "../context/assertions-artifacts.ts";
import type { DispatchAgentParams, SpawnResearchParams, ToolExecutionResult, ToolExecutor, ToolUpdate } from "./context.ts";

type Gate = { reason: string; message: string } | null;
type DispatchResult = { output: string; exitCode: number; elapsed: number; billed?: number; out?: number; pending?: boolean; sessionReset?: unknown };
type AgentState = { def: { name: string; tools: string }; runCount: number; contextPct: number; lastBackend?: string | null };

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
	getResearchPersonas(): ResearchAgentDef[];
	getActiveWritableDispatches(): number; setActiveWritableDispatches(value: number): void;
	getWritableOverlapCounter(): number; setWritableOverlapCounter(value: number): void;
}

export interface DispatchExecutorDeps {
	state: DispatchExecutionState;
	budget: BudgetContext;
	artifacts: AssertionsArtifactsContext;
	research: ResearchRuntime<any>;
	provisionalCapabilityRefusal(pack: "fleet"): ToolExecutionResult | null;
	dispatchAgent(agent: string, task: string, ctx: ExtensionContext, artifacts: InputArtifactPreview[], scope: string[], watchdog?: boolean, backend?: "auto" | "native" | "coms", resume?: boolean): Promise<DispatchResult>;
	runReturnExtraction(path: string, ids: string[], ctx: ExtensionContext): Promise<any>;
	extractNeedsResearch(output: string): string[];
	extractAskUserQuestions(output: string): string[];
	contextPressure(percent: number): boolean;
	displayName(name: string): string;
	updateResearchWidget(): void;
}

interface PreparedDispatch { agent: string; task: string; inputArtifacts: InputArtifactPreview[]; scopeGlobs: string[]; fingerprint: string; }
interface RunData { result: DispatchResult; billed: number; out: number; researchRounds: { questions: string[]; files: string[] }[]; autoResearchTaskCapped: boolean; }
interface Tracking { writable: boolean; snapshot: any; overlapBaseline: number; concurrentAtStart: boolean; }

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

function prepareDispatch(d: DispatchExecutorDeps, params: DispatchAgentParams, ctx: ExtensionContext): PreparedDispatch | ToolExecutionResult {
	const s = d.state; const { task, artifacts, scope, review_reason } = params; const agent = normalizeAgentInput(params.agent);
	d.budget.ensureTaskTier();
	const preflight = preflightGate(d, agent) ?? checkReviewRoundCap(s.getTaskTier(), agent, s.getTaskReviewRounds()) ?? checkDocsLane(agent, scope || [], review_reason);
	if (preflight) return refusal(d, agent, task, preflight.reason, preflight.message, preflight.reason);
	const taskRefusal = checkTaskBudget("dispatch", d.budget.taskCounters(), d.budget.currentTaskBudget(), d.budget.taskActiveElapsedMs(), s.getTaskTier());
	if (taskRefusal) { d.budget.armBudgetContinuation("task", taskRefusal.reason); return refusal(d, agent, task, "task_budget_refused", budgetContinuationInstruction(taskRefusal.message, "task", s.getUserLanguage()), taskRefusal.reason); }
	const turnRefusal = checkTurnBudget("dispatch", { dispatches: s.getTurnDispatchCount(), research: s.getTurnResearchCount() }, d.budget.currentBudget(), d.budget.turnBudgetActiveElapsedMs(), s.getTaskTier());
	if (turnRefusal) { d.budget.armBudgetContinuation("turn", turnRefusal.reason); return refusal(d, agent, task, "budget_refused", budgetContinuationInstruction(turnRefusal.message, "turn", s.getUserLanguage()), turnRefusal.reason); }
	const fingerprint = taskFingerprint(agent, task);
	if (s.getTurnDispatchFingerprints().has(fingerprint)) return refusal(d, agent, task, "duplicate_refused", `⚠ Duplicate dispatch refused: you already dispatched ${agent} with this task (or a trivial rewording of it) THIS turn. Use the earlier result — re-read its digest/returnPath — or change the task materially (new instructions, corrected inputs) before re-dispatching.`);
	let inputArtifacts: InputArtifactPreview[];
	try { inputArtifacts = d.artifacts.loadInputArtifacts(artifacts, ctx); }
	catch (err: any) { return { content: [{ type: "text", text: `⚠ Dispatch NOT sent and NOT counted against the turn budget — input artifact could not be resolved:\n${err?.message || err}\n\nFix the path and dispatch again.` }], details: { agent, task, status: "artifact_preflight_failed", elapsed: 0, exitCode: 1, fullOutput: "" } }; }
	s.setTurnDispatchCount(s.getTurnDispatchCount() + 1); s.setTaskDispatchCount(s.getTaskDispatchCount() + 1);
	if (isReviewPersona(agent)) s.setTaskReviewRounds(s.getTaskReviewRounds() + 1);
	s.getSessionTotals().dispatches++; d.budget.updateModeStatus();
	return { agent, task, inputArtifacts, scopeGlobs: (scope || []).map(String).map(x => x.trim()).filter(Boolean), fingerprint };
}

function startTracking(d: DispatchExecutorDeps, prepared: PreparedDispatch, ctx: ExtensionContext): Tracking {
	const s = d.state; const state = s.getAgentStates().get(prepared.agent.toLowerCase()); const canWrite = !!state && hasWriteCapability(state.def.tools);
	const tracking = { writable: canWrite, snapshot: null as any, overlapBaseline: s.getWritableOverlapCounter(), concurrentAtStart: false };
	if (canWrite) {
		tracking.concurrentAtStart = s.getActiveWritableDispatches() > 0;
		if (tracking.concurrentAtStart) s.setWritableOverlapCounter(s.getWritableOverlapCounter() + 1);
		s.setActiveWritableDispatches(s.getActiveWritableDispatches() + 1);
		if (prepared.scopeGlobs.length > 0) tracking.snapshot = snapshotWorktree(ctx.cwd || process.cwd());
	}
	return tracking;
}

async function runWithAutoResearch(d: DispatchExecutorDeps, p: PreparedDispatch, params: DispatchAgentParams, ctx: ExtensionContext, onUpdate: ToolUpdate): Promise<RunData> {
	const findingClause = reviewBudgetClause(d.state.getTaskTier(), p.agent); const dispatchedTask = findingClause ? `${p.task}\n\n${findingClause}` : p.task;
	let result = await d.dispatchAgent(p.agent, dispatchedTask, ctx, p.inputArtifacts, p.scopeGlobs, params.watchdog, params.backend ?? "auto");
	let billed = result.billed ?? 0; let out = result.out ?? 0; const researchRounds: RunData["researchRounds"] = []; let autoResearchTaskCapped = false;
	while (result.exitCode === 0 && researchRounds.length < MAX_AUTO_RESEARCH_ROUNDS) {
		const left = remainingTaskResearch(d.budget.currentTaskBudget(), d.budget.taskCounters()); if (left === 0) { autoResearchTaskCapped = true; break; }
		const questions = d.extractNeedsResearch(result.output).slice(0, left == null ? MAX_AUTO_RESEARCH_QUESTIONS : Math.min(MAX_AUTO_RESEARCH_QUESTIONS, left)); if (!questions.length) break;
		d.state.setTaskResearchCount(d.state.getTaskResearchCount() + questions.length); d.budget.updateModeStatus();
		onUpdate?.({ content: [{ type: "text", text: `${p.agent} paused for research (${questions.length} question(s)) — spawning read-only helpers...` }], details: { agent: p.agent, task: p.task, status: "researching" } });
		const findingsDir = safePathWithin(d.state.getSessionDir(), "findings"); mkdirSync(findingsDir, { recursive: true }); const key = safeAgentKey(d.state.getAgentStates().get(p.agent.toLowerCase())?.def.name ?? p.agent);
		const answered = await Promise.all(questions.map(async question => {
			const def = d.research.anonymousDef(); const state = d.research.createState(def, false, d.research.resolveModel(def, undefined, ctx), true); d.updateResearchWidget();
			const response = await d.research.spawn(state, question, ctx); const file = safePathWithin(findingsDir, `${key}-r${state.id}.md`);
			writeFileSync(file, `# Research findings r${state.id}\n\n**Question:** ${question}\n\n${response.exitCode === 0 ? response.output : `(research helper failed, exit ${response.exitCode})\n\n${response.output}`}\n`, "utf-8"); return { question, file };
		}));
		researchRounds.push({ questions, files: answered.map(a => a.file) });
		const resume = "Research findings for your NEEDS_RESEARCH questions are ready. Read each file with your read tool, then continue from where you paused:\n" + answered.map((a, i) => `${i + 1}. ${a.question}\n   → ${a.file}`).join("\n");
		result = await d.dispatchAgent(p.agent, resume, ctx, p.inputArtifacts, p.scopeGlobs, params.watchdog, params.backend ?? "auto", true); billed += result.billed ?? 0; out += result.out ?? 0;
	}
	return { result, billed, out, researchRounds, autoResearchTaskCapped };
}

function scopeResult(d: DispatchExecutorDeps, p: PreparedDispatch, tracking: Tracking, ctx: ExtensionContext): any {
	if (!tracking.snapshot) return null; const diff = diffAgainst(tracking.snapshot, ctx.cwd || process.cwd());
	const concurrentWritableOverlap = tracking.concurrentAtStart || d.state.getWritableOverlapCounter() !== tracking.overlapBaseline;
	if (diff.skipped) return { skipped: true, reason: diff.reason, declaredScope: p.scopeGlobs, concurrentWritableOverlap };
	return { ...checkScope(diff.paths, p.scopeGlobs), changedPaths: diff.paths, declaredScope: p.scopeGlobs, concurrentWritableOverlap };
}

async function finishDispatch(d: DispatchExecutorDeps, p: PreparedDispatch, params: DispatchAgentParams, run: RunData, tracking: Tracking, ctx: ExtensionContext, onUpdate: ToolUpdate): Promise<ToolExecutionResult> {
	const s = d.state; const { result, researchRounds } = run; const ids = extractAssertionIds(p.task); const disposition = deliveryDisposition(result.exitCode, result.pending === true);
	let { parsed: parsedReturn, notices: contractNotices } = parseDeliveredReturn(result.output, ids, disposition.delivered); const shouldUseDigest = ids.length > 0 || !!parsedReturn;
	const state = s.getAgentStates().get(p.agent.toLowerCase()); const key = safeAgentKey(state?.def.name ?? p.agent);
	const runPath = disposition.artifactKind && (shouldUseDigest || !disposition.delivered) ? d.artifacts.writeRunArtifact(key, state?.runCount ?? 0, result.output, disposition.artifactKind) : null;
	const returnPath = disposition.delivered ? runPath : null; const failurePath = disposition.delivered ? null : runPath; let returnExtracted = false;
	if (returnPath && shouldExtractReturn(parsedReturn, ids)) {
		onUpdate?.({ content: [{ type: "text", text: `${p.agent} returned no structured block — extracting it from the report...` }], details: { agent: p.agent, task: p.task, status: "extracting_return" } });
		const recovered = await d.runReturnExtraction(returnPath, ids, ctx); if (recovered) { parsedReturn = recovered; contractNotices = crossCheck(recovered, ids); returnExtracted = true; }
	}
	if ([0, 124, 125].includes(result.exitCode)) s.getTurnDispatchFingerprints().add(p.fingerprint);
	s.getTurnReport().dispatches.push({ agent: p.agent, status: disposition.status, elapsed: result.elapsed, billed: run.billed, out: run.out }); s.getSessionTotals().billed += run.billed; s.getSessionTotals().out += run.out;
	const questions = d.extractAskUserQuestions(result.output); const unresolved = d.extractNeedsResearch(result.output); const answered = researchRounds.reduce((n, r) => n + r.questions.length, 0);
	const notices: string[] = [];
	const blockers = extractExternalBlockers(result.output); if (blockers.length) { for (const what of blockers) if (!s.getExternalBlockers().some(b => b.what === what)) s.getExternalBlockers().push({ agent: p.agent, what }); s.setExternalBlockerAcknowledged(false); s.setExternalBlockerRefusedOnce(false); notices.push(`⛔ ${p.agent} reported an EXTERNAL BLOCKER — something outside the fleet's reach is missing:\n${blockers.map((w, i) => `  ${i + 1}. ${w}`).join("\n")}\nThe next dispatch/research call is refused until you escalate this to the human. Do not build a substitute for the missing fact.`); }
	if (questions.length) notices.push(`⚠ ${questions.length} ASK_USER question(s) raised by ${p.agent}. You MUST call ask_user for each (in ${s.getUserLanguage()}) before re-dispatching:\n${questions.map((q, i) => `  ${i + 1}. ${q}`).join("\n")}`);
	if (researchRounds.length) notices.push(`ℹ ${p.agent} auto-paused for research ${researchRounds.length} round(s); ${answered} question(s) answered by read-only helpers. Findings were saved under ${safePathWithin(s.getSessionDir(), "findings")} and read by the agent directly — they are NOT inlined here.`);
	if (unresolved.length && researchRounds.length >= MAX_AUTO_RESEARCH_ROUNDS) notices.push(`⚠ ${p.agent} still requests research (${unresolved.length} question(s)) but the auto-research budget is exhausted. Run spawn_research yourself and re-dispatch with the findings, or simplify the task.`);
	if (run.autoResearchTaskCapped) notices.push(`⚠ ${p.agent} paused for research, but the TASK research envelope is spent (${s.getTaskResearchCount()}/${d.budget.currentTaskBudget().maxResearch}) — no helper was spawned and the specialist was not resumed. Its questions are unanswered. Narrow the task so it can proceed on what it has, or call set_task_tier with new_task: true if this is genuinely different work.`);
	if (returnPath) notices.push(`Full specialist output: ${returnPath}`);
	if (disposition.pending) notices.push("⏳ DELIVERY PENDING — no result or assertion evidence is available yet, and no return/failure artifact was written. Use the msg_id above with coms_get/coms_await; do not re-dispatch.");
	if (failurePath) notices.push(`⚠ DELIVERY FAILURE (exit ${result.exitCode}) — no specialist result was returned. The error output is at ${failurePath}; it is NOT a return and carries no assertion evidence. The work may or may not have happened — check the artifacts the task was supposed to produce before re-dispatching.`);
	const corrected = p.inputArtifacts.filter(a => a.resolvedFromKind); if (corrected.length) notices.push(`ℹ Artifact path corrected: ${corrected.map(a => `"${a.input}" → ${a.displayPath}`).join("; ")}. Use the corrected path from now on.`);
	if (state && d.contextPressure(state.contextPct)) notices.push(`⚠ ${d.displayName(state.def.name)} context at ${Math.ceil(state.contextPct)}% — consider /af-agents-restart ${state.def.name} (state lives in the artifacts/ledger, a restart is cheap).`);
	const scopeViolations = scopeResult(d, p, tracking, ctx); const scopeNotice = scopeNoticeText(scopeViolations); if (scopeNotice) notices.push(scopeNotice.trim());
	const finding = isReviewPersona(p.agent) ? findingBudgetNotice(p.agent, blockingFindingCap(s.getTaskTier()), countReviewFindings(result.output), s.getTaskReviewRounds(), reviewRoundCap(s.getTaskTier())) || "" : ""; if (finding) notices.push(finding.trim());
	const docs = docsLaneNotice(p.agent, p.scopeGlobs); if (docs) notices.push(docs);
	const contract = contractNoticeText(contractNotices); const extraction = returnExtracted ? "ℹ The specialist declared no structured return. The block below was EXTRACTED from its report by a cheap read-only pass — weaker than a declared return. Verify the named evidence before you gate on it." : "";
	const digest = shouldUseDigest ? [extraction, structuredReturnDigest(parsedReturn) || "Structured return: (none parsed)", contract].filter(Boolean).join("\n\n") : (result.output.length > 8000 ? `${result.output.slice(0, 8000)}\n\n... [truncated]` : result.output);
	return { content: [{ type: "text", text: `[${p.agent}] ${disposition.status} in ${Math.round(result.elapsed / 1000)}s${notices.length ? `\n\n${notices.join("\n\n")}` : ""}\n\n${digest}` }], details: { agent: p.agent, task: p.task, status: disposition.status, backendRequested: params.backend ?? "auto", backendUsed: state?.lastBackend ?? null, elapsed: result.elapsed, exitCode: result.exitCode, fullOutput: result.output, structuredReturn: parsedReturn, returnExtracted, pending: disposition.pending, returnPath, failurePath, contractNotices, questions, researchRounds, scopeViolations, sessionReset: result.sessionReset ?? null, artifacts: p.inputArtifacts.map(a => ({ path: a.path, displayPath: a.displayPath, preview: a.preview, resolvedFromKind: a.resolvedFromKind ?? null })) } };
}

export function createDispatchExecutor(d: DispatchExecutorDeps): ToolExecutor<DispatchAgentParams> {
	return async (_id, params, _signal, onUpdate, ctx) => {
		const capability = d.provisionalCapabilityRefusal("fleet"); if (capability) return capability;
		const prepared = prepareDispatch(d, params, ctx); if (!("agent" in prepared)) return prepared;
		const tracking = startTracking(d, prepared, ctx);
		try { onUpdate?.({ content: [{ type: "text", text: `Dispatching to ${prepared.agent}...` }], details: { agent: prepared.agent, task: prepared.task, status: "dispatching" } }); return await finishDispatch(d, prepared, params, await runWithAutoResearch(d, prepared, params, ctx, onUpdate), tracking, ctx, onUpdate); }
		catch (err: any) { return { content: [{ type: "text", text: `Error dispatching to ${prepared.agent}: ${err?.message || err}` }], details: { agent: prepared.agent, task: prepared.task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" } }; }
		finally { if (tracking.writable) d.state.setActiveWritableDispatches(Math.max(0, d.state.getActiveWritableDispatches() - 1)); }
	};
}

export function createResearchExecutor(d: DispatchExecutorDeps): ToolExecutor<SpawnResearchParams> {
	return async (_id, params, signal, onUpdate, ctx) => {
		const capability = d.provisionalCapabilityRefusal("fleet"); if (capability) return capability; const s = d.state; d.budget.ensureTaskTier();
		const preflight = preflightGate(d, params.persona || ""); if (preflight) return refusal(d, "", params.task, preflight.reason, preflight.message, preflight.reason);
		const taskRefusal = checkTaskBudget("research", d.budget.taskCounters(), d.budget.currentTaskBudget(), d.budget.taskActiveElapsedMs(), s.getTaskTier());
		if (taskRefusal) { d.budget.armBudgetContinuation("task", taskRefusal.reason); return refusal(d, "", params.task, "task_budget_refused", budgetContinuationInstruction(taskRefusal.message, "task", s.getUserLanguage()), taskRefusal.reason); }
		const turnRefusal = checkTurnBudget("research", { dispatches: s.getTurnDispatchCount(), research: s.getTurnResearchCount() }, d.budget.currentBudget(), d.budget.turnBudgetActiveElapsedMs(), s.getTaskTier());
		if (turnRefusal) { d.budget.armBudgetContinuation("turn", turnRefusal.reason); return refusal(d, "", params.task, "budget_refused", budgetContinuationInstruction(turnRefusal.message, "turn", s.getUserLanguage()), turnRefusal.reason); }
		let def: any; let persona = false;
		if (params.persona) { def = s.getResearchPersonas().find(x => x.name.toLowerCase() === params.persona!.toLowerCase()); if (!def) return { content: [{ type: "text", text: `No research persona "${params.persona}". Available: ${s.getResearchPersonas().map(x => x.name).join(", ") || "(none defined)"}. Omit \`persona\` for an ad-hoc helper. (Not counted against the turn budget.)` }], details: { status: "error" } }; persona = true; } else def = d.research.anonymousDef();
		const model = d.research.resolveModel(def, persona ? undefined : params.model, ctx); let artifacts: InputArtifactPreview[];
		try { artifacts = d.artifacts.loadInputArtifacts(params.artifacts, ctx); } catch (err: any) { return { content: [{ type: "text", text: `⚠ Research NOT spawned and NOT counted against the turn budget — input artifact could not be resolved:\n${err?.message || err}\n\nFix the path and try again.` }], details: { status: "artifact_preflight_failed" } }; }
		s.setTurnResearchCount(s.getTurnResearchCount() + 1); s.setTaskResearchCount(s.getTaskResearchCount() + 1); s.getTurnReport().research++; s.getSessionTotals().research++; d.budget.updateModeStatus();
		const state = d.research.createState(def, persona, model); d.updateResearchWidget(); onUpdate?.({ content: [{ type: "text", text: `Spawning research helper r${state.id}...` }], details: { handle: `r${state.id}`, persona: persona ? def.name : null, status: "spawning" } });
		try { const result = await d.research.spawn(state, params.task, ctx, artifacts, signal); const status = result.termination ? result.termination.reason : result.exitCode === 0 ? "done" : "error"; const output = result.output.length > 8000 ? `${result.output.slice(0, 8000)}\n\n... [truncated]` : result.output; return { content: [{ type: "text", text: `[research r${state.id} · ${persona ? d.displayName(def.name) : "ad-hoc"} · read-only] ${status} in ${Math.round(result.elapsed / 1000)}s\n\n${output}` }], details: { handle: `r${state.id}`, persona: persona ? def.name : null, model, status, elapsed: result.elapsed, exitCode: result.exitCode, fullOutput: result.output, termination: result.termination, artifacts: artifacts.map(a => ({ path: a.path, displayPath: a.displayPath, preview: a.preview, resolvedFromKind: a.resolvedFromKind ?? null })) } }; }
		catch (err: any) { return { content: [{ type: "text", text: `Error spawning research helper: ${err?.message || err}` }], details: { handle: `r${state.id}`, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" } }; }
	};
}

function hasWriteCapability(tools: string): boolean { const set = new Set(String(tools || "").split(",").map(x => x.trim()).filter(Boolean)); return ["write", "edit", "bash"].some(x => set.has(x)); }
function scopeNoticeText(v: any): string { if (!v) return ""; if (v.skipped) return `\n\n⚠ Scope gate skipped: ${v.reason || "not a git worktree"}.`; if (!v.outOfScope?.length) return ""; const overlap = v.concurrentWritableOverlap ? " Concurrent writable dispatches overlapped this run, so attribution is approximate." : ""; return `\n\n⚠ Scope advisory: changed outside declared scope: ${v.outOfScope.join(", ")}. Review these paths and decide whether to accept them or explicitly order cleanup; the hub did not revert anything.${overlap}`; }
function structuredReturnDigest(parsed: any): string { if (!parsed) return ""; const lines = ["Structured return (parsed):"]; for (const key of ["assertions_proven", "assertions_unproven", "assertions_failed"]) { const entries = parsed[key] || []; if (!entries.length) continue; lines.push(`${key}:`); for (const entry of entries) { const evidence = entry.evidence ? ` — evidence: ${entry.evidence}` : ""; const note = entry.note || (entry.evidence ? "" : "(no note)"); lines.push(`- ${entry.id}${note ? `: ${note}` : ""}${evidence}`); } } for (const key of ["changed_files", "tests_run", "open_risks", "requires_user_decision"]) { const entries = parsed[key] || []; if (entries.length) lines.push(`${key}: ${entries.slice(0, 5).join("; ")}${entries.length > 5 ? " …" : ""}`); } return lines.join("\n"); }
function contractNoticeText(notices: any[]): string { if (!notices?.length) return ""; const lines = ["⚠ Structured return contract notices:"]; const missing = notices.filter(n => n.type === "missing").map(n => n.id); const noStructured = notices.find(n => n.type === "no_structured_return"); if (noStructured) lines.push(`- no_structured_return: no parseable structured return for dispatched assertions ${(noStructured.ids || []).join(", ")} — treat all as unproven; full output is on disk.`); if (missing.length) lines.push(`- missing: return does not cover ${missing.join(", ")} — treat as unproven.`); for (const n of notices.filter(n => n.type === "proven_without_evidence")) lines.push(`- proven_without_evidence: ${n.id} claimed proven without named evidence — demoted to unproven.`); return lines.join("\n"); }
