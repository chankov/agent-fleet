/**
 * Pure decision helpers for Fleet Dashboard destructive actions and live views.
 * Kept free of pi imports so black-box tests can exercise operator outcomes
 * without booting the full agent-hub extension.
 */
import type { FleetKind } from "./fleet-read-model.ts";
import type { createPanelResources } from "./fleet-panel.ts";

export type KillHandles = {
	proc?: unknown;
	comsAbort?: (() => void) | null;
};

export type KillOutcome =
	| { action: "kill-research"; message: string }
	| { action: "kill-proc"; message: string }
	| { action: "coms-abort"; message: string }
	| { action: "unsupported"; level: "warning"; message: string };

export type RestartOutcome =
	| { action: "restart-specialist"; message: string }
	| { action: "unsupported"; level: "warning"; message: string };

/** Resolve a confirmed `x` kill for the highlighted row kind. */
export function resolveFleetKill(
	selected: { key: string; kind: FleetKind; name: string; status: "idle" | "running" | "done" | "error" | "pending" | "stale" },
	lookup: {
		researchExists: (key: string) => boolean;
		agentHandles: (key: string) => KillHandles | undefined;
	},
): KillOutcome {
	if (selected.kind === "research") {
		if (!lookup.researchExists(selected.key)) {
			return { action: "unsupported", level: "warning", message: `Research ${selected.name} is no longer available.` };
		}
		return { action: "kill-research", message: `Killed research ${selected.name}.` };
	}
	const agent = lookup.agentHandles(selected.key);
	if (agent?.proc) {
		return { action: "kill-proc", message: `Killing ${selected.name}...` };
	}
	if (agent?.comsAbort) {
		return { action: "coms-abort", message: `Abandoning ${selected.name}'s coms dispatch (the peer pane keeps running)...` };
	}
	if (selected.kind === "specialist" && selected.status !== "running") {
		return {
			action: "unsupported",
			level: "warning",
			message: `${selected.name} is ${selected.status === "done" ? "already finished" : `not running (${selected.status})`}; no live process or abort handle is available.`,
		};
	}
	return {
		action: "unsupported",
		level: "warning",
		message: `Kill is unsupported for ${selected.kind} rows; no owned process or abort handle is available.`,
	};
}

/** Resolve a confirmed `r` restart for the highlighted row kind. */
export function resolveFleetRestart(
	selected: { key: string; kind: FleetKind; name: string },
	lookup: {
		specialistRestartable: (key: string) => boolean;
	},
): RestartOutcome {
	if (selected.kind === "peer" || selected.kind === "delegate") {
		return {
			action: "unsupported",
			level: "warning",
			message: `Restart is unsupported for ${selected.kind} rows; restart it from its owning session.`,
		};
	}
	if (selected.kind === "research") {
		return {
			action: "unsupported",
			level: "warning",
			message: `Research ${selected.name} cannot be restarted; spawn a new helper instead.`,
		};
	}
	if (!lookup.specialistRestartable(selected.key)) {
		return {
			action: "unsupported",
			level: "warning",
			message: `${selected.name} has no previous task to restart.`,
		};
	}
	return { action: "restart-specialist", message: `Restarting ${selected.name} (fresh)...` };
}

/**
 * Always read the live timeline array from the target. Capturing the array at
 * open time freezes the detail view across re-dispatch (`state.timeline = []`).
 */
export function liveTimeline<T>(target: { timeline?: readonly T[] } | null | undefined): readonly T[] {
	return target?.timeline ?? [];
}

/** Column count for a specialist card grid. Empty rosters still return a defensive 1. */
export function gridColumnsForSize(size: number): number {
	if (size <= 0) return 1;
	return size <= 3 ? size : size === 4 ? 2 : 3;
}

/** Defensive render bound: a non-empty card list can never be split by zero. */
export function gridColumnsForItems(columns: number, itemCount: number): number {
	const safeColumns = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
	const safeItems = Number.isFinite(itemCount) ? Math.max(1, Math.floor(itemCount)) : 1;
	return Math.min(safeColumns, safeItems);
}

/** Render card lines in a grid without ever indexing an empty first column. */
export function renderCardGrid<T>(
	items: readonly T[],
	columns: number,
	cardHeight: number,
	renderCard: (item: T) => string[],
	gap = " ",
	blankLine = "",
): string[] {
	if (items.length === 0) return [];
	const cols = gridColumnsForItems(columns, items.length);
	const height = Number.isFinite(cardHeight) ? Math.max(0, Math.floor(cardHeight)) : 0;
	const lines: string[] = [];
	for (let i = 0; i < items.length; i += cols) {
		const cards = items.slice(i, i + cols).map(renderCard);
		while (cards.length < cols) cards.push(Array(height).fill(blankLine));
		const rowHeight = cards[0]?.length ?? height;
		for (let line = 0; line < rowHeight; line++) {
			lines.push(cards.map(card => card[line] || "").join(gap));
		}
	}
	return lines;
}

/** Compact below-editor specialist widgets render only in compact mode. */
export function compactWidgetsEnabled(viewMode: "compact" | "off"): boolean {
	return viewMode === "compact";
}

/** Freeze an already-open Fleet detail row when its live target leaves "running". */
export function snapshotFleetDetailRow<
	T extends { status: string; startedAt?: number; elapsed: number; lastWork: string },
>(detailRow: T, target: { status?: string; elapsed?: number; lastWork?: string } | null | undefined, now = Date.now()): T {
	const status = (target?.status ?? detailRow.status) as T["status"];
	if (status === "running" && detailRow.startedAt != null) {
		return { ...detailRow, status, elapsed: now - detailRow.startedAt, lastWork: target?.lastWork || detailRow.lastWork };
	}
	return {
		...detailRow,
		status,
		elapsed: target?.elapsed ?? detailRow.elapsed,
		lastWork: target?.lastWork || detailRow.lastWork,
	};
}

type PanelResources = ReturnType<typeof createPanelResources>;

/** Register the 2s recovery/elapsed ticker; live events request immediate renders. */
export function attachFleetDashboardTicker(
	resources: PanelResources,
	requestRender: () => void,
	intervalMs = 2000,
): () => void {
	resources.every(intervalMs, requestRender);
	return () => resources.dispose();
}
