// Session-file health — the pure policy behind never handing pi a session file
// it will refuse. `spawnPiAgent` passes `--session <file>` on every run, so one
// corrupt `<agentKey>.json` bricks a persona for the rest of the session: every
// dispatch dies in ~1s with an empty result, and drop + re-add does not help
// because the file survives the roster change.
//
// A pi session file is JSONL whose FIRST record is the header
// `{"type":"session","version":N,...}`. Both files that pi rejected in the
// field (`builder.json.corrupt-*`, `builder.json.invalid-gate-p`) start with a
// `{"type":"message",...}` record instead — they were truncated at the head, so
// the conversation begins mid-chain. That single check separates them from the
// session files that were healthy but retired for other reasons.

export const SESSION_HEADER_TYPE = "session";

/**
 * Would pi accept this session file body? Returns `{ ok, reason }`; `reason` is
 * null when ok, and a human-readable cause otherwise (it reaches the dispatcher
 * verbatim, so it must explain what happened, not just that something did).
 */
export function isUsablePiSession(text) {
	const body = String(text ?? "");
	if (!body.trim()) return { ok: false, reason: "session file is empty" };

	const firstLine = body.split(/\r?\n/).find((line) => line.trim());
	let header;
	try {
		header = JSON.parse(firstLine);
	} catch {
		return { ok: false, reason: "first record is not valid JSON — the file is truncated or not a pi session" };
	}
	if (!header || typeof header !== "object" || Array.isArray(header)) {
		return { ok: false, reason: "first record is not a JSON object" };
	}
	if (header.type !== SESSION_HEADER_TYPE) {
		return {
			ok: false,
			reason: `first record is "${header.type ?? "(no type)"}", not a "${SESSION_HEADER_TYPE}" header — ` +
				"the file was truncated at the head and the conversation starts mid-chain",
		};
	}
	return { ok: true, reason: null };
}

/** `builder.json` → `builder.json.corrupt-2026-07-25T09-14-02-123Z` (no colons: portable filename). */
export function quarantineName(file, now = new Date()) {
	const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
	return `${file}.corrupt-${stamp}`;
}

/**
 * The observed post-hoc signature of a session file pi rejects: it exits
 * non-zero having produced no output at all, and says so on stderr. Validation
 * cannot catch every reason pi refuses a file, so this is the second net — and
 * the run never started, which is what makes a retry safe.
 */
export function isCorruptSessionExit({ code, output, stderr } = {}) {
	if (code === 0 || code == null) return false;
	if (String(output ?? "").trim()) return false;
	return /not a valid pi session|invalid pi session/i.test(String(stderr ?? ""));
}

/**
 * Check `file` and move it aside when pi would reject it. `io` supplies the fs
 * calls (`existsSync`, `readFileSync`, `renameSync`) and an optional `now`.
 * Returns `{ usable, quarantined, reason }` — `quarantined` is the path the bad
 * file was moved to, so the caller can name it for the human.
 */
export function quarantineIfUnusable(file, io) {
	if (!io.existsSync(file)) return { usable: false, quarantined: null, reason: null };

	let verdict;
	try {
		verdict = isUsablePiSession(io.readFileSync(file, "utf-8"));
	} catch (err) {
		verdict = { ok: false, reason: `session file unreadable: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (verdict.ok) return { usable: true, quarantined: null, reason: null };

	const target = quarantineName(file, io.now ? io.now() : new Date());
	try {
		io.renameSync(file, target);
		return { usable: false, quarantined: target, reason: verdict.reason };
	} catch {
		// Could not move it aside — still refuse to resume it. Starting clean
		// overwrites the bad file, which is the outcome we want anyway.
		return { usable: false, quarantined: null, reason: verdict.reason };
	}
}
