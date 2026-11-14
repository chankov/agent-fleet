import { CAPABILITY_PACKS, persistedCapabilityState, resolveCapabilityPacks, type CapabilityPack, type CapabilityResolution, type ContextState, type PendingOperation } from "../capability-packs.ts";
import { confirmationGate, type CapabilityConfirmationState, type ConfirmableCapabilityPack } from "../capability-confirmation.ts";
import { resolveWorkModeTools, type WorkMode } from "../work-mode.ts";

export interface WorkModeUiPort {
	hasUI?: boolean;
	ui: { notify(message: string, level: "error" | "warning" | "info"): void; setStatus(key: string, value: string | undefined): void };
}
export interface PersistedCapabilityRestore { taskPacks: CapabilityPack[]; provisional: CapabilityPack[]; confirmation: CapabilityConfirmationState }
export interface WorkModePolicyPorts {
	getBaselineTools(): readonly string[];
	getRosterSize(): number;
	getActiveTeamName(): string;
	getComsReady(): boolean;
	getHerdrReady(): boolean;
	getAskUserAvailable(): boolean;
	getDeterministicToolsEnabled?(): boolean;
	getDispatchTriageEnabled?(): boolean;
	getAgenticAskEnabled?(): boolean;
 getFileDiscoveryEnabled?(): boolean;
	getIdentityLabel(): string | null;
	getTaskTier(): string | null;
	getPendingOperations(): PendingOperation[];
	getContextState(): ContextState;
	getActiveTools?(): readonly string[];
	setActiveTools(tools: string[]): void;
	recordToolCatalog?(change: { fromMode: WorkMode; toMode: WorkMode; previous: readonly string[]; next: readonly string[]; reason: "refresh" | "mode_switch" }): void;
	persist(type: string, data: unknown): void;
}
export interface WorkModePolicy {
	/** Always the operator: the Hub has one work mode (2026-11-11). */
	getWorkMode(): WorkMode;
	getCapabilityResolution(): CapabilityResolution;
	getCapabilityConfirmation(): CapabilityConfirmationState;
	setCapabilityConfirmation(pack: ConfirmableCapabilityPack, status: CapabilityConfirmationState[ConfirmableCapabilityPack]): void;
	restoreCapabilities(state: PersistedCapabilityRestore): void;
	resetCapabilities(): void;
	resolveIncomingCapabilities(userText: string, newTask?: boolean): void;
	/** Recompute state/lease changes without losing the current input's transient compaction intent. */
	refreshCapabilities(): void;
	provisionalCapabilityRefusal(pack: ConfirmableCapabilityPack): { content: { type: "text"; text: string }[]; details: { status: string; confirmation: string; pack: ConfirmableCapabilityPack } } | null;
	applyWorkModeTools(): void;
	updateStatus(ctx: WorkModeUiPort): void;
	statusText(): string;
}

