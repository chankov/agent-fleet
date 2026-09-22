import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { ModelPolicy } from "../policy/models.ts";
import type { ContextPressureState } from "../context-pressure.ts";
import { contextPressureDiagnostic } from "../context-pressure.ts";
import type { ResearchState } from "../research/runtime.ts";
import type { DetailAgentDef } from "./detail-panel.ts";
import type { DashboardAgentState } from "./fleet-dashboard.ts";
import { resolveContextWindow } from "../context-window.js";
import { collectContextBudgetSnapshot, type LivePlane } from "../context-budget-snapshot.ts";
import { CONTEXT_BUDGET_CHROME_ROWS, contextBudgetTransition, renderContextBudget, type ContextBudgetViewState } from "../../lib/context-budget-view.ts";
import { safeSchemaChars } from "../../lib/context-budget.ts";
import {
	buildSpecialistContextManifest, delegateStandingParts, nativeResearchSystemPrompt,
	nativeSpecialistSystemPrompt, researchStandingParts, specialistStandingParts,
} from "../../lib/context-budget-child-prompt.ts";
import { FULLSCREEN_OVERLAY, bodyRows } from "../../lib/fleet-overlay.ts";
import { createPanelResources } from "../../lib/fleet-panel.ts";

export interface ContextBudgetUiContext {
	cwd?: string;
	getSystemPromptOptions?(): unknown;
	ui: { custom(factory: (tui: any, theme: any, kb: any, done: () => void) => any, options: unknown): Promise<unknown> };
}

export interface ContextBudgetDeps<TDef extends DetailAgentDef, TAgent extends DashboardAgentState<TDef>, TResearch extends ResearchState<TDef>> {
	getAgents(): ReadonlyMap<string, TAgent>;
	getResearch(): ReadonlyMap<number, TResearch>;
	getAllDefs(): readonly TDef[];
	getResearchPersonas(): readonly TDef[];
	getPeers(): Iterable<{ name: string; model?: string; context_used_pct?: number }>;
	modelPolicy: ModelPolicy<TDef>;
	displayName(name: string): string;
	getProjectDocsPaths(): readonly string[];
	getUserLanguage(): string;
	getDelegateExtensionPath(): string | null;
	safeAgentKey(name: string): string;
	projectPolicyPaths(cwd: string): string[];
	modelWindowLookup(ctx: ContextBudgetUiContext): (model: string) => number | undefined;
	getResearchTools(): string;
	getPromptLedger(): readonly unknown[];
	getPressureState(): ContextPressureState;
	buildHubSystemPrompt(): void;
	getAllTools(): readonly any[];
	getActiveTools(): readonly string[];
	getCommands(): readonly any[];
}

