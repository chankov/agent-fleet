import type { ChildProcess } from "child_process";
import type { DelegationChild } from "./dispatch-core.ts";
import type { SpecialistContextManifest } from "../lib/context-budget-child-prompt.ts";
import type { FleetTranscriptStore } from "../lib/fleet-transcript-store.ts";
import type { HistoryEntry } from "./ui/history-store.ts";
import type { TimelineEntry } from "./ui/zoom.ts";
import type { ResearchAgentDef, ResearchState as RuntimeResearchState } from "./research/runtime.ts";
import type { TaskResumeContract } from "./task-resume-contract.ts";

export interface SubagentRole {
	model: string;
	tools?: string;
	fallbackModel?: string;
	thinking?: string;
}

export interface AgentDef extends ResearchAgentDef {
	name: string;
	description: string;
	tools: string;
	readOnly?: boolean;
	model?: string;
	fallbackModel?: string;
	models?: string[];
	subagents?: Record<string, SubagentRole>;
	/** Role-file defaults per practice id (`practice_models:`); the first overridden practice of an assignment wins (D9). */
	practiceModels?: Record<string, { model: string; thinking?: string }>;
	delegateDepth?: number;
	warnings?: string[];
	kind?: string;
	thinking?: string;
	systemPrompt: string;
	file: string;
}

export interface AgentState {
	dispatchId?: string;
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	messageCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	contextTokens: number;
	sessionFile: string | null;
	specialistManifest?: SpecialistContextManifest;
	resumeContract?: TaskResumeContract;
	runCount: number;
	runsSinceFresh: number;
	timer?: ReturnType<typeof setInterval>;
	delegations?: Map<string, DelegationChild>;
	delegationsWatcher?: { close(): void };
	proc?: ChildProcess;
	killedByOperator?: boolean;
	restarting?: boolean;
	driftFence?: { dispose(): void };
	onTerminate?: () => void;
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	zoomRender?: (force?: boolean) => void;
	histEntry?: HistoryEntry;
	lastScope?: string[];
	lastBackend?: "native" | "coms";
	comsPeerModel?: string;
	comsAbort?: () => void;
}

export type ResearchState = RuntimeResearchState<AgentDef>;
