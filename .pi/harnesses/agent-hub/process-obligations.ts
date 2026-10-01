import { consumeActionGrant, type ActionContract, type ActionGrant } from "./task-triage-authorization.ts";

export const PROCESS_OBLIGATIONS_SCHEMA = "agent-fleet.process-obligations/v1" as const;
export type TaskRisk = "unknown" | "low" | "high";
export type TaskScope = "unknown" | "read-only" | "small" | "wide";
export type ObligationStatus = "satisfied" | "open" | "unsupported" | "waived";
export type ProcessStage = "classify-risk" | "plan" | "execute" | "acceptance" | "review" | "confirm-action" | "complete";

export interface ProcessStageState { required: boolean; evidenceRef: string | null; revision: string | null; }
export interface ProcessAddition { id: string; source: "system1"; taskId: string; evaluationId: string; inputRevision: string; policyVersion: string; questionVersion: string; provider: string; model: string; reason: "security_change" | "wide_change" | "irreversible_execution"; status: "active" | "waived"; waiverReason: string | null; }
export interface ProcessObligationState {
 schema: typeof PROCESS_OBLIGATIONS_SCHEMA; risk: TaskRisk; scope: TaskScope;
 acceptance: ProcessStageState; review: ProcessStageState; plan: ProcessStageState;
 reassessments: number; lastReason: string | null; appliedRuleIds: string[]; changedFiles: string[];
 additions?: ProcessAddition[];
}
export interface ProcessClassificationInput { risk?: string; scope?: string; reason?: string; newTask?: boolean; }
export interface ProcessVerdict {
 accepted: boolean; path: "read-only" | "changed-task"; risk: TaskRisk; scope: TaskScope; budgetTier: string;
 obligations: Record<"risk" | "acceptance" | "review" | "plan", { status: ObligationStatus; evidenceRef?: string }> & { confirmation?: { status: ObligationStatus } };
 additions: Pick<ProcessAddition, "id" | "taskId" | "evaluationId" | "inputRevision" | "reason" | "status">[];
 appliedRuleIds: string[]; currentStage: ProcessStage; admissibleNextAction: string; auditScope: string[]; explanation: string;
}
const RISKS = new Set<TaskRisk>(["unknown", "low", "high"]), SCOPES = new Set<TaskScope>(["unknown", "read-only", "small", "wide"]);
const scopeRank: Record<TaskScope, number> = { unknown: 0, "read-only": 0, small: 1, wide: 2 };
const cleanReason = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 512) : null;
const strings = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter(v => typeof v === "string" && v.trim()).map(v => v.trim()))].sort() : [];
export function createProcessState(): ProcessObligationState { return { schema: PROCESS_OBLIGATIONS_SCHEMA, risk: "unknown", scope: "unknown", acceptance: { required: true, evidenceRef: null, revision: null }, review: { required: false, evidenceRef: null, revision: null }, plan: { required: false, evidenceRef: null, revision: null }, reassessments: 0, lastReason: null, appliedRuleIds: ["risk-unknown-fail-closed"], changedFiles: [] }; }
export function normalizeProcessState(value: unknown): ProcessObligationState {
 const row = value && typeof value === "object" ? value as any : {}, state = createProcessState();
 if (RISKS.has(row.risk)) state.risk = row.risk; if (SCOPES.has(row.scope)) state.scope = row.scope;
 for (const key of ["acceptance", "review", "plan"] as const) { const stage = row[key] && typeof row[key] === "object" ? row[key] : {}; state[key] = { required: key === "acceptance" || stage.required === true || key === "review" && (state.risk === "high" || state.scope === "wide") || key === "plan" && state.scope === "wide", evidenceRef: typeof stage.evidenceRef === "string" && stage.evidenceRef ? stage.evidenceRef : null, revision: typeof stage.revision === "string" && stage.revision ? stage.revision : null }; }
 // Legacy required stages remain independent of S1 and cannot be waived.
 if (Array.isArray(row.additions) && (row.additions.length > 300 || Buffer.byteLength(JSON.stringify(row.additions)) > 64 * 1024)) throw new Error("Process additions exceed the persistence limit; dependent effects are blocked.");
 state.additions = Array.isArray(row.additions) ? row.additions.map((a: any) => {
  if (!a || a.source !== "system1" || typeof a.id !== "string" || !a.id || !["taskId", "evaluationId", "inputRevision", "policyVersion", "questionVersion", "provider", "model"].every(k => typeof a[k] === "string" && a[k]) || !["security_change", "wide_change", "irreversible_execution"].includes(a.reason) || !["active", "waived"].includes(a.status) || a.status === "waived" && (typeof a.waiverReason !== "string" || !a.waiverReason)) throw new Error("Invalid process addition; dependent effects are blocked.");
  return { id: a.id, source: "system1" as const, taskId: a.taskId, evaluationId: a.evaluationId, inputRevision: a.inputRevision, policyVersion: a.policyVersion, questionVersion: a.questionVersion, provider: a.provider, model: a.model, reason: a.reason, status: a.status, waiverReason: a.status === "waived" ? a.waiverReason : null };
 }) : [];
 state.reassessments = Number.isSafeInteger(row.reassessments) && row.reassessments >= 0 ? row.reassessments : 0; state.lastReason = cleanReason(row.lastReason);
 state.appliedRuleIds = strings(row.appliedRuleIds); state.changedFiles = strings(row.changedFiles); return state;
}
function rules(risk: TaskRisk, scope: TaskScope): string[] { return [...new Set([risk === "unknown" ? "risk-unknown-fail-closed" : risk === "high" ? "risk-high-independent-review" : "risk-low-minimal-acceptance", scope === "wide" ? "scope-wide-plan-review" : scope === "read-only" ? "scope-read-only-lightweight" : "scope-changed-task", "budget-tier-spend-only"])]; }
export function applyProcessClassification(current: ProcessObligationState, input: ProcessClassificationInput): { ok: true; state: ProcessObligationState; message: string } | { ok: false; state: ProcessObligationState; message: string } {
 const reason = cleanReason(input.reason); if (input.newTask && !reason) return { ok: false, state: normalizeProcessState(current), message: "A genuine new task requires a non-empty reason." };
 const base = input.newTask ? createProcessState() : normalizeProcessState(current), risk = input.risk === undefined ? base.risk : String(input.risk).trim().toLowerCase() as TaskRisk, scope = input.scope === undefined ? base.scope : String(input.scope).trim().toLowerCase() as TaskScope;
 if (!RISKS.has(risk)) return { ok: false, state: base, message: `risk must be one of unknown | low | high (got "${input.risk}").` }; if (!SCOPES.has(scope)) return { ok: false, state: base, message: `scope must be one of read-only | small | wide (got "${input.scope}").` };
 const riskWasExplicit = input.risk !== undefined, riskChanged = risk !== base.risk, scopeExpanded = scopeRank[scope] > scopeRank[base.scope];
 if ((riskChanged || scopeExpanded) && !reason) return { ok: false, state: base, message: `${riskChanged ? "Risk change" : "Scope expansion"} requires a non-empty reason.` }; if (scopeExpanded && base.scope !== "unknown" && !riskWasExplicit) return { ok: false, state: base, message: "Scope expansion requires explicit risk reassessment in the same set_task_tier call." };
 const next = normalizeProcessState(base); next.risk = risk; next.scope = scope; next.lastReason = reason ?? next.lastReason; next.appliedRuleIds = rules(risk, scope);
 if (riskWasExplicit && (riskChanged || scopeExpanded || !!reason) || scopeExpanded) next.reassessments++;
 if (risk === "high" || scope === "wide") next.review.required = true; if (scope === "wide") next.plan.required = true;
 if (scopeExpanded) { next.acceptance = { required: true, evidenceRef: null, revision: null }; if (effectiveProcessStage(next, "review")) next.review = { ...next.review, evidenceRef: null, revision: null }; if (effectiveProcessStage(next, "plan")) next.plan = { ...next.plan, evidenceRef: null, revision: null }; }
 return { ok: true, state: next, message: `Process classified: risk ${next.risk}, scope ${next.scope}.` };
}
export function effectiveProcessStage(state: ProcessObligationState, stage: "plan" | "review" | "confirmation"): boolean { const s = normalizeProcessState(state); return (stage !== "confirmation" && s[stage].required) || !!s.additions?.some(a => a.status === "active" && (stage === "confirmation" ? a.reason === "irreversible_execution" : stage === "plan" ? a.reason === "wide_change" : a.reason === "wide_change" || a.reason === "security_change")); }
export function noteProcessStage(state: ProcessObligationState, stage: "acceptance" | "plan" | "review", evidence: { evidenceRef: string; revision: string; changedFiles?: string[] }): ProcessObligationState { const next = normalizeProcessState(state); if ((stage === "acceptance" || effectiveProcessStage(next, stage)) && evidence.evidenceRef && evidence.revision) next[stage] = { ...next[stage], evidenceRef: evidence.evidenceRef, revision: evidence.revision }; if (stage === "acceptance" && evidence.changedFiles) next.changedFiles = strings(evidence.changedFiles); return next; }
export function processOpenObligations(state: ProcessObligationState, revision?: string): string[] { const s = normalizeProcessState(state); return [s.risk === "unknown" ? "risk" : "", effectiveProcessStage(s, "plan") && !s.plan.evidenceRef ? "plan" : "", s.acceptance.required && (!s.acceptance.evidenceRef || revision && s.acceptance.revision !== revision) ? "acceptance" : "", effectiveProcessStage(s, "review") && (!s.review.evidenceRef || revision && s.review.revision !== revision) ? "review" : "", effectiveProcessStage(s, "confirmation") ? "action_confirmation" : ""].filter(Boolean); }
// Recovery guidance is derived from effective obligations, not roster size or model advice.
export function missingProcessRoleRecoveryHints(state: ProcessObligationState, roster: ReadonlySet<string>): string {
 const open = processOpenObligations(state);
 const missingPlan = open.includes("plan") && !roster.has("planner");
 const missingReview = open.includes("review") && !["code-reviewer", "plan-reviewer", "security-auditor"].some(name => roster.has(name));
 return [
  missingPlan ? "Plan requires planner: ask the human to run /af-agents-add planner or choose a roster with /af-agents-team." : "",
  missingReview ? "Review requires a reviewer: ask the human to run /af-agents-add code-reviewer (or plan-reviewer or security-auditor), or choose a roster with /af-agents-team." : "",
 ].filter(Boolean).join(" ");
}

