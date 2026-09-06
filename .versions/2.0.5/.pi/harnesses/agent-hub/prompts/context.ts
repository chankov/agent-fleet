import type { CapabilityPack, CapabilityResolution } from "../capability-packs.ts";
import type { WorkMode } from "../work-mode.ts";

export interface HubPromptAgent {
	name: string;
	displayName: string;
	description: string;
	tools: string;
}

export interface HubPromptResearchPersona {
	name: string;
	displayName: string;
	description: string;
	model?: string;
	thinking: string;
}

export interface HubPromptState {
	taskTier: string;
	taskTierAssumed: boolean;
	turnDispatchCount: number;
	turnResearchCount: number;
	taskDispatchCount: number;
	taskResearchCount: number;
	taskReviewRounds: number;
	turnBudget: { maxDispatches: number | null; maxResearch: number | null };
	taskBudget: { wallMs: number | null };
	provisionalConfirmations: readonly { pack: CapabilityPack; reason: string; question: string }[];
}

/** Read-only prompt dependencies. Mutable Hub state remains owned by index.ts. */
export interface HubPromptContext {
	getCapabilityResolution(): CapabilityResolution;
	getActiveTools(): readonly string[];
	getAgents(): readonly HubPromptAgent[];
	getResearchPersonas(): readonly HubPromptResearchPersona[];
	getPromptState(): HubPromptState;
	getWorkMode(): WorkMode;
	getActiveTeamName(): string;
	getUserLanguage(): string;
	isAskUserAvailable(): boolean;
	isComsReady(): boolean;
	getIdentity(): { name: string; project: string } | null;
	isHerdrFleetReady(): boolean;
}
