import { buildFleetRows, fleetTiming, projectProactive, projectSystem1Owner, type DelegateInput, type FleetFilter, type FleetRow, type FleetSource, type PeerInput, type ProactiveLedgerInput, type ResearchInput, type SpecialistInput, type System1CheckInput, type System1OwnerView } from "../../lib/fleet-read-model.ts";

export interface FleetSourceAgent {
	def: { name: string; description?: string };
	status: FleetRow["status"];
	task?: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	contextTokens: number;
	histEntry?: { startedAt: number; endedAt: number | null };
	delegations?: ReadonlyMap<string, FleetSourceDelegate>;
	lastBackend?: "native" | "coms";
	comsPeerModel?: string;
	runCount: number;
	dispatchId?: string;
}
export interface FleetSourceDelegate {
	id: string;
	parent: string;
	role: string;
	model: string;
	status: "running" | "done" | "error";
	toolCount: number;
	tokens: number;
	lastWork: string;
	startedAt: number;
	elapsed: number;
	histEntry?: { startedAt: number; endedAt: number | null };
}
export interface FleetSourceResearch {
	id: number;
	persona: boolean;
	def: { name: string };
	status: FleetRow["status"];
	model: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	histEntry?: { startedAt: number; endedAt: number | null };
}
export interface PendingReplyLike { target_name?: string; created_at?: string; result?: unknown; }
export interface PeerCardLike { name: string; model: string; purpose: string; color: string; staleCount?: number; status?: string; queue_depth?: number; }

export interface FleetSourceDeps<TAgent extends FleetSourceAgent = FleetSourceAgent, TResearch extends FleetSourceResearch = FleetSourceResearch> {
	getAgents(): ReadonlyMap<string, TAgent>;
	getResearch(): ReadonlyMap<number, TResearch>;
	getPeerInputs(formatModel?: (model: string) => string): PeerInput[];
	getPeerCards(): ReadonlyMap<string, PeerCardLike>;
	getPendingReplies(): Iterable<PendingReplyLike>;
	displayName(name: string): string;
	modelForAgent(state: TAgent): string;
	modelForResearch(state: TResearch): string;
	modelForPeer(model: string): string;
	/** In-memory projection only. Render must not call the provider or read JSONL. */
	getSystem1?(): { active: readonly System1CheckInput[]; completed: readonly System1CheckInput[]; degraded?: boolean } | null | undefined;
	/** Session-owned in-memory ledger; never read private evidence or trace files here. */
	getProactive?(): ProactiveLedgerInput | null | undefined;
}

function delegateForest(children: readonly FleetSourceDelegate[], now: number, model: (value: string) => string): DelegateInput[] {
	const byId = new Map(children.map(child => [child.id, child]));
	const invalid = new Set<string>();
	for (const child of children) {
		if (child.parent === child.id) { invalid.add(child.id); continue; }
		let cursor: FleetSourceDelegate | undefined = child;
		const path = new Set<string>();
		while (cursor && cursor.parent !== "root" && byId.has(cursor.parent)) {
			if (path.has(cursor.id)) { for (const id of path) invalid.add(id); break; }
			path.add(cursor.id); cursor = byId.get(cursor.parent);
		}
	}
	const nested = new Map<string, FleetSourceDelegate[]>();
	const roots: FleetSourceDelegate[] = [];
	for (const child of children) {
		if (!invalid.has(child.id) && child.parent !== "root" && byId.has(child.parent)) {
			const list = nested.get(child.parent) ?? []; list.push(child); nested.set(child.parent, list);
		} else roots.push(child);
	}
	const make = (child: FleetSourceDelegate, ancestry = new Set<string>()): DelegateInput => {
		const safeChildren = ancestry.has(child.id) ? [] : (nested.get(child.id) ?? []);
		const next = new Set(ancestry); next.add(child.id);
		const timing = child.histEntry ? fleetTiming(child.histEntry, now) : {
			startedAt: child.startedAt,
			endedAt: child.status === "running" ? undefined : child.startedAt + Math.max(0, child.elapsed),
			elapsed: child.status === "running" ? Math.max(0, now - child.startedAt) : child.elapsed,
			timingKind: "run" as const,
		};
		return { key: child.id, name: child.role || child.id, status: child.status, model: model(child.model), contextPct: null, contextTokens: null, ...timing, runToken: `${child.id}:${child.startedAt}`, toolCount: child.toolCount, lastWork: child.lastWork, children: safeChildren.map(item => make(item, next)) };
	};
	return roots.map(child => make(child));
}