export const taskTransitionRecoveryHint = "Pending task transition: before dependent effects, call set_task_tier with the current tier and explicit risk/scope to bind this input to the same task; for a genuinely different task use new_task: true with a reason and obtain human supersession authorization if prior obligations are open. Do not waive while pending; bind first, then use only active addition IDs for the bound task.";

export function activeAdditionRecoveryHints(state: ProcessObligationState, taskId: string, inputRevision: string | undefined): string {
 const descriptions = {
  security_change: "Security-sensitive change: independent review before acceptance (not before authoring).",
  wide_change: "Wide change: plan before effects and independent review before acceptance.",
  irreversible_execution: "Potentially irreversible execution: exact action-bound, one-use human confirmation before each effect; unsupported child/peer binding refuses the effect.",
 } as const;
 const active = normalizeProcessState(state).additions!.filter(a => a.status === "active" && a.taskId === taskId);
 if (!active.length) return "";
 return `Active System 1 additions (not baseline): ${active.map(a => `${a.id} — ${descriptions[a.reason]} ${inputRevision && a.inputRevision === inputRevision ? `To contest this exact addition, ask the human to run /af-task-triage-waive ${a.id} <reason>.` : "Waiver unavailable for this input revision; do not reuse a stale authorization."}`).join(" ")} A waiver needs human authorization and cannot remove baseline or other additions.`;
}

