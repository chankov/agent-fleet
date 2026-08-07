export const POSTURES = ["operator", "orchestrator"] as const;
export type Posture = (typeof POSTURES)[number];

export const ORCHESTRATION_TOOLS = [
	"dispatch_agent",
	"spawn_research",
	"set_task_tier",
	"team_adjust",
	"set_assertions",
	"update_assertion",
	"get_assertions",
] as const;

export const COMS_TOOLS = ["coms_list", "coms_send", "coms_get", "coms_await"] as const;

export const HERDR_TOOLS = [
	"herdr_spawn_peer",
	"herdr_spawn_pane",
	"herdr_read_pane",
	"herdr_close_pane",
	"herdr_notify",
] as const;

const CONDITIONAL_TOOLS = new Set<string>([...COMS_TOOLS, ...HERDR_TOOLS, "ask_user"]);
const HUB_OWNED_TOOLS = new Set<string>([
	...ORCHESTRATION_TOOLS,
	...CONDITIONAL_TOOLS,
]);

export function parsePosture(value: unknown): Posture | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return POSTURES.includes(normalized as Posture) ? normalized as Posture : null;
}

export function resolveStartupPosture(options: {
	explicitPosture?: unknown;
	hasExplicitRoster?: boolean;
}): Posture {
	if (options.explicitPosture !== undefined) {
		const explicit = parsePosture(options.explicitPosture);
		if (!explicit) throw new Error(`Unknown posture "${String(options.explicitPosture)}"; expected operator|orchestrator.`);
		return explicit;
	}
	return options.hasExplicitRoster ? "orchestrator" : "operator";
}

export function latestPersistedPosture(entries: readonly unknown[]): Posture | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: unknown; customType?: unknown; data?: { posture?: unknown } } | null;
		if (entry?.type !== "custom" || entry.customType !== "agent-hub-posture") continue;
		const persisted = parsePosture(entry.data?.posture);
		if (persisted) return persisted;
	}
	return null;
}

export function resolveSessionPosture(options: {
	entries: readonly unknown[];
	explicitPosture?: unknown;
	hasExplicitRoster?: boolean;
}): Posture {
	if (options.explicitPosture !== undefined) {
		return resolveStartupPosture({ explicitPosture: options.explicitPosture });
	}
	return latestPersistedPosture(options.entries)
		?? resolveStartupPosture({ hasExplicitRoster: options.hasExplicitRoster });
}

export function posturePrompt(posture: Posture): { intro: string; hardRules: string } {
	if (posture === "operator") {
		return {
			intro: "You are the Fleet operator. You may work on the codebase directly and may also coordinate specialist agents when delegation adds value.",
			hardRules: `- You MAY read, execute, edit, and write directly in operator posture.
- Use direct tools for focused work when they are the simplest path; delegate when specialization, parallelism, or independent verification adds value.
- Give concurrent writable agents explicit non-overlapping scopes and inspect overlap warnings before proceeding.`,
		};
	}
	return {
		intro: "You are a dispatcher agent — an orchestrator. You coordinate specialist agents to accomplish tasks. You do NOT have direct access to the codebase.",
		hardRules: `- NEVER try to read, write, or execute code directly — you have no such tools.
- ALWAYS use \`dispatch_agent\` to get implementation work done; use \`spawn_research\` for read-only recon.
- \`herdr_spawn_pane\` is only for auxiliary processes such as watchers or servers; NEVER use it to bypass delegation by reading, editing, testing, or implementing code in a raw pane.`,
	};
}

export function resolvePostureTools(options: {
	posture: Posture;
	baselineTools: readonly string[];
	comsReady: boolean;
	herdrReady: boolean;
	askUserAvailable: boolean;
}): string[] {
	const tools = options.posture === "operator"
		? options.baselineTools.filter(name => !HUB_OWNED_TOOLS.has(name))
		: [];

	tools.push(...ORCHESTRATION_TOOLS);
	if (options.comsReady) tools.push(...COMS_TOOLS);
	if (options.askUserAvailable) tools.push("ask_user");
	if (options.herdrReady) tools.push(...HERDR_TOOLS);
	return [...new Set(tools)];
}
