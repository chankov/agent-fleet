/**
 * Opt-in C4 entry. Pi does not auto-load `.pi/harnesses/`.
 * Load only with AF_C4_PI_UI=1 and an explicit `pi -e` of THIS file.
 * Do not load agent-hub/index.ts. No dispatch, no model turns, no config writes.
 */
import "./system1-c4-no-inference.js";
import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createFleetSource } from "../../../.pi/harnesses/agent-hub/ui/fleet-source.ts";
import { createGridUI } from "../../../.pi/harnesses/agent-hub/ui/grid.ts";
import { createFleetDashboard } from "../../../.pi/harnesses/agent-hub/ui/fleet-dashboard.ts";
import { createDetailPanel } from "../../../.pi/harnesses/agent-hub/ui/detail-panel.ts";
import { createFleetActions } from "../../../.pi/harnesses/agent-hub/ui/fleet-actions.ts";
import { registerInputShortcuts } from "../../../.pi/harnesses/agent-hub/input/shortcuts.ts";
import { C4_OPT_IN, C4_SCENES, createC4MockState, type C4Scene } from "./system1-c4-pi-ui-state.ts";

const HELP = "C4 mock: /c4 concurrent|statuses|fast|cancel|reopen|cleanup|narrow|dash|detail. No model turns.";

function enabled(env: NodeJS.ProcessEnv): boolean {
	return env[C4_OPT_IN] === "1";
}

