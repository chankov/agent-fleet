import type { ChildProcess } from "child_process";
import { unlinkSync } from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Termination, spawnPiAgentWithModelFallback } from "../spawn.ts";
import type { TimelineEntry } from "../ui/zoom.ts";
import type { FleetTranscriptStore } from "../../lib/fleet-transcript-store.ts";
import type { HistoryEntry, ExecutionHistoryStore } from "../ui/history-store.ts";
import type { HubStateContext } from "../context/hub-state.ts";
import type { BudgetContext } from "../context/budgets.ts";
import type { InputArtifactPreview, AssertionsArtifactsContext } from "../context/assertions-artifacts.ts";
import type { createProviderSemaphore } from "../provider-semaphore.js";
import { DEFAULT_RESEARCH_KEEP, selectResearchPrunable } from "../research-retention.js";
import { safePathWithin } from "../helpers.ts";
import { runResearchSpawn, type ResearchSpawnPorts } from "./spawn-run.ts";

export const RESEARCH_TOOLS = "read,grep,find,ls";
export const MAX_AUTO_RESEARCH_ROUNDS = 2;
export const MAX_AUTO_RESEARCH_QUESTIONS = 4;

export const ANON_RESEARCH_PROMPT = `# Research Helper

You are an ad-hoc read-only research helper assisting a team of specialist agents.
Locate the relevant code or docs, read the surrounding context, and report concise,
well-cited findings the rest of the team can act on.`;

export interface ResearchAgentDef {
	name: string;
	description: string;
	tools: string;
	model?: string;
	fallbackModel?: string;
	thinking?: string;
	systemPrompt: string;
	file: string;
}

export interface ResearchState<TDef extends ResearchAgentDef = ResearchAgentDef> {
	id: number;
	def: TDef;
	persona: boolean;
	ephemeral: boolean;
	model: string;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	contextTokens: number;
	sessionFile: string | null;
	turnCount: number;
	finishedAt?: number;
	timer?: ReturnType<typeof setInterval>;
	proc?: ChildProcess;
	killedByOperator?: boolean;
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	zoomRender?: (force?: boolean) => void;
	histEntry?: HistoryEntry;
}

export interface ResearchResult {
	output: string;
	exitCode: number;
	elapsed: number;
	termination?: Termination;
}

export interface ResearchRuntimeStatePorts<TDef extends ResearchAgentDef> {
	getResearchStates(): Map<number, ResearchState<TDef>>;
	setResearchStates(value: Map<number, ResearchState<TDef>>): void;
	getNextResearchId(): number;
	setNextResearchId(value: number): void;
	getResearchKeep(): number;
	setResearchKeep(value: number): void;
}

export interface ResearchRuntimeDeps<TDef extends ResearchAgentDef> extends ResearchRuntimeStatePorts<TDef> {
	hubState: Pick<HubStateContext, "getSessionDir">;
	budget: Pick<BudgetContext, "currentBudget">;
	artifacts: Pick<AssertionsArtifactsContext, "appendInputArtifacts">;
	executionHistory: ExecutionHistoryStore;
	providerSemaphore: ReturnType<typeof createProviderSemaphore>;
	getSafetyHarnessPath(): string | null;
	getReconSearchTimeoutMs(): number | null;
	getContextWindow(): number;
	resolvedModel(def: TDef): string | undefined;
	resolvedThinking(def: TDef): string | undefined;
	resolveThinkingLevel(value: string | undefined): string;
	fallbackModelFor(def: TDef, model: string): string | undefined;
	substitutedModel(model: string | undefined): string | undefined;
	modelWindowLookup(ctx: ExtensionContext): (provider: string, modelId: string) => unknown;
	guardrailEnv(agentId: string): Record<string, string>;
	notifyProviderQueue(model: string, label: string, ctx: ExtensionContext): void;
	spawnPiAgentWithModelFallback: typeof spawnPiAgentWithModelFallback;
	nativeResearchSystemPrompt(input: { personaName?: string; personaPath?: string; cwd: string }): string;
	requireSafetyHarness(path: string | null): { ok: true; extensions: string[] } | { ok: false; error: string };
	shortModel(model: string): string;
	displayName(name: string): string;
	flushTimelineStore(state: ResearchState<TDef>): void;
	appendTimelineText(state: ResearchState<TDef>, kind: "text" | "thinking", content: string): void;
	appendTimelineEvent(state: ResearchState<TDef>, event: TimelineEntry): void;
	createTranscriptStore(path: string): FleetTranscriptStore;
	updateResearchWidget(): void;
	sendResearchMessage(message: { customType: string; content: string; display: true }): void;
}

