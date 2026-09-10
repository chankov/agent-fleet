// Spawned coms peers: pane launch, readiness policy and the never-addressed sweep.
//
// Lives in the SHARED harness lib, not under agent-hub: `just fleet peer`
// (scripts/peer-launch.ts) launches a single peer with the same pane plumbing
// and the same readiness timings, and the fleet scripts are installed into
// target projects that may not have selected the agent-hub harness at all.
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

// Second root cause this encodes: herdr's `pane.split` takes NO command — a
// split always opens a plain interactive shell in `cwd`. The hub used to pass
// `command: argv` to it; herdr silently ignores unknown params, so every
// "spawned peer" was an empty shell pane with the right label, the tool
// reported success, and the peer never existed. `just fleet team` was
// unaffected because it launches through `layout.apply`, whose pane nodes DO
// carry an argv. A hub spawn is therefore three steps: split, wait for the
// pane's shell prompt, then type the command line.

/** Longest we wait for a spawned peer to register in the coms pool. */
export const PEER_READY_TIMEOUT_MS = 45_000;

/** Longest we wait for a freshly split pane to reach its shell prompt. */
export const PANE_PROMPT_TIMEOUT_MS = 10_000;

/** Poll interval while watching a new pane for its shell prompt, in ms. */
export const PANE_PROMPT_POLL_MS = 250;

/** Shell metacharacter-free values pass through unquoted; everything else is quoted. */
const BARE_ARG = /^[A-Za-z0-9._/,:=@%+-]+$/;

function shellQuote(arg) {
	const s = String(arg ?? "");
	if (s === "") return "''"; // positional placeholders must survive as empty args
	if (BARE_ARG.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * An argv (as built by peerCommand) turned into one line of shell input,
 * newline included. Quoting matters for the empty positional placeholders the
 * `just` recipes use to keep later positionals aligned — unquoted they would
 * vanish and shift `--project` into the model slot.
 */
export function paneLaunchLine(argv) {
	if (!Array.isArray(argv) || argv.length === 0) {
		throw new Error("paneLaunchLine: empty argv");
	}
	return `${argv.map(shellQuote).join(" ")}\n`;
}

/**
 * Does this pane read end at an interactive shell prompt? Typing before the
 * shell is up can drop the line, and herdr's own `agent.start` refuses a pane
 * that is not at a prompt, so the spawn waits for one. Best-effort by design:
 * the caller sends anyway once PANE_PROMPT_TIMEOUT_MS is spent.
 */
export function looksLikeShellPrompt(text) {
	if (typeof text !== "string") return false;
	const lines = text.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	if (lines.length === 0) return false;
	return /[$#%>❯➜›]\s*$/.test(lines[lines.length - 1]);
}

/**
 * Launch an argv in a freshly split pane by typing it at the pane's shell.
 * `client` is the herdr client (paneRead/paneSendText/paneSendKeys).
 *
 * Text and Enter go as separate calls on purpose: bash enables bracketed
 * paste, where a newline inside sent text is inserted into the line editor
 * instead of executing it. A pane that never shows a prompt still gets the
 * command — the shell's input queue survives a slow banner — but the caller
 * is told, because that is also what a pane whose shell died looks like.
 */
export async function launchPeerInPane(client, paneId, argv, opts = {}) {
	const {
		timeoutMs = PANE_PROMPT_TIMEOUT_MS,
		pollMs = PANE_PROMPT_POLL_MS,
		now = Date.now,
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	} = opts;
	const line = paneLaunchLine(argv).replace(/\n$/, "");
	const started = now();
	let promptSeen = false;
	for (;;) {
		try {
			const { read } = await client.paneRead({ pane_id: paneId, lines: 5 });
			if (looksLikeShellPrompt(read?.text ?? "")) {
				promptSeen = true;
				break;
			}
		} catch {
			// Pane not readable yet; the timeout below bounds the wait.
		}
		if (now() - started >= timeoutMs) break;
		await sleep(pollMs);
	}
	await client.paneSendText(paneId, line);
	await client.paneSendKeys(paneId, ["enter"]);
	return { promptSeen, waitedMs: now() - started };
}

/**
 * Seconds a hub-spawned pi peer should sleep before launching (the justfile
 * recipes honor it as AGENT_FLEET_SPAWN_DELAY). Same stale-OAuth lock race
 * that staggers team spawns: the first peer refreshes the token, so only a
 * sibling spawned inside the warm-up window has to wait. `needed` is
 * oauthNeedsWarmup() re-read at each spawn — once the warmer lands a fresh
 * token it goes false and nobody waits.
 */
export function spawnStaggerSeconds({ needed, lastSpawnAt, now, warmupSeconds }) {
	if (!needed || !Number.isFinite(warmupSeconds) || warmupSeconds <= 0) return 0;
	if (typeof lastSpawnAt !== "number" || !Number.isFinite(lastSpawnAt)) return 0;
	if (now - lastSpawnAt >= warmupSeconds * 1000) return 0;
	return warmupSeconds;
}

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
export function peerReadyVerdict({ name, paneId, found, waitedMs, timeoutMs = PEER_READY_TIMEOUT_MS, paneTail }) {
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
	// A peer that missed the window is usually dead, not slow, so the verdict
	// carries the pane's own last words instead of sending the caller off to
	// run herdr_read_pane to find out.
	const tail = typeof paneTail === "string" ? paneTail.trim() : "";
	return {
		peer_ready: false,
		peer_name: name,
		pane_id: paneId,
		waited_ms: waitedMs,
		pane_tail: tail || null,
		message:
			`Peer "${name}" did not register in the coms pool within ${Math.round(timeoutMs / 1000)}s — ` +
			`assume it failed to start rather than that it is slow. Do not coms_send to it. ` +
			`Check coms_list; if it never appears, close the pane with herdr_close_pane.` +
			(tail ? `\n\nLast output of pane ${paneId}:\n${tail}` : ""),
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
