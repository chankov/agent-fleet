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

export const FLEET_TOOLS = ["dispatch_agent", "dispatch_triage", "spawn_research", "recover_task", "poll_panel", "debate_panel", "set_task_tier"] as const;
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

/** Operator guidance on when to delegate. Stable policy: no counters or task state. */
export const OPERATOR_DELEGATION_GUIDE = `## When to delegate
Delegation is your judgment, not an obligation.
- Research: delegate by default with \`spawn_research\`; start independent questions in parallel in one turn and work from the findings.
- Build: make a small, focused change yourself. Delegate a larger coherent change to one editor.
- Review: a non-trivial change gets an independent \`reviewer\` via \`dispatch_agent\`. Review your own edits with native \`review_mode: "operator-current-state"\`. With parallel editors, audit each finished area and run one final review of the whole change after the writers finish.
- Decisions: for an architectural choice, uncertain diagnosis, choice between approaches or risky change, call \`poll_panel\` with one self-contained question; \`debate_panel\` when a known objection could change it or a poll disagrees. Never poll or debate facts; deep research stays one model.
- Read-only audits, research, polls and debates can run beside an editor. Use \`review_mode: "run-checks"\` only when the reviewer needs its configured shell. Write-capable runs execute one at a time unless each gets \`parallel: true\` and a sandboxed, disjoint scope of exact existing paths. Edit shared files and run full checks after writers finish.
- Every delegate receives the task brief (\`artifacts/briefs/\`). Keep its "Operator notes" current with decisions and open questions. Read a delegate's return path instead of dispatching again.`;

/** The operator prompt. The removed orchestrator variant had no direct tools. */
export function workModePrompt(): { intro: string; hardRules: string; delegationGuide: string } {
	return {
		delegationGuide: OPERATOR_DELEGATION_GUIDE,
		intro: "You are the Fleet operator. You work on the codebase directly and delegate to specialist and research agents whenever that keeps your context focused, adds an independent view, or lets independent work run in parallel.",
		hardRules: `- You MAY read, execute, edit, and write directly.
- For inspection, use the active catalog's read/grep/find/ls with an explicit target path (or the filesystem tool when enabled). A refused shell string needs no slash reset; preflight refusals carry their authoritative tier/catalog/revision snapshot.
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
 /** Recovery is exposed only while the guard has a continuable operation. */
 recoveryAvailable?: boolean;
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

	if (packs.has("fleet")) tools.push(...FLEET_TOOLS.filter(name => (name !== 'dispatch_triage' || options.triageEnabled === true) && (name !== 'recover_task' || options.recoveryAvailable === true)));
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
