import { CAPABILITY_PACKS, persistedCapabilityState, resolveCapabilityPacks, type CapabilityPack, type CapabilityResolution, type ContextState, type PendingOperation } from "../capability-packs.ts";
import { confirmationGate, type CapabilityConfirmationState, type ConfirmableCapabilityPack } from "../capability-confirmation.ts";
import { orchestratorNeedsRoster } from "../helpers.ts";
import { WORK_MODE_ENTRY_TYPE, resolveWorkModeTools, type WorkMode } from "../work-mode.ts";
import { selectedPickerValue, workModeChangeBlockedByRoster, workModePickerOptions } from "../work-mode-controls.ts";

export interface WorkModeUiPort {
	hasUI?: boolean;
	ui: { notify(message: string, level: "error" | "warning" | "info" | "success"): void; setStatus(key: string, value: string): void; select(title: string, options: string[]): Promise<string | undefined> };
}
export interface PersistedCapabilityRestore { taskPacks: CapabilityPack[]; provisional: CapabilityPack[]; confirmation: CapabilityConfirmationState }
export interface WorkModePolicyPorts {
	getBaselineTools(): readonly string[];
	getRosterSize(): number;
	getActiveTeamName(): string;
	getComsReady(): boolean;
	getHerdrReady(): boolean;
	getAskUserAvailable(): boolean;
	getIdentityLabel(): string | null;
	getTaskTier(): string | null;
	getPendingOperations(): PendingOperation[];
	getContextState(): ContextState;
	setActiveTools(tools: string[]): void;
	persist(type: string, data: unknown): void;
	replayDeferredInputs(): void;
	watchdogArmed(workMode: WorkMode): boolean;
}
export interface WorkModePolicy {
	getWorkMode(): WorkMode;
	setRestoredWorkMode(mode: WorkMode): void;
	getCapabilityResolution(): CapabilityResolution;
	getCapabilityConfirmation(): CapabilityConfirmationState;
	setCapabilityConfirmation(pack: ConfirmableCapabilityPack, status: CapabilityConfirmationState[ConfirmableCapabilityPack]): void;
	restoreCapabilities(state: PersistedCapabilityRestore): void;
	resetCapabilities(): void;
	resolveIncomingCapabilities(userText: string, newTask?: boolean): void;
	provisionalCapabilityRefusal(pack: ConfirmableCapabilityPack): { content: { type: "text"; text: string }[]; details: { status: string; confirmation: string; pack: ConfirmableCapabilityPack } } | null;
	applyWorkModeTools(): void;
	updateStatus(ctx: WorkModeUiPort): void;
	statusText(): string;
	modelWorkBlockedByRosterRecovery(ctx: WorkModeUiPort): boolean;
	setRosterRecovery(required: boolean, diagnostic?: string): void;
	clearRosterRecovery(): void;
	commit(next: WorkMode, ctx: WorkModeUiPort): Promise<"ok" | "unchanged" | "roster">;
	applySelection(next: WorkMode, ctx: WorkModeUiPort): Promise<void>;
	openPicker(ctx: WorkModeUiPort): Promise<void>;
}