/** T5/D2: trusted read-only inspection route for refused shell effects.
 *  There is no regex/model-label/operator-mode exemption for arbitrary bash: unknown
 *  shell/backend stays a potential effect. The usable route is the effective catalog's
 *  deterministic inspection tools with an explicit target path — never the shell string. */
export function readOnlyInspectionRoute(): string {
 return "Usable read-only route: read/grep/find/ls with an explicit target path (or the filesystem tool when the deterministic-tools opt-in is enabled). Do not execute the shell string; no planner and no slash reset is needed for inspection.";
}
export function processActionGate(state: ProcessObligationState, contract?: ActionContract, grant?: ActionGrant): { reason: string; message: string } | null {
 const pending = normalizeProcessState(state).additions!.filter(a => a.status === "active" && a.reason === "irreversible_execution");
 if (!pending.length) return null;
 if (!contract?.actionId || !contract.taskId || !contract.inputRevision || !contract.operation || !contract.target || pending.some(a => a.taskId !== contract.taskId || a.inputRevision !== contract.inputRevision) || !consumeActionGrant(grant, contract)) return { reason: "action_confirmation_unsupported", message: "A task-triage irreversible-action signal requires exact task/revision/action-bound human confirmation; unsupported binding refuses this effect." };
 return null;
}
export function processPreEffectGate(state: ProcessObligationState, effect: "write" | "child" | "prove", persona = "", revision?: string): { reason: string; message: string } | null {
 let s: ProcessObligationState;
 try { s = normalizeProcessState(state); } catch { return { reason: "process_state_corrupt", message: "Saved process additions are invalid or oversized; dependent effects are blocked until human recovery of the session state." }; }
 // Only the Hub's direct bash/edit/write effects receive exact-action grants.
 // Only currently needed stage producers may pass the child gate. The native
 // launch restricts their tools to inspection; the Hub persists their output;
 // coms cannot supply this boundary. All other child/peer
 // effects refuse an active confirmation addition as unsupported. Even read-only
 // bash is treated as an effect: no shell-content heuristic grants an exemption.
 const stageProducer = effect === "child" && (persona === "planner"
  ? effectiveProcessStage(s, "plan") && !s.plan.evidenceRef
  : ["code-reviewer", "plan-reviewer", "security-auditor"].includes(persona) && effectiveProcessStage(s, "review") && !s.review.evidenceRef);
 if ((effect === "write" || effect === "child") && effectiveProcessStage(s, "plan") && !s.plan.evidenceRef && persona !== "planner") return { reason: "process_plan_open", message: `Process gate refused the dependent effect: the wide-task plan obligation is open. Run the planner first; if no planner is on the roster, ask the human to use /af-agents-add planner or /af-agents-team. ${readOnlyInspectionRoute()}` };
 if ((effect === "write" || effect === "child") && !stageProducer) { const confirmation = processActionGate(s); if (confirmation) return confirmation; }
 if (effect === "prove") { const open = processOpenObligations(s, revision).filter(x => x !== "acceptance" && x !== "action_confirmation"); if (open.length) return { reason: "process_obligations_open", message: `Assertion cannot become proven while process obligations are open: ${open.join(", ")}.` }; }
 return null;
}
export function evaluateProcessObligations(state: ProcessObligationState, input: { writable: boolean; budgetTier: string; t2Accepted?: boolean; currentRevision?: string }): ProcessVerdict {
 const s = normalizeProcessState(state); const additions = s.additions!.map(({ id, taskId, evaluationId, inputRevision, reason, status }) => ({ id, taskId, evaluationId, inputRevision, reason, status })); if (!input.writable) return { accepted: false, path: "read-only", risk: s.risk, scope: s.scope, budgetTier: input.budgetTier, obligations: { risk: { status: "unsupported" }, acceptance: { status: "unsupported" }, review: { status: "unsupported" }, plan: { status: "unsupported" } }, additions, appliedRuleIds: rules(s.risk, "read-only"), currentStage: "acceptance", admissibleNextAction: "continue read-only research; changed-task acceptance is unavailable", auditScope: [], explanation: `Read-only source-traceable path; T2 acceptance is unsupported and fails closed. Budget tier ${input.budgetTier} limits spend only.` };
 const status = (stage: ProcessStageState, required = stage.required, revisionBound = true): ObligationStatus => !required ? "satisfied" : stage.evidenceRef && (!revisionBound || !input.currentRevision || stage.revision === input.currentRevision) ? "satisfied" : "open";
 const obligations: ProcessVerdict["obligations"] = { risk: { status: s.risk === "unknown" ? "open" : "satisfied" }, acceptance: { status: input.t2Accepted || status(s.acceptance) === "satisfied" ? "satisfied" : "open", ...(s.acceptance.evidenceRef ? { evidenceRef: s.acceptance.evidenceRef } : {}) }, review: { status: status(s.review, effectiveProcessStage(s, "review")), ...(s.review.evidenceRef ? { evidenceRef: s.review.evidenceRef } : {}) }, plan: { status: status(s.plan, effectiveProcessStage(s, "plan"), false), ...(s.plan.evidenceRef ? { evidenceRef: s.plan.evidenceRef } : {}) } };
 const waivedOnly = (stage: "plan" | "review" | "confirmation") => !effectiveProcessStage(s, stage) && !((stage === "plan" || stage === "review") && s[stage].required) && s.additions!.some(a => a.status === "waived" && (stage === "confirmation" ? a.reason === "irreversible_execution" : stage === "plan" ? a.reason === "wide_change" : a.reason === "wide_change" || a.reason === "security_change"));
 for (const stage of ["plan", "review"] as const) if (waivedOnly(stage)) obligations[stage] = { status: "waived" };
 if (effectiveProcessStage(s, "confirmation") || waivedOnly("confirmation")) obligations.confirmation = { status: effectiveProcessStage(s, "confirmation") ? "open" : "waived" };
 // Confirmation is checked for each exact effect before execution, not a task-level acceptance stage.
 const open = Object.entries(obligations).filter(([name, x]) => name !== "confirmation" && (x.status === "open" || x.status === "unsupported")).map(([x]) => x), accepted = open.length === 0; const currentStage: ProcessStage = open.includes("risk") ? "classify-risk" : open.includes("plan") ? "plan" : open.includes("acceptance") ? "acceptance" : open.includes("review") ? "review" : "complete";
 const next = currentStage === "classify-risk" ? "set_task_tier with explicit risk and reason" : currentStage === "plan" ? "dispatch planner" : currentStage === "acceptance" ? "execute and verify the changed task" : currentStage === "review" ? "dispatch an independent reviewer over the current changed scope" : "report completion";
 return { accepted, path: "changed-task", risk: s.risk, scope: s.scope, budgetTier: input.budgetTier, obligations, additions, appliedRuleIds: s.appliedRuleIds.length ? s.appliedRuleIds : rules(s.risk,s.scope), currentStage, admissibleNextAction: next, auditScope: s.changedFiles, explanation: `Risk ${s.risk} and scope ${s.scope} determine correctness obligations; budget tier ${input.budgetTier} limits spend only.${open.length ? ` Open: ${open.join(", ")}.` : " All task-level obligations satisfied; source waivers remain waived, not satisfied."}${obligations.confirmation?.status === "open" ? " Each future effect still requires exact one-use human confirmation." : ""}` };
}
export function processAllowsPersona(state: ProcessObligationState, persona: string): boolean { const name = String(persona||"").trim().toLowerCase(), s=normalizeProcessState(state); return effectiveProcessStage(s, "plan") && name === "planner" || effectiveProcessStage(s, "review") && ["code-reviewer","plan-reviewer","security-auditor"].includes(name); }
export function processAuditRecord(state: ProcessObligationState, verdict: ProcessVerdict) { return { schema: PROCESS_OBLIGATIONS_SCHEMA, risk: verdict.risk, scope: verdict.scope, budgetTier: verdict.budgetTier, obligations: Object.fromEntries(Object.entries(verdict.obligations).map(([k,v])=>[k,{status:v.status}])), additions: verdict.additions, appliedRuleIds: verdict.appliedRuleIds, currentStage: verdict.currentStage, admissibleNextAction: verdict.admissibleNextAction, auditScope: verdict.auditScope, explanation: verdict.explanation, state: normalizeProcessState(state) }; }
export function latestProcessState(entries: readonly unknown[]): ProcessObligationState { for(let i=entries.length-1;i>=0;i--){const row=entries[i] as any,type=row?.customType??row?.type;if(type!=="agent-hub-process-state")continue;const data=row?.data;if(data?.schema===PROCESS_OBLIGATIONS_SCHEMA)return normalizeProcessState(data.state??data);}return createProcessState(); }

/** A saved addition must never authorize a different or ambiguous recovered task. */
export function processTaskIdentityConflicts(state: ProcessObligationState, taskId: string): boolean {
 const ids = new Set(state.additions?.map(addition => addition.taskId));
 return ids.size > 1 || ids.size === 1 && !ids.has(taskId);
}
