// .pi/harnesses/lib/coms-registry-entry.ts
//
// The shape written to ~/.pi/coms/projects/<project>/agents/<name>.json, and
// the one function that builds it for the 30-second heartbeat.
//
// It exists because both harnesses (the standalone coms harness and the copy
// embedded in agent-hub) had their own inline copy of the same object literal,
// and both copies wrote `started_at: nowIso()` on EVERY heartbeat. The field
// therefore never held the start of anything — it was always "about 30 seconds
// ago", and every reader that tried to show uptime showed noise. Registration
// sets `started_at`; the heartbeat carries it forward unchanged and moves
// `heartbeat_at` instead. That distinction is the whole point of this module,
// so it is stated once, here, and tested.
//
// Pure module: no pi imports, no fs, no clock of its own — `now` is passed in.
// Erasable-TS; testable under node --test.

export interface ComsRegistryEntry {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	color: string;
	pid: number;
	endpoint: string;
	cwd: string;
	// When this session registered. NEVER refreshed — see the module note.
	started_at: string;
	explicit: boolean;
	version: number;
	// Live status snapshot — refreshed every keepalive tick. Optional so
	// entries written before the heartbeat carried them still parse cleanly.
	context_used_pct?: number;
	queue_depth?: number;
	heartbeat_at?: string;
}

// What the session knows about itself from registration onwards. This is the
// harness `identity` object; it is the source of every field the heartbeat is
// not allowed to invent.
export interface ComsIdentity {
	session_id: string;
	name: string;
	purpose: string;
	color: string;
	cwd: string;
	endpoint: string;
	explicit: boolean;
	model: string;
	started_at: string;
}

// What is genuinely new at heartbeat time.
export interface LiveSnapshot {
	now: string;
	pid: number;
	// The model can change mid-session (`/model`), so it is re-read rather than
	// frozen at registration; falling back to the registered one when the ctx
	// is not available.
	model?: string | null;
	contextUsedPct?: number | null;
	queueDepth?: number | null;
}

// Percentages arrive from `ctx.getContextUsage()`, queue depths from a Map
// size. Both reach a human eye and a JSON file, so neither may be NaN,
// negative, or fractional.
function count(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.round(value));
}

// The registry entry for a heartbeat write. Also the entry used for self-heal
// (the file was unlinked under us and is being re-created), which is why every
// field is present rather than patched onto whatever is on disk: there may be
// nothing on disk.
export function buildLiveRegistryEntry(identity: ComsIdentity, live: LiveSnapshot): ComsRegistryEntry {
	return {
		session_id: identity.session_id,
		name: identity.name,
		purpose: identity.purpose,
		model: live.model || identity.model,
		color: identity.color,
		pid: live.pid,
		endpoint: identity.endpoint,
		cwd: identity.cwd,
		started_at: identity.started_at,
		explicit: identity.explicit,
		version: 1,
		context_used_pct: count(live.contextUsedPct),
		queue_depth: count(live.queueDepth),
		heartbeat_at: live.now,
	};
}
