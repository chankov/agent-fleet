// .pi/harnesses/lib/herdr-presence.ts
//
// The herdr presence backend for the coms layer (used by both the standalone
// coms harness and the copy embedded in agent-hub). Two halves:
//
//   - HerdrPresence — reports THIS agent's state into its pane
//     (pane.report_agent) so the herdr sidebar shows live pi agent states.
//   - HerdrAgentWatch — watches OTHER agents via agent.list +
//     events.subscribe (push, no polling): global pane.created/closed/exited
//     plus a per-pane agent_status_changed subscription for every tracked
//     pane (herdr has no wildcard for that topic — spike finding). When the
//     tracked pane set changes, the stream is torn down and resubscribed.
//
// Two wire dialects for the same idea — "this pane is coms peer X":
//
//   tokens (herdr >= 0.7.4)   `tokens: { coms, proj, ctx, q }` on
//                             pane.report_metadata. Values are uncapped, so the
//                             peer name arrives whole and the PROJECT travels
//                             with it — which is what makes the join a real key
//                             (two projects may each run an `orchestrator`).
//   custom_status (<= 0.7.3)  a single 32-char-capped string,
//                             `<name> <pct>% q<depth>`, name FIRST so a
//                             truncated tail still leaves the identity readable.
//
// herdr 0.7.4 dropped `custom_status` from PaneReportMetadataParams entirely,
// which made every report fail — silently, because report() swallows errors.
// So: tokens first, one latched fallback to the legacy string, and an onError
// hook so a dialect mismatch is never invisible again.
//
// Pure module: no pi imports; erasable-TS; testable under node --test.

import {
	herdr,
	herdrAvailable,
	subscribe,
	type HerdrClientOptions,
	type SubscribeHandle,
	type Subscription,
} from "./herdr-client.ts";

export const CUSTOM_STATUS_MAX = 32;

// HERDR_ENV=1 + HERDR_PANE_ID mark a process running inside a herdr pane.
export function herdrPaneId(env: NodeJS.ProcessEnv = process.env): string | null {
	if (env.HERDR_ENV !== "1") return null;
	return env.HERDR_PANE_ID || null;
}

// True when this process should use the herdr presence backend: inside a
// herdr pane AND the server answers ping.
export async function herdrPresenceAvailable(
	opts: HerdrClientOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	if (!herdrPaneId(env)) return false;
	return (await herdrAvailable(opts)) !== null;
}

// What a pane advertises about the coms peer occupying it.
export interface PeerPresence {
	name: string;
	// The coms project. Optional only because the legacy dialect cannot carry
	// it; always pass it when you have it — without it, two projects running a
	// peer of the same name are indistinguishable to any watcher.
	project?: string | null;
	contextUsedPct: number;
	queueDepth: number;
}

// Token keys must match herdr's `^[A-Za-z0-9_-]{1,32}$`; at most 16 per pane.
// `ctx`/`q` are for human eyes in the sidebar — the registry entry carries the
// authoritative numbers — so they are formatted, not raw.
export function peerTokens(presence: PeerPresence): Record<string, string> {
	const tokens: Record<string, string> = {
		coms: presence.name,
		ctx: `${Math.round(presence.contextUsedPct)}%`,
		q: `q${presence.queueDepth}`,
	};
	if (presence.project) tokens.proj = presence.project;
	return tokens;
}

// Legacy dialect: `<name> <pct>% q<depth>` truncated to the 32-char server cap,
// name first. The project does not fit and is therefore not carried.
export function formatPeerStatus(name: string, contextUsedPct: number, queueDepth: number): string {
	const s = `${name} ${Math.round(contextUsedPct)}% q${queueDepth}`;
	return s.length <= CUSTOM_STATUS_MAX ? s : s.slice(0, CUSTOM_STATUS_MAX);
}

// Inverse of formatPeerStatus: the peer name is everything before the last
// ` <pct>% q<n>` tail (tolerates a name that was itself truncated).
export function parsePeerName(customStatus: string | undefined | null): string | null {
	if (!customStatus) return null;
	const m = customStatus.match(/^(.*?)\s+\d+%\s+q\d*$/);
	const name = (m ? m[1] : customStatus).trim();
	return name || null;
}

// The one place that knows how to read a peer identity off a herdr pane,
// whichever dialect wrote it. `agent.rename` also puts a name on a pane, but
// that one is human-assigned and not necessarily a coms peer, so it is the last
// resort rather than the first.
export function peerNameFrom(agent: HerdrAgentInfo | undefined | null): string | null {
	if (!agent) return null;
	const token = agent.tokens?.coms;
	if (typeof token === "string" && token.trim()) return token.trim();
	const legacy = parsePeerName(agent.custom_status);
	if (legacy) return legacy;
	const named = agent.name;
	return typeof named === "string" && named.trim() ? named.trim() : null;
}

