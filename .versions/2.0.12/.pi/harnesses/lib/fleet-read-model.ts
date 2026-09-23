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
	/** Owner-fenced System 1 view. Absent unless the current runToken matches. */
	system1?: System1OwnerView;
}

export const SYSTEM1_RETENTION_MS = 10_000;
export const SYSTEM1_GLYPH = "S1";

export interface System1CheckInput {
	dispatchId: string;
	attemptId: string;
	checkId: string;
	snapshotId: string;
	evaluation: "evaluating" | "finished" | "interrupted" | "unknown";
	llm: string;
	status: string;
	reason: string;
	elapsedMs: number | null;
	finishedAt?: number;
	rule?: string;
	configuredMode?: "off" | "shadow" | "active";
	effectiveMode?: "off" | "shadow" | "active";
	stateVersion?: string;
	questionsVersion?: string;
	numerical?: Record<string, number>;
	statusChoice?: string;
	returnedModel?: string;
	usage?: { inputTokens: number; outputTokens: number } | "unknown";
	source?: "llm" | "none" | "system1" | "unknown";
	applied?: "yes" | "no" | "unknown";
	outcome?: string;
	llmVerdict?: string;
	unused?: boolean;
	degraded?: boolean;
	/** Test/fixture override. Production shadow does not invent an active fallback. */
	llmRelation?: "parallel" | "fallback" | "none";
}

