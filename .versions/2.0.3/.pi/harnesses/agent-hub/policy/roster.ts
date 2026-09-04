export interface RosterDef { name: string }
export interface RosterState<TDef extends RosterDef> { def: TDef; status: string }
export interface RosterMutationResult { ok: boolean; message: string }
export interface SessionAdoption { file: string | null; quarantined: string | null; reason: string | null }

export interface RosterPolicyPorts<TDef extends RosterDef, TState extends RosterState<TDef>> {
	getTeams(): Readonly<Record<string, readonly string[]>>;
	getAllDefs(): readonly TDef[];
	getStates(): Map<string, TState>;
	getActiveTeamName(): string;
	setActiveTeamName(name: string): void;
	clearBackendNotices(): void;
	createFreshState(def: TDef, adoption?: SessionAdoption): TState;
	adoptSession(def: TDef): SessionAdoption;
	quarantineSession(def: TDef): { usable: boolean; quarantined: string | null; reason: string | null };
	persist(teamName: string): void;
	recompute(): void;
	refreshUi(): void;
	displayName(name: string): string;
	orchestratorNeedsRosterAfterDrop(size: number): boolean;
}

export interface RosterPolicy<TDef extends RosterDef> {
	activateTeam(teamName: string): void;
	persistActiveRoster(): void;
	add(name: string): RosterMutationResult;
	drop(name: string): RosterMutationResult;
}

export function createRosterPolicy<TDef extends RosterDef, TState extends RosterState<TDef>>(ports: RosterPolicyPorts<TDef, TState>): RosterPolicy<TDef> {
	function activateTeam(teamName: string): void {
		ports.setActiveTeamName(teamName);
		const members = ports.getTeams()[teamName] || [];
		const defsByName = new Map(ports.getAllDefs().map(def => [def.name.toLowerCase(), def]));
		const states = ports.getStates();
		states.clear();
		ports.clearBackendNotices();
		for (const member of members) {
			const def = defsByName.get(member.toLowerCase());
			if (def) states.set(def.name.toLowerCase(), ports.createFreshState(def, ports.adoptSession(def)));
		}
		ports.recompute();
	}
	function persistActiveRoster(): void {
		const team = ports.getActiveTeamName();
		if (team && ports.getStates().size > 0) ports.persist(team);
	}
	function add(name: string): RosterMutationResult {
		const key = String(name || "").trim().toLowerCase();
		const def = ports.getAllDefs().find(candidate => candidate.name.toLowerCase() === key);
		if (!def) {
			const available = ports.getAllDefs().map(candidate => candidate.name).sort().join(", ") || "(none)";
			return { ok: false, message: `No persona "${name}". Available: ${available}` };
		}
		const states = ports.getStates();
		if (states.has(def.name.toLowerCase())) return { ok: false, message: `${ports.displayName(def.name)} is already in the active team` };
		const adoption = ports.adoptSession(def);
		states.set(def.name.toLowerCase(), ports.createFreshState(def, adoption));
		if (!ports.getActiveTeamName()) ports.setActiveTeamName("ad-hoc");
		ports.recompute(); ports.refreshUi();
		const note = adoption.quarantined ? ` — its previous session file was unusable (${adoption.reason}) and was quarantined to ${adoption.quarantined}; it starts clean` : "";
		return { ok: true, message: `${ports.displayName(def.name)} added to the active team${note}` };
	}
	function drop(name: string): RosterMutationResult {
		const key = String(name || "").trim().toLowerCase();
		const states = ports.getStates();
		const state = states.get(key);
		if (!state) return { ok: false, message: `"${name}" is not in the active team (${Array.from(states.values()).map(item => item.def.name).join(", ") || "empty"})` };
		if (state.status === "running") return { ok: false, message: `${ports.displayName(state.def.name)} is running — wait for it to finish or /af-agents-kill it first` };
		if (ports.orchestratorNeedsRosterAfterDrop(states.size - 1)) return { ok: false, message: `${ports.displayName(state.def.name)} is the last team member — switch to operator work mode or add a replacement before dropping it` };
		states.delete(key);
		if (states.size === 0) ports.setActiveTeamName("");
		ports.recompute(); ports.refreshUi();
		const health = ports.quarantineSession(state.def);
		const note = health.usable ? " (its session file is kept for re-adding)" : health.quarantined ? ` (its session file was unusable — ${health.reason} — and was quarantined to ${health.quarantined}; re-adding starts clean)` : " (it has no session file; re-adding starts clean)";
		return { ok: true, message: `${ports.displayName(state.def.name)} dropped from the active team${note}` };
	}
	return { activateTeam, persistActiveRoster, add, drop };
}