export function createContextBudgetUi<TDef extends DetailAgentDef, TAgent extends DashboardAgentState<TDef>, TResearch extends ResearchState<TDef>>(deps: ContextBudgetDeps<TDef, TAgent, TResearch>) {
	function toolSchemaChars(toolList: string): number {
		const names = toolList.split(",").map(name => name.trim()).filter(Boolean);
		const byName = new Map(deps.getAllTools().map(tool => [tool.name, tool]));
		return names.reduce((sum, name) => { const tool = byName.get(name); return sum + (tool ? safeSchemaChars({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines }) : name.length); }, 0);
	}

	function contextPlanes(ctx: ContextBudgetUiContext): LivePlane[] {
		const agents = deps.getAgents(), researchStates = deps.getResearch(), baseChars = safeSchemaChars(ctx.getSystemPromptOptions?.() ?? {}), cwd = ctx.cwd || process.cwd();
		const projection = (def: TDef, research = false) => research
			? researchStandingParts({ replacementPrompt: nativeResearchSystemPrompt({ personaName: def.name, personaPath: def.file, cwd }), toolChars: toolSchemaChars(deps.getResearchTools()), basePromptChars: 0 })
			: specialistStandingParts({ replacementPrompt: nativeSpecialistSystemPrompt({ manifest: agents.get(def.name.toLowerCase())?.specialistManifest ?? buildSpecialistContextManifest({ personaName: def.name, personaPath: def.file, personaPrompt: def.systemPrompt, task: "", rulesPaths: deps.projectPolicyPaths(cwd), docsPaths: [...deps.getProjectDocsPaths()], hasAssertions: false, hasScope: false, hasArtifacts: false, delegateRoles: def.subagents && deps.getDelegateExtensionPath() ? Object.keys(def.subagents) : [] }), userLanguage: deps.getUserLanguage(), agentKey: deps.safeAgentKey(def.name), runNumber: agents.get(def.name.toLowerCase())?.runCount ?? 0 }), toolChars: toolSchemaChars(def.tools) });
		const windowFor = (model: string) => model ? resolveContextWindow(model, { lookup: deps.modelWindowLookup(ctx), fallbackWindow: 0 }).window || undefined : undefined;
		const local = deps.getAllDefs().filter(def => def.kind !== "research").map(def => { const state = agents.get(def.name.toLowerCase()), model = deps.modelPolicy.resolvedModel(state?.def as TDef ?? def) ?? ""; return { id: `specialist/${def.name}`, label: deps.displayName(def.name), plane: "specialist" as const, model, window: windowFor(model), tokens: state?.contextTokens, projectionParts: projection(def) }; });
		const research = deps.getResearchPersonas().map(def => { const active = Array.from(researchStates.values()).find(state => state.def.name === def.name), model = active?.model ?? deps.modelPolicy.resolvedModel(def) ?? ""; return { id: `research/${def.name}`, label: deps.displayName(def.name), plane: "research" as const, model, window: windowFor(model), tokens: active?.contextTokens, projectionParts: projection(def, true), attribution: "projected" as const }; });
		const delegates = Array.from(agents.values()).flatMap(state => Array.from(state.delegations?.values() ?? []).map(child => { const role = Object.entries(state.def.subagents ?? {}).find(([name]) => name.toLowerCase() === child.role.toLowerCase()); const parts = role ? delegateStandingParts({ toolChars: toolSchemaChars(child.tools || role[1].tools || state.def.tools), basePromptChars: baseChars, roleNames: [role[0]] }) : undefined; return parts ? { id: `delegate/${child.id}`, label: child.role, plane: "delegate" as const, model: child.model, window: windowFor(child.model), tokens: child.tokens, projectionParts: parts, attribution: "projected" as const } : { id: `delegate/${child.id}`, label: child.role, plane: "delegate" as const, model: child.model, window: windowFor(child.model), tokens: child.tokens, attribution: "unavailable" as const }; }));
		const peers = Array.from(deps.getPeers()).map(peer => ({ id: `peer/${peer.name}`, label: peer.name, plane: "peer" as const, model: peer.model, window: windowFor(peer.model ?? ""), percent: peer.context_used_pct, projectionChars: 0, attribution: "unavailable" as const }));
		return [...local, ...research, ...delegates, ...peers];
	}

	async function openContextBudget(ctx: ContextBudgetUiContext): Promise<void> {
		const resources = createPanelResources();
		const toInput = (data: string): string => {
			if (matchesKey(data, Key.up)) return "\u001b[A";
			if (matchesKey(data, Key.down)) return "\u001b[B";
			if (matchesKey(data, Key.pageUp)) return "\u001b[5~";
			if (matchesKey(data, Key.pageDown)) return "\u001b[6~";
			if (matchesKey(data, Key.enter)) return "\r";
			if (matchesKey(data, Key.escape)) return "\u001b";
			return data;
		};
		const state: ContextBudgetViewState = { selection: { index: 0 }, expanded: new Set(), scrollOffset: 0 };
		const collect = () => { deps.buildHubSystemPrompt(); return collectContextBudgetSnapshot(ctx, { ledger: deps.getPromptLedger() as any, pressure: contextPressureDiagnostic(deps.getPressureState()), planes: contextPlanes(ctx), tools: [...deps.getAllTools()], activeToolNames: [...deps.getActiveTools()], commands: [...deps.getCommands()] }); };
		let snapshot = collect(); const refresh = () => { snapshot = collect(); };
		try { await ctx.ui.custom((tui: any, _theme: any, _kb: any, done: () => void) => { resources.every(1000, () => { refresh(); tui.requestRender(); }); return { render: (w: number) => renderContextBudget(snapshot, state, w, bodyRows(tui.terminal?.rows, CONTEXT_BUDGET_CHROME_ROWS)), handleInput: (data: string) => { const intent = contextBudgetTransition(toInput(data), state, snapshot, bodyRows(tui.terminal?.rows, CONTEXT_BUDGET_CHROME_ROWS)); if (intent === "close") done(); if (intent === "refresh") refresh(); tui.requestRender(); }, invalidate() {}, dispose: () => resources.dispose() }; }, FULLSCREEN_OVERLAY); } finally { resources.dispose(); }
	}

	return { contextPlanes, openContextBudget };
}