export interface ResearchRuntime<TDef extends ResearchAgentDef = ResearchAgentDef> {
	states(): Map<number, ResearchState<TDef>>;
	reset(): void;
	setRetention(keep: number): void;
	sessionPath(id: number): string;
	anonymousDef(): TDef;
	resolveModel(def: TDef, explicit: string | undefined, ctx: ExtensionContext): string;
	createState(def: TDef, persona: boolean, model: string, ephemeral?: boolean): ResearchState<TDef>;
	prune(): void;
	spawn(state: ResearchState<TDef>, prompt: string, ctx: ExtensionContext, inputArtifacts?: InputArtifactPreview[], signal?: AbortSignal): Promise<ResearchResult>;
	deliverFollowUp(state: ResearchState<TDef>, result: ResearchResult): void;
}

export function parseResearchHandle(arg: string): number | null {
	const match = arg.trim().match(/^#?r?(\d+)$/i);
	return match ? parseInt(match[1], 10) : null;
}

export function createResearchRuntime<TDef extends ResearchAgentDef>(deps: ResearchRuntimeDeps<TDef>): ResearchRuntime<TDef> {
	const sessionPath = (id: number) => safePathWithin(deps.hubState.getSessionDir(), `research-${id}.json`);
	const prune = () => {
		const states = deps.getResearchStates();
		const ids = selectResearchPrunable(Array.from(states.values()), deps.getResearchKeep());
		if (ids.length === 0) return;
		for (const id of ids) {
			try { unlinkSync(sessionPath(id)); } catch {}
			states.delete(id);
		}
		deps.updateResearchWidget();
	};
	const spawnPorts: ResearchSpawnPorts<TDef> = { ...deps, researchTools: RESEARCH_TOOLS, sessionPath, prune };

	return {
		states: deps.getResearchStates,
		reset() {
			deps.setResearchStates(new Map());
			deps.setNextResearchId(1);
		},
		setRetention(keep) { deps.setResearchKeep(keep); },
		sessionPath,
		anonymousDef() {
			return {
				name: "research", description: "Ad-hoc read-only research helper.", tools: RESEARCH_TOOLS,
				systemPrompt: ANON_RESEARCH_PROMPT, file: "",
			} as TDef;
		},
		resolveModel(def, explicit, ctx) {
			if (explicit) return explicit;
			return deps.resolvedModel(def) || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview");
		},
		createState(def, persona, model, ephemeral = false) {
			const id = deps.getNextResearchId();
			deps.setNextResearchId(id + 1);
			const state: ResearchState<TDef> = {
				id, def, persona, ephemeral, model, status: "running", task: "", toolCount: 0,
				elapsed: 0, lastWork: "", contextPct: 0, contextTokens: 0, sessionFile: null,
				turnCount: 1, timeline: [],
			};
			deps.getResearchStates().set(id, state);
			return state;
		},
		prune,
		spawn(state, prompt, ctx, inputArtifacts = [], signal) {
			return runResearchSpawn(spawnPorts, state, prompt, ctx, inputArtifacts, signal);
		},
		deliverFollowUp(state, result) {
			const truncated = result.output.length > 8000 ? `${result.output.slice(0, 8000)}\n\n... [truncated]` : result.output;
			const label = state.persona ? deps.displayName(state.def.name) : "research";
			deps.sendResearchMessage({
				customType: "research-result", display: true,
				content: `[research r${state.id} · ${label}${state.turnCount > 1 ? ` · Turn ${state.turnCount}` : ""}] ${result.exitCode === 0 ? "finished" : "failed"} in ${Math.round(result.elapsed / 1000)}s.\n\nFindings:\n${truncated}`,
			});
		},
	};
}

export { DEFAULT_RESEARCH_KEEP };
