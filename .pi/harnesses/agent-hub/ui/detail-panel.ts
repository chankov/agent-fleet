import { assertProfileModel, readActiveProfile } from '../policy/profile-runtime.ts';
import { copyToClipboard } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { ModelPolicy } from "../policy/models.ts";
import type { ResearchState } from "../research/runtime.ts";
import type { DelegationChild } from "../dispatch-core.ts";
import type { SpecialistContextManifest } from "../../lib/context-budget-child-prompt.ts";
import type { TimelineEntry, Zoomable } from "./zoom.ts";
import type { FleetRow } from "../../lib/fleet-read-model.ts";
import {
	detailContent, detailEntryOffsets, detailTransition, fleetModelChoices, modelPickerTransition,
	normalizeFleetDetailInput, renderFleetDetail, renderFleetModelPicker, DETAIL_CHROME_ROWS,
	type FleetDetailKey, type FleetModelChoice,
} from "../../lib/fleet-detail-view.ts";
import { liveTimeline, snapshotFleetDetailRow } from "../../lib/fleet-dashboard-ops.ts";
import { FULLSCREEN_OVERLAY, bodyRows } from "../../lib/fleet-overlay.ts";
import { createPanelResources } from "../../lib/fleet-panel.ts";
import {
	readFleetTranscript, readFleetTranscriptBefore, readFleetTranscriptTail,
	type FleetTranscriptRecord, type FleetTranscriptStore,
} from "../../lib/fleet-transcript-store.ts";

export interface DetailAgentDef {
	name: string;
	description: string;
	tools: string;
	model?: string;
	fallbackModel?: string;
	thinking?: string;
	kind?: string;
	systemPrompt: string;
	file: string;
	subagents?: Record<string, { model: string; fallbackModel?: string; tools?: string }>;
}

export interface DetailAgentState {
	def: DetailAgentDef;
	status: "idle" | "running" | "done" | "error";
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	zoomRender?: (force?: boolean) => void;
	specialistManifest?: SpecialistContextManifest;
}

export interface DetailDelegation {
	child: DelegationChild;
	owner: DetailAgentState;
}

export interface DetailUiContext {
	ui: {
		custom(factory: (tui: any, theme: any, kb: any, done: () => void) => any, options: unknown): Promise<unknown>;
		notify(message: string, level: "error" | "info" | "success" | "warning"): void;
	};
	modelRegistry?: {
		refresh?(): Promise<void>;
		getAvailable?(): readonly unknown[];
		getError?(): string | undefined;
	};
}

export interface DetailPanelDeps<TDef extends DetailAgentDef, TAgent extends DetailAgentState, TResearch extends ResearchState<TDef>> {
	getAgent(key: string): TAgent | undefined;
	getResearch(id: number): TResearch | undefined;
	parseResearchHandle(value: string): number | null;
	findDelegationChild(key: string): DetailDelegation | null;
	modelPolicy: ModelPolicy<TDef>;
	displayName(name: string): string;
	shortModel(model: string | undefined): string;
	refreshUi(): void;
	getDispatchPreference(name: string): "native" | "coms";
	maxLiveEntryChars: number;
}

type ModelTarget<TAgent, TResearch> =
	| { kind: "specialist"; current: string; state: TAgent }
	| { kind: "research"; current: string; state: TResearch }
	| { kind: "delegate"; current: string; delegation: DetailDelegation; role: [string, { model: string; fallbackModel?: string; tools?: string }] };

