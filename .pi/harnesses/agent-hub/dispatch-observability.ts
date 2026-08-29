import * as fs from "node:fs";
import { join } from "node:path";
import type { FleetTranscriptStore } from "../lib/fleet-transcript-store.ts";
import type { ExecutionHistoryStore, HistoryEntry } from "./ui/history-store.ts";
import type { TimelineEntry, Zoomable } from "./ui/zoom.ts";

export interface DelegationChild extends Zoomable {
	id: string;
	parent: string;
	role: string;
	model: string;
	tools: string;
	status: "running" | "done" | "error";
	toolCount: number;
	tokens: number;
	lastWork: string;
	startedAt: number;
	elapsed: number;
	transcriptStore?: FleetTranscriptStore;
	transcriptPending?: TimelineEntry;
	transcriptFlushTimer?: ReturnType<typeof setTimeout>;
	histEntry?: HistoryEntry;
}

export interface DelegationObservableState {
	def: { name: string };
	delegations?: Map<string, DelegationChild>;
	delegationsWatcher?: { close(): void };
	histEntry?: HistoryEntry;
}

interface TimelineTarget {
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	transcriptPending?: TimelineEntry;
	transcriptFlushTimer?: ReturnType<typeof setTimeout>;
	zoomRender?: (force?: boolean) => void;
}

export interface DispatchObservabilityDeps {
	getSessionDir(): string;
	getDelegatedTokens(): number;
	setDelegatedTokens(value: number): void;
	getWidgetContext(): { ui: { setStatus(name: string, value: string): void } } | null | undefined;
	executionHistory: Pick<ExecutionHistoryStore, "start" | "end">;
	displayName(name: string): string;
	safeAgentKey(name: string): string;
	safePathWithin(root: string, ...parts: string[]): string;
	createTranscriptStore(path: string): FleetTranscriptStore;
	appendTimelineText(target: TimelineTarget, kind: "text" | "thinking", delta: string): void;
	appendTimelineEvent(target: TimelineTarget, event: TimelineEntry): TimelineEntry;
	updateWidget(): void;
}

