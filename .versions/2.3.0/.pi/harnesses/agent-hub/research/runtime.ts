import type {PrepareNativeDiscovery,ResearchAdmission} from '../file-discovery/native-context.ts';
import type { DamageSpawnRegistration } from '../damage-guard-owners.ts';

/** Parent-only preparation: canonical task/input authority stays with the parent. */
export interface ResearchDamagePreparationInput {
 readonly ownerId: string;
 readonly cwd: string;
 readonly tools: readonly string[];
 readonly readScope: readonly string[];
 readonly signal?: AbortSignal;
 readonly admit: () => boolean;
}
export type PrepareResearchDamageGuard = (input: ResearchDamagePreparationInput) =>
 DamageSpawnRegistration | null | undefined | Promise<DamageSpawnRegistration | null | undefined>;
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { ChildProcess } from "child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Termination, spawnPiAgentWithModelFallback } from "../spawn.ts";
import type { TimelineEntry } from "../ui/zoom.ts";
import type { FleetTranscriptStore } from "../../lib/fleet-transcript-store.ts";
import type { HistoryEntry, ExecutionHistoryStore } from "../ui/history-store.ts";
import type { HubStateContext } from "../context/hub-state.ts";
import type { BudgetContext } from "../context/budgets.ts";
import type { InputArtifactPreview, AssertionsArtifactsContext } from "../context/assertions-artifacts.ts";
import type { createProviderSemaphore } from "../provider-semaphore.js";
import { safePathWithin } from "../helpers.ts";
import { runResearchSpawn, type ResearchSpawnPorts } from "./spawn-run.ts";

export const RESEARCH_TOOLS = "read,grep,find,ls";
export const MAX_AUTO_RESEARCH_ROUNDS = 2;
export const MAX_AUTO_RESEARCH_QUESTIONS = 4;
/** The ad-hoc helper's definition name; it is not a role and owns no model policy. */
export const ANON_RESEARCH_NAME = "research";

export const ANON_RESEARCH_PROMPT = `# Research Helper

You are an ad-hoc read-only research helper assisting a team of specialist agents.
Locate the relevant code or docs, read the surrounding context, and report concise,
well-cited findings the rest of the team can act on.`;

export interface ResearchAgentDef {
	name: string;
	description: string;
	tools: string;
	toolsExplicit?: boolean;
	model?: string;
	fallbackModel?: string;
	thinking?: string;
	systemPrompt: string;
	file: string;
}

export interface ResearchState<TDef extends ResearchAgentDef = ResearchAgentDef> {
	id: number;
	dispatchId: string;
	sessionPath: string;
	evidenceDir: string;
	def: TDef;
	persona: boolean;
	model: string;
	/** Thinking chosen with the model (role and practices, D9); absent means the definition's own. */
	thinking?: string;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	messageCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	contextTokens: number;
	timer?: ReturnType<typeof setInterval>;
	proc?: ChildProcess;
	killedByOperator?: boolean;
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	zoomRender?: (force?: boolean) => void;
	histEntry?: HistoryEntry;
}

export interface ResearchResult {
	dispatchId?: string;
	evidencePath?: string;
	transcriptPath?: string;
	output: string;
	exitCode: number;
	elapsed: number;
	termination?: Termination;
	/** T3 runtime lifecycle facts. Safety refusal and spawn failure never launched. */
	lifecycle?: { launched: boolean; closeSeen: boolean };
}

export interface ResearchFinalizeOutcome {
	status: "idle" | "done" | "error";
	historyStatus: "idle" | "done" | "error";
	lastWork: string;
}

export interface ResearchRuntimeStatePorts<TDef extends ResearchAgentDef> {
	getResearchStates(): Map<number, ResearchState<TDef>>;
	setResearchStates(value: Map<number, ResearchState<TDef>>): void;
	getNextResearchId(): number;
	setNextResearchId(value: number): void;
}

export interface ResearchRuntimeDeps<TDef extends ResearchAgentDef> extends ResearchRuntimeStatePorts<TDef> {
 prepareDiscovery?:PrepareNativeDiscovery;
 prepareDamageGuard?: PrepareResearchDamageGuard;
 launchIdentity?():unknown;
 researchAdmission?():boolean;
	hubState: Pick<HubStateContext, "getSessionDir">;
	budget: Pick<BudgetContext, "currentBudget">;
	artifacts: Pick<AssertionsArtifactsContext, "appendInputArtifacts">;
	executionHistory: ExecutionHistoryStore;
	providerSemaphore: ReturnType<typeof createProviderSemaphore>;
	getSafetyHarnessPath(): string | null;
	getReconSearchTimeoutMs(): number | null;
	getContextWindow(): number;
	resolvedModel(def: TDef, practices?: readonly string[]): string | undefined;
	resolvedThinking(def: TDef, practices?: readonly string[]): string | undefined;
	/** The installed researcher role definition, whose model and practice choices an ad-hoc helper takes (D9–D10). */
	researcherDef?(): TDef | undefined;
	resolveThinkingLevel(value: string | undefined): string;
	fallbackModelFor(def: TDef, model: string): string | undefined;
	substitutedModel(model: string | undefined): string | undefined;
	modelWindowLookup(ctx: ExtensionContext): (provider: string, modelId: string) => { contextWindow?: number } | undefined;
	guardrailEnv(agentId: string): Record<string, string>;
	notifyProviderQueue(model: string, label: string, ctx: ExtensionContext): void;
	spawnPiAgentWithModelFallback: typeof spawnPiAgentWithModelFallback;
	getProjectPolicyPaths(cwd: string): string[];
	getProjectDocsPaths(): string[];
	nativeResearchSystemPrompt(input: { personaName?: string; personaPath?: string; cwd: string; rulesPaths?: readonly string[]; docsPaths?: readonly string[] }): string;
	requireSafetyHarness(path: string | null): { ok: true; extensions: string[] } | { ok: false; error: string };
	shortModel(model: string): string;
	displayName(name: string): string;
	flushTimelineStore(state: ResearchState<TDef>): void;
	appendTimelineText(state: ResearchState<TDef>, kind: "text" | "thinking", content: string): void;
	appendTimelineEvent(state: ResearchState<TDef>, event: TimelineEntry): void;
	createTranscriptStore(path: string): FleetTranscriptStore;
	onElapsed?(): void;
}

