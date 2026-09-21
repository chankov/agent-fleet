import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { ChildProcess } from "node:child_process";
import type { ModelPolicy } from "../policy/models.ts";
import type { ResearchState } from "../research/runtime.ts";
import type { DetailAgentDef, DetailAgentState, DetailUiContext } from "./detail-panel.ts";
import type { DelegationChild } from "../dispatch-core.ts";
import type { FleetRow } from "../../lib/fleet-read-model.ts";
import { summarise, unionMs } from "../../lib/fleet-read-model.ts";
import { attachFleetDashboardTicker } from "../../lib/fleet-dashboard-ops.ts";
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
	getFleetRows(now: number, unfiltered: boolean): FleetRow[];
	actions: {
		open(key: string, runToken: string | undefined, ctx: DetailUiContext, verbose?: boolean): Promise<boolean>;
		execute(action: "kill" | "restart", key: string, runToken: string | undefined, ctx: DetailUiContext): Promise<void>;
	};
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
	openHistory(ctx: DetailUiContext): Promise<void>;
	modelWorkBlocked(ctx: DetailUiContext): boolean;
	restartSpecialist(state: TAgent, ctx: DetailUiContext): Promise<void>;
	removeResearch(state: TResearch, ctx: DetailUiContext): void;
	killSpecialistProcess(state: TAgent): void;
	abortComs(state: TAgent): void;
	getComsLines(width: number, theme: { fg(color: string, text: string): string }): string[];
}

type SubstitutionPicker = { stage: "source" | "target"; source?: string; choices: FleetModelChoice[]; index: number; scrollOffset: number };

export function createFleetDashboard<TDef extends DetailAgentDef, TAgent extends DashboardAgentState<TDef>, TResearch extends ResearchState<TDef>>(deps: FleetDashboardDeps<TDef, TAgent, TResearch>) {
	function fleetRows(unfiltered = false, now = Date.now()): FleetRow[] {
		return deps.getFleetRows(now, unfiltered);
	}

	function substitutionSourceChoices(): FleetModelChoice[] {
		return deps.modelPolicy.allKnownModels().map(spec => { const target = deps.modelPolicy.getSubstitution(spec); return { spec, label: target ? `${spec} → ${target} (active this session)` : spec }; });
	}

	async function restartRow(selected: FleetRow, ctx: DetailUiContext): Promise<void> {
		if (deps.modelWorkBlocked(ctx)) return;
		await deps.actions.execute("restart", selected.key, selected.runToken, ctx);
	}

	async function openFleetDashboard(ctx: DetailUiContext, startSubstitution = false): Promise<void> {
		const resources = createPanelResources(), selection: Selection = { index: 0 };
		let scrollOffset = 0, filtering = false, detailVerbose = false, confirm: DashboardConfirm = null;
		let picker: SubstitutionPicker | null = startSubstitution ? { stage: "source", choices: substitutionSourceChoices(), index: 0, scrollOffset: 0 } : null;
		const toInput = (data: string) => matchesKey(data, Key.up) ? "\u001b[A" : matchesKey(data, Key.down) ? "\u001b[B" : matchesKey(data, Key.pageUp) ? "\u001b[5~" : matchesKey(data, Key.pageDown) ? "\u001b[6~" : matchesKey(data, Key.enter) ? "\r" : matchesKey(data, Key.escape) ? "\u001b" : data;
		try { await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => {
			attachFleetDashboardTicker(resources, () => tui.requestRender());
			return { render: (w: number) => { const now = Date.now(), rows = fleetRows(false, now); reconcileSelection(selection, rows); const comsLines = deps.getComsLines(w, theme); const body = bodyRows(tui.terminal?.rows, FLEET_CHROME_ROWS + comsLines.length); if (picker) return renderFleetSubstitutionPicker(picker.stage, picker.source, picker.choices, picker, w, body, theme); scrollOffset = clampScroll(scrollOffset, rows.length, body); const summary = summarise(rows); return renderFleetDashboard({ rows, selection, scrollOffset, filterQuery: deps.getFilter(), showFinished: deps.getShowFinished(), confirmation: confirm && confirm.until > now ? `press ${confirm.action === "kill" ? "x" : "r"} again to ${confirm.action} ${rows.find(row => row.key === confirm!.key && row.runToken === confirm!.runToken)?.name ?? "agent"}` : undefined, summary: { ...summary, wallMs: unionMs(summary.intervals) }, comsLines }, w, body, theme, { visibleWidth, truncateToWidth }); },
				handleInput: async (data: string) => { const now = Date.now(), rows = fleetRows(false, now); reconcileSelection(selection, rows); const body = bodyRows(tui.terminal?.rows, FLEET_CHROME_ROWS), input = toInput(data);
					if (picker) { const action = modelPickerTransition(input, picker, picker.choices.length, body); if (action === "cancel") { if (picker.stage === "target") { const source = picker.source, choices = substitutionSourceChoices(), index = Math.max(0, choices.findIndex(choice => choice.spec === source)); picker = { stage: "source", choices, index, scrollOffset: index }; } else picker = null; } else if (action === "select") { const picked = picker.choices[picker.index]?.spec; if (picked && picker.stage === "source") { const targets = await deps.loadAvailableModels(ctx, deps.modelPolicy.getSubstitution(picked)); if (targets) { const current = deps.modelPolicy.getSubstitution(picked), index = Math.max(0, targets.findIndex(choice => choice.spec === current)); picker = { stage: "target", source: picked, choices: targets, index, scrollOffset: index }; } } else if (picked && picker.source) { await deps.modelPolicy.applySessionSubstitution(picker.source, picked, { loadAvailable: current => deps.loadAvailableModels(ctx, current), notify: (message, level) => ctx.ui.notify(message, level) }); picker = null; } } tui.requestRender(); return; }
					const state = { selection, scrollOffset, filtering, filterQuery: deps.getFilter(), showFinished: deps.getShowFinished(), confirm }, intent = dashboardTransition(input, state, rows, body, now); ({ scrollOffset, filtering, confirm } = state); deps.setFilter(state.filterQuery); deps.setShowFinished(state.showFinished);
					if (intent === "close") done(); else if (intent === "history") { confirm = null; await deps.openHistory(ctx); } else if (intent === "substitute") { confirm = null; const choices = substitutionSourceChoices(); if (!choices.length) ctx.ui.notify("No configured persona or sub-role models are available as substitution sources.", "warning"); else picker = { stage: "source", choices, index: 0, scrollOffset: 0 }; } else if (intent && typeof intent === "object" && "open" in intent) { const selected = rows.find(row => row.key === intent.open); confirm = null; if (selected) detailVerbose = await deps.actions.open(selected.key, selected.runToken, ctx, detailVerbose); } else if (intent && typeof intent === "object" && "kill" in intent) { const selected = rows.find(row => row.key === intent.kill); if (selected) await deps.actions.execute("kill", selected.key, selected.runToken, ctx); else ctx.ui.notify("Selected fleet row no longer exists.", "warning"); } else if (intent && typeof intent === "object" && "restart" in intent) { const selected = rows.find(row => row.key === intent.restart); if (selected) await restartRow(selected, ctx); } tui.requestRender(); },
				invalidate() {}, dispose: () => resources.dispose() };
		}, FULLSCREEN_OVERLAY); } finally { resources.dispose(); }
	}

	return { fleetRows, openFleetDashboard };
}
