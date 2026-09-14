export const WORK_MODES = ["operator", "orchestrator"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const WORK_MODE_ENTRY_TYPE = "agent-hub-work-mode";
const LEGACY_POSTURE_ENTRY_TYPE = "agent-hub-posture";

export const FLEET_TOOLS = ["dispatch_agent", "spawn_research", "set_task_tier", "team_adjust"] as const;
export const VERIFICATION_TOOLS = ["set_assertions", "update_assertion", "get_assertions"] as const;
/** Compatibility export for callers that need every orchestration-owned tool. */
export const ORCHESTRATION_TOOLS = [...FLEET_TOOLS, ...VERIFICATION_TOOLS] as const;

export const COMS_TOOLS = ["coms_list", "coms_send", "coms_get", "coms_await"] as const;

export const HERDR_TOOLS = [
	"herdr_spawn_peer",
	"herdr_spawn_pane",
	"herdr_read_pane",
	"herdr_close_pane",
	"herdr_notify",
] as const;

const CONDITIONAL_TOOLS = new Set<string>([...COMS_TOOLS, ...HERDR_TOOLS, "ask_user", "request_compaction"]);
const HUB_OWNED_TOOLS = new Set<string>([
	...ORCHESTRATION_TOOLS,
	...CONDITIONAL_TOOLS,
]);

export function parseWorkMode(value: unknown): WorkMode | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return WORK_MODES.includes(normalized as WorkMode) ? normalized as WorkMode : null;
}

export function resolveStartupWorkMode(options: {
	explicitWorkMode?: unknown;
	hasExplicitRoster?: boolean;
}): WorkMode {
	if (options.explicitWorkMode !== undefined) {
		const explicit = parseWorkMode(options.explicitWorkMode);
		if (!explicit) throw new Error(`Unknown work mode "${String(options.explicitWorkMode)}"; expected operator|orchestrator.`);
		return explicit;
	}
	return options.hasExplicitRoster ? "orchestrator" : "operator";
}

/** Restores canonical work-mode entries and legacy posture entries from older sessions. */
export function latestPersistedWorkMode(entries: readonly unknown[]): WorkMode | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: unknown; customType?: unknown; data?: { workMode?: unknown; posture?: unknown } } | null;
		if (entry?.type !== "custom") continue;
		const value = entry.customType === WORK_MODE_ENTRY_TYPE
			? entry.data?.workMode
			: entry.customType === LEGACY_POSTURE_ENTRY_TYPE
				? entry.data?.posture
				: undefined;
		const persisted = parseWorkMode(value);
		if (persisted) return persisted;
	}
	return null;
}

export function resolveSessionWorkMode(options: {
	entries: readonly unknown[];
	explicitWorkMode?: unknown;
	hasExplicitRoster?: boolean;
}): WorkMode {
	if (options.explicitWorkMode !== undefined) {
		return resolveStartupWorkMode({ explicitWorkMode: options.explicitWorkMode });
	}
	return latestPersistedWorkMode(options.entries)
		?? resolveStartupWorkMode({ hasExplicitRoster: options.hasExplicitRoster });
}

export const NATIVE_ROSTER_STATE_VERSION = 1 as const;
export const NATIVE_ROSTER_ENTRY_TYPE = "agent-hub-native-roster";

export function persistedNativeRosterState(team: string): { version: 1; team: string } {
	const normalized = String(team ?? "").trim();
	if (!normalized) throw new Error("Native roster team name cannot be empty.");
	return { version: NATIVE_ROSTER_STATE_VERSION, team: normalized };
}

export function latestPersistedNativeRoster(entries: readonly unknown[]): string | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: { version?: unknown; team?: unknown } } | null;
		if (entry?.type !== "custom" || entry.customType !== NATIVE_ROSTER_ENTRY_TYPE) continue;
		if (entry.data?.version !== NATIVE_ROSTER_STATE_VERSION || typeof entry.data.team !== "string") continue;
		const team = entry.data.team.trim();
		if (team) return team;
	}
	return null;
}