export function createWorkModePolicy(ports: WorkModePolicyPorts, initial: WorkMode = "operator"): WorkModePolicy {
	let workMode = initial;
	let rosterRecoveryRequired = false;
	let rosterRecoveryDiagnostic = "";
	let taskPacks: CapabilityPack[] = [];
	let provisionalPacks: CapabilityPack[] = [];
	let confirmation: CapabilityConfirmationState = {};
	let resolution = resolveCapabilityPacks({ workMode, userText: "", taskPacks: [], comsReady: false, herdrReady: false, pendingOperations: [], contextState: "normal" });

	function resolveIncomingCapabilities(userText: string, newTask = false): void {
		resolution = resolveCapabilityPacks({
			workMode, userText,
			taskTier: (["trivial", "small", "feature", "project"] as const).find(tier => tier === ports.getTaskTier()),
			taskPacks, provisionalPacks,
			comsReady: ports.getComsReady(), herdrReady: ports.getHerdrReady(),
			pendingOperations: ports.getPendingOperations(), contextState: ports.getContextState(), newTask,
		});
		for (const pack of ["fleet", "peer", "workspace"] as const) {
			if (confirmation[pack] === "promoted" || confirmation[pack] === "declined") {
				resolution.provisional = resolution.provisional.filter(candidate => candidate !== pack);
				resolution.confirmationRequired = resolution.confirmationRequired.filter(candidate => candidate !== pack);
				if (confirmation[pack] === "promoted" && !resolution.active.includes(pack)) resolution.active.push(pack);
			}
		}
		taskPacks = resolution.nextTaskPacks = CAPABILITY_PACKS.filter(pack => pack !== "core" && pack !== "compaction" && resolution.active.includes(pack));
		provisionalPacks = resolution.provisional.filter(pack => confirmation[pack as ConfirmableCapabilityPack] !== "declined");
		try { ports.persist("agent-hub-capability-packs", persistedCapabilityState(resolution, confirmation)); } catch { /* best effort */ }
	}
	function applyWorkModeTools(): void {
		ports.setActiveTools(resolveWorkModeTools({ workMode, baselineTools: ports.getBaselineTools(), comsReady: ports.getComsReady(), herdrReady: ports.getHerdrReady(), askUserAvailable: ports.getAskUserAvailable(), capabilityPacks: [...resolution.active, ...resolution.provisional] }));
	}
	function statusText(): string {
		return [`Work Mode: ${workMode}`, `Direct tools: ${workMode === "operator" ? "enabled" : "disabled"}`, `Native roster: ${ports.getActiveTeamName() || "(none)"} (${ports.getRosterSize()})`, `Coms: ${ports.getComsReady() ? `ready${ports.getIdentityLabel() ? ` (${ports.getIdentityLabel()})` : ""}` : "unavailable"}`, `Herdr: ${ports.getHerdrReady() ? "ready" : "unavailable"}`].join("\n");
	}
	function refusalMessage(): string { return "Orchestrator work mode requires at least one native specialist. Add one with /af-agents-add or select /af-agents-team first."; }
	function watchdogNote(next: WorkMode): string { return next === "orchestrator" ? ports.watchdogArmed(next) ? "\nDrift watchdog: armed (orchestrator auto). /af-watchdog off to disarm." : "\nDrift watchdog: off (explicit hub setting)." : ""; }
	async function commit(next: WorkMode, ctx: WorkModeUiPort): Promise<"ok" | "unchanged" | "roster"> {
		if (orchestratorNeedsRoster(next, ports.getRosterSize())) return "roster";
		if (next === workMode) return "unchanged";
		workMode = next;
		if (workMode === "operator") { rosterRecoveryRequired = false; rosterRecoveryDiagnostic = ""; setTimeout(ports.replayDeferredInputs, 0); }
		resolveIncomingCapabilities(""); applyWorkModeTools(); ctx.ui.setStatus("hub-work-mode", `Work Mode: ${workMode}`); ports.persist(WORK_MODE_ENTRY_TYPE, { workMode });
		return "ok";
	}
	async function applySelection(next: WorkMode, ctx: WorkModeUiPort): Promise<void> {
		if (workModeChangeBlockedByRoster(workMode, next, ports.getRosterSize())) { ctx.ui.notify(refusalMessage(), "warning"); return; }
		const result = await commit(next, ctx);
		if (result === "roster") { ctx.ui.notify(refusalMessage(), "warning"); return; }
		ctx.ui.notify(`${statusText()}\nPrompt and tools update on the next model call.${watchdogNote(next)}`, result === "ok" ? "success" : "info");
	}
	async function openPicker(ctx: WorkModeUiPort): Promise<void> {
		const picker = workModePickerOptions(workMode);
		const choice = await ctx.ui.select(picker.title, [...picker.options]);
		const next = selectedPickerValue(picker.options, choice, picker.workModes);
		if (next) await applySelection(next, ctx);
	}
	return {
		getWorkMode: () => workMode, setRestoredWorkMode: mode => { workMode = mode; },
		getCapabilityResolution: () => resolution, getCapabilityConfirmation: () => confirmation,
		setCapabilityConfirmation: (pack, status) => { if (status) confirmation[pack] = status; else delete confirmation[pack]; },
		restoreCapabilities: state => { taskPacks = [...state.taskPacks]; provisionalPacks = [...state.provisional]; confirmation = { ...state.confirmation }; },
		resetCapabilities: () => { taskPacks = []; provisionalPacks = []; confirmation = {}; },
		resolveIncomingCapabilities,
		provisionalCapabilityRefusal: pack => { const gate = confirmationGate(confirmation, pack, resolution.provisional.includes(pack)); return gate.allowed ? null : { content: [{ type: "text", text: gate.message }], details: { status: "provisional_confirmation_required", confirmation: gate.status, pack } }; },
		applyWorkModeTools, updateStatus: ctx => ctx.ui.setStatus("hub-work-mode", `Work Mode: ${workMode}`), statusText,
		modelWorkBlockedByRosterRecovery: ctx => { if (workMode !== "orchestrator" || !rosterRecoveryRequired) return false; const message = `${rosterRecoveryDiagnostic || "No valid native roster is active."} Select one with /af-agents-team, restart with --agent-team <name>, or switch explicitly with /af-work-mode operator.`; ctx.ui.notify(message, "error"); if (!ctx.hasUI) console.error(`[agent-hub] ${message}`); return true; },
		setRosterRecovery: (required, diagnostic = "") => { rosterRecoveryRequired = required; rosterRecoveryDiagnostic = required ? diagnostic : ""; }, clearRosterRecovery: () => { rosterRecoveryRequired = false; rosterRecoveryDiagnostic = ""; },
		commit, applySelection, openPicker,
	};
}
