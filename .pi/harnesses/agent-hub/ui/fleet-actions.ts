import type { ChildProcess } from "node:child_process";
import { resolveFleetKill, resolveFleetRestart, type FleetAction } from "../../lib/fleet-dashboard-ops.ts";
import type { FleetRow } from "../../lib/fleet-read-model.ts";
import type { DetailUiContext } from "./detail-panel.ts";

export interface FleetActionAgent {
	def: { name: string };
	task?: string;
	proc?: ChildProcess;
	comsAbort?: () => void;
	killedByOperator?: boolean;
}
export interface FleetActionsDeps<TAgent extends FleetActionAgent, TResearch> {
	getRows(): readonly FleetRow[];
	getAgents(): ReadonlyMap<string, TAgent>;
	getResearch(): ReadonlyMap<number, TResearch>;
	parseResearchHandle(value: string): number | null;
	displayName(name: string): string;
	modelWorkBlocked(ctx: DetailUiContext): boolean;
	restartSpecialist(state: TAgent, ctx: DetailUiContext): Promise<void>;
	removeResearch(state: TResearch, ctx: DetailUiContext): void;
	killSpecialistProcess(state: TAgent): void;
	abortComs(state: TAgent): void;
	openDetail(row: FleetRow, ctx: DetailUiContext, verbose?: boolean): Promise<boolean>;
	generation(): number;
}

/** Shared dashboard/widget actions with fresh lookup, ownership checks and async deduplication. */
export function createFleetActions<TAgent extends FleetActionAgent, TResearch>(deps: FleetActionsDeps<TAgent, TResearch>) {
	const pending = new Set<string>();
	function fresh(key: string, runToken?: string): FleetRow | undefined {
		return deps.getRows().find(row => row.key === key && (!runToken || row.runToken === runToken));
	}
	async function execute(action: FleetAction, key: string, runToken: string | undefined, ctx: DetailUiContext): Promise<void> {
		const guard = `${action}:${key}:${runToken ?? ""}`;
		if (pending.has(guard)) return;
		const selected = fresh(key, runToken);
		if (!selected || !runToken) { ctx.ui.notify("Selected fleet run is no longer available.", "warning"); return; }
		const generation = deps.generation();
		if (action === "restart") {
			if (deps.modelWorkBlocked(ctx)) return;
			const decision = resolveFleetRestart(selected, { specialistRestartable: candidate => !!deps.getAgents().get(candidate)?.task });
			if (decision.action === "unsupported") { ctx.ui.notify(decision.message, decision.level); return; }
			const state = deps.getAgents().get(selected.key);
			if (!state?.task || !fresh(key, runToken)) { ctx.ui.notify(`${selected.name} is no longer restartable.`, "warning"); return; }
			pending.add(guard);
			try {
				ctx.ui.notify(`Restarting ${deps.displayName(state.def.name)} (fresh)...`, "info");
				await deps.restartSpecialist(state, ctx);
				if (deps.generation() !== generation) return;
			} finally { pending.delete(guard); }
			return;
		}
		const decision = resolveFleetKill(selected, {
			researchExists: candidate => { const id = deps.parseResearchHandle(candidate); return id != null && deps.getResearch().has(id); },
			agentHandles: candidate => { const state = deps.getAgents().get(candidate); return state ? { proc: state.proc, comsAbort: state.comsAbort } : undefined; },
		});
		if (!fresh(key, runToken) || deps.generation() !== generation) return;
		if (decision.action === "kill-research") {
			const id = deps.parseResearchHandle(selected.key), state = id == null ? undefined : deps.getResearch().get(id);
			if (state) { deps.removeResearch(state, ctx); ctx.ui.notify(decision.message, "info"); }
			else ctx.ui.notify(`Research ${selected.name} is no longer available.`, "warning");
		} else if (decision.action === "kill-proc") {
			const state = deps.getAgents().get(selected.key);
			if (state) { state.killedByOperator = true; deps.killSpecialistProcess(state); ctx.ui.notify(decision.message, "info"); }
		} else if (decision.action === "coms-abort") {
			const state = deps.getAgents().get(selected.key); if (state) deps.abortComs(state); ctx.ui.notify(decision.message, "info");
		} else ctx.ui.notify(decision.message, decision.level);
	}
	async function open(key: string, runToken: string | undefined, ctx: DetailUiContext, verbose = false): Promise<boolean> {
		const selected = fresh(key, runToken);
		if (!selected) { ctx.ui.notify("Selected fleet run is no longer available.", "warning"); return verbose; }
		return deps.openDetail(selected, ctx, verbose);
	}
	return { execute, open, pending: (action: FleetAction, key: string, runToken?: string) => pending.has(`${action}:${key}:${runToken ?? ""}`), reset: () => pending.clear() };
}