export interface ResearchRuntime<TDef extends ResearchAgentDef = ResearchAgentDef> {
	states(): Map<number, ResearchState<TDef>>;
	reset(): void;
	sessionPath(id: number): string;
	anonymousDef(): TDef;
	resolveModel(def: TDef, explicit: string | undefined, ctx: ExtensionContext, practices?: readonly string[]): string;
	/** Thinking for the same choice, from the researcher role for the practices; an explicit model does not change it. */
	resolveThinking?(def: TDef, explicit: string | undefined, practices?: readonly string[]): string | undefined;
	createState(def: TDef, persona: boolean, model: string, thinking?: string): ResearchState<TDef>;
	finalize(state: ResearchState<TDef>, outcome: ResearchFinalizeOutcome): void;
	spawn(state: ResearchState<TDef>, prompt: string, ctx: ExtensionContext, inputArtifacts?: InputArtifactPreview[], signal?: AbortSignal, admission?:ResearchAdmission): Promise<ResearchResult>;
}

export function parseResearchHandle(arg: string): number | null {
	const match = arg.trim().match(/^#?r?(\d+)$/i);
	return match ? parseInt(match[1], 10) : null;
}

export function createResearchRuntime<TDef extends ResearchAgentDef>(deps: ResearchRuntimeDeps<TDef>): ResearchRuntime<TDef> {
	const paths = new Map<number, string>();
	const sessionPath = (id: number) => { const path = paths.get(id); if (!path) throw new Error(`Unknown research handle r${id}`); return path; };
	const finalized = new WeakSet<ResearchState<TDef>>();
	const finalize = (state: ResearchState<TDef>, outcome: ResearchFinalizeOutcome) => {
		if (finalized.has(state)) return;
		finalized.add(state);
		if (state.timer) {
			clearInterval(state.timer);
			state.timer = undefined;
		}
		state.proc = undefined;
		state.status = outcome.status;
		state.lastWork = outcome.lastWork;
		state.zoomRender?.(true);
		if (state.histEntry) {
			deps.executionHistory.end(state.histEntry, outcome.historyStatus);
			state.histEntry = undefined;
		}
		const states = deps.getResearchStates();
		if (states.get(state.id) === state) states.delete(state.id);
	};
	// The ad-hoc helper keeps its own prompt but has no model policy of its own: it takes the researcher
	// role's (D9–D10). Without this a complete profile hands the name "research" its defaults, and the two
	// spawn_research forms would pick different models, thinking and fallbacks for the same practices.
	const policyDef = (def: TDef): TDef => def.name === ANON_RESEARCH_NAME && !def.file ? deps.researcherDef?.() ?? def : def;
	const spawnPorts: ResearchSpawnPorts<TDef> = {
		...deps, researchTools: RESEARCH_TOOLS, sessionPath, finalize,
		resolvedThinking: (def, practices) => deps.resolvedThinking(policyDef(def), practices),
		fallbackModelFor: (def, model) => deps.fallbackModelFor(policyDef(def), model),
	};

	return {
		states: deps.getResearchStates,
		reset() {
			paths.clear();
			deps.setResearchStates(new Map());
			deps.setNextResearchId(1);
		},
		sessionPath,
		anonymousDef() {
			return {
				name: ANON_RESEARCH_NAME, description: "Ad-hoc read-only research helper.", tools: RESEARCH_TOOLS,
				systemPrompt: ANON_RESEARCH_PROMPT, file: "",
			} as TDef;
		},
		// One choice for both spawn_research forms (D9–D10): the researcher role's model for these practices,
		// and the chat model only when no role is installed. An explicit helper model replaces the model alone.
		resolveModel(def, explicit, ctx, practices) {
			if (explicit) return explicit;
			return deps.resolvedModel(policyDef(def), practices)
				|| (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview");
		},
		// Thinking follows the role for the practices in both forms, also when the operator named the model.
		resolveThinking(def, _explicit, practices) {
			return deps.resolvedThinking(policyDef(def), practices);
		},
		createState(def, persona, model, thinking) {
			const id = deps.getNextResearchId();
			deps.setNextResearchId(id + 1);
			const dispatchId = randomUUID();
			const evidenceDir = safePathWithin(deps.hubState.getSessionDir(), "dispatches", dispatchId);
			mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
			const rawSession = safePathWithin(evidenceDir, "session.json");
			paths.set(id, rawSession);
			const state: ResearchState<TDef> = {
				id, dispatchId, evidenceDir, sessionPath: rawSession, def, persona, model, ...(thinking ? { thinking } : {}), status: "running", task: "", toolCount: 0, messageCount: 0,
				elapsed: 0, lastWork: "", contextPct: 0, contextTokens: 0, timeline: [],
			};
			deps.getResearchStates().set(id, state);
			return state;
		},
		finalize,
		spawn(state, prompt, ctx, inputArtifacts = [], signal, admission) {
			return runResearchSpawn(spawnPorts, state, prompt, ctx, inputArtifacts, signal, admission);
		},
	};
}
