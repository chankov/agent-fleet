import type { ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RegistryEntry } from "../lib/coms-core.ts";
import type { FleetTranscriptStore } from "../lib/fleet-transcript-store.ts";
import type { SpecialistContextManifest } from "../lib/context-budget-child-prompt.ts";
import type { ExecutionHistoryStore, HistoryEntry, HistoryStatus } from "./ui/history-store.ts";
import type { TimelineEntry } from "./ui/zoom.ts";
import type { DelegationChild, DelegationObservableState } from "./dispatch-observability.ts";
import type { ComsDispatchResult, DispatchInputArtifactPreview } from "./dispatch-coms.ts";
import type { PiRunControl, SpawnPiAgentCallbacks, SpawnPiAgentOptions, SpawnPiAgentResult } from "./spawn.ts";

export type NativeBackend = "auto" | "native" | "coms";

export interface NativeSubagentRole {
	model: string;
	fallbackModel?: string;
	tools?: string;
	thinking?: string;
}

export interface NativeAgentDefinition {
	name: string;
	description: string;
	tools: string;
	model?: string;
	fallbackModel?: string;
	models?: string[];
	subagents?: Record<string, NativeSubagentRole>;
	delegateDepth?: number;
	thinking?: string;
	systemPrompt: string;
	file: string;
}

export interface NativeTimelineTarget {
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	transcriptPending?: TimelineEntry;
	transcriptFlushTimer?: ReturnType<typeof setTimeout>;
	zoomRender?: (force?: boolean) => void;
}

export interface NativeDispatchState extends NativeTimelineTarget, DelegationObservableState {
	def: NativeAgentDefinition;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	contextTokens: number;
	sessionFile: string | null;
	specialistManifest?: SpecialistContextManifest;
	runCount: number;
	runsSinceFresh: number;
	timer?: ReturnType<typeof setInterval>;
	delegations?: Map<string, DelegationChild>;
	proc?: ChildProcess;
	killedByOperator?: boolean;
	restarting?: boolean;
	onTerminate?: () => void;
	lastBackend?: "native" | "coms";
	comsPeerModel?: string;
	comsAbort?: () => void;
	histEntry?: HistoryEntry;
}

export interface NativeDispatchResult {
	output: string;
	exitCode: number;
	elapsed: number;
	billed?: number;
	out?: number;
	sessionReset?: NativeSessionReset | null;
	pending?: boolean;
}

export interface NativeSessionReset {
	reason: string;
	quarantined: string | null;
	retried: boolean;
}

export interface NativeDispatchPolicy {
	default: string;
	grace_s: number;
	substitutions: Record<string, { prefer: string; fallback: string; timeout_s?: number }>;
}

export interface NativeProviderSemaphore {
	run<T>(model: string, fn: () => Promise<T>): Promise<T>;
}