export interface System1OwnerView {
	dispatchId: string;
	attemptId: string;
	checkId: string;
	snapshotId: string;
	runToken: string;
	phase: "evaluating" | "result" | "unavailable" | "cancelled" | "interrupted";
	compact: string;
	label: string;
	detail: string;
	effectiveMode: "off" | "shadow" | "active" | "unknown";
	llmRelation: "parallel" | "fallback" | "none";
	rule: string;
	elapsedMs: number | null;
	retainUntil: number;
	status: string;
	reason: string;
	statusChoice: string;
	confidence: number | null;
	returnedModel: string;
	stateVersion: string;
	questionsVersion: string;
	policyVersion: "none" | "watchdog-policy/v1";
	usage: "unknown" | { inputTokens: number; outputTokens: number };
	source: "llm" | "none" | "system1" | "unknown";
	applied: "yes" | "no" | "unknown";
	outcome: string;
	llm: string;
	llmVerdict: string;
	degraded: boolean;
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

const SYSTEM1_CHOICES = new Set(["on_track", "drifting", "stuck", "insufficient_evidence"]);
const safeToken = (value: string | undefined, fallback: string) => {
	const cleaned = (value ?? "").replace(/[^a-z0-9_.:/-]/gi, "").slice(0, 48);
	return cleaned || fallback;
};
const finite = (value: number | null | undefined): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function system1Elapsed(ms: number | null, evaluating: boolean): string {
	if (ms == null) return "elapsed unknown";
	const safe = Math.max(0, Math.round(ms));
	if (evaluating) return safe < 10_000 ? `${(safe / 1000).toFixed(1)}s` : `${Math.floor(safe / 1000)}s`;
	return safe < 1000 ? `${safe}ms` : `${(safe / 1000).toFixed(1)}s`;
}

function system1Relation(input: System1CheckInput): System1OwnerView["llmRelation"] {
	if (input.llmRelation) return input.llmRelation;
	if (input.effectiveMode === "shadow") return "parallel";
	if (input.effectiveMode === "active" && input.llm !== "none") return "fallback";
	return "none";
}

/** Pure owner view. Callers must pass the current run token; a mismatch is not a view. */
export function projectSystem1Owner(input: System1CheckInput, runToken: string, now: number): System1OwnerView | undefined {
	if (!input.dispatchId || !input.checkId || !runToken) return undefined;
	// Off, and any record that never started an evaluation, is not a System 1 badge.
	if (input.configuredMode === "off" || input.effectiveMode === "off") return undefined;
	if (input.evaluation !== "evaluating" && input.evaluation !== "finished" && input.evaluation !== "interrupted") return undefined;
	const relation = system1Relation(input);
	const evaluating = input.evaluation === "evaluating" && input.unused !== true;
	const choice = input.statusChoice && SYSTEM1_CHOICES.has(input.statusChoice) ? input.statusChoice : "";
	const cancelled = input.status === "cancelled" || input.reason === "disposed" || input.reason === "cancelled" || input.unused === true;
	const interrupted = !evaluating && (input.evaluation === "interrupted" || input.status === "interrupted");
	const unavailable = !evaluating && !cancelled && !interrupted && (input.status === "unavailable" || input.status === "skipped" || input.status === "unsupported" || input.status === "unknown");
	const phase: System1OwnerView["phase"] = evaluating ? "evaluating" : cancelled ? "cancelled" : interrupted ? "interrupted" : unavailable ? "unavailable" : "result";
	const mode = input.effectiveMode === "shadow" || input.effectiveMode === "active" ? input.effectiveMode : "unknown";
	const rule = safeToken(input.rule, "unknown");
	const elapsed = system1Elapsed(finite(input.elapsedMs), evaluating);
	const relationText = relation === "parallel" ? "LLM parallel" : relation === "fallback" ? (input.status === "ok" ? "S1 uncertain \u2192 LLM judging" : "S1 unavailable \u2192 LLM judging") : "";
	const compact = phase === "evaluating" ? "S1 evaluating"
		: phase === "cancelled" ? "S1 cancelled"
		: phase === "interrupted" ? "S1 interrupted"
		: relation === "fallback" ? relationText
		: phase === "unavailable" ? "S1 unavailable"
		: choice ? `S1 ${choice}` : `S1 ${safeToken(input.status, "unknown")}`;
	const labelParts = [compact];
	if (phase === "evaluating") labelParts.push(rule, elapsed);
	else if (phase === "result") labelParts.push(elapsed, ...(mode === "unknown" ? [] : [mode]));
	if (relation === "parallel") labelParts.push("LLM parallel");
	if (relation === "fallback" && compact !== relationText) labelParts.push(relationText);
	const confidence = finite(input.numerical?.status_confidence);
	const usage = input.usage && typeof input.usage === "object" ? input.usage : "unknown";
	const source = input.source === "llm" || input.source === "none" || input.source === "system1" ? input.source : "unknown";
	const applied = input.applied === "yes" || input.applied === "no" ? input.applied : "unknown";
	const detail = [
		`System 1 \u00b7 watchdog \u00b7 ${rule} \u00b7 ${mode}`,
		`check ${safeToken(input.checkId, "unknown").slice(0, 8)} / attempt ${safeToken(input.attemptId, "unknown").slice(0, 8)} \u00b7 ${phase} \u00b7 ${elapsed}`,
		`Jev: ${choice || "unknown"} \u00b7 confidence ${confidence == null ? "unknown" : confidence} (provider)`,
		`LLM: ${safeToken(input.llmVerdict, "unknown")} \u00b7 decision: ${safeToken(input.outcome, "unknown")} \u00b7 applied: ${applied} \u00b7 source: ${source}`,
		`model ${safeToken(input.returnedModel, "unknown")} \u00b7 state ${safeToken(input.stateVersion, "unknown")} \u00b7 questions ${safeToken(input.questionsVersion, "unknown")} \u00b7 policy ${mode === "active" ? "watchdog-policy/v1" : "none"}`,
		usage === "unknown" ? "usage unknown" : `usage ${usage.inputTokens}/${usage.outputTokens}`,
		relationText,
		input.degraded ? "observability degraded" : "",
	].filter(Boolean).join("\n");
	return {
		dispatchId: input.dispatchId,
		attemptId: input.attemptId,
		checkId: input.checkId,
		snapshotId: input.snapshotId,
		runToken,
		phase,
		compact,
		label: labelParts.filter(Boolean).join(" \u00b7 "),
		detail,
		effectiveMode: mode,
		llmRelation: relation,
		rule,
		elapsedMs: finite(input.elapsedMs),
		retainUntil: evaluating ? Number.POSITIVE_INFINITY : finite(input.finishedAt) == null ? 0 : finite(input.finishedAt)! + SYSTEM1_RETENTION_MS,
		status: safeToken(input.status, "unknown"),
		reason: safeToken(input.reason, "unknown"),
		statusChoice: choice || "unknown",
		confidence,
		returnedModel: safeToken(input.returnedModel, "unknown"),
		stateVersion: safeToken(input.stateVersion, "unknown"),
		questionsVersion: safeToken(input.questionsVersion, "unknown"),
		policyVersion: mode === "active" ? "watchdog-policy/v1" : "none",
		usage,
		source,
		applied,
		outcome: safeToken(input.outcome, "unknown"),
		llm: safeToken(input.llm, "unknown"),
		llmVerdict: safeToken(input.llmVerdict, "unknown"),
		degraded: input.degraded === true,
	};
}

/** Owner row stays visible through System 1 retention, including idle/cancelled workers. */
export function system1Visible(row: FleetRow, now: number): boolean {
	const view = row.system1;
	if (!view || row.kind !== "specialist" || view.runToken !== row.runToken) return false;
	if (view.phase === "evaluating") return true;
	return Number.isFinite(view.retainUntil) && now < view.retainUntil;
}

function widgetEligible(row: FleetRow, now: number, pin?: WidgetSelectionPin): boolean {
	const activeTask = row.kind !== "peer" && (row.status === "running" || row.status === "pending");
	const activePeer = row.kind === "peer" && row.status === "running";
	const retained = row.kind !== "peer" && (row.status === "done" || row.status === "error") && row.endedAt != null && now < row.endedAt + 10_000;
	const pinned = !!pin && row.key === pin.key && (row.status === "done" || row.status === "error") && row.runToken === pin.runToken;
	return activeTask || activePeer || retained || pinned || system1Visible(row, now);
}

/** Select widget rows using a single snapshot clock and exact terminal retention. */
export function selectWidgetRows(rows: readonly FleetRow[], now: number, pin?: WidgetSelectionPin): FleetRow[] {
	const byKey = new Map(rows.map(row => [row.key, row]));
	const include = new Set<string>();
	for (const row of rows) if (widgetEligible(row, now, pin)) include.add(row.key);
	for (const key of [...include]) {
		let row = byKey.get(key);
		const seen = new Set<string>();
		while (row?.parentKey && !seen.has(row.parentKey)) {
			seen.add(row.parentKey); include.add(row.parentKey); row = byKey.get(row.parentKey);
		}
	}
	return withTreeMetadata(rows.filter(row => include.has(row.key)).map(row => ({ ...row, structuralOnly: !widgetEligible(row, now, pin) })));
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
	/** Present only when an owner-fenced System 1 view is in the widget set. */
	system1Evaluating?: number;
	system1Mode?: "off" | "shadow" | "active" | "unknown" | null;
	system1Last?: string | null;
	system1Mixed?: boolean;
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
	const summary: StripSummary = { running, peerActive, done, failed, contextMax, contextKnown, contextTotal, wallMs: unionMs(intervals), wallKnown, wallTotal };
	const identities: string[] = [];
	const modes = new Set<StripSummary["system1Mode"]>();
	let system1Evaluating = 0;
	let latest: System1OwnerView | undefined;
	for (const row of rows) {
		const view = row.system1;
		if (row.structuralOnly || !view || view.runToken !== row.runToken || row.kind !== "specialist") continue;
		if (view.phase === "evaluating") system1Evaluating++;
		modes.add(view.effectiveMode);
		identities.push([view.phase, view.compact, view.effectiveMode, view.llmRelation, view.statusChoice].join("|"));
		if (!latest || view.retainUntil >= latest.retainUntil) latest = view;
	}
	if (identities.length > 0 && latest) {
		summary.system1Evaluating = system1Evaluating;
		summary.system1Mode = modes.size === 1 ? [...modes][0] : null;
		summary.system1Mixed = new Set(identities).size > 1;
		summary.system1Last = summary.system1Mixed ? null : latest.label;
	}
	return summary;
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
