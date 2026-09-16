export type FleetKind = "specialist" | "research" | "delegate" | "peer";
export type FleetStatus = "idle" | "running" | "done" | "error" | "pending" | "stale";
export type FleetTimingKind = "run" | "wait" | "unknown";

export interface FleetRow {
	key: string;
	kind: FleetKind;
	name: string;
	parentKey?: string;
	depth: number;
	status: FleetStatus;
	model: string;
	backend: "native" | "coms";
	contextPct: number | null;
	contextTokens: number | null;
	elapsed: number;
	startedAt?: number;
	endedAt?: number;
	timingKind?: FleetTimingKind;
	runToken?: string;
	aliasKeys?: readonly string[];
	peerPresence?: "present" | "pending" | "stale";
	toolCount: number | null;
	lastWork: string;
	hasTimeline: boolean;
	colorHex?: string;
	lastAtDepth?: readonly boolean[];
	/** Included only to preserve the path to an eligible descendant. */
	structuralOnly?: boolean;
}

export interface DelegateInput extends Omit<FleetRow, "kind" | "parentKey" | "depth" | "backend" | "hasTimeline" | "lastAtDepth" | "structuralOnly"> {
	children?: readonly DelegateInput[];
}
export interface SpecialistInput extends Omit<FleetRow, "kind" | "parentKey" | "depth" | "lastAtDepth" | "structuralOnly"> {
	delegates?: readonly DelegateInput[];
}
export interface ResearchInput extends Omit<FleetRow, "kind" | "parentKey" | "depth" | "lastAtDepth" | "structuralOnly"> {}
export interface PeerInput extends Omit<FleetRow, "kind" | "parentKey" | "depth" | "backend" | "hasTimeline" | "status" | "contextPct" | "contextTokens" | "toolCount" | "elapsed" | "lastAtDepth" | "structuralOnly"> {
	/** Registry-only entries have not answered a ping; this is presence, not a task queue. */
	pending?: boolean;
	staleCount?: number;
	status?: FleetStatus;
	elapsed?: number;
}
export interface FleetSource {
	specialists: readonly SpecialistInput[];
	research: readonly ResearchInput[];
	peers: readonly PeerInput[];
}
export interface FleetFilter { showFinished: boolean; query?: string; }
export interface WidgetSelectionPin { key: string; runToken?: string; }

/** Convert an authoritative run interval into row timing without re-anchoring completed work. */
export function fleetTiming(interval: { startedAt: number; endedAt: number | null } | undefined, now = Date.now()): Pick<FleetRow, "startedAt" | "endedAt" | "elapsed" | "timingKind"> {
	if (!interval) return { startedAt: undefined, endedAt: undefined, elapsed: 0, timingKind: "unknown" };
	const endedAt = interval.endedAt ?? now;
	return { startedAt: interval.startedAt, endedAt: interval.endedAt ?? undefined, elapsed: Math.max(0, endedAt - interval.startedAt), timingKind: "run" };
}

const statusOrder: Record<FleetStatus, number> = { running: 0, pending: 1, error: 2, done: 3, idle: 3, stale: 3 };
const hiddenWhenFinished = new Set<FleetStatus>(["done", "stale"]);

function compareRows(a: FleetRow, b: FleetRow): number {
	return statusOrder[a.status] - statusOrder[b.status]
		|| (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER)
		|| a.key.localeCompare(b.key);
}

function matches(row: FleetRow, query: string): boolean {
	return `${row.name} ${row.model} ${row.lastWork}`.toLowerCase().includes(query);
}

interface FleetNode { row: FleetRow; children: FleetNode[]; }

/** Add branch metadata after filtering, preserving the supplied pre-order. */
export function withTreeMetadata(rows: readonly FleetRow[]): FleetRow[] {
	const included = new Set(rows.map(row => row.key));
	const children = new Map<string | undefined, FleetRow[]>();
	for (const row of rows) {
		const parent = row.parentKey && included.has(row.parentKey) ? row.parentKey : undefined;
		const list = children.get(parent) ?? [];
		list.push(row);
		children.set(parent, list);
	}
	const out: FleetRow[] = [];
	const emit = (row: FleetRow, path: readonly boolean[]) => {
		out.push({ ...row, depth: path.length, parentKey: row.parentKey && included.has(row.parentKey) ? row.parentKey : undefined, lastAtDepth: path });
		const nested = children.get(row.key) ?? [];
		nested.forEach((child, index) => emit(child, [...path, index === nested.length - 1]));
	};
	const roots = children.get(undefined) ?? [];
	roots.forEach(row => emit(row, []));
	return out;
}

