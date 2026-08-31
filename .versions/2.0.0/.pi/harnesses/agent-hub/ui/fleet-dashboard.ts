import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { ChildProcess } from "node:child_process";
import type { ModelPolicy } from "../policy/models.ts";
import type { ResearchState } from "../research/runtime.ts";
import type { DetailAgentDef, DetailAgentState, DetailUiContext } from "./detail-panel.ts";
import type { DelegationChild } from "../dispatch-core.ts";
import type { FleetRow, PeerInput, ResearchInput, SpecialistInput } from "../../lib/fleet-read-model.ts";
import { buildFleetRows, fleetTiming, summarise, unionMs } from "../../lib/fleet-read-model.ts";
import { attachFleetDashboardTicker, resolveFleetKill, resolveFleetRestart } from "../../lib/fleet-dashboard-ops.ts";
import { dashboardTransition, renderFleetDashboard, FLEET_CHROME_ROWS, type DashboardConfirm } from "../../lib/fleet-dashboard-view.ts";
import { modelPickerTransition, renderFleetSubstitutionPicker, type FleetModelChoice } from "../../lib/fleet-detail-view.ts";
import { FULLSCREEN_OVERLAY, bodyRows, clampScroll } from "../../lib/fleet-overlay.ts";
import { createPanelResources } from "../../lib/fleet-panel.ts";
import { reconcileSelection, type Selection } from "../../lib/fleet-selection.ts";
import type { HistoryEntry } from "./history-store.ts";

export interface DashboardAgentState<TDef extends DetailAgentDef> extends DetailAgentState {
	def: TDef;
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	contextTokens: number;
	histEntry?: HistoryEntry;
	delegations?: Map<string, DelegationChild>;
	lastBackend?: "native" | "coms";
	comsPeerModel?: string;
	proc?: ChildProcess;
	comsAbort?: () => void;
	killedByOperator?: boolean;
	runCount: number;
}

export interface FleetDashboardDeps<TDef extends DetailAgentDef, TAgent extends DashboardAgentState<TDef>, TResearch extends ResearchState<TDef>> {
	getAgents(): ReadonlyMap<string, TAgent>;
	getResearch(): ReadonlyMap<number, TResearch>;
	getShowFinished(): boolean;
	setShowFinished(value: boolean): void;
	getFilter(): string;
	setFilter(value: string): void;
	getPeerInputs(formatModel?: (model: string) => string): PeerInput[];
	parseResearchHandle(value: string): number | null;
	displayName(name: string): string;
	shortModel(model: string | undefined): string;
	thinkingSuffix(thinking: string | undefined): string;
	modelWithThinking(def: TDef): string;
	resolvedThinking(def: TDef): string | undefined;
	abbreviatePeerModel(model: string): string;
	modelPolicy: ModelPolicy<TDef>;
	loadAvailableModels(ctx: DetailUiContext, current?: string): Promise<FleetModelChoice[] | null>;
	openDetail(row: FleetRow, ctx: DetailUiContext, verbose?: boolean): Promise<boolean>;
	modelWorkBlocked(ctx: DetailUiContext): boolean;
	restartResearch(state: TResearch, ctx: DetailUiContext): void;
	restartSpecialist(state: TAgent, ctx: DetailUiContext): Promise<void>;
	removeResearch(state: TResearch, ctx: DetailUiContext): void;
	killSpecialistProcess(state: TAgent): void;
	abortComs(state: TAgent): void;
}

type SubstitutionPicker = { stage: "source" | "target"; source?: string; choices: FleetModelChoice[]; index: number; scrollOffset: number };

