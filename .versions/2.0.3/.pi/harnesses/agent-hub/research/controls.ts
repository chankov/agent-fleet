import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ResearchAgentDef, ResearchRuntime, ResearchState } from "./runtime.ts";

export interface ResearchControlPorts<TDef extends ResearchAgentDef> {
	runtime: ResearchRuntime<TDef>;
	refresh(): void;
	restartSpecialist(state: any, ctx: ExtensionContext): Promise<void>;
	getAgents(): Map<string, any>;
	displayName(name: string): string;
	modelWorkBlocked(ctx: ExtensionContext): boolean;
	cancelWait(state: any, kind: "wait_only_cancelled" | "restart"): Promise<void>;
	cancelOwned(state: any): void;
}
export interface ResearchControls<TDef extends ResearchAgentDef> {
	remove(state: ResearchState<TDef>, ctx: ExtensionContext): void;
	clear(ctx: ExtensionContext): void;
	restartSpecialist(state: any, ctx: ExtensionContext): Promise<void>;
	handleKill(args: string | undefined, ctx: ExtensionContext): Promise<void>;
	handleRestart(args: string | undefined, ctx: ExtensionContext): Promise<void>;
}

const researchId = (name: string | undefined) => { const match = name?.match(/^#?r?(\d+)$/i); return match ? parseInt(match[1], 10) : null; };
const specialistTargets = <TDef extends ResearchAgentDef>(ports: ResearchControlPorts<TDef>) =>
	Array.from(ports.getAgents().values()).map(state => ports.displayName(state.def.name)).join(", ");
const liveTargets = <TDef extends ResearchAgentDef>(ports: ResearchControlPorts<TDef>) => [
	...Array.from(ports.getAgents().values()).map(state => ports.displayName(state.def.name)),
	...Array.from(ports.runtime.states().values()).map(state => `r${state.id}`),
].join(", ");

export function createResearchControls<TDef extends ResearchAgentDef>(ports: ResearchControlPorts<TDef>): ResearchControls<TDef> {
	const remove = (state: ResearchState<TDef>, ctx: ExtensionContext) => {
		if (state.proc && state.status === "running") { state.killedByOperator = true; state.proc.kill("SIGTERM"); ctx.ui.notify(`Research r${state.id} killed and removed.`, "warning"); }
		else ctx.ui.notify(`Research r${state.id} removed.`, "info");
		ports.runtime.finalize(state, { status: "idle", historyStatus: "idle", lastWork: "(killed by operator)" });
		ports.refresh();
	};
	const controls: ResearchControls<TDef> = {
		remove,
		clear(ctx) {
			let killed = 0; const live = Array.from(ports.runtime.states().values()); const total = live.length;
			for (const state of live) {
				if (state.proc && state.status === "running") { state.killedByOperator = true; state.proc.kill("SIGTERM"); killed++; }
				ports.runtime.finalize(state, { status: "idle", historyStatus: "idle", lastWork: "(killed by operator)" });
			}
			ports.refresh();
			ctx.ui.notify(total === 0 ? "No research helpers to clear." : `Cleared ${total} research helper${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`, total === 0 ? "info" : "success");
		},
		restartSpecialist: ports.restartSpecialist,
		async handleKill(args, ctx) {
			const name = args?.trim();
			if (name?.toLowerCase() === "all") { controls.clear(ctx); return; }
			const id = researchId(name);
			if (id != null) { const research = ports.runtime.states().get(id); if (!research) ctx.ui.notify(`No research helper "${name}". Known: ${Array.from(ports.runtime.states().values()).map(item => `r${item.id}`).join(", ") || "none"}`, "error"); else controls.remove(research, ctx); return; }
			const state = name ? ports.getAgents().get(name.toLowerCase()) : undefined;
			if (!state) { ctx.ui.notify(`Usage: /af-agents-kill <name|rN|all>. Known: ${liveTargets(ports) || "none"}`, "error"); return; }
			if (state.status !== "running" || (!state.proc && !state.comsAbort)) { ctx.ui.notify(`${ports.displayName(state.def.name)} is not running — nothing to kill.`, "warning"); return; }
			if (!state.proc) { void ports.cancelWait(state, "wait_only_cancelled"); ctx.ui.notify(`Abandoning ${ports.displayName(state.def.name)}'s coms dispatch (the peer pane keeps running)...`, "info"); return; }
			state.killedByOperator = true; ports.cancelOwned(state); ctx.ui.notify(`Killing ${ports.displayName(state.def.name)}...`, "info");
		},
		async handleRestart(args, ctx) {
			if (ports.modelWorkBlocked(ctx)) return;
			const name = args?.trim(); const id = researchId(name);
			if (id != null) {
				ctx.ui.notify(`Research helpers cannot be restarted — spawn a new helper instead.`, "warning");
				return;
			}
			const state = name ? ports.getAgents().get(name.toLowerCase()) : undefined;
			if (!state) { ctx.ui.notify(`Usage: /af-agents-restart <name>. Known: ${specialistTargets(ports) || "none"}`, "error"); return; }
			if (!state.task) { ctx.ui.notify(`${ports.displayName(state.def.name)} has no previous task to restart.`, "warning"); return; }
			ctx.ui.notify(`Restarting ${ports.displayName(state.def.name)} (fresh)...`, "info"); await ports.restartSpecialist(state, ctx);
		},
	};
	return controls;
}