export function createC4PiUi(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	if (!enabled(env)) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`C4 mock refused: set ${C4_OPT_IN}=1. This file is not production agent-hub.`, "warning");
		});
		pi.on("input", async (_event, ctx) => {
			ctx.ui.notify("C4 mock is not opted in; input was not sent to a model.", "warning");
			return { action: "handled" };
		});
		pi.on("before_agent_start", async (_event, ctx) => {
			ctx.abort();
		});
		return;
	}

	const mock = createC4MockState();
	let widgetCtx: ExtensionContext | undefined;
	let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	const fleetSource = createFleetSource({
		getAgents: () => mock.workers,
		getResearch: () => new Map(),
		getPeerInputs: () => [],
		getPeerCards: () => new Map(),
		getPendingReplies: () => [],
		displayName: name => name,
		modelForAgent: () => "mock",
		modelForResearch: () => "mock",
		modelForPeer: model => model,
		getSystem1: () => mock.live(),
	});
	const grid = createGridUI({
		getWidgetContext: () => widgetCtx,
		getRows: now => fleetSource.rows(now, { showFinished: true }),
		handleIntent: async intent => {
			if (!widgetCtx) return;
			if (intent.type === "open") await grid.withSuspended(() => actions.open(intent.key, intent.runToken, widgetCtx!));
			else widgetCtx.ui.notify("C4 mock does not kill or restart workers.", "warning");
		},
	});
	const detail = createDetailPanel({
		getAgent: key => mock.workers.get(key),
		getResearch: () => undefined,
		parseResearchHandle: () => null,
		findDelegationChild: () => null,
		modelPolicy: blockedPolicy(),
		displayName: name => name,
		shortModel: model => model ?? "mock",
		refreshUi: () => grid.updateWidget(),
		getDispatchPreference: () => "native",
		maxLiveEntryChars: 64 * 1024,
		currentFleetRow: key => fleetSource.rows(Date.now(), { showFinished: true }).find(row => row.key === key),
	});
	const actions = createFleetActions({
		getRows: () => fleetSource.rows(Date.now(), { showFinished: true }),
		getAgents: () => mock.workers,
		getResearch: () => new Map(),
		parseResearchHandle: () => null,
		displayName: name => name,
		modelWorkBlocked: () => true,
		restartSpecialist: async (_state, ctx) => { ctx.ui.notify("C4 mock does not dispatch.", "warning"); },
		removeResearch: () => {},
		killSpecialistProcess: () => {},
		abortComs: () => {},
		openDetail: (row, ctx, verbose) => detail.openFleetDetail(row, ctx, verbose),
		generation: () => generation,
	});
	const dashboard = createFleetDashboard({
		getAgents: () => mock.workers,
		getResearch: () => new Map(),
		getShowFinished: () => true,
		setShowFinished: () => {},
		getFilter: () => "",
		setFilter: () => {},
		getFleetRows: (now, _unfiltered) => fleetSource.rows(now, { showFinished: true }),
		actions,
		parseResearchHandle: () => null,
		displayName: name => name,
		shortModel: model => model ?? "mock",
		thinkingSuffix: () => "",
		modelWithThinking: () => "mock",
		resolvedThinking: () => undefined,
		abbreviatePeerModel: model => model,
		modelPolicy: blockedPolicy(),
		loadAvailableModels: async (_ctx) => null,
		openDetail: (row, ctx, verbose) => detail.openFleetDetail(row, ctx, verbose),
		openHistory: async (ctx) => { ctx.ui.notify("C4 mock has no history overlay.", "info"); },
		modelWorkBlocked: () => true,
		restartSpecialist: async (_state, ctx) => { ctx.ui.notify("C4 mock does not dispatch.", "warning"); },
		removeResearch: () => {},
		killSpecialistProcess: () => {},
		abortComs: () => {},
		getComsLines: () => [],
	});

	function refresh() {
		grid.updateWidget();
	}
	function apply(scene: C4Scene, ctx: ExtensionContext) {
		if (cleanupTimer) clearTimeout(cleanupTimer);
		cleanupTimer = undefined;
		generation++;
		mock.apply(scene);
		refresh();
		const note = scene === "narrow"
			? "C4 narrow: resize this terminal to about 40 columns, then about 20. Alt+I expands owner lines; S1 stays in the name, not only as color."
			: `C4 scene ${mock.scene}. Workers stay at 1 tools / edit.`;
		ctx.ui.notify(note, "info");
		try { ctx.ui.setStatus("c4-mock", `C4 mock · ${mock.scene}`); } catch { /* status slot is optional */ }
		if (scene === "cleanup") {
			const started = Date.now();
			cleanupTimer = setTimeout(() => {
				mock.workers.clear();
				refresh();
				ctx.ui.notify("C4 cleanup: fake workers dropped after 10s retention.", "info");
			}, 10_050);
			cleanupTimer.unref?.();
			void started;
		}
	}
	async function openDash(ctx: ExtensionContext) {
		widgetCtx = ctx;
		await grid.withSuspended(() => dashboard.openFleetDashboard(ctx));
	}
	async function openBuilder(ctx: ExtensionContext) {
		widgetCtx = ctx;
		const row = fleetSource.rows(Date.now(), { showFinished: true }).find(item => item.key === "builder");
		if (!row) { ctx.ui.notify("C4 mock has no Builder row in this scene.", "warning"); return; }
		await grid.withSuspended(() => actions.open(row.key, row.runToken, ctx));
	}

	registerInputShortcuts(pi, {
		setWidgetContext: ctx => { widgetCtx = ctx; },
		openFleetDashboard: ctx => openDash(ctx),
		toggleFleetWidget: () => grid.toggle(),
		workModeStatusText: () => "C4 mock has no work mode",
		openWorkModePicker: async ctx => { ctx.ui.notify("C4 mock has no work mode and does not edit config.", "info"); },
	});
	pi.registerCommand("c4", {
		description: "Drive fake System 1 scenes in the real Fleet widgets",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const scene = (args ?? "").trim().split(/\s+/)[0] ?? "";
			if (scene === "dash") { await openDash(ctx); return; }
			if (scene === "detail") { await openBuilder(ctx); return; }
			if (scene === "help" || !scene) { ctx.ui.notify(HELP, "info"); return; }
			if (!C4_SCENES.includes(scene as C4Scene)) { ctx.ui.notify(HELP, "warning"); return; }
			apply(scene as C4Scene, ctx);
		},
	});
	pi.on("session_start", (_event, ctx) => {
		widgetCtx = ctx;
		refresh();
		try { ctx.ui.setStatus("c4-mock", "C4 mock · concurrent"); } catch { /* optional */ }
		ctx.ui.notify(`${HELP} Alt+A dashboard, Alt+I strip, Enter detail, /quit exits.`, "info");
		const ready = env.AF_C4_READY_FILE;
		if (ready) writeFileSync(ready, "ready concurrent\n", { mode: 0o600 });
	});
	pi.on("session_shutdown", () => {
		if (cleanupTimer) clearTimeout(cleanupTimer);
		grid.dispose();
		mock.dispose();
	});
	pi.on("input", async (event, ctx) => {
		if (event.text.trim() === "/quit") return { action: "continue" };
		ctx.ui.notify("C4 mock blocked model input. Use /c4 or /quit.", "warning");
		return { action: "handled" };
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		ctx.abort();
		ctx.ui.notify("C4 mock aborted a model turn.", "error");
	});
	pi.on("before_provider_request", () => {
		throw new Error("System 1 offline tests forbid HTTPS requests");
	});
}

function blockedPolicy() {
	return {
		allKnownModels: () => [],
		getSubstitution: () => undefined,
		applySessionSubstitution: async () => false,
		substitutedModel: (model?: string) => model,
		resolvedModel: () => "mock",
		resolvedSubagentModel: () => "mock",
		resolvedThinking: () => undefined,
		allowedModels: () => [],
		switchablePersonaDef: () => undefined,
		getPersonaOverride: () => undefined,
		setPersonaOverride: () => {},
		getSubagentOverride: () => undefined,
		setSubagentOverride: () => {},
		setThinkingOverride: () => {},
		substitutionEntries: () => [][Symbol.iterator](),
		applyProfile: () => [],
	};
}

export default function system1C4PiUi(pi: ExtensionAPI) {
	createC4PiUi(pi);
}
