import { profilePeerRefusal } from '../policy/profile-runtime.ts';
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_TASK_TIER, applyTierChange } from "../run-budget.js";
import { validateAssertionBatch } from "../assertion-ledger.js";
import { validateEvidence } from "../evidence-rules.js";
import { safePathWithin } from "../helpers.ts";
import { TIMEOUT_MS } from "../../lib/coms-core.ts";
import type { Assertion, AssertionStatus, AssertionsArtifactsContext } from "../context/assertions-artifacts.ts";
import type { BudgetContext, TurnReport } from "../context/budgets.ts";
import type { HubStateContext } from "../context/hub-state.ts";
import type {
	ComsAwaitParams, ComsGetParams, ComsListParams, ComsSendParams, SetAssertionsParams,
	SetTaskTierParams, TeamAdjustParams, ToolExecutionResult, ToolExecutor, UpdateAssertionParams,
} from "./context.ts";

const TEAM_ADJUST_ROSTER_CAP = 8;
type Refusal = ToolExecutionResult | null;

export interface ActionExecutorDeps {
	budget: BudgetContext;
	artifacts: AssertionsArtifactsContext;
	hubState: HubStateContext;
	provisionalCapabilityRefusal(pack: "fleet" | "peer"): Refusal;
	getTaskTier(): string | null;
	setTaskTier(value: string): void;
	getTaskTierAssumed(): boolean;
	setTaskTierAssumed(value: boolean): void;
	getTaskDispatchCount(): number;
	getTaskResearchCount(): number;
	getTurnReport(): TurnReport;
	getAssertions(): Assertion[];
	setAssertions(value: Assertion[]): void;
	getAgentStates(): Map<string, { def: { name: string } }>;
	rosterAdd(agent: string): { ok: boolean; message: string };
	rosterDrop(agent: string): { ok: boolean; message: string };
	getIdentity(): unknown | null;
	getComs(): any;
	resolveTarget(target: string): { name: string } | null;
	appendMachineHandoffSections(brief: string): string;
	markPeerAddressed(name: string): void;
}

export interface ActionExecutors {
	executeSetTaskTier: ToolExecutor<SetTaskTierParams>;
	executeTeamAdjust: ToolExecutor<TeamAdjustParams>;
	executeSetAssertions: ToolExecutor<SetAssertionsParams>;
	executeUpdateAssertion: ToolExecutor<UpdateAssertionParams>;
	executeGetAssertions: ToolExecutor<Record<string, never>>;
	executeComsList: ToolExecutor<ComsListParams>;
	executeComsSend: ToolExecutor<ComsSendParams>;
	executeComsGet: ToolExecutor<ComsGetParams>;
	executeComsAwait: ToolExecutor<ComsAwaitParams>;
}