export function createWorkModePolicy(ports: WorkModePolicyPorts): WorkModePolicy {
	const workMode: WorkMode = "operator";
	let taskPacks: CapabilityPack[] = [];
	let provisionalPacks: CapabilityPack[] = [];
	let confirmation: CapabilityConfirmationState = {};
	let currentExplicitCompaction = false;
 let persistedState: string | null = null;
	let resolution = resolveCapabilityPacks({ userText: "", taskPacks: [], comsReady: false, herdrReady: false, pendingOperations: [], contextState: "normal" });

	function resolveIncomingCapabilities(userText: string, newTask = false, refresh = false): void {
		resolution = resolveCapabilityPacks({
			userText,
			taskTier: (["trivial", "small", "feature", "project"] as const).find(tier => tier === ports.getTaskTier()),
			taskPacks, provisionalPacks,
			comsReady: ports.getComsReady(), herdrReady: ports.getHerdrReady(),
			pendingOperations: ports.getPendingOperations(), contextState: ports.getContextState(), newTask,
		});
		if (refresh && currentExplicitCompaction && !newTask) {
			resolution.active = CAPABILITY_PACKS.filter(pack => pack === "compaction" || resolution.active.includes(pack));
			resolution.reasons.compaction = "explicit-compaction";
		}
		currentExplicitCompaction = resolution.active.includes("compaction") && resolution.reasons.compaction === "explicit-compaction";
		for (const pack of ["fleet", "peer", "workspace"] as const) {
			if (confirmation[pack] === "promoted" || confirmation[pack] === "declined") {
				resolution.provisional = resolution.provisional.filter(candidate => candidate !== pack);
				resolution.confirmationRequired = resolution.confirmationRequired.filter(candidate => candidate !== pack);
				if (confirmation[pack] === "promoted" && !resolution.active.includes(pack)) resolution.active.push(pack);
			}
		}
		taskPacks = resolution.nextTaskPacks = CAPABILITY_PACKS.filter(pack => pack !== "core" && pack !== "compaction" && resolution.active.includes(pack));
		provisionalPacks = resolution.provisional.filter(pack => confirmation[pack as ConfirmableCapabilityPack] !== "declined");
		const snapshot = persistedCapabilityState(resolution, confirmation);
  const key = JSON.stringify(snapshot);
  if (key !== persistedState) {
   try { ports.persist("agent-hub-capability-packs", snapshot); persistedState = key; } catch { /* retry next refresh */ }
  }
	}
	function applyWorkModeTools(fromMode: WorkMode = workMode, reason: "refresh" | "mode_switch" = "refresh"): void {
		const previous = [...(ports.getActiveTools?.() ?? [])];
		const requested = resolveWorkModeTools({ baselineTools: ports.getBaselineTools(), comsReady: ports.getComsReady(), herdrReady: ports.getHerdrReady(), askUserAvailable: ports.getAskUserAvailable(), deterministicTools: ports.getDeterministicToolsEnabled?.() === true, triageEnabled: ports.getDispatchTriageEnabled?.() === true, agenticAskEnabled: ports.getAgenticAskEnabled?.() === true, fileDiscoveryEnabled: ports.getFileDiscoveryEnabled?.() === true, capabilityPacks: [...resolution.active, ...resolution.provisional] });
		ports.setActiveTools(requested);
		ports.recordToolCatalog?.({ fromMode, toMode: workMode, previous, next: [...(ports.getActiveTools?.() ?? requested)], reason });
	}
	function statusText(): string {
		return [`Work Mode: ${workMode}`, "Direct tools: enabled", `Native roster: ${ports.getActiveTeamName() || "(none)"} (${ports.getRosterSize()})`, `Coms: ${ports.getComsReady() ? `ready${ports.getIdentityLabel() ? ` (${ports.getIdentityLabel()})` : ""}` : "unavailable"}`, `Herdr: ${ports.getHerdrReady() ? "ready" : "unavailable"}`].join("\n");
	}
	return {
		getWorkMode: () => workMode,
		getCapabilityResolution: () => resolution, getCapabilityConfirmation: () => confirmation,
		setCapabilityConfirmation: (pack, status) => { if (status) confirmation[pack] = status; else delete confirmation[pack]; },
		restoreCapabilities: state => { persistedState = null; taskPacks = [...state.taskPacks]; provisionalPacks = [...state.provisional]; confirmation = { ...state.confirmation }; currentExplicitCompaction = false; },
		resetCapabilities: () => { persistedState = null; taskPacks = []; provisionalPacks = []; confirmation = {}; currentExplicitCompaction = false; },
		resolveIncomingCapabilities, refreshCapabilities: () => resolveIncomingCapabilities("", false, true),
		provisionalCapabilityRefusal: pack => { const gate = confirmationGate(confirmation, pack, resolution.provisional.includes(pack)); return gate.allowed ? null : { content: [{ type: "text", text: gate.message }], details: { status: "provisional_confirmation_required", confirmation: gate.status, pack } }; },
		applyWorkModeTools, updateStatus: ctx => ctx.ui.setStatus("hub-work-mode", `Work Mode: ${workMode}`), statusText,
	};
}
