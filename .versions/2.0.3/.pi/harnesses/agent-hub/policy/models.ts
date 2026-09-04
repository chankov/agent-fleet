export interface ModelPolicyDef {
	name: string;
	model?: string;
	fallbackModel?: string;
	models?: string[];
	thinking?: string;
	subagents?: Record<string, { model: string; fallbackModel?: string }>;
}

export interface ModelPolicyPorts<TDef extends ModelPolicyDef> {
	getAllDefs(): readonly TDef[];
	getActiveDef(name: string): TDef | undefined;
	getResearchDefs(): readonly TDef[];
	refreshUi(): void;
}

export interface ModelSubstitutionUiPort {
	loadAvailable(current?: string): Promise<readonly { spec: string }[] | null>;
	notify(message: string, level: "error" | "info" | "success"): void;
}

export interface ModelPolicy<TDef extends ModelPolicyDef> {
	allowedModels(def: TDef): string[];
	substitutedModel(model: string | undefined): string | undefined;
	resolvedModel(def: TDef): string | undefined;
	resolvedSubagentModel(persona: string, role: string, declared: string): string;
	resolvedThinking(def: TDef): string | undefined;
	switchablePersonaDef(name: string): TDef | undefined;
	allKnownModels(): string[];
	getPersonaOverride(name: string): string | undefined;
	setPersonaOverride(name: string, model: string | undefined): void;
	getSubagentOverride(persona: string, role: string): string | undefined;
	setSubagentOverride(persona: string, role: string, model: string | undefined): void;
	setThinkingOverride(name: string, thinking: string | undefined): void;
	getSubstitution(source: string): string | undefined;
	substitutionEntries(): IterableIterator<[string, string]>;
	applyProfile(profile: Readonly<Record<string, string>>): string[];
	applySessionSubstitution(source: string, target: string, ui: ModelSubstitutionUiPort): Promise<boolean>;
	reset(): void;
}

export function createModelPolicy<TDef extends ModelPolicyDef>(ports: ModelPolicyPorts<TDef>): ModelPolicy<TDef> {
	const personaOverrides = new Map<string, string>();
	const substitutions = new Map<string, string>();
	const thinkingOverrides = new Map<string, string>();
	const subagentOverrides = new Map<string, string>();
	const key = (value: string) => value.toLowerCase();
	const roleKey = (persona: string, role: string) => `${key(persona)}.${key(role)}`;

	function allowedModels(def: TDef): string[] {
		const out: string[] = [];
		for (const model of [def.model, ...(def.models || [])]) if (model && !out.includes(model)) out.push(model);
		return out;
	}
	function substitutedModel(model: string | undefined): string | undefined {
		return model ? substitutions.get(model) ?? model : undefined;
	}
	function resolvedModel(def: TDef): string | undefined {
		return substitutedModel(personaOverrides.get(key(def.name)) ?? def.model);
	}
	function resolvedSubagentModel(persona: string, role: string, declared: string): string {
		return substitutedModel(subagentOverrides.get(roleKey(persona, role)) ?? declared) ?? declared;
	}
	function resolvedThinking(def: TDef): string | undefined {
		return thinkingOverrides.get(key(def.name)) ?? def.thinking;
	}
	function switchablePersonaDef(name: string): TDef | undefined {
		return ports.getActiveDef(key(name)) ?? ports.getResearchDefs().find(def => key(def.name) === key(name));
	}
	function allKnownModels(): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		const add = (model: string | undefined) => { if (model && !seen.has(model)) { seen.add(model); out.push(model); } };
		for (const def of ports.getAllDefs()) {
			add(def.model); add(def.fallbackModel);
			for (const model of def.models ?? []) add(model);
			for (const role of Object.values(def.subagents ?? {})) { add(role.model); add(role.fallbackModel); }
		}
		for (const model of personaOverrides.values()) add(model);
		for (const model of subagentOverrides.values()) add(model);
		for (const source of substitutions.keys()) add(source);
		return out;
	}
	function setPersonaOverride(name: string, model: string | undefined): void {
		if (model === undefined) personaOverrides.delete(key(name)); else personaOverrides.set(key(name), model);
	}
	function setSubagentOverride(persona: string, role: string, model: string | undefined): void {
		const target = roleKey(persona, role);
		if (model === undefined) subagentOverrides.delete(target); else subagentOverrides.set(target, model);
	}
	function applyProfile(profile: Readonly<Record<string, string>>): string[] {
		const applied: string[] = [];
		for (const [persona, model] of Object.entries(profile)) {
			const def = ports.getAllDefs().find(candidate => key(candidate.name) === key(persona));
			if (!def) continue;
			setPersonaOverride(persona, model === def.model ? undefined : model);
			applied.push(persona);
		}
		ports.refreshUi();
		return applied;
	}
	async function applySessionSubstitution(source: string, target: string, ui: ModelSubstitutionUiPort): Promise<boolean> {
		const known = allKnownModels();
		if (!known.includes(source)) { ui.notify(`Unknown configured source model "${source}". Choose one of: ${known.join(", ") || "none"}.`, "error"); return false; }
		const available = await ui.loadAvailable(substitutions.get(source));
		if (!available) return false;
		if (!available.some(choice => choice.spec === target)) { ui.notify(`Target model "${target}" is not currently available in Pi.`, "error"); return false; }
		if (source === target) { ui.notify(`Source and target are the same (${source}); the session substitution was not changed.`, "info"); return false; }
		const previous = substitutions.get(source);
		if (previous === target) { ui.notify(`Substitution ${source} → ${target} is already active for this session.`, "info"); return false; }
		substitutions.set(source, target);
		const personas = ports.getAllDefs().filter(def => (personaOverrides.get(key(def.name)) ?? def.model) === source);
		const roles = ports.getAllDefs().flatMap(def => Object.entries(def.subagents ?? {}).filter(([role, config]) => (subagentOverrides.get(roleKey(def.name, role)) ?? config.model) === source));
		ports.refreshUi();
		ui.notify(`${previous ? "Updated" : "Saved"} session substitution ${source} → ${target}. ${personas.length} persona${personas.length === 1 ? "" : "s"} and ${roles.length} sub-role${roles.length === 1 ? "" : "s"} currently resolve through it; future agents spawned from the same configured source inherit it automatically. Current runs are not interrupted.`, "success");
		return true;
	}
	return {
		allowedModels, substitutedModel, resolvedModel, resolvedSubagentModel, resolvedThinking, switchablePersonaDef, allKnownModels,
		getPersonaOverride: name => personaOverrides.get(key(name)), setPersonaOverride,
		getSubagentOverride: (persona, role) => subagentOverrides.get(roleKey(persona, role)), setSubagentOverride,
		setThinkingOverride: (name, thinking) => { if (thinking === undefined) thinkingOverrides.delete(key(name)); else thinkingOverrides.set(key(name), thinking); },
		getSubstitution: source => substitutions.get(source), substitutionEntries: () => substitutions.entries(), applyProfile, applySessionSubstitution,
		reset: () => { personaOverrides.clear(); substitutions.clear(); subagentOverrides.clear(); thinkingOverrides.clear(); },
	};
}
