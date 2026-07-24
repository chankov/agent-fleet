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
// Wire constraint baked in (measured live, herdr 0.7.1): `custom_status` is
// truncated to 32 chars by the server — no JSON fits. formatPeerStatus()
// therefore emits `<name> <pct>% q<depth>` with the coms peer NAME FIRST, so
// watchers can join a herdr pane back to the registry entry that carries the
// full agent card. parsePeerName() is the inverse.
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

// `<name> <pct>% q<depth>` truncated to the 32-char server cap, name first.
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

export type PresenceState = "idle" | "working" | "blocked" | "unknown";

export interface HerdrPresenceOptions extends HerdrClientOptions {
	paneId: string;
	// Identity herdr uses to arbitrate reporting authority (required by the
	// API). Convention: `coms:<session_id>`.
	source: string;
	// Detected-agent label shown in the sidebar; pi peers report "pi".
	agentLabel?: string;
}

// Reports this agent's state into its herdr pane. All calls are best-effort:
// presence must never break the session, so errors resolve false.
//
// Two wire calls per report (both idempotent): pane.report_agent carries the
// state and covers panes herdr's built-in detection does NOT recognize; for
// recognized panes (pi has a detection manifest) that call is accepted but
// IGNORED — detection holds agent authority — so pane.report_metadata carries
// the custom_status annotation that detection cannot provide. Measured live
// on herdr 0.7.1; see docs/plans/herdr/spike-notes.md.
export class HerdrPresence {
	private opts: HerdrPresenceOptions;

	constructor(opts: HerdrPresenceOptions) {
		this.opts = opts;
	}

	async report(state: PresenceState, customStatus: string): Promise<boolean> {
		const status = customStatus.slice(0, CUSTOM_STATUS_MAX);
		const agent = this.opts.agentLabel ?? "pi";
		let ok = false;
		try {
			await herdr.paneReportAgent(
				{ pane_id: this.opts.paneId, source: this.opts.source, agent, state, custom_status: status },
				this.opts,
			);
			ok = true;
		} catch {
			// fall through — metadata may still land
		}
		try {
			await herdr.paneReportMetadata(
				{
					pane_id: this.opts.paneId,
					source: this.opts.source,
					agent,
					custom_status: status,
					// Expire if this reporter dies without releasing: a bit over
					// two keepalive cycles keeps the annotation fresh-or-gone.
					ttl_ms: 90_000,
				},
				this.opts,
			);
			ok = true;
		} catch {
			// best-effort
		}
		return ok;
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
