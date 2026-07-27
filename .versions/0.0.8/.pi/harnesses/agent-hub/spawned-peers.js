// Hub-spawned coms peers: readiness policy and the never-addressed sweep.
//
// Root cause this encodes: `herdr_spawn_peer` launches a REUSABLE coms peer —
// it boots idle and waits for a `coms_send`. Spawning it delivers no work. One
// session spawned `repair-builder` and `final-test-worker`, sent all twelve of
// its messages to a third peer, and left two empty panes named like workers.
// The spawns were a sound reaction to a broken session; nothing told the
// dispatcher when the peers became addressable, and nothing noticed they never
// were addressed.
//
// Two answers: the spawn returns a readiness verdict instead of a bare pane id,
// and an unaddressed hub-spawned peer is named at the end of the session.

/** Longest we wait for a spawned peer to register in the coms pool. */
export const PEER_READY_TIMEOUT_MS = 45_000;

/** Poll backoff while waiting for registration, in ms; the last step repeats. */
export const PEER_READY_BACKOFF_MS = [250, 500, 1_000, 2_000, 3_000];

/** Backoff delay for the nth readiness poll (0-based); the last step repeats. */
export function peerReadyDelayMs(attempt) {
	const i = Math.max(0, Math.min(Math.floor(attempt) || 0, PEER_READY_BACKOFF_MS.length - 1));
	return PEER_READY_BACKOFF_MS[i];
}

/**
 * The verdict a spawn reports back. `ready` means the peer is in the pool and
 * `coms_send` will reach it; otherwise it is still booting and the caller is
 * told how long we waited rather than being left to guess.
 */
export function peerReadyVerdict({ name, paneId, found, waitedMs, timeoutMs = PEER_READY_TIMEOUT_MS }) {
	if (found) {
		return {
			peer_ready: true,
			peer_name: name,
			pane_id: paneId,
			waited_ms: waitedMs,
			message:
				`Peer "${name}" is ready in pane ${paneId} after ${Math.round(waitedMs / 1000)}s — ` +
				`address it with coms_send(target: "${name}", ...). It boots idle and does no work until you send.`,
		};
	}
	return {
		peer_ready: false,
		peer_name: name,
		pane_id: paneId,
		waited_ms: waitedMs,
		message:
			`Peer "${name}" is still booting in pane ${paneId} — it did not register in the coms pool within ` +
			`${Math.round(timeoutMs / 1000)}s. Check coms_list before sending; if it never appears, read the pane ` +
			"to see why it failed to start, and close it if it is dead.",
	};
}

/**
 * Sweep report for peers this hub spawned. `entries` carry
 * { name, paneId, addressed } — `addressed` is true once any coms_send targeted
 * that peer. Returns null when every spawned peer got work (the common case).
 */
export function unaddressedPeerSweep(entries) {
	const idle = (Array.isArray(entries) ? entries : []).filter((e) => e && !e.addressed);
	if (idle.length === 0) return null;
	const rows = idle.map((e) => `  ${e.name} (pane ${e.paneId ?? "?"}) — spawned, never sent to`);
	return {
		count: idle.length,
		peers: idle.map((e) => ({ name: e.name, pane_id: e.paneId ?? null })),
		message: [
			`⚠ ${idle.length} hub-spawned peer(s) never received a message:`,
			...rows,
			"A spawned peer boots idle and waits — it is holding a pane and a model session for nothing.",
			`Close them with herdr_close_pane (asks for your confirmation) or send them work.`,
		].join("\n"),
	};
}
