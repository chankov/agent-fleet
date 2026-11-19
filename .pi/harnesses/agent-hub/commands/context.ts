import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ModelProfile, ModelProfiles } from "../config/model-profiles.ts";
import type { ModelPolicy } from "../policy/models.ts";
import type { AgentDef } from "../types.ts";

interface ModelCommandContext {
	policy: ModelPolicy<AgentDef>;
	activeAgents: ReadonlyMap<string, { def: AgentDef }>;
	getResearchPersonas(): readonly AgentDef[];
	getProfiles(): ModelProfiles;
	prefersComs(name: string): boolean;
	updateWidget(): void;
	shortModel(model: string | undefined): string;
	activateProfile(name: string, profile: ModelProfile, ctx: ExtensionContext): Promise<string[]>;
	applyWorkModeTools(): void;
	openSubstitutions(ctx: ExtensionContext): Promise<void>;
	applySubstitution(source: string, target: string, ctx: ExtensionContext): Promise<boolean>;
}

/** Dependencies command registrars receive from the hub composition root. */
export interface CommandContext {
	setWidgetContext(ctx: ExtensionContext): void;
	modelCommands: ModelCommandContext;
	handleAgentsTeam(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsList(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsHistory(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsAdd(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsDrop(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsSave(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsKill(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsRestart(args: string, ctx: ExtensionContext): Promise<void>;
	handleContext(args: string, ctx: ExtensionContext): Promise<void>;
	handleConfig(args: string, ctx: ExtensionContext): Promise<void>;
	handleAudit(ctx: ExtensionContext, args?: string): Promise<void>;
	handleHubReport(args: string, ctx: ExtensionContext): Promise<void>;
	handleZoom(args: string, ctx: ExtensionContext): Promise<void>;
	handleDispatchPolicy(args: string, ctx: ExtensionContext): Promise<void>;
	handleWatchdog(args: string, ctx: ExtensionContext): Promise<void>;
	handleComs(args: string, ctx: ExtensionContext): Promise<void>;
	handleHandoff(args: string, ctx: ExtensionContext): Promise<void>;
	handleCompound(args: string, ctx: ExtensionContext): Promise<void>;
	handlePoll(args: string, ctx: ExtensionContext): Promise<void>;
	handleRetry(args: string, ctx: ExtensionContext): Promise<void>;
	handleRecover(args: string, ctx: ExtensionContext): Promise<void>;
	handleTaskTriageWaive(args: string, ctx: ExtensionContext): Promise<boolean>;
	handleTaskTriageRecover(): boolean;
	handleDebate(args: string, ctx: ExtensionContext): Promise<void>;
	getAgentsKillCompletions(prefix: string): AutocompleteItem[] | null;
	getZoomCompletions(prefix: string): AutocompleteItem[] | null;
	getAgentModelCompletions(prefix: string): AutocompleteItem[] | null;
	getAgentModelThinkingCompletions(prefix: string): AutocompleteItem[] | null;
	getModelProfileCompletions(prefix: string): AutocompleteItem[] | null;
	getSubstituteCompletions(prefix: string): AutocompleteItem[] | null;
	getComsPeerCompletions(prefix: string): AutocompleteItem[] | null;
	getSubagentTargetCompletions(prefix: string): AutocompleteItem[] | null;
}