export function createFleetDashboard<TDef extends DetailAgentDef, TAgent extends DashboardAgentState<TDef>, TResearch extends ResearchState<TDef>>(deps: FleetDashboardDeps<TDef, TAgent, TResearch>) {
	function fleetRows(unfiltered = false): FleetRow[] {
		const specialists: SpecialistInput[] = Array.from(deps.getAgents().entries()).map(([key, state]) => ({
			key, name: deps.displayName(state.def.name), status: state.status,
			model: state.lastBackend === "coms" ? `⇄ ${deps.shortModel(state.comsPeerModel)}` : deps.modelWithThinking(state.def), backend: state.lastBackend ?? "native",
			contextPct: state.contextPct, contextTokens: state.contextTokens, ...fleetTiming(state.histEntry), toolCount: state.toolCount,
			lastWork: state.lastWork || state.task || state.def.description, hasTimeline: true,
			delegates: Array.from(state.delegations?.values() ?? []).map(child => ({ key: child.id, name: child.role || child.id, status: child.status, model: deps.shortModel(child.model), contextPct: null, contextTokens: child.tokens, elapsed: child.status === "running" ? Date.now() - child.startedAt : child.elapsed, startedAt: child.startedAt, toolCount: child.toolCount, lastWork: child.lastWork, children: [] })),
		}));
		const research: ResearchInput[] = Array.from(deps.getResearch().values()).map(state => ({ key: `r${state.id}`, name: `r${state.id} ${state.persona ? deps.displayName(state.def.name) : "research"}`, status: state.status, model: deps.shortModel(state.model) + deps.thinkingSuffix(deps.resolvedThinking(state.def)), backend: "native", contextPct: state.contextPct, contextTokens: null, ...fleetTiming(state.histEntry), toolCount: state.toolCount, lastWork: state.lastWork || state.task, hasTimeline: true }));
		const peers = deps.getPeerInputs(model => `⇄ ${deps.abbreviatePeerModel(model)}`);
		return buildFleetRows({ specialists, research, peers }, unfiltered ? { showFinished: true } : { showFinished: deps.getShowFinished(), query: deps.getFilter() });
	}

	function substitutionSourceChoices(): FleetModelChoice[] {
		return deps.modelPolicy.allKnownModels().map(spec => { const target = deps.modelPolicy.getSubstitution(spec); return { spec, label: target ? `${spec} → ${target} (active this session)` : spec }; });
	}

	async function restartRow(selected: FleetRow, ctx: DetailUiContext): Promise<void> {
		if (deps.modelWorkBlocked(ctx)) return;
		const decision = resolveFleetRestart(selected, {
			researchRestartable: key => { const id = deps.parseResearchHandle(key); const state = id == null ? undefined : deps.getResearch().get(id); return !!(state?.task && state.status !== "running"); },
			specialistRestartable: key => !!deps.getAgents().get(key)?.task,
		});
		if (decision.action === "unsupported") { ctx.ui.notify(decision.message, decision.level); return; }
		if (decision.action === "restart-research") {
			const id = deps.parseResearchHandle(selected.key), state = id == null ? undefined : deps.getResearch().get(id);
			if (!state?.task) { ctx.ui.notify(decision.message.replace("Restarting", "Cannot restart"), "warning"); return; }
			ctx.ui.notify(decision.message, "info"); deps.restartResearch(state, ctx); return;
		}
		const state = deps.getAgents().get(selected.key);
		if (!state?.task) { ctx.ui.notify(decision.message.replace("Restarting", "Cannot restart"), "warning"); return; }
		ctx.ui.notify(decision.message.includes(deps.displayName(state.def.name)) ? decision.message : `Restarting ${deps.displayName(state.def.name)} (fresh)...`, "info");
		await deps.restartSpecialist(state, ctx);
	}

	function killRow(selected: FleetRow, ctx: DetailUiContext): void {
		const decision = resolveFleetKill(selected, {
			researchExists: key => { const id = deps.parseResearchHandle(key); return id != null && deps.getResearch().has(id); },
			agentHandles: key => { const agent = deps.getAgents().get(key); return agent ? { proc: agent.proc, comsAbort: agent.comsAbort } : undefined; },
		});
		if (decision.action === "kill-research") {
			const id = deps.parseResearchHandle(selected.key), state = id == null ? undefined : deps.getResearch().get(id);
			if (state) { deps.removeResearch(state, ctx); ctx.ui.notify(decision.message, "info"); } else ctx.ui.notify(`Research ${selected.name} is no longer available.`, "warning");
		} else if (decision.action === "kill-proc") {
			const state = deps.getAgents().get(selected.key)!; state.killedByOperator = true; deps.killSpecialistProcess(state); ctx.ui.notify(decision.message, "info");
		} else if (decision.action === "coms-abort") { const state = deps.getAgents().get(selected.key); if (state) deps.abortComs(state); ctx.ui.notify(decision.message, "info"); }
		else ctx.ui.notify(decision.message, decision.level);
	}

	async function openFleetDashboard(ctx: DetailUiContext, startSubstitution = false): Promise<void> {
		const resources = createPanelResources(), selection: Selection = { index: 0 };
		let scrollOffset = 0, filtering = false, detailVerbose = false, confirm: DashboardConfirm = null;
		let picker: SubstitutionPicker | null = startSubstitution ? { stage: "source", choices: substitutionSourceChoices(), index: 0, scrollOffset: 0 } : null;
		const toInput = (data: string) => matchesKey(data, Key.up) ? "\u001b[A" : matchesKey(data, Key.down) ? "\u001b[B" : matchesKey(data, Key.pageUp) ? "\u001b[5~" : matchesKey(data, Key.pageDown) ? "\u001b[6~" : matchesKey(data, Key.enter) ? "\r" : matchesKey(data, Key.escape) ? "\u001b" : data;
		try { await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => {
			attachFleetDashboardTicker(resources, () => tui.requestRender());
			return { render: (w: number) => { const rows = fleetRows(); reconcileSelection(selection, rows); const body = bodyRows(tui.terminal?.rows, FLEET_CHROME_ROWS); if (picker) return renderFleetSubstitutionPicker(picker.stage, picker.source, picker.choices, picker, w, body, theme); scrollOffset = clampScroll(scrollOffset, rows.length, body); const summary = summarise(rows); return renderFleetDashboard({ rows, selection, scrollOffset, filterQuery: deps.getFilter(), showFinished: deps.getShowFinished(), confirmation: confirm && confirm.until > Date.now() ? `press ${confirm.action === "kill" ? "x" : "r"} again to ${confirm.action} ${rows.find(row => row.key === confirm!.key)?.name ?? "agent"}` : undefined, summary: { ...summary, wallMs: unionMs(summary.intervals) } }, w, body, theme); },
				handleInput: async (data: string) => { const rows = fleetRows(); reconcileSelection(selection, rows); const body = bodyRows(tui.terminal?.rows, FLEET_CHROME_ROWS), input = toInput(data);
					if (picker) { const action = modelPickerTransition(input, picker, picker.choices.length, body); if (action === "cancel") { if (picker.stage === "target") { const source = picker.source, choices = substitutionSourceChoices(), index = Math.max(0, choices.findIndex(choice => choice.spec === source)); picker = { stage: "source", choices, index, scrollOffset: index }; } else picker = null; } else if (action === "select") { const picked = picker.choices[picker.index]?.spec; if (picked && picker.stage === "source") { const targets = await deps.loadAvailableModels(ctx, deps.modelPolicy.getSubstitution(picked)); if (targets) { const current = deps.modelPolicy.getSubstitution(picked), index = Math.max(0, targets.findIndex(choice => choice.spec === current)); picker = { stage: "target", source: picked, choices: targets, index, scrollOffset: index }; } } else if (picked && picker.source) { await deps.modelPolicy.applySessionSubstitution(picker.source, picked, { loadAvailable: current => deps.loadAvailableModels(ctx, current), notify: (message, level) => ctx.ui.notify(message, level) }); picker = null; } } tui.requestRender(); return; }
					const state = { selection, scrollOffset, filtering, filterQuery: deps.getFilter(), showFinished: deps.getShowFinished(), confirm }, intent = dashboardTransition(input, state, rows, body); ({ scrollOffset, filtering, confirm } = state); deps.setFilter(state.filterQuery); deps.setShowFinished(state.showFinished);
					if (intent === "close") done(); else if (intent === "substitute") { const choices = substitutionSourceChoices(); if (!choices.length) ctx.ui.notify("No configured persona or sub-role models are available as substitution sources.", "warning"); else picker = { stage: "source", choices, index: 0, scrollOffset: 0 }; } else if (intent && typeof intent === "object" && "open" in intent) { const selected = rows.find(row => row.key === intent.open) ?? rows[selection.index]; if (selected) detailVerbose = await deps.openDetail(selected, ctx, detailVerbose); } else if (intent && typeof intent === "object" && "kill" in intent) { const selected = rows.find(row => row.key === intent.kill); if (selected) killRow(selected, ctx); else ctx.ui.notify("Selected fleet row no longer exists.", "warning"); } else if (intent && typeof intent === "object" && "restart" in intent) { const selected = rows.find(row => row.key === intent.restart); if (selected) await restartRow(selected, ctx); } tui.requestRender(); },
				invalidate() {}, dispose: () => resources.dispose() };
		}, FULLSCREEN_OVERLAY); } finally { resources.dispose(); }
	}

	return { fleetRows, openFleetDashboard };
}