/** One production adapter for dashboard and below-editor widget data. */
export function createFleetSource<TAgent extends FleetSourceAgent, TResearch extends FleetSourceResearch>(deps: FleetSourceDeps<TAgent, TResearch>) {
	function ownerSystem1(key: string, state: TAgent, now: number): System1OwnerView | undefined {
		const live = deps.getSystem1?.();
		if (!live || !state.dispatchId) return undefined;
		const runToken = `${key}:${state.dispatchId}`;
		const checks = [...live.active, ...live.completed].filter(check => check.dispatchId === state.dispatchId);
		const ranked = checks.map(check => ({ check, view: projectSystem1Owner({ ...check, degraded: live.degraded === true || check.degraded === true }, runToken, now) })).filter((item): item is { check: System1CheckInput; view: System1OwnerView } => !!item.view);
		ranked.sort((a, b) => Number(b.view.phase === "evaluating") - Number(a.view.phase === "evaluating") || (b.check.finishedAt ?? 0) - (a.check.finishedAt ?? 0));
		const chosen = ranked.find(item => item.view.phase === "evaluating" || now < item.view.retainUntil);
		return chosen && chosen.view.runToken === runToken ? chosen.view : undefined;
	}
	function snapshot(now: number): FleetSource {
		const ledger = deps.getProactive?.();
		const proactive = ledger ? projectProactive(ledger) : undefined;
		const specialists: SpecialistInput[] = Array.from(deps.getAgents().entries()).map(([key, state]) => ({
			key,
			name: deps.displayName(state.def.name),
			status: state.status,
			model: deps.modelForAgent(state),
			backend: state.lastBackend ?? "native",
			contextPct: state.contextPct,
			contextTokens: state.contextTokens,
			...fleetTiming(state.histEntry, now),
			runToken: `${key}:${state.dispatchId ?? state.runCount}`,
			toolCount: state.toolCount,
			lastWork: state.lastWork || state.task || state.def.description || "",
			hasTimeline: true,
			system1: ownerSystem1(key, state, now),
			proactive: state.dispatchId && state.lastBackend !== "coms" ? proactive?.owners.find(view => view.owner === key && view.attempt === state.dispatchId && view.runToken === `${key}:${state.dispatchId}`) : undefined,
			delegates: delegateForest(Array.from(state.delegations?.values() ?? []), now, deps.modelForPeer),
		}));
		const research: ResearchInput[] = Array.from(deps.getResearch().values()).map(state => ({
			key: `r${state.id}`, name: `r${state.id} ${state.persona ? deps.displayName(state.def.name) : "research"}`, status: state.status,
			model: deps.modelForResearch(state), backend: "native", contextPct: state.contextPct, contextTokens: null,
			...fleetTiming(state.histEntry, now), runToken: `r${state.id}:${state.histEntry?.startedAt ?? 0}`, toolCount: state.toolCount,
			lastWork: state.lastWork, hasTimeline: true,
		}));

		const peers = deps.getPeerInputs(deps.modelForPeer).map(peer => ({ ...peer }));
		const peerBySession = new Map(peers.map(peer => [peer.key, peer]));
		const peersByName = new Map<string, PeerInput[]>();
		for (const peer of peers) { const list = peersByName.get(peer.name) ?? []; list.push(peer); peersByName.set(peer.name, list); }
		for (const [sessionId, card] of deps.getPeerCards()) {
			const key = `peer:${sessionId}`;
			let peer = peerBySession.get(key);
			if (!peer) {
				peer = { key, name: card.name, model: deps.modelForPeer(card.model), lastWork: card.purpose, colorHex: card.color, staleCount: card.staleCount };
				peers.push(peer); peerBySession.set(key, peer);
				const list = peersByName.get(peer.name) ?? []; list.push(peer); peersByName.set(peer.name, list);
			}
			if (card.status === "working" || (card.queue_depth ?? 0) > 0) peer.status = "running";
		}
		const pendingByName = new Map<string, { count: number; oldest?: number }>();
		for (const pending of deps.getPendingReplies()) {
			if (pending.result || !pending.target_name) continue;
			const parsed = pending.created_at ? Date.parse(pending.created_at) : Number.NaN;
			const previous = pendingByName.get(pending.target_name) ?? { count: 0 };
			previous.count++;
			if (Number.isFinite(parsed)) previous.oldest = previous.oldest == null ? parsed : Math.min(previous.oldest, parsed);
			pendingByName.set(pending.target_name, previous);
		}
		for (const [name, pending] of pendingByName) {
			const candidates = peersByName.get(name) ?? [];
			if (candidates.length === 1) {
				const peer = candidates[0];
				peer.status = "running"; peer.timingKind = pending.oldest == null ? "unknown" : "wait";
				peer.startedAt = pending.oldest; peer.elapsed = pending.oldest == null ? 0 : Math.max(0, now - pending.oldest);
				peer.aliasKeys = [`peer-pending:${encodeURIComponent(name)}`];
			} else {
				peers.push({ key: `peer-pending:${encodeURIComponent(name)}`, name, model: "", lastWork: `${pending.count} pending ${pending.count === 1 ? "reply" : "replies"}`, status: "running", timingKind: pending.oldest == null ? "unknown" : "wait", startedAt: pending.oldest, elapsed: pending.oldest == null ? 0 : Math.max(0, now - pending.oldest) });
			}
		}
		return { specialists, research, peers, ...(proactive ? { proactive } : {}) };
	}
	return {
		snapshot,
		rows(now: number, filter: FleetFilter): FleetRow[] { return buildFleetRows(snapshot(now), filter); },
	};
}