// The coms project a pane advertises, or null when the writer could not carry
// one (legacy dialect). Null means "unscoped", never "the default project".
export function peerProjectFrom(agent: HerdrAgentInfo | undefined | null): string | null {
	const token = agent?.tokens?.proj;
	return typeof token === "string" && token.trim() ? token.trim() : null;
}

export type PresenceState = "idle" | "working" | "blocked" | "unknown";

export interface HerdrPresenceOptions extends HerdrClientOptions {
	paneId: string;
	// Identity herdr uses to arbitrate reporting authority (required by the
	// API). Convention: `coms:<session_id>`.
	source: string;
	// Detected-agent label shown in the sidebar; pi peers report "pi".
	agentLabel?: string;
	// Called the first time an annotation dialect is rejected, and again if the
	// fallback is rejected too. Presence stays best-effort, but a herdr that no
	// longer speaks our wire format must not be able to hide.
	onError?: (err: Error, dialect: AnnotationDialect) => void;
}

export type AnnotationDialect = "tokens" | "custom_status";

// Reports this agent's state into its herdr pane. All calls are best-effort:
// presence must never break the session, so errors resolve false.
//
// Two wire calls per report (both idempotent): pane.report_agent carries the
// state and covers panes herdr's built-in detection does NOT recognize; for
// recognized panes (pi has a detection manifest) that call is accepted but
// IGNORED — detection holds agent authority — so pane.report_metadata carries
// the peer annotation that detection cannot provide.
//
// The annotation dialect is negotiated by trying and latching, not by version
// sniffing: `herdr --version` is a string we would have to keep a table for,
// while a rejected request is the actual answer to the actual question.
export class HerdrPresence {
	private opts: HerdrPresenceOptions;
	private dialect: AnnotationDialect | null = null;
	private reported = new Set<AnnotationDialect>();

	constructor(opts: HerdrPresenceOptions) {
		this.opts = opts;
	}

	// Which dialect this pane's herdr accepted, once known. Exposed for
	// diagnostics (the coms audit log records it) — never a branch condition
	// anywhere but here.
	acceptedDialect(): AnnotationDialect | null {
		return this.dialect;
	}

	private noteError(err: Error, dialect: AnnotationDialect): void {
		if (this.reported.has(dialect)) return;
		this.reported.add(dialect);
		try {
			this.opts.onError?.(err, dialect);
		} catch {
			// a broken reporter must not break presence
		}
	}

	private async writeAnnotation(presence: PeerPresence, agent: string, dialect: AnnotationDialect): Promise<boolean> {
		const base = {
			pane_id: this.opts.paneId,
			source: this.opts.source,
			agent,
			// Expire if this reporter dies without releasing: a bit over two
			// keepalive cycles keeps the annotation fresh-or-gone.
			ttl_ms: 90_000,
		};
		const params =
			dialect === "tokens"
				? { ...base, tokens: peerTokens(presence) }
				: {
						...base,
						custom_status: formatPeerStatus(presence.name, presence.contextUsedPct, presence.queueDepth),
					};
		try {
			await herdr.paneReportMetadata(params, this.opts);
			this.dialect = dialect;
			return true;
		} catch (err) {
			this.noteError(err as Error, dialect);
			return false;
		}
	}

	// The identity half of presence on its own: "this pane is coms peer X",
	// with no claim about what the agent is doing. Callers whose pane state is
	// owned by someone else use this instead of report() — the Claude bridge
	// reads `agent_status` back as its own turn-completion signal, so a state
	// it reported itself would poison the loop that polls it.
	async annotate(presence: PeerPresence): Promise<boolean> {
		const agent = this.opts.agentLabel ?? "pi";
		// Once a dialect has worked, stop probing: a retry per report would put
		// a guaranteed-failing request on the wire every 30s forever.
		const order: AnnotationDialect[] = this.dialect ? [this.dialect] : ["tokens", "custom_status"];
		for (const dialect of order) {
			if (await this.writeAnnotation(presence, agent, dialect)) return true;
		}
		return false;
	}

	async report(state: PresenceState, presence: PeerPresence): Promise<boolean> {
		let ok = false;
		try {
			await herdr.paneReportAgent(
				{ pane_id: this.opts.paneId, source: this.opts.source, agent: this.opts.agentLabel ?? "pi", state },
				this.opts,
			);
			ok = true;
		} catch {
			// fall through — the annotation may still land
		}
		return (await this.annotate(presence)) || ok;
	}

	async release(): Promise<void> {
		try {
			await herdr.paneReleaseAgent(
				{ pane_id: this.opts.paneId, source: this.opts.source, agent: this.opts.agentLabel ?? "pi" },
				this.opts,
			);
		} catch {
			// best-effort
		}
	}
}

export interface HerdrAgentInfo {
	pane_id: string;
	agent?: string;
	agent_status?: string;
	// herdr >= 0.7.4
	tokens?: Record<string, string>;
	name?: string;
	// herdr <= 0.7.3
	custom_status?: string;
	workspace_id?: string;
	[key: string]: unknown;
}