export function createDetailPanel<TDef extends DetailAgentDef, TAgent extends DetailAgentState, TResearch extends ResearchState<TDef>>(deps: DetailPanelDeps<TDef, TAgent, TResearch>) {
	function resolveModelTarget(row: FleetRow, ctx: DetailUiContext): ModelTarget<TAgent, TResearch> | null {
		if (row.kind === "peer") { ctx.ui.notify("External coms peers control their own model; switch it in that peer's Pi session.", "info"); return null; }
		if (row.kind === "specialist") {
			const state = deps.getAgent(row.key);
			if (!state) { ctx.ui.notify("This specialist is no longer available.", "warning"); return null; }
			return { kind: "specialist", current: deps.modelPolicy.resolvedModel(state.def as TDef) ?? "", state };
		}
		if (row.kind === "research") {
			const id = deps.parseResearchHandle(row.key);
			const state = id == null ? undefined : deps.getResearch(id);
			if (!state) { ctx.ui.notify("This research helper is no longer available.", "warning"); return null; }
			return { kind: "research", current: state.model, state };
		}
		const delegation = deps.findDelegationChild(row.key);
		if (!delegation) { ctx.ui.notify("This nested delegate is no longer available.", "warning"); return null; }
		const role = Object.entries(delegation.owner.def.subagents ?? {}).find(([name]) => name.toLowerCase() === delegation.child.role.toLowerCase());
		if (!role) { ctx.ui.notify(`The role for ${row.name} is no longer declared by ${deps.displayName(delegation.owner.def.name)}.`, "warning"); return null; }
		return { kind: "delegate", current: deps.modelPolicy.resolvedSubagentModel(delegation.owner.def.name, role[0], role[1].model), delegation, role };
	}

	async function loadAvailableModelChoices(ctx: DetailUiContext, current?: string): Promise<FleetModelChoice[] | null> {
		try { await ctx.modelRegistry?.refresh?.(); } catch { /* retain last-known models */ }
		const allowed=readActiveProfile()?.profile['allowed-models'];
		const choices = fleetModelChoices(ctx.modelRegistry?.getAvailable?.() ?? [], current).filter(choice=>!allowed||allowed.includes(choice.spec));
		if (choices.length === 0) {
			const diagnostic = ctx.modelRegistry?.getError?.();
			ctx.ui.notify(`Pi reports no available models${diagnostic ? `: ${diagnostic}` : "."}`, "warning");
			return null;
		}
		return choices;
	}

	function applyModel(row: FleetRow, picked: string, ctx: DetailUiContext): boolean {
		const target = resolveModelTarget(row, ctx);
		if (!target) return false;
		const effectivePicked = deps.modelPolicy.substitutedModel(picked) ?? picked;
		try {assertProfileModel(effectivePicked);}catch(error){ctx.ui.notify(String(error),"error");return false;}
		if (effectivePicked === target.current) { ctx.ui.notify(`${row.name} is already on ${effectivePicked}`, "info"); return false; }
		let applyHint = "applies on the next run";
		if (target.kind === "specialist") {
			const key = target.state.def.name.toLowerCase();
			deps.modelPolicy.setPersonaOverride(key, picked === target.state.def.model ? undefined : picked);
			applyHint = "applies on the next dispatch";
		} else if (target.kind === "research") {
			target.state.model = picked;
			applyHint = "current run is not interrupted; spawn a new helper to use this model";
		} else {
			deps.modelPolicy.setSubagentOverride(target.delegation.owner.def.name, target.role[0], picked === target.role[1].model ? undefined : picked);
			applyHint = `applies on the next ${deps.displayName(target.delegation.owner.def.name)} dispatch`;
		}
		deps.refreshUi();
		ctx.ui.notify(`${row.name} → ${effectivePicked} (${applyHint}; current runs are not interrupted)`, "success");
		if (target.kind === "specialist" && deps.getDispatchPreference(target.state.def.name) === "coms") ctx.ui.notify("This specialist prefers a coms peer; the choice applies to native fallback runs, while the peer keeps its own model.", "info");
		return true;
	}

	function matchedInput(data: string): string {
		const key: FleetDetailKey | undefined = matchesKey(data, Key.up) ? "up" : matchesKey(data, Key.down) ? "down" : matchesKey(data, Key.pageUp) ? "pageUp" : matchesKey(data, Key.pageDown) ? "pageDown" : matchesKey(data, Key.home) ? "home" : matchesKey(data, Key.end) ? "end" : matchesKey(data, Key.enter) ? "enter" : matchesKey(data, Key.escape) ? "escape" : matchesKey(data, Key.ctrl("c")) ? "copy" : undefined;
		return normalizeFleetDetailInput(data, key);
	}

	async function openFleetDetail(row: FleetRow, ctx: DetailUiContext, initialVerbose = false): Promise<boolean> {
		const researchId = row.kind === "research" ? deps.parseResearchHandle(row.key) : null;
		const target: Zoomable | undefined = researchId != null ? deps.getResearch(researchId) : row.kind === "delegate" ? deps.findDelegationChild(row.key)?.child : deps.getAgent(row.key);
		const resources = createPanelResources();
		let detailRow = row, modelPicker: { choices: FleetModelChoice[]; index: number; scrollOffset: number } | null = null;
		let scrollOffset = 0, selectedIndex = 0, expandedIndex: number | null = null, followTail = true, verbose = initialVerbose, lastRender = 0;
		const transcriptPath = target?.transcriptStore?.path;
		let transcriptRecords: FleetTranscriptRecord[] | null = transcriptPath ? readFleetTranscriptTail(transcriptPath, { limit: 2000 }).records : null;
		const compactRecords = (records: readonly FleetTranscriptRecord[]): TimelineEntry[] => {
			const entries: TimelineEntry[] = [];
			for (const { event } of records) {
				const current = event as TimelineEntry, last = entries[entries.length - 1];
				const merge = last && last.kind === current.kind && (current.kind === "text" || current.kind === "thinking" || (last.callId && last.callId === current.callId));
				if (merge && last.content.length < deps.maxLiveEntryChars) { const room = deps.maxLiveEntryChars - last.content.length; last.content += current.content.slice(0, room); if (current.content.length > room) entries.push({ ...current, content: current.content.slice(room) }); }
				else entries.push({ ...current });
			}
			return entries;
		};
		const timeline = () => transcriptRecords ? compactRecords(transcriptRecords) : [...liveTimeline(target)] as TimelineEntry[];
		const syncTail = () => { if (!transcriptPath || !transcriptRecords || !followTail) return; const after = transcriptRecords.at(-1)?.endOffset ?? 0; const page = readFleetTranscript(transcriptPath, { after, limit: 500 }); transcriptRecords.push(...page.records); if (transcriptRecords.length > 2000) transcriptRecords.splice(0, transcriptRecords.length - 2000); };
		const loadOlder = () => { if (!transcriptPath || !transcriptRecords) return 0; const before = transcriptRecords[0]?.startOffset ?? 0; if (before <= 0) return 0; const older = readFleetTranscriptBefore(transcriptPath, { before, limit: 500 }).records; transcriptRecords.unshift(...older); if (transcriptRecords.length > 2000) transcriptRecords.splice(2000); return compactRecords(older).length; };
		const loadNewer = () => { if (!transcriptPath || !transcriptRecords) return 0; const newer = readFleetTranscript(transcriptPath, { after: transcriptRecords.at(-1)?.endOffset ?? 0, limit: 500 }).records; if (!newer.length) return 0; transcriptRecords.push(...newer); const overflow = Math.max(0, transcriptRecords.length - 2000); const removed = overflow ? compactRecords(transcriptRecords.slice(0, overflow)).length : 0; if (overflow) transcriptRecords.splice(0, overflow); return removed; };
		const reloadTail = () => { if (transcriptPath) transcriptRecords = readFleetTranscriptTail(transcriptPath, { limit: 2000 }).records; };
		try { await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => {
			if (target) target.zoomRender = (force?: boolean) => { const now = Date.now(); if (force || now - lastRender > 80) { lastRender = now; tui.requestRender(); } };
			resources.every(2000, () => tui.requestRender());
			return { render: (w: number) => { const body = bodyRows(tui.terminal?.rows, DETAIL_CHROME_ROWS); if (modelPicker) return renderFleetModelPicker(detailRow.name, modelPicker.choices, modelPicker, w, body, theme); syncTail(); const entries = timeline(); if (followTail) { selectedIndex = Math.max(0, entries.length - 1); scrollOffset = Math.max(0, detailContent(entries, w, expandedIndex, verbose, selectedIndex).length - body); } const liveRow = snapshotFleetDetailRow(detailRow, target); return renderFleetDetail(liveRow, entries, scrollOffset, w, body, theme, expandedIndex, verbose, selectedIndex); },
				handleInput: async (data: string) => { const input = matchedInput(data), body = bodyRows(tui.terminal?.rows, DETAIL_CHROME_ROWS); if (modelPicker) { const action = modelPickerTransition(input, modelPicker, modelPicker.choices.length, body); if (action === "cancel") modelPicker = null; else if (action === "select") { const picked = modelPicker.choices[modelPicker.index]?.spec; modelPicker = null; if (picked && applyModel(detailRow, picked, ctx)) { const effective = deps.modelPolicy.substitutedModel(picked) ?? picked; detailRow = { ...detailRow, model: detailRow.status === "running" ? `${detailRow.model} → ${deps.shortModel(effective)} next` : `${deps.shortModel(effective)} (next)` }; } } tui.requestRender(); return; }
					if ((input === "\u001b[A" || input === "k" || input === "\u001b[5~" || input === "\u001b[H") && scrollOffset === 0) selectedIndex += loadOlder(); if (input === "\u001b[F") reloadTail(); let entries = timeline(); if (!followTail && (input === "\u001b[B" || input === "j" || input === "\u001b[6~") && selectedIndex >= entries.length - 1) { selectedIndex = Math.max(0, selectedIndex - loadNewer()); entries = timeline(); }
					const width = tui.terminal?.columns ?? 80, state = { scrollOffset, selectedIndex, expandedIndex, followTail, verbose }, content = detailContent(entries, width, expandedIndex, verbose, selectedIndex), offsets = detailEntryOffsets(entries, width, expandedIndex, verbose); const action = detailTransition(input, state, entries, body, content.length, offsets); ({ scrollOffset, selectedIndex, expandedIndex, followTail, verbose } = state); if (action === "close") done(); else if (action === "copy") { const item = entries[selectedIndex]; if (item) { try { await copyToClipboard(item.content); ctx.ui.notify("Copied selected zoom row", "success"); } catch { ctx.ui.notify("Failed to copy selected zoom row", "error"); } } } else if (action === "model") { const target = resolveModelTarget(detailRow, ctx); if (target) { const choices = await loadAvailableModelChoices(ctx, target.current); if (choices) { const index = choices.findIndex(choice => choice.spec === target.current); modelPicker = { choices, index: Math.max(0, index), scrollOffset: Math.max(0, index) }; } } } tui.requestRender(); },
				invalidate() {}, dispose: () => resources.dispose() };
		}, FULLSCREEN_OVERLAY); } finally { resources.dispose(); if (target) target.zoomRender = undefined; }
		return verbose;
	}

	return { openFleetDetail, loadAvailableModelChoices };
}