export interface SessionRosterResolution {
	source: "none" | "explicit" | "persisted";
	roster: { name: string; members: string[] } | null;
	diagnostic: string | null;
}

export function resolveSessionRoster(options: {
	teams: Readonly<Record<string, readonly string[]>>;
	entries: readonly unknown[];
	explicitRoster?: unknown;
	availablePersonas: readonly string[];
	includePersisted?: boolean;
}): SessionRosterResolution {
	const explicit = typeof options.explicitRoster === "string" ? options.explicitRoster.trim() : "";
	const persisted = options.includePersisted === false ? null : latestPersistedNativeRoster(options.entries);
	const requested = explicit || persisted;
	const source: SessionRosterResolution["source"] = explicit ? "explicit" : persisted ? "persisted" : "none";
	if (!requested) return { source, roster: null, diagnostic: null };

	const name = Object.keys(options.teams).find(candidate => candidate.toLowerCase() === requested.toLowerCase());
	if (!name) {
		const available = Object.keys(options.teams).sort().join(", ") || "(none)";
		return { source, roster: null, diagnostic: `Native roster "${requested}" is unavailable. Select one of: ${available}.` };
	}
	const members = [...options.teams[name]];
	if (members.length === 0) {
		return { source, roster: null, diagnostic: `Native roster "${name}" has no specialists.` };
	}
	const available = new Set(options.availablePersonas.map(persona => persona.toLowerCase()));
	const missing = members.filter(member => !available.has(member.toLowerCase()));
	if (missing.length > 0) {
		return { source, roster: null, diagnostic: `Native roster "${name}" references missing personas: ${missing.join(", ")}.` };
	}
	return { source, roster: { name, members }, diagnostic: null };
}

export function workModePrompt(workMode: WorkMode): { intro: string; hardRules: string } {
	if (workMode === "operator") {
		return {
			intro: "You are the Fleet operator. You may work on the codebase directly and may also coordinate specialist agents when delegation adds value.",
			hardRules: `- You MAY read, execute, edit, and write directly in operator work mode.
- Use direct tools for focused work when they are the simplest path; delegate when specialization, parallelism, or independent verification adds value.
- Give concurrent writable agents explicit non-overlapping scopes and inspect overlap warnings before proceeding.`,
		};
	}
	return {
		intro: "You are a dispatcher agent — an orchestrator. You coordinate specialist agents to accomplish tasks. You do NOT have direct access to the codebase.",
		hardRules: `- NEVER try to read, write, or execute code directly — you have no such tools.
- ALWAYS use \`dispatch_agent\` to get implementation work done; use \`spawn_research\` for read-only recon.`,
	};
}

export function resolveWorkModeTools(options: {
	workMode: WorkMode;
	baselineTools: readonly string[];
	comsReady: boolean;
	herdrReady: boolean;
	askUserAvailable: boolean;
	/** Active and provisional packs; omitted only for legacy callers. */
	capabilityPacks?: readonly ("core" | "fleet" | "verification" | "peer" | "workspace" | "compaction")[];
}): string[] {
	const packs = new Set(options.capabilityPacks ?? ["core", "fleet", "verification", "peer", "workspace"]);
	const tools = options.workMode === "operator" && packs.has("core")
		? options.baselineTools.filter(name => !HUB_OWNED_TOOLS.has(name))
		: [];

	if (packs.has("fleet")) tools.push(...FLEET_TOOLS);
	if (packs.has("verification")) tools.push(...VERIFICATION_TOOLS);
	if (packs.has("peer") && options.comsReady) tools.push(...COMS_TOOLS);
	if (packs.has("workspace") && options.herdrReady) tools.push(...HERDR_TOOLS);
	if (packs.has("core") && options.askUserAvailable) tools.push("ask_user");
	if (packs.has("compaction")) tools.push("request_compaction");
	return [...new Set(tools)];
}