/** Collapse local specialists, delegate trees, research, and coms peers into stable display rows. */
export function buildFleetRows(src: FleetSource, filter: FleetFilter): FleetRow[] {
	const query = filter.query?.trim().toLowerCase() ?? "";
	const roots: FleetNode[] = [];
	const delegate = (input: DelegateInput, parentKey: string, depth: number): FleetNode => ({
		row: { ...input, kind: "delegate", parentKey, depth, backend: "native", hasTimeline: true },
		children: (input.children ?? []).map(child => delegate(child, input.key, depth + 1)).sort((a, b) => compareRows(a.row, b.row)),
	});
	for (const input of src.specialists) roots.push({
		row: { ...input, kind: "specialist", depth: 0 },
		children: (input.delegates ?? []).map(child => delegate(child, input.key, 1)).sort((a, b) => compareRows(a.row, b.row)),
	});
	for (const input of src.research) roots.push({ row: { ...input, kind: "research", depth: 0 }, children: [] });
	for (const input of src.peers) {
		const stale = (input.staleCount ?? 0) >= 3;
		const status: FleetStatus = input.status ?? (input.pending ? "pending" : stale ? "stale" : "idle");
		roots.push({ row: { ...input, kind: "peer", depth: 0, status, backend: "coms", contextPct: null, contextTokens: null, toolCount: null, elapsed: input.elapsed ?? 0, timingKind: input.timingKind ?? "unknown", peerPresence: input.peerPresence ?? (input.pending ? "pending" : stale ? "stale" : "present"), hasTimeline: false }, children: [] });
	}
	roots.sort((a, b) => compareRows(a.row, b.row));
	const visible = (node: FleetNode): boolean => {
		const children = node.children.filter(visible);
		node.children = children;
		const own = (filter.showFinished || !hiddenWhenFinished.has(node.row.status)) && (!query || matches(node.row, query));
		return own || children.length > 0;
	};
	const out: FleetRow[] = [];
	const emit = (node: FleetNode) => { out.push(node.row); for (const child of node.children) emit(child); };
	for (const root of roots) if (visible(root)) emit(root);
	return withTreeMetadata(out);
}

/** Select widget rows using a single snapshot clock and exact terminal retention. */
export function selectWidgetRows(rows: readonly FleetRow[], now: number, pin?: WidgetSelectionPin): FleetRow[] {
	const byKey = new Map(rows.map(row => [row.key, row]));
	const include = new Set<string>();
	for (const row of rows) {
		const activeTask = row.kind !== "peer" && (row.status === "running" || row.status === "pending");
		const activePeer = row.kind === "peer" && row.status === "running";
		const retained = row.kind !== "peer" && (row.status === "done" || row.status === "error") && row.endedAt != null && now < row.endedAt + 10_000;
		const pinned = !!pin && row.key === pin.key && (row.status === "done" || row.status === "error") && row.runToken === pin.runToken;
		if (activeTask || activePeer || retained || pinned) include.add(row.key);
	}
	for (const key of [...include]) {
		let row = byKey.get(key);
		const seen = new Set<string>();
		while (row?.parentKey && !seen.has(row.parentKey)) {
			seen.add(row.parentKey); include.add(row.parentKey); row = byKey.get(row.parentKey);
		}
	}
	return withTreeMetadata(rows.filter(row => include.has(row.key)).map(row => ({ ...row, structuralOnly: !(
		(row.kind !== "peer" && (row.status === "running" || row.status === "pending")) ||
		(row.kind === "peer" && row.status === "running") ||
		(row.kind !== "peer" && (row.status === "done" || row.status === "error") && row.endedAt != null && now < row.endedAt + 10_000) ||
		(!!pin && row.key === pin.key && row.runToken === pin.runToken)
	) })));
}

/** Total covered length of possibly overlapping intervals. */
export function unionMs(intervals: readonly [number, number][]): number {
	if (intervals.length === 0) return 0;
	const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
	let total = 0, start = sorted[0][0], end = sorted[0][1];
	for (let i = 1; i < sorted.length; i++) {
		const [nextStart, nextEnd] = sorted[i];
		if (nextStart > end) { total += end - start; [start, end] = [nextStart, nextEnd]; }
		else if (nextEnd > end) end = nextEnd;
	}
	return total + end - start;
}

export interface StripSummary {
	running: number;
	peerActive: number;
	done: number;
	failed: number;
	contextMax: number | null;
	contextKnown: number;
	contextTotal: number;
	wallMs: number;
	wallKnown: number;
	wallTotal: number;
}

/** Aggregate the whole eligible widget set, excluding peer waits and structural context. */
export function summariseWidget(rows: readonly FleetRow[]): StripSummary {
	let running = 0, peerActive = 0, done = 0, failed = 0, contextMax: number | null = null, contextKnown = 0, contextTotal = 0, wallKnown = 0, wallTotal = 0;
	const intervals: Array<[number, number]> = [];
	for (const row of rows) {
		if (row.structuralOnly) continue;
		if (row.kind === "peer") { if (row.status === "running") peerActive++; continue; }
		if (row.status === "running") {
			running++; contextTotal++;
			if (row.contextPct != null && Number.isFinite(row.contextPct)) { contextKnown++; contextMax = Math.max(contextMax ?? -Infinity, row.contextPct); }
		}
		if (row.status === "done") done++;
		if (row.status === "error") failed++;
		if (["running", "done", "error"].includes(row.status)) {
			wallTotal++;
			if (row.timingKind === "run" && row.startedAt != null) { wallKnown++; intervals.push([row.startedAt, row.endedAt ?? row.startedAt + Math.max(0, row.elapsed)]); }
		}
	}
	return { running, peerActive, done, failed, contextMax, contextKnown, contextTotal, wallMs: unionMs(intervals), wallKnown, wallTotal };
}

/** Backward-compatible dashboard aggregate. */
export function summarise(rows: readonly FleetRow[]): { running: number; done: number; failed: number; totalTokens: number; intervals: Array<[number, number]> } {
	const intervals: Array<[number, number]> = [];
	let running = 0, done = 0, failed = 0, totalTokens = 0;
	for (const row of rows) {
		if (row.status === "running") running++;
		if (row.status === "done") done++;
		if (row.status === "error") failed++;
		if (row.contextTokens != null) totalTokens += row.contextTokens;
		if (row.timingKind !== "wait" && row.startedAt != null) intervals.push([row.startedAt, row.endedAt ?? row.startedAt + Math.max(0, row.elapsed)]);
	}
	return { running, done, failed, totalTokens, intervals };
}
