// scripts/lib/spawn-stagger.ts
//
// Pre-warm/stagger for simultaneous pi pane spawns (team-up, hub-team,
// team-resume). pi's credential store (~/.pi/agent/auth.json) is loaded once
// at boot under a short-retry file lock; when a stale OAuth token forces one
// pane to refresh it over the network WHILE holding that lock, sibling panes
// booting in the same instant lose the lock race and come up with an empty
// credential store — every provider shows "unconfigured". The fix is local:
// when a stale OAuth credential is detected, one pi pane starts immediately
// (the warmer — it refreshes the token) and every other pi pane sleeps a few
// seconds before launching. Fresh tokens mean zero delay everywhere.
//
// Pure logic only — no fs, no sockets, no process.exit. Callers read
// auth.json themselves (lock-free, same as pi's readStoredCredential) and
// inject delays into pane env; the `_peer`/`_peer-plus` recipes honor
// AGENT_FLEET_SPAWN_DELAY with a plain `sleep`.

/** Env var the justfile peer recipes read: seconds to sleep before launching pi. */
export const STAGGER_ENV_VAR = "AGENT_FLEET_SPAWN_DELAY";

/** Delay for the first staggered pane — long enough for the warmer's token refresh round-trip. */
export const WARMUP_SECONDS = 4;

/** Extra spacing between subsequent staggered panes. */
export const STEP_SECONDS = 1;

/** Treat tokens expiring within this window as stale — pane boot takes seconds. */
export const EXPIRY_MARGIN_MS = 60_000;

/**
 * Does auth.json hold an OAuth credential that a booting pi would refresh?
 * `raw` is the file's contents (undefined when unreadable/absent). Missing or
 * malformed files never stagger: with no stored credential there is nothing
 * to refresh, so there is no long lock hold to dodge.
 */
export function oauthNeedsWarmup(raw: string | undefined, now = Date.now()): boolean {
	if (!raw) return false;
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return false;
	}
	if (typeof data !== "object" || data === null) return false;
	for (const credential of Object.values(data)) {
		if (typeof credential !== "object" || credential === null) continue;
		const { type, expires } = credential as { type?: unknown; expires?: unknown };
		if (type !== "oauth" || typeof expires !== "number") continue;
		if (expires <= now + EXPIRY_MARGIN_MS) return true;
	}
	return false;
}

export interface StaggerOptions {
	/** Per-peer flag, in spawn order: does this pane boot a pi process? */
	peerIsPi: boolean[];
	/** Does the root pane (hub) boot a pi process? The hub warms when present. */
	rootIsPi: boolean;
	/** Result of oauthNeedsWarmup — false short-circuits to all-zero delays. */
	needed: boolean;
	warmupSeconds?: number;
	stepSeconds?: number;
}

/**
 * Per-peer delay seconds (spawn order). Exactly one pi process — the hub when
 * present, otherwise the first pi peer — starts at 0 and refreshes the stale
 * token; every other pi peer starts after the warm-up window. Non-pi panes
 * (runner: claude-code) never wait: they do not touch pi's credential store.
 */
export function staggerDelays(opts: StaggerOptions): number[] {
	const { peerIsPi, rootIsPi, needed, warmupSeconds = WARMUP_SECONDS, stepSeconds = STEP_SECONDS } = opts;
	if (!needed) return peerIsPi.map(() => 0);
	let staggered = 0;
	let warmerAssigned = rootIsPi;
	return peerIsPi.map((isPi) => {
		if (!isPi) return 0;
		if (!warmerAssigned) {
			warmerAssigned = true;
			return 0;
		}
		return warmupSeconds + staggered++ * stepSeconds;
	});
}

/**
 * Convenience for the team entrypoints: auth.json contents + peers → a
 * `delayForPeer` hook for buildTeamLayout. Structural peer type avoids a
 * circular import with herdr-layout.ts.
 */
export function planSpawnDelays<P extends { runner?: string }>(
	peers: P[],
	rootIsPi: boolean,
	authJsonRaw: string | undefined,
	now = Date.now(),
): { needed: boolean; delayForPeer: (peer: P) => number | undefined } {
	const needed = oauthNeedsWarmup(authJsonRaw, now);
	const delays = staggerDelays({ peerIsPi: peers.map((p) => p.runner !== "claude-code"), rootIsPi, needed });
	const byPeer = new Map<P, number>(peers.map((p, i) => [p, delays[i]]));
	return { needed, delayForPeer: (peer) => byPeer.get(peer) };
}
