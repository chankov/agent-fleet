/**
 * The Hub has one work mode: the operator (PHILOSOPHY, 2026-11-11). The former
 * delegate-only "orchestrator" mode was removed; sessions saved in it, and the
 * deprecated --work-mode flag, continue as the operator.
 */
export const WORK_MODES = ["operator"] as const;
export type WorkMode = (typeof WORK_MODES)[number];
/** The removed delegate-only mode, recognised only to migrate old sessions and flags. */
export const RETIRED_WORK_MODE = "orchestrator";

export const WORK_MODE_ENTRY_TYPE = "agent-hub-work-mode";
const LEGACY_POSTURE_ENTRY_TYPE = "agent-hub-posture";

export const FLEET_TOOLS = ["dispatch_agent", "dispatch_triage", "spawn_research", "poll_panel", "set_task_tier", "team_adjust"] as const;
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
	"filesystem",
	"ask_system1",
	"ask_system1_files",
]);

export function parseWorkMode(value: unknown): WorkMode | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return WORK_MODES.includes(normalized as WorkMode) ? normalized as WorkMode : null;
}

/** True for the removed mode's name, so callers can tell a migration from a typo. */
export function isRetiredWorkMode(value: unknown): boolean {
	return typeof value === "string" && value.trim() === RETIRED_WORK_MODE;
}

/** The latest persisted work-mode value (canonical or legacy posture entry), raw. */
function latestPersistedWorkModeValue(entries: readonly unknown[]): unknown {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: unknown; customType?: unknown; data?: { workMode?: unknown; posture?: unknown } } | null;
		if (entry?.type !== "custom") continue;
		const value = entry.customType === WORK_MODE_ENTRY_TYPE
			? entry.data?.workMode
			: entry.customType === LEGACY_POSTURE_ENTRY_TYPE
				? entry.data?.posture
				: undefined;
		if (parseWorkMode(value) || isRetiredWorkMode(value)) return value;
	}
	return undefined;
}

/** True when an older session was last saved in the removed orchestrator mode. */
export function sessionSavedInRetiredWorkMode(entries: readonly unknown[]): boolean {
	return isRetiredWorkMode(latestPersistedWorkModeValue(entries));
}

export const RETIRED_WORK_MODE_NOTICE =
	"Orchestrator work mode was removed: the Hub has one operator that works directly and delegates on its own judgment. This session continues as the operator; --work-mode and /af-work-mode no longer exist.";

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

/** Operator guidance on when to delegate. Stable policy: no counters or task state. */
export const OPERATOR_DELEGATION_GUIDE = `## When to delegate
Delegation is your judgment, not an obligation: use it to keep your context focused, get an independent view, or run independent work in parallel.
- Research: delegate by default with \`spawn_research\`; start independent questions in parallel in one turn and work from the findings.
- Build: make a small, focused change yourself. Delegate a larger coherent change to one builder.
- Review: a non-trivial change always gets review from a separate agent. With parallel builders, review each finished area (\`parallel: true\`), then once no writer runs do one final review of the whole change; only that closes the task.
- Decisions: for an architectural choice, uncertain diagnosis, choice between approaches or risky change, call \`poll_panel\` with one self-contained question. Never poll facts; deep research stays one model.
- Research and polls run in parallel freely. Writers (write, edit or bash; reviewers too) run one at a time unless each gets \`parallel: true\` and a disjoint scope of exact existing paths; the sandbox then confines each. Parallelize only independent areas. You edit shared files (package.json, locks, manifests) after writers finish and run the full checks with no writer active.
- Every delegate receives the task brief (\`artifacts/briefs/\`). Keep its "Operator notes" current with decisions and open questions. Read a delegate's return path instead of dispatching again.`;

/** The operator prompt. The removed orchestrator variant had no direct tools. */
export function workModePrompt(): { intro: string; hardRules: string; delegationGuide: string } {
	return {
		delegationGuide: OPERATOR_DELEGATION_GUIDE,
		intro: "You are the Fleet operator. You work on the codebase directly and delegate to specialist and research agents whenever that keeps your context focused, adds an independent view, or lets independent work run in parallel.",
		hardRules: `- You MAY read, execute, edit, and write directly.
- Use direct tools for focused work when they are the simplest path; delegate when specialization, parallelism, or independent verification adds value.
- For inspection, use the active catalog's read/grep/find/ls with an explicit target path (or the filesystem tool when enabled). A refused shell string needs no planner and no slash reset; preflight refusals carry their authoritative tier/catalog/revision snapshot.
- Tool availability is never gate admission: a listed tool can still refuse; read the refusal's snapshot and fix the prerequisite.
- \`dispatch_triage\`, when listed, is optional advice; never a gate or permission.`,
	};
}

export function resolveWorkModeTools(options: {
	baselineTools: readonly string[];
	comsReady: boolean;
	herdrReady: boolean;
	askUserAvailable: boolean;
	deterministicTools?: boolean;
	/** Omit dispatch_triage unless the consumer can evaluate. Default off. */
	triageEnabled?: boolean;
	/** Approved parent-only advisory consumer; default off. */
	agenticAskEnabled?: boolean;
 fileDiscoveryEnabled?: boolean;
	/** Active and provisional packs; omitted only for legacy callers. */
	capabilityPacks?: readonly ("core" | "fleet" | "verification" | "peer" | "workspace" | "compaction")[];
}): string[] {
	const packs = new Set(options.capabilityPacks ?? ["core", "fleet", "verification", "peer", "workspace"]);
	const tools = packs.has("core")
		? options.baselineTools.filter(name => !HUB_OWNED_TOOLS.has(name))
		: [];

	if (packs.has("fleet")) tools.push(...(options.triageEnabled ? FLEET_TOOLS : FLEET_TOOLS.filter(name => name !== "dispatch_triage")));
	// Verification can require explicit risk classification even for direct
	// operator work. Expose the trusted setter without leasing fleet dispatch.
	if (packs.has("verification")) tools.push("set_task_tier", ...VERIFICATION_TOOLS);
	if (packs.has("peer") && options.comsReady) tools.push(...COMS_TOOLS);
	if (packs.has("workspace") && options.herdrReady) tools.push(...HERDR_TOOLS);
	if (packs.has("core") && options.askUserAvailable) tools.push("ask_user");
	if (packs.has("core") && options.agenticAskEnabled === true) tools.push("ask_system1");
 if (packs.has("core") && options.fileDiscoveryEnabled === true) tools.push("ask_system1_files");
	if (packs.has("compaction")) tools.push("request_compaction");
	// The filesystem inspection tool stays profile-gated (deterministic-tools).
	if (options.deterministicTools === true) tools.push("filesystem");
	return [...new Set(tools)];
}
