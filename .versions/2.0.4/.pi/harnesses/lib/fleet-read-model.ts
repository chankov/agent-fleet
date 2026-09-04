export type FleetKind = "specialist" | "research" | "delegate" | "peer";
export type FleetStatus = "idle" | "running" | "done" | "error" | "pending" | "stale";

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
	toolCount: number | null;
	lastWork: string;
	hasTimeline: boolean;
	colorHex?: string;
}

export interface DelegateInput extends Omit<FleetRow, "kind" | "parentKey" | "depth" | "backend" | "hasTimeline"> {
	children?: readonly DelegateInput[];
}
export interface SpecialistInput extends Omit<FleetRow, "kind" | "parentKey" | "depth"> {
	delegates?: readonly DelegateInput[];
}
export interface ResearchInput extends Omit<FleetRow, "kind" | "parentKey" | "depth"> {}
export interface PeerInput extends Omit<FleetRow, "kind" | "parentKey" | "depth" | "backend" | "hasTimeline" | "status" | "contextPct" | "contextTokens" | "toolCount" | "elapsed"> {
	/** Registry-only entries have not answered a ping. */
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

/** Convert an authoritative run interval into row timing without re-anchoring completed work. */
export function fleetTiming(interval: { startedAt: number; endedAt: number | null } | undefined, now = Date.now()): Pick<FleetRow, "startedAt" | "elapsed"> {
	if (!interval) return { startedAt: undefined, elapsed: 0 };
	const endedAt = interval.endedAt ?? now;
	return { startedAt: interval.startedAt, elapsed: Math.max(0, endedAt - interval.startedAt) };
}

const statusOrder: Record<FleetStatus, number> = { running: 0, pending: 1, error: 2, done: 3, idle: 3, stale: 3 };
// A roster member is idle until dispatched, not finished; keep it visible by default.
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
		const status: FleetStatus = input.pending ? "pending" : (input.staleCount ?? 0) >= 3 ? "stale" : (input.status ?? "idle");
		roots.push({ row: { ...input, kind: "peer", depth: 0, status, backend: "coms", contextPct: null, contextTokens: null, toolCount: null, elapsed: input.elapsed ?? 0, hasTimeline: false }, children: [] });
	}
	roots.sort((a, b) => compareRows(a.row, b.row));
	const visible = (node: FleetNode): boolean => {
		const children = node.children.filter(visible);
		node.children = children;
		const own = (filter.showFinished || !hiddenWhenFinished.has(node.row.status)) && (!query || matches(node.row, query));
		return own || children.length > 0;
	};
	const out: FleetRow[] = [];
	const emit = (node: FleetNode) => {
		out.push(node.row);
		for (const child of node.children) emit(child);
	};
	for (const root of roots) if (visible(root)) emit(root);
	return out;
}

/** Total covered length of possibly overlapping intervals. */
export function unionMs(intervals: readonly [number, number][]): number {
	if (intervals.length === 0) return 0;
	const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
	let total = 0;
	let start = sorted[0][0];
	let end = sorted[0][1];
	for (let i = 1; i < sorted.length; i++) {
		const [nextStart, nextEnd] = sorted[i];
		if (nextStart > end) {
			total += end - start;
			[start, end] = [nextStart, nextEnd];
		} else if (nextEnd > end) {
			end = nextEnd;
		}
	}
	return total + end - start;
}

/** Aggregate visible rows; callers use unionMs(intervals) for overlap-aware wall time. */
export function summarise(rows: readonly FleetRow[]): { running: number; done: number; failed: number; totalTokens: number; intervals: Array<[number, number]> } {
	const intervals: Array<[number, number]> = [];
	let running = 0, done = 0, failed = 0, totalTokens = 0;
	for (const row of rows) {
		if (row.status === "running") running++;
		if (row.status === "done") done++;
		if (row.status === "error") failed++;
		if (row.contextTokens != null) totalTokens += row.contextTokens;
		if (row.startedAt != null) intervals.push([row.startedAt, row.startedAt + Math.max(0, row.elapsed)]);
	}
	return { running, done, failed, totalTokens, intervals };
}
