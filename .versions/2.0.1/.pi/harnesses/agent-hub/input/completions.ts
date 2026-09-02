import type { AutocompleteItem } from "@mariozechner/pi-tui";

interface CompletionDef { name: string; subagents?: Record<string, { model?: string }> }
interface CompletionState<TDef extends CompletionDef> { def: TDef; status: string; delegations?: Map<string, { id: string; status: string }> }
interface CompletionResearch<TDef extends CompletionDef> { id: number; def: TDef; persona: boolean; status: string }
interface CompletionPeer { name: string; purpose?: string; model: string }

export interface CompletionDeps<TDef extends CompletionDef> {
	getAgents(): Iterable<CompletionState<TDef>>;
	getResearch(): Iterable<CompletionResearch<TDef>>;
	getResearchPersonas(): TDef[];
	getModelProfiles(): Record<string, Record<string, string>>;
	getPeers(): CompletionPeer[];
	displayName(name: string): string;
	shortModel(model: string | undefined): string;
	resolvedModel(def: TDef): string | undefined;
	resolvedThinking(def: TDef): string | undefined;
	resolveThinkingLevel(value: string | undefined): string;
	resolvedSubagentModel(persona: string, role: string, fallback?: string): string;
	getSubagentOverride(persona: string, role: string): string | undefined;
	getSubstitutionSources(): Array<{ spec: string; label: string }>;
}

export interface CompletionPresentation {
	agentNames(prefix: string): AutocompleteItem[] | null;
	zoom(prefix: string): AutocompleteItem[] | null;
	agentModels(prefix: string): AutocompleteItem[] | null;
	agentThinking(prefix: string): AutocompleteItem[] | null;
	modelProfiles(prefix: string): AutocompleteItem[] | null;
	substitutions(prefix: string): AutocompleteItem[] | null;
	researchHandles(prefix: string): AutocompleteItem[] | null;
	subagentTargets(prefix: string): AutocompleteItem[] | null;
	agentsKill(prefix: string): AutocompleteItem[] | null;
	comsPeers(prefix: string): AutocompleteItem[] | null;
}

function filter(items: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
	if (items.length === 0) return null;
	const matched = items.filter(item => item.value.toLowerCase().startsWith(prefix.toLowerCase()));
	return matched.length > 0 ? matched : items;
}

export function createCompletionPresentation<TDef extends CompletionDef>(deps: CompletionDeps<TDef>): CompletionPresentation {
	const agents = () => Array.from(deps.getAgents());
	const research = () => Array.from(deps.getResearch());
	const agentNames = (prefix: string) => filter(agents().map(state => ({ value: state.def.name, label: `${deps.displayName(state.def.name)} (${state.status})` })), prefix);
	const researchHandles = (prefix: string) => filter(research().map(state => ({ value: `r${state.id}`, label: `r${state.id} ${state.persona ? deps.displayName(state.def.name) : "research"} (${state.status})` })), prefix);
	const subagentTargets = (prefix: string) => filter([...(agentNames("") ?? []), ...(researchHandles("") ?? [])], prefix);
	return {
		agentNames,
		zoom: prefix => filter([
			...agents().map(state => ({ value: state.def.name, label: `${deps.displayName(state.def.name)} (${state.status})` })),
			...research().map(state => ({ value: `r${state.id}`, label: `r${state.id} ${state.persona ? deps.displayName(state.def.name) : "research"} (${state.status})` })),
			...agents().flatMap(state => Array.from(state.delegations?.values() ?? []).map(child => ({ value: child.id, label: `${child.id} — delegate of ${deps.displayName(state.def.name)} (${child.status})` }))),
		], prefix),
		agentModels: prefix => filter([
			...agents().map(state => ({ value: state.def.name, label: `${deps.displayName(state.def.name)} (${state.status})` })),
			...deps.getResearchPersonas().map(def => ({ value: def.name, label: `${deps.displayName(def.name)} (research — ${deps.shortModel(deps.resolvedModel(def))})` })),
			...agents().flatMap(state => Object.entries(state.def.subagents ?? {}).map(([role, spec]) => {
				const override = deps.getSubagentOverride(state.def.name, role);
				const effective = deps.resolvedSubagentModel(state.def.name, role, spec.model);
				return { value: `${state.def.name}.${role}`, label: `${state.def.name}.${role} — ${deps.shortModel(effective)}${override || effective !== spec.model ? " (switched)" : ""}` };
			})),
		], prefix),
		agentThinking: prefix => filter([
			...agents().map(state => ({ value: state.def.name, label: `${deps.displayName(state.def.name)} — ${deps.resolveThinkingLevel(deps.resolvedThinking(state.def))}` })),
			...deps.getResearchPersonas().map(def => ({ value: def.name, label: `${deps.displayName(def.name)} (research) — ${deps.resolveThinkingLevel(deps.resolvedThinking(def))}` })),
		], prefix),
		modelProfiles: prefix => filter(Object.entries(deps.getModelProfiles()).map(([name, entries]) => ({ value: name, label: `${name} — ${Object.entries(entries).map(([persona, model]) => `${persona}: ${deps.shortModel(model)}`).join(", ")}` })), prefix),
		substitutions: prefix => filter(deps.getSubstitutionSources().map(choice => ({ value: choice.spec, label: choice.label })), prefix),
		researchHandles,
		subagentTargets,
		agentsKill: prefix => filter(research().length > 0 ? [...(subagentTargets("") ?? []), { value: "all", label: "all — kill & remove every research helper" }] : subagentTargets("") ?? [], prefix),
		comsPeers: prefix => filter(deps.getPeers().map(peer => ({ value: peer.name, label: `${peer.name} — ${peer.purpose || peer.model}` })), prefix),
	};
}
