import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";

export const SESSION_START_COMMANDS = [
	"/af-work-mode [mode]      Operator | Orchestrator (Alt+M)",
	"/af-agents-team          Select a team",
	"/af-agents-list          Open Fleet Dashboard",
	"/af-agents-history       Timeline of agent runs — durations, parallel markers, grand total",
	"/af-context              Read-only full-screen context budget diagnostic",
	"/af-agent-model <persona>[.<role>] Switch a persona's or sub-role's model",
	"/af-agent-model-thinking <persona> Switch a persona's thinking level",
	"/af-models [profile]     Apply a named model profile to the team",
	"/af-agent-models-substitute [src tgt] Pick/save a session-wide source → target model substitution",
	"/af-dispatch-policy      Show which members route to coms peers (dispatch-policy.yaml)",
	"/af-agents-kill <name|rN|all> Kill a frozen specialist or remove research helper(s)",
	"/af-agents-restart <name|rN> Kill + re-run its last task fresh",
	"/af-zoom <name|rN|child> Scrollable view of an agent / research / delegate-child stream",
	"/af-coms [--all|--project N] Refresh the coms peer pool",
	"/af-handoff <peer>       Hand the session off to a coms peer",
	"/af-compound [focus]     Capture session lessons into the project rules/docs",
	"/af-poll [--panel NAME]  Ask every voice in a model panel the same question",
] as const;

export interface SessionStartNoticeData {
	workMode: string;
	activeTeamName: string;
	agentCount: number;
	members: string;
	dispatchLabel: string;
	userLanguage: string;
	askUserLabel: string;
	comsLabel: string;
	fleetLabel: string;
}

export function buildSessionStartNotice(data: SessionStartNoticeData): string {
	return [
		`Work Mode: ${data.workMode} (${data.workMode === "operator" ? "direct tools enabled" : "delegate-only"})`,
		`Native roster: ${data.activeTeamName || "(none)"} (${data.agentCount}${data.members ? `: ${data.members}` : ""})`,
		"Native roster sets loaded from: .pi/agents/teams.yaml",
		`Dispatch backends: ${data.dispatchLabel}`,
		`User-facing language: ${data.userLanguage} (override in .ai/agent-fleet-overrides.md)`,
		`ask_user: ${data.askUserLabel}; specialists bubble up via ASK_USER:`,
		`Coms: ${data.comsLabel}`,
		`Fleet: ${data.fleetLabel}`,
		"",
		...SESSION_START_COMMANDS,
	].join("\n");
}

export interface SessionFooterDependencies {
	ctx: ExtensionContext;
	version: string;
	getModel(): string;
	getThinkingLevel(): string | undefined;
	thinkingSuffix(value: string | undefined): string;
	getHint(): string;
	renderLeft(theme: Theme, version: string, model: string, thinking: string): string;
	truncateToWidth(value: string, width: number): string;
	visibleWidth(value: string): number;
}

export function createSessionFooter(deps: SessionFooterDependencies) {
	return (_tui: unknown, theme: Theme, footerData: { getExtensionStatuses?(): Map<string, string> } | undefined) => ({
		dispose: () => {},
		invalidate() {},
		render(width: number): string[] {
			const model = deps.getModel();
			const think = deps.thinkingSuffix(deps.getThinkingLevel());
			const usage = deps.ctx.getContextUsage();
			const pct = usage ? usage.percent : 0;
			const filled = Math.round(pct / 10);
			const bar = "#".repeat(filled) + "-".repeat(10 - filled);
			const left = deps.renderLeft(theme, deps.version, model, think);
			const hint = theme.fg("dim", deps.getHint());
			const btwHint = (globalThis as { __btwActivated?: boolean }).__btwActivated
				? theme.fg("muted", "  ·  Alt+' ") + theme.fg("dim", "btw")
				: "";
			const right = hint + btwHint + theme.fg("muted", "  ·  ") + theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
			const pad = " ".repeat(Math.max(1, width - deps.visibleWidth(left) - deps.visibleWidth(right)));
			const lines = [deps.truncateToWidth(left + pad + right, width)];
			const stt = footerData?.getExtensionStatuses?.().get("voice-stt");
			if (stt && stt.trim()) {
				const color = /REC/.test(stt) ? "accent" : "muted";
				lines.push(deps.truncateToWidth(theme.fg(color, ` ${stt}`), width));
			}
			return lines;
		},
	});
}