export interface NativeDispatchDeps {
	getAgentState(key: string): NativeDispatchState | undefined;
	listAgentStates(): NativeDispatchState[];
	getSessionDir(): string;
	getDispatchPolicy(): NativeDispatchPolicy;
	isComsReady(): boolean;
	getIdentity(): unknown | null;
	peersInScope(): RegistryEntry[];
	wasComsMissNotified(personaKey: string): boolean;
	markComsMissNotified(personaKey: string): void;
	startMonitorChild(input: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<any> | undefined;
	finalizeMonitorChild(task: any, output: string, status: "blocked" | "completed" | "failed" | "cancelled"): Promise<unknown> | unknown;
	registerMonitorWaitOnly(key: string, state: NativeDispatchState): Promise<unknown> | unknown;
	registerMonitorProcess(task: any, proc: ChildProcess): Promise<unknown> | unknown;
	appendMonitorOutput(task: any, delta: string): Promise<unknown> | unknown;
	getContextWindow(): number;
	currentBudget(): any;
	bumpRecycle(): void;
	bumpDriftStop(): void;
	getSessionHealthIo(): any;
	getSafetyHarnessPath(): string | null;
	getDelegateExtensionPath(): string | null;
	getReconSearchTimeoutMs(): number;
	getProjectDocsPaths(): string[];
	getUserLanguage(): string;
	getWatchdogSetting(): any;
	getWatchdogAgentOverride(key: string): any;
	getWorkMode(): any;
	providerSemaphore: NativeProviderSemaphore;
	executionHistory: Pick<ExecutionHistoryStore, "start" | "end">;
	displayName(name: string): string;
	shortModel(model: string): string;
	resolvedModel(def: NativeAgentDefinition): string | undefined;
	resolvedThinking(def: NativeAgentDefinition): string | undefined;
	resolveThinkingLevel(raw?: string): string;
	resolvedSubagentModel(personaKey: string, role: string, model: string): string;
	substitutedModel(model: string | undefined): string | undefined;
	modelWindowLookup(ctx: ExtensionContext): (provider: string, modelId: string) => any;
	specialistProjectPolicyPaths(cwd: string): string[];
	guardrailEnv(agentKey: string): Record<string, string>;
	appendInputArtifacts(task: string, artifacts: DispatchInputArtifactPreview[]): string;
	appendDeclaredScope(task: string, scopeGlobs: string[]): string;
	flushTimelineStore(target: NativeTimelineTarget): void;
	appendTimelineText(target: NativeTimelineTarget, kind: "text" | "thinking", delta: string): void;
	appendTimelineEvent(target: NativeTimelineTarget, event: TimelineEntry): TimelineEntry;
	createTranscriptStore(path: string): FleetTranscriptStore;
	updateWidget(): void;
	startDelegationWatch(state: NativeDispatchState, dir: string): void;
	dispatchViaComs(
		state: NativeDispatchState,
		task: string,
		peerName: string,
		timeoutMs: number,
		allowNativeFallback: boolean,
		ctx: ExtensionContext,
		inputArtifacts: DispatchInputArtifactPreview[],
		scopeGlobs: string[],
	): Promise<ComsDispatchResult | null>;
	runDriftJudge(input: any, ctx: ExtensionContext): Promise<{ verdict: string; reason: string } | null>;
	notifyProviderQueue(model: string, label: string, ctx: ExtensionContext): void;
	spawnPiAgentWithModelFallback(
		options: SpawnPiAgentOptions,
		fallbackModel: string | undefined,
		callbacks: SpawnPiAgentCallbacks,
	): Promise<SpawnPiAgentResult>;
}

export interface NativeRunBase {
	deps: NativeDispatchDeps;
	state: NativeDispatchState;
	ctx: ExtensionContext;
	task: string;
	inputArtifacts: DispatchInputArtifactPreview[];
	scopeGlobs: string[];
	watchdogParam?: boolean;
	key: string;
	personaKey: string;
	agentKey: string;
	runNumber: number;
	histEntry: HistoryEntry;
	monitorKey: string;
	monitorStart?: Promise<any>;
	startTime: number;
	finishRun(output: string, exitCode: number, options?: { idle?: boolean; pending?: boolean; notice?: string }): Promise<NativeDispatchResult>;
}

export interface PreparedNativeRun extends NativeRunBase {
	model: string;
	originalModelFallback?: string;
	agentWindow: { window: number; source: string };
	agentSessionFile: string;
	turnBudget: any;
	sessionRecycled: boolean;
	sessionReset: NativeSessionReset | null;
	effectiveTools: string;
	extensions: string[];
	delegateEnv?: Record<string, string>;
	thinkingLevel: string;
	wantThinking: boolean;
	replacementSystemPrompt: string;
	runPrompt: string;
}

export interface NativeSpawnOutcome {
	res: SpawnPiAgentResult;
	runBilled: number;
	runOut: number;
	sessionRecycled: boolean;
	sessionReset: NativeSessionReset | null;
	driftStop: { rule: string; detail: string; verdict: string; reason: string } | null;
	driftAdvisories: Array<{ rule: string; detail: string; verdict: string; reason: string }>;
}

export type { DispatchInputArtifactPreview, HistoryStatus, PiRunControl, SpawnPiAgentCallbacks, SpawnPiAgentOptions };
