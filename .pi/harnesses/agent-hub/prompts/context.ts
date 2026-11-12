import type { CapabilityPack, CapabilityResolution } from "../capability-packs.ts";
import type { WorkMode } from "../work-mode.ts";
import type { AgenticConfig } from "../agentic-contract.ts";

export interface HubPromptAgent {
	name: string;
	displayName: string;
	description: string;
	tools: string;
	model?: string;
	/** False for an installed agent not yet in the active team; its first dispatch adds it. */
	inTeam?: boolean;
}

export interface HubPromptProviderLimit {
	provider: string;
	limit: number;
	inFlight: number;
	queued: number;
}

export interface HubPromptResearchPersona {
	name: string;
	displayName: string;
	description: string;
	model?: string;
	thinking: string;
}

export interface HubPromptState {
 requirements?: readonly {id:string;text:string;source?:string;reference?:string;criticalConditions?:readonly string[];recordedStatus:string;evidenceRevision?:string;evidenceTaskId?:string}[];
	taskTier: string;
	taskTierAssumed: boolean;
	processRisk?: string;
	processScope?: string;
	processOpen?: readonly string[];
	turnDispatchCount: number;
	turnResearchCount: number;
	taskDispatchCount: number;
	taskResearchCount: number;
	taskReviewRounds: number;
	/** Nested repositories the task uses when the workspace root is not a Git repository; absent or empty at a root repository. */
	nestedRepositories?: readonly string[];
	provisionalConfirmations: readonly { pack: CapabilityPack; reason: string; question: string | { question: string; context?: string; options?: string[] } }[];
}

/** Read-only prompt dependencies. Mutable Hub state remains owned by index.ts. */
export interface HubPromptContext {
	getArtifactRoot?(): string | null;
	getTriageBeforeDispatch?(): boolean;
	getAgenticAskMode?(): AgenticConfig["mode"];
	getCapabilityResolution(): CapabilityResolution;
	getActiveTools(): readonly string[];
	getToolCatalogNotice?(): string;
	/** Every installed dispatchable agent, not only the active team. */
	getAgents(): readonly HubPromptAgent[];
	/** Active team display names; defaults to agents marked inTeam. */
	getTeamMembers?(): readonly string[];
	/** Capped model providers (local endpoints) with live usage. */
	getProviderLimits?(): readonly HubPromptProviderLimit[];
	getResearchPersonas(): readonly HubPromptResearchPersona[];
	getPromptState(): HubPromptState;
	getWorkMode(): WorkMode;
	getActiveTeamName(): string;
	getUserLanguage(): string;
	getRulesProtocol(): string;
	getDocsProtocol(): string;
	isAskUserAvailable(): boolean;
	isComsReady(): boolean;
	getIdentity(): { name: string; project: string } | null;
	isHerdrFleetReady(): boolean;
}
