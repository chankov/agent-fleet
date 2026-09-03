import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { WorkMode } from "../work-mode.ts";

/** Dependencies command registrars receive from the hub composition root. */
export interface CommandContext {
	setWidgetContext(ctx: ExtensionContext): void;
	applyWorkModeSelection(next: WorkMode, ctx: ExtensionContext): Promise<void>;
	getWorkModeStatusText(): string;
	openWorkModePicker(ctx: ExtensionContext): Promise<void>;
	handleAgentsTeam(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsList(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsHistory(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsAdd(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsDrop(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsSave(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsKill(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentsRestart(args: string, ctx: ExtensionContext): Promise<void>;
	handleContext(args: string, ctx: ExtensionContext): Promise<void>;
	handleHubReport(args: string, ctx: ExtensionContext): Promise<void>;
	handleZoom(args: string, ctx: ExtensionContext): Promise<void>;
	handleDispatchPolicy(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentModel(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentModelThinking(args: string, ctx: ExtensionContext): Promise<void>;
	handleModels(args: string, ctx: ExtensionContext): Promise<void>;
	handleAgentModelsSubstitute(args: string, ctx: ExtensionContext): Promise<void>;
	handleWatchdog(args: string, ctx: ExtensionContext): Promise<void>;
	handleComs(args: string, ctx: ExtensionContext): Promise<void>;
	handleHandoff(args: string, ctx: ExtensionContext): Promise<void>;
	handleCompound(args: string, ctx: ExtensionContext): Promise<void>;
	handlePoll(args: string, ctx: ExtensionContext): Promise<void>;
	getAgentsKillCompletions(prefix: string): AutocompleteItem[] | null;
	getZoomCompletions(prefix: string): AutocompleteItem[] | null;
	getAgentModelCompletions(prefix: string): AutocompleteItem[] | null;
	getAgentModelThinkingCompletions(prefix: string): AutocompleteItem[] | null;
	getModelProfileCompletions(prefix: string): AutocompleteItem[] | null;
	getSubstituteCompletions(prefix: string): AutocompleteItem[] | null;
	getComsPeerCompletions(prefix: string): AutocompleteItem[] | null;
	getSubagentTargetCompletions(prefix: string): AutocompleteItem[] | null;
}