export function createActionExecutors(d: ActionExecutorDeps): ActionExecutors {
	const executeSetTaskTier: ToolExecutor<SetTaskTierParams> = async (_callId, params, _signal, _onUpdate, ctx) => {
		const { tier, reason, new_task } = params;
		if (!new_task) { const refusal = d.provisionalCapabilityRefusal("fleet"); if (refusal) return refusal; }
		const currentTier = new_task ? null : (d.getTaskTierAssumed() ? null : d.getTaskTier());
		const change = applyTierChange(currentTier, tier, reason);
		if (!change.ok) return { content: [{ type: "text", text: change.message }], details: { status: "error", reason: change.reason, tier: change.tier } };
		if (new_task) {
			const resetAt = Date.now();
			const prior = d.budget.taskResetSnapshot(resetAt);
			d.budget.resetTaskWindow(null, resetAt);
			d.budget.appendTaskResetEntry("tool:set_task_tier", null, prior, ctx);
		}
		d.setTaskTier(change.tier); d.setTaskTierAssumed(false); d.getTurnReport().tier = change.tier; d.budget.updateModeStatus();
		const b = d.budget.currentBudget(); const tb = d.budget.currentTaskBudget();
		const cap = (n: number | null) => n == null ? "unlimited" : String(n);
		const spent = `${d.getTaskDispatchCount()}/${cap(tb.maxDispatches)} dispatches, ${d.getTaskResearchCount()}/${cap(tb.maxResearch)} research`;
		return { content: [{ type: "text", text: `${change.message}${new_task ? " (new task window opened)" : ""}\nPer turn: ${cap(b.maxDispatches)} dispatches, ${cap(b.maxResearch)} research. Whole task: ${spent} spent. Size the apparatus accordingly — do not spend a cap just because it exists.` }], details: { status: "ok", tier: change.tier, escalated: change.escalated, newTask: !!new_task } };
	};

	const executeTeamAdjust: ToolExecutor<TeamAdjustParams> = async (_id, params, _signal, _update, ctx) => {
		const refusal = d.provisionalCapabilityRefusal("fleet"); if (refusal) return refusal;
		const act = String(params.action || "").trim().toLowerCase();
		if (!d.budget.currentBudget().delegation) {
			const tier = d.getTaskTier() ?? DEFAULT_TASK_TIER;
			return { content: [{ type: "text", text: `team_adjust is disabled at tier "${tier}" — a single-specialist path never needs roster changes. Raise the task tier with set_task_tier if the work outgrew "${tier}".` }], details: { status: "refused" } };
		}
		if (act !== "add" && act !== "drop") return { content: [{ type: "text", text: `Unknown action "${params.action}" — expected add or drop.` }], details: { status: "error" } };
		if (act === "add" && d.getAgentStates().size >= TEAM_ADJUST_ROSTER_CAP) return { content: [{ type: "text", text: `Roster cap reached (${TEAM_ADJUST_ROSTER_CAP}) — drop an unused member first, or ask the user to /af-agents-add manually.` }], details: { status: "refused" } };
		const result = act === "add" ? d.rosterAdd(params.agent) : d.rosterDrop(params.agent);
		if (result.ok) ctx.ui.notify(`team_adjust (${act}): ${result.message} — dispatcher's reason: ${params.reason || "(none given)"}`, "info");
		const roster = Array.from(d.getAgentStates().values()).map(s => s.def.name).join(", ");
		return { content: [{ type: "text", text: `${result.message}. Active team: ${roster}.` }], details: { status: result.ok ? "ok" : "refused", roster } };
	};

	const executeSetAssertions: ToolExecutor<SetAssertionsParams> = async (_id, params, _signal, _update, ctx) => {
		const verdict = validateAssertionBatch(params.assertions);
		if (!verdict.ok) return { content: [{ type: "text", text: verdict.refusal! }], details: { status: "rejected", reason: "missing-source" } };
		const assertions = verdict.assertions.map(a => ({ ...a, status: "open" as AssertionStatus })); d.setAssertions(assertions);
		d.artifacts.persistAssertions(); d.artifacts.updateAssertionStatus();
		if (verdict.warning) ctx.ui.notify(verdict.warning, "warning");
		const head = `Ledger set: ${assertions.length} assertion(s) open — ${assertions.map(a => a.id).join(", ") || "(none)"}. Pass the relevant ones verbatim into each dispatch and advance only on proven.`;
		return { content: [{ type: "text", text: verdict.warning ? `${head}\n\n${verdict.warning}` : head }], details: { count: assertions.length, capWarning: Boolean(verdict.warning) } };
	};

	const executeUpdateAssertion: ToolExecutor<UpdateAssertionParams> = async (_id, params) => {
		const assertions = d.getAssertions(); const wanted = String(params.status).trim().toLowerCase();
		if (!["proven", "unproven", "failed"].includes(wanted)) return { content: [{ type: "text", text: `status must be one of proven | unproven | failed (got "${params.status}").` }], details: { status: "error" } };
		const a = assertions.find(x => x.id.toLowerCase() === String(params.id).trim().toLowerCase());
		if (!a) return { content: [{ type: "text", text: `No assertion "${params.id}" in the ledger. Call set_assertions first, or check the id. Current: ${assertions.map(x => x.id).join(", ") || "(empty)"}.` }], details: { status: "error" } };
		if (wanted === "proven") {
			const validation = validateEvidence(a.tag, params.evidence || "", { fileExists: d.artifacts.evidencePathExists, evidenceRoot: safePathWithin(d.artifacts.artifactsRoot(), "evidence") });
			if (!validation.ok) return { content: [{ type: "text", text: `${a.id} stays ${a.status}: ${validation.reason}` }], details: { status: "rejected", reason: validation.reason } };
		}
		a.status = wanted as AssertionStatus; a.evidence = wanted === "unproven" ? undefined : (params.evidence?.trim() || undefined);
		d.artifacts.persistAssertions(); d.artifacts.updateAssertionStatus();
		const open = assertions.filter(x => x.status === "open" || x.status === "unproven").map(x => x.id); const failed = assertions.filter(x => x.status === "failed").map(x => x.id);
		const tail = failed.length ? `Failed: ${failed.join(", ")}. Still open: ${open.join(", ") || "none"}.` : open.length ? `Still open: ${open.join(", ")}.` : "All assertions proven.";
		return { content: [{ type: "text", text: `${a.id} → ${a.status}${a.evidence ? ` (${a.evidence})` : ""}. ${tail}` }], details: { id: a.id, status: a.status } };
	};

	const executeGetAssertions: ToolExecutor<Record<string, never>> = async () => d.getAssertions().length === 0
		? { content: [{ type: "text", text: "Ledger is empty. Call set_assertions to build the acceptance assertions before dispatching." }], details: { count: 0 } }
		: { content: [{ type: "text", text: d.artifacts.renderAssertionLedgerText() }], details: { count: d.getAssertions().length } };

	const executeComsList: ToolExecutor<ComsListParams> = async (_id, params) => {
		if (!d.getIdentity()) return { content: [{ type: "text", text: "coms not initialised." }], details: { agents: [], project: null } };
		const coms = d.getComs(); const result = await coms.list(params);
		const notice = result.widenRequested ? `\n\n(Discovery is scoped to "${result.project}"${coms.scope.includeExplicit ? "" : ", explicit peers hidden"}. Widening to other projects or revealing --explicit peers is a human action via /af-coms --project <name> or /af-coms --all.)` : "";
		const lines = result.agents.length === 0 ? "No peer agents in your pool." : result.agents.map((agent: any) => `${agent.alive ? "●" : "✗"} ${agent.name} (${agent.model})${agent.context_used_pct != null ? ` ${agent.context_used_pct}%` : " ?%"} [${agent.alive ? agent.status ?? "unknown" : "unreachable"}${agent.pane_id ? ` pane ${agent.pane_id}` : ""}]${agent.purpose ? ` — ${agent.purpose}` : ""}`).join("\n");
		return { content: [{ type: "text", text: `${result.agents.length} peer(s) in pool (project ${result.project}):\n${lines}${notice}` }], details: result };
	};
	const executeComsSend: ToolExecutor<ComsSendParams> = async (_id, params) => {
		const profileRefusal=profilePeerRefusal();if(profileRefusal) return profileRefusal;
		const refusal = d.provisionalCapabilityRefusal("peer"); if (refusal) return refusal;
		const target = d.resolveTarget(params.target); const pending = d.hubState.getPendingHandoff();
		const authorized = !!(target && pending && pending.target === target.name && params.handoff_token === pending.token);
		const prompt = authorized ? d.appendMachineHandoffSections(String(params.prompt || "")) : String(params.prompt || "");
		const sent = await d.getComs().send({ target: params.target, prompt, conversation_id: params.conversation_id ?? null, response_schema: (params.response_schema as object | undefined) ?? null, reply_timeout_ms: params.reply_timeout_ms ?? null });
		d.markPeerAddressed(sent.target); if (authorized) d.hubState.setPendingHandoff(null);
		return { content: [{ type: "text", text: `coms_send → ${sent.target}\nmsg_id ${sent.msg_id}\nhops ${sent.hops}` }], details: { msg_id: sent.msg_id, target: sent.target, target_session: sent.target_session, hops: sent.hops } };
	};
	const executeComsGet: ToolExecutor<ComsGetParams> = async (_id, params) => {
		const result = d.getComs().get(params.msg_id); const text = result.status === "error" ? `coms_get: unknown msg_id ${params.msg_id}` : result.status === "pending" ? "coms_get: pending" : result.error ? `coms_get: error — ${result.error}` : `coms_get: complete\n${typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2)}`;
		return { content: [{ type: "text", text }], details: result };
	};
	const executeComsAwait: ToolExecutor<ComsAwaitParams> = async (_id, params) => {
		const result = await d.getComs().await(params.msg_id, typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : TIMEOUT_MS);
		if (result.status === "pending") return { content: [{ type: "text", text: "coms_await: pending — wait budget exhausted; the peer may still complete" }], details: { status: "pending" } };
		if (result.status === "error") { const unknown = result.error === "unknown msg_id"; return { content: [{ type: "text", text: unknown ? `coms_await: unknown msg_id ${params.msg_id}` : `coms_await: error — ${result.error}` }], details: unknown ? { error: "unknown msg_id" } : { status: "error", error: result.error } }; }
		return { content: [{ type: "text", text: typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2) }], details: { response: result.response } };
	};
	return { executeSetTaskTier, executeTeamAdjust, executeSetAssertions, executeUpdateAssertion, executeGetAssertions, executeComsList, executeComsSend, executeComsGet, executeComsAwait };
}