export interface DelegationEvent {
	t?: string;
	id?: string;
	parent?: string;
	role?: string;
	model?: string;
	tools?: string;
	ts?: number;
	kind?: string;
	delta?: string;
	from?: string;
	to?: string;
	reason?: string;
	name?: string;
	args?: string;
	callId?: string;
	output?: any;
	isError?: boolean;
	durationMs?: number;
	input?: number;
	code?: number;
	elapsed?: number;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function updateDelegatedSpendStatus(deps: DispatchObservabilityDeps): void {
	const widgetCtx = deps.getWidgetContext();
	const delegatedTokens = deps.getDelegatedTokens();
	if (!widgetCtx || delegatedTokens <= 0) return;
	try { widgetCtx.ui.setStatus("delegated-spend", `Δ delegated: ${formatTokens(delegatedTokens)} tok`); } catch {}
}

function handleDelegationEvent(deps: DispatchObservabilityDeps, state: DelegationObservableState, e: DelegationEvent): void {
	if (!state.delegations || typeof e?.id !== "string") return;
	if (e.t === "spawn") {
		const startedAt = e.ts || Date.now();
		const parentId = typeof e.parent === "string" ? e.parent : "root";
		const parentEntry = parentId !== "root"
			? state.delegations.get(parentId)?.histEntry ?? state.histEntry ?? null
			: state.histEntry ?? null;
		const histEntry = deps.executionHistory.start("delegate", deps.displayName(e.role || e.id), { parent: parentEntry, startedAt });
		state.delegations.set(e.id, {
			id: e.id,
			parent: parentId,
			role: e.role || e.id,
			model: e.model || "",
			tools: e.tools || "",
			def: { name: e.id },
			status: "running",
			toolCount: 0,
			tokens: 0,
			lastWork: "",
			startedAt,
			elapsed: 0,
			timeline: [],
			transcriptStore: deps.createTranscriptStore(deps.safePathWithin(deps.getSessionDir(), "transcripts", `${deps.safeAgentKey(state.def.name)}-${deps.safeAgentKey(e.id)}.jsonl`)),
			histEntry,
		});
		return;
	}
	const child = state.delegations.get(e.id);
	if (!child) return;
	if (e.t === "timeline") {
		deps.appendTimelineText(child, e.kind === "thinking" ? "thinking" : "text", e.delta || "");
		if (e.kind !== "thinking") {
			const trailing = child.timeline[child.timeline.length - 1];
			if (trailing?.kind === "text") child.lastWork = trailing.content.split("\n").filter(line => line.trim()).pop() || "";
		}
		child.zoomRender?.();
	} else if (e.t === "model_fallback") {
		child.model = e.to || child.model;
		child.lastWork = `model fallback: ${e.from || "override"} → ${e.to || "original"}`;
		deps.appendTimelineEvent(child, {
			kind: "text",
			title: "Model fallback",
			content: `${e.from || "override"} failed before work began; retrying with ${e.to || "original"}. ${e.reason || ""}`.trim(),
			timestamp: Date.now(),
		});
		child.zoomRender?.();
	} else if (e.t === "tool" || e.t === "tool_start") {
		child.toolCount++;
		deps.appendTimelineEvent(child, {
			kind: "tool-start",
			title: `Tool: ${e.name || "tool"}`,
			content: e.args || "",
			timestamp: e.ts || Date.now(),
			...(e.callId ? { callId: e.callId } : {}),
		});
		child.zoomRender?.();
	} else if (e.t === "tool_result") {
		deps.appendTimelineEvent(child, {
			kind: "tool-result",
			title: `Result: ${e.name || "tool"}`,
			content: e.output || "",
			timestamp: e.ts || Date.now(),
			...(e.callId ? { callId: e.callId } : {}),
			status: e.isError ? "error" : "success",
			...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}),
		});
		child.zoomRender?.();
	} else if (e.t === "usage") {
		const add = (e.input || 0) + (e.output || 0);
		child.tokens += add;
		deps.setDelegatedTokens(deps.getDelegatedTokens() + add);
		updateDelegatedSpendStatus(deps);
	} else if (e.t === "exit") {
		child.status = e.code === 0 ? "done" : "error";
		child.elapsed = e.elapsed || (Date.now() - child.startedAt);
		if (child.histEntry) deps.executionHistory.end(child.histEntry, child.status, child.startedAt + child.elapsed);
		child.zoomRender?.(true);
	}
}

function startDelegationWatch(deps: DispatchObservabilityDeps, state: DelegationObservableState, dir: string): void {
	state.delegations = new Map();
	const eventsFile = join(dir, "events.jsonl");
	let offset = 0;
	let pending = "";
	const drain = () => {
		let size: number;
		try { size = fs.statSync(eventsFile).size; } catch { return; }
		if (size <= offset) return;
		let chunk: string;
		try {
			const fd = fs.openSync(eventsFile, "r");
			try {
				const buf = Buffer.alloc(size - offset);
				fs.readSync(fd, buf, 0, buf.length, offset);
				chunk = buf.toString("utf-8");
			} finally { fs.closeSync(fd); }
		} catch { return; }
		offset = size;
		pending += chunk;
		const lines = pending.split("\n");
		pending = lines.pop() || "";
		let dirty = false;
		for (const line of lines) {
			if (!line.trim()) continue;
			try { handleDelegationEvent(deps, state, JSON.parse(line)); dirty = true; } catch {}
		}
		if (dirty) deps.updateWidget();
	};
	const timer = setInterval(drain, 2000);
	try { (timer as any).unref?.(); } catch {}
	let watcher: fs.FSWatcher | null = null;
	try { watcher = fs.watch(dir, () => drain()); } catch {}
	state.delegationsWatcher = {
		close() {
			clearInterval(timer);
			try { watcher?.close(); } catch {}
			drain();
		},
	};
}

export function createDispatchObservability(deps: DispatchObservabilityDeps) {
	return {
		handleDelegationEvent: (state: DelegationObservableState, event: DelegationEvent) => handleDelegationEvent(deps, state, event),
		startDelegationWatch: (state: DelegationObservableState, dir: string) => startDelegationWatch(deps, state, dir),
	};
}
