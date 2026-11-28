// roster.ts — the Hub's map of dispatchable roles and their parallel instances.
//
// There are no teams (PLAN-11-01, D7): every installed dispatchable role is on
// the roster from session start, and a parallel instance (`editor--p2`) joins it
// on demand. Nothing here is persisted; the roster is rebuilt from the installed
// role definitions on every session start.

export interface RosterDef { name: string }
export interface RosterState<TDef extends RosterDef> { def: TDef; status: string }
export interface RosterMutationResult { ok: boolean; message: string }
export interface SessionAdoption { file: string | null; quarantined: string | null; reason: string | null }

export interface RosterPolicyPorts<TDef extends RosterDef, TState extends RosterState<TDef>> {
	/** Installed dispatchable role definitions (researcher excluded: it runs through spawn_research). */
	getDispatchableDefs(): readonly TDef[];
	getStates(): Map<string, TState>;
	clearBackendNotices(): void;
	createFreshState(def: TDef, adoption?: SessionAdoption): TState;
	adoptSession(def: TDef): SessionAdoption;
	recompute(): void;
	refreshUi(): void;
	displayName(name: string): string;
}

export interface RosterPolicy<TDef extends RosterDef> {
	/** Replace the roster with every installed dispatchable role. */
	populate(): void;
	/** Adds an installed role that is not on the roster yet (dispatch auto-add). */
	add(name: string): RosterMutationResult;
	/** Adds a synthetic instance definition (for example a parallel editor--p2). */
	addInstance(def: TDef): RosterMutationResult;
}

export function createRosterPolicy<TDef extends RosterDef, TState extends RosterState<TDef>>(ports: RosterPolicyPorts<TDef, TState>): RosterPolicy<TDef> {
	function admit(def: TDef): SessionAdoption {
		const adoption = ports.adoptSession(def);
		ports.getStates().set(def.name.toLowerCase(), ports.createFreshState(def, adoption));
		return adoption;
	}
	function populate(): void {
		const states = ports.getStates();
		states.clear();
		ports.clearBackendNotices();
		for (const def of ports.getDispatchableDefs()) admit(def);
		ports.recompute();
	}
	function add(name: string): RosterMutationResult {
		const key = String(name || "").trim().toLowerCase();
		const def = ports.getDispatchableDefs().find(candidate => candidate.name.toLowerCase() === key);
		if (!def) {
			const available = ports.getDispatchableDefs().map(candidate => candidate.name).sort().join(", ") || "(none)";
			return { ok: false, message: `No installed role "${name}". Installed: ${available}` };
		}
		if (ports.getStates().has(key)) return { ok: true, message: `${ports.displayName(def.name)} is already available` };
		const adoption = admit(def);
		ports.recompute(); ports.refreshUi();
		const note = adoption.quarantined ? ` — its previous session file was unusable (${adoption.reason}) and was quarantined to ${adoption.quarantined}; it starts clean` : "";
		return { ok: true, message: `${ports.displayName(def.name)} is now available${note}` };
	}
	function addInstance(def: TDef): RosterMutationResult {
		if (ports.getStates().has(def.name.toLowerCase())) return { ok: true, message: `${ports.displayName(def.name)} is already available` };
		admit(def);
		ports.recompute(); ports.refreshUi();
		return { ok: true, message: `${ports.displayName(def.name)} started as a parallel instance` };
	}
	return { populate, add, addInstance };
}
