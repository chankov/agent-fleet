export type HistoryKind = "orchestrator" | "agent" | "research" | "delegate";
export type HistoryStatus = "running" | "done" | "error" | "idle";

export interface HistoryEntry {
	kind: HistoryKind;
	name: string;
	startedAt: number;
	endedAt: number | null;
	status: HistoryStatus;
	parent: HistoryEntry | null;
	awaitIntervals?: Array<[number, number]>;
}

export interface ExecutionHistoryStore {
	entries(): readonly HistoryEntry[];
	onChange(listener: () => void): () => void;
	start(kind: HistoryKind, name: string, options?: { parent?: HistoryEntry | null; startedAt?: number }): HistoryEntry;
	end(entry: HistoryEntry, status: HistoryStatus, endedAt?: number): void;
	reset(): void;
	startTurn(startedAt?: number): void;
	endTurn(endedAt?: number): void;
	renewTurnStartedAt(startedAt?: number): void;
	turnStartedAt(): number;
	startAskUser(toolCallId: string, startedAt?: number): void;
	endAskUser(toolCallId: string, endedAt?: number): number;
	openAskUserWaitMs(now?: number): number;
}

export function createExecutionHistoryStore(now: () => number = Date.now): ExecutionHistoryStore {
	const history: HistoryEntry[] = [];
	const listeners = new Set<() => void>();
	const askUserStarts = new Map<string, number>();
	const turnAskUserIntervals: Array<[number, number]> = [];
	let currentOrchestrator: HistoryEntry | null = null;
	let turnActive = false;
	let currentTurnStartedAt = 0;

	const changed = () => { for (const listener of listeners) listener(); };
	const push = (kind: HistoryKind, name: string, parent: HistoryEntry | null, startedAt: number): HistoryEntry => {
		const entry: HistoryEntry = { kind, name, startedAt, endedAt: null, status: "running", parent };
		history.push(entry);
		changed();
		return entry;
	};
	const ensureOrchestrator = (): HistoryEntry | null => {
		if (!turnActive) return null;
		if (!currentOrchestrator) {
			currentOrchestrator = push("orchestrator", "Dispatcher", null, currentTurnStartedAt);
			if (turnAskUserIntervals.length) {
				currentOrchestrator.awaitIntervals = [...turnAskUserIntervals];
				turnAskUserIntervals.length = 0;
			}
		}
		return currentOrchestrator;
	};
	const descendantOf = (node: HistoryEntry, ancestor: HistoryEntry): boolean => {
		let parent = node.parent;
		while (parent) {
			if (parent === ancestor) return true;
			parent = parent.parent;
		}
		return false;
	};

	return {
		entries: () => history,
		onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		start(kind, name, options = {}) {
			const parent = options.parent !== undefined
				? options.parent
				: kind === "agent" || kind === "research" ? ensureOrchestrator() : null;
			return push(kind, name, parent, options.startedAt ?? now());
		},
		end(entry, status, endedAt = now()) {
			entry.endedAt = endedAt;
			entry.status = status;
			if (entry.kind !== "delegate") {
				for (const candidate of history) {
					if (candidate.endedAt === null && descendantOf(candidate, entry)) {
						candidate.endedAt = endedAt;
						if (candidate.status === "running") candidate.status = status === "error" ? "error" : "done";
					}
				}
			}
			changed();
		},
		reset() {
			history.length = 0;
			currentOrchestrator = null;
			turnActive = false;
			currentTurnStartedAt = 0;
			askUserStarts.clear();
			turnAskUserIntervals.length = 0;
			changed();
		},
		startTurn(startedAt = now()) {
			if (currentOrchestrator?.endedAt === null) {
				currentOrchestrator.endedAt = startedAt;
				if (currentOrchestrator.status === "running") currentOrchestrator.status = "done";
			}
			turnActive = true;
			currentTurnStartedAt = startedAt;
			currentOrchestrator = null;
			askUserStarts.clear();
			turnAskUserIntervals.length = 0;
			changed();
		},
		endTurn(endedAt = now()) {
			turnActive = false;
			if (currentOrchestrator) {
				currentOrchestrator.endedAt = endedAt;
				if (currentOrchestrator.status === "running") currentOrchestrator.status = "done";
				currentOrchestrator = null;
			}
			currentTurnStartedAt = 0;
			changed();
		},
		renewTurnStartedAt(startedAt = now()) { currentTurnStartedAt = startedAt; },
		turnStartedAt: () => currentTurnStartedAt,
		startAskUser(toolCallId, startedAt = now()) { askUserStarts.set(toolCallId, startedAt); },
		endAskUser(toolCallId, endedAt = now()) {
			const startedAt = askUserStarts.get(toolCallId);
			askUserStarts.delete(toolCallId);
			if (startedAt == null) return 0;
			const interval: [number, number] = [startedAt, endedAt];
			if (currentOrchestrator) (currentOrchestrator.awaitIntervals ??= []).push(interval);
			else turnAskUserIntervals.push(interval);
			changed();
			return Math.max(0, endedAt - startedAt);
		},
		openAskUserWaitMs(at = now()) {
			let total = 0;
			for (const startedAt of askUserStarts.values()) total += Math.max(0, at - startedAt);
			return total;
		},
	};
}