export interface AgentWatchOptions extends HerdrClientOptions {
	// Called with the full current agent set after every change (initial
	// snapshot included). Consumers diff/join against their own state.
	onChange: (agents: HerdrAgentInfo[]) => void;
	// This process's own pane — excluded from the tracked set.
	ownPaneId?: string | null;
	onError?: (err: Error) => void;
	reconnectDelayMs?: number;
}

// Push-driven view of the herdr agent population. start() takes an
// agent.list snapshot and opens the event stream; pane lifecycle events
// refresh the snapshot (and the per-pane subscription set).
export class HerdrAgentWatch {
	private opts: AgentWatchOptions;
	private agents = new Map<string, HerdrAgentInfo>();
	private stream: SubscribeHandle | null = null;
	private stopped = false;
	private resyncTimer: ReturnType<typeof setTimeout> | null = null;
	// Pane-id set the live stream was opened with. resync() only tears the
	// stream down when the set actually changed — an unconditional resubscribe
	// would loop forever through onConnect → resync → resubscribe → onConnect,
	// hammering the server with stream churn (seen live: herdr pegged a core).
	private subscribedKey: string | null = null;

	constructor(opts: AgentWatchOptions) {
		this.opts = opts;
	}

	current(): HerdrAgentInfo[] {
		return [...this.agents.values()];
	}

	async start(): Promise<void> {
		await this.resync();
	}

	stop(): void {
		this.stopped = true;
		this.stream?.close();
		this.stream = null;
		this.subscribedKey = null;
		if (this.resyncTimer) clearTimeout(this.resyncTimer);
		this.resyncTimer = null;
	}

	// Re-list agents, rebuild the subscription set if it changed, notify.
	private async resync(): Promise<void> {
		if (this.stopped) return;
		try {
			const { agents } = await herdr.agentList(this.opts);
			this.agents.clear();
			for (const a of agents as HerdrAgentInfo[]) {
				const paneId = a.pane_id as string | undefined;
				if (!paneId || paneId === this.opts.ownPaneId) continue;
				this.agents.set(paneId, a);
			}
		} catch (err) {
			this.opts.onError?.(err as Error);
		}
		const key = [...this.agents.keys()].sort().join("\n");
		if (this.stream === null || key !== this.subscribedKey) this.resubscribe(key);
		this.opts.onChange(this.current());
	}

	// Debounced resync: lifecycle events often arrive in bursts (layout.apply
	// creates N panes); one refresh after the burst is enough.
	private scheduleResync(): void {
		if (this.stopped || this.resyncTimer) return;
		this.resyncTimer = setTimeout(() => {
			this.resyncTimer = null;
			void this.resync();
		}, 250);
	}

	private resubscribe(key: string): void {
		this.stream?.close();
		this.subscribedKey = null;
		if (this.stopped) return;
		const subs: Subscription[] = [
			{ type: "pane.created" },
			{ type: "pane.closed" },
			{ type: "pane.exited" },
			{ type: "workspace.closed" },
		];
		for (const paneId of this.agents.keys()) {
			subs.push({ type: "pane.agent_status_changed", pane_id: paneId });
		}
		// The ack of THIS deliberately opened stream must not resync: the
		// snapshot is milliseconds old, and resyncing here restarts the
		// subscribe/close loop. Only a genuine drop + reconnect (events
		// possibly missed while disconnected) warrants a fresh snapshot.
		let initialAck = true;
		this.stream = subscribe(subs, (ev) => this.handleEvent(ev.event, ev.data), {
			socketPath: this.opts.socketPath,
			reconnectDelayMs: this.opts.reconnectDelayMs,
			onError: this.opts.onError,
			onConnect: () => {
				if (initialAck) {
					initialAck = false;
					return;
				}
				this.scheduleResync();
			},
		});
		this.subscribedKey = key;
	}

	private handleEvent(event: string, data: Record<string, unknown>): void {
		const paneId = data.pane_id as string | undefined;
		switch (event) {
			case "pane.agent_status_changed": {
				if (!paneId) return;
				const existing = this.agents.get(paneId);
				if (existing) {
					existing.agent_status = data.agent_status as string;
					if (typeof data.agent === "string") existing.agent = data.agent;
					if (typeof data.custom_status === "string") existing.custom_status = data.custom_status;
					this.opts.onChange(this.current());
				} else {
					// Status for a pane we don't track yet (e.g. agent detected
					// after creation) — refresh the snapshot.
					this.scheduleResync();
				}
				return;
			}
			case "pane.closed":
			case "pane.exited": {
				if (paneId && this.agents.delete(paneId)) {
					this.opts.onChange(this.current());
				}
				// The pane set changed either way — resubscribe without the
				// dead pane (and catch anything created meanwhile).
				this.scheduleResync();
				return;
			}
			case "pane.created":
			case "workspace.closed": {
				this.scheduleResync();
				return;
			}
		}
	}
}
