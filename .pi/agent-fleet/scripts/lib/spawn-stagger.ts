// .pi/agent-fleet/scripts/lib/spawn-stagger.ts
//
// Pre-warm/stagger for pi pane spawns that land close together (the Hub's
// herdr_spawn_peer). pi's credential store (~/.pi/agent/auth.json) is loaded
// once at boot under a short-retry file lock; when a stale OAuth token forces
// one pane to refresh it over the network WHILE holding that lock, a sibling
// pane booting in the same instant loses the lock race and comes up with an
// empty credential store — every provider shows "unconfigured". The fix is
// local: when a stale OAuth credential is detected, a pi pane spawned right
// after another sleeps a few seconds before launching (spawned-peers.js
// spawnStaggerSeconds decides how long). Fresh tokens mean zero delay.
//
// Pure logic only — no fs, no sockets, no process.exit. Callers read
// auth.json themselves (lock-free, same as pi's readStoredCredential) and
// inject the delay into pane env; the `_peer`/`_peer-read-only` recipes honor
// AGENT_FLEET_SPAWN_DELAY with a plain `sleep`.

/** Env var the justfile peer recipes read: seconds to sleep before launching pi. */
export const STAGGER_ENV_VAR = "AGENT_FLEET_SPAWN_DELAY";

/** Delay for the first staggered pane — long enough for the warmer's token refresh round-trip. */
export const WARMUP_SECONDS = 4;

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
