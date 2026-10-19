// External-blocker circuit breaker — the pure policy core behind "stop when the
// thing you need is not yours to get".
//
// The observed failure: a runtime-telemetry assertion could not be proven
// because the correlation destination did not exist outside the fleet. Nothing
// stopped the line, so the run kept substituting internal work for the missing
// external fact — building manifests, fixtures, and diagnostic packets — for
// hours, and the assertion ended UNPROVEN anyway. An external blocker is not a
// harder version of the task; it is the end of what delegation can buy.
//
// Protocol: a specialist that cannot proceed without something outside the
// fleet's reach emits `EXTERNAL_BLOCKED: <what is missing and who owns it>`.
// The hub records it and refuses the NEXT dispatch/research until the human has
// been addressed — the escalation is the deliverable at that point.

/** Pull `EXTERNAL_BLOCKED: …` markers out of a specialist's output. */
export function extractExternalBlockers(output) {
	const blockers = [];
	for (const rawLine of String(output || "").split("\n")) {
		const line = rawLine.trim();
		const match = line.match(/^EXTERNAL_BLOCKED\s*:\s*(.+)$/i);
		if (match) {
			const what = match[1].trim();
			if (what && !blockers.includes(what)) blockers.push(what);
		}
	}
	return blockers;
}

/**
 * Gate the next dispatcher call while an external blocker is unacknowledged.
 *
 * state: {
 *   blockers: [{ agent, what }],   // recorded, newest last
 *   acknowledged: boolean,          // human addressed (ask_user called, or new user turn)
 *   askUserAvailable: boolean,      // whether this session has the ask_user tool
 *   refusedOnce: boolean,           // a refusal was already issued for this blocker set
 * }
 *
 * Returns null when allowed, else { reason, message }. Without ask_user the gate
 * fires exactly once: a session that cannot reach the human must still be able
 * to finish and report, and an unbreakable gate there is a deadlock, not a stop.
 */
export function checkExternalBlockerGate(state) {
	const blockers = state?.blockers || [];
	if (blockers.length === 0) return null;
	if (state?.acknowledged) return null;
	if (!state?.askUserAvailable && state?.refusedOnce) return null;

	const list = blockers.map((b) => `  - ${b.what}${b.agent ? ` (reported by ${b.agent})` : ""}`).join("\n");
	const escalation = state?.askUserAvailable
		? "Call `ask_user` with the packet below. The gate opens as soon as you do."
		: "`ask_user` is unavailable in this session: put the packet below in your reply to the human and stop " +
		  "this line of work. (This gate fires once; further dispatches are allowed so you can finish and report.)";

	return {
		reason: "external_blocked",
		message: `⛔ EXTERNAL BLOCKER — dispatch refused and NOT counted against any budget.\n\n` +
			`A specialist reported that it needs something outside the fleet's reach:\n${list}\n\n` +
			`Do NOT route around this. Substituting internal work for a missing external fact — building ` +
			`scripts, manifests, fixtures, or diagnostic packets to approximate it — is how a blocked ` +
			`assertion turns into hours of work that still ends UNPROVEN.\n\n` +
			`${escalation}\n\n` +
			`Owner escalation packet (one message, no dispatches):\n` +
			`  1. WHAT is missing and who owns it.\n` +
			`  2. WHICH assertions/tasks are blocked on it, by id.\n` +
			`  3. WHAT is already proven and where the evidence lives (artifact paths).\n` +
			`  4. The concrete OPTIONS for the human: provide the missing access, waive the assertion as ` +
			`UNPROVEN (a waiver is not a PASS), or drop the item from scope.\n` +
			`  5. What you will do while it is blocked — normally: the unrelated remaining work, or nothing.`,
	};
}

/** The protocol paragraph injected into every specialist's system prompt. */
export function externalBlockedProtocol() {
	return [
		"- External blocker: if you cannot proceed because something OUTSIDE this repo and outside your",
		"  tools is missing — an account, a permission, a deployment credential, a telemetry/monitoring",
		"  destination, a third-party service, a human-only console action — do NOT build a substitute for",
		"  it and do NOT keep trying alternatives. Emit a line of the form",
		"  `EXTERNAL_BLOCKED: <what is missing, who owns it, and what it blocks>`, report what you DID",
		"  prove, and stop. The dispatcher escalates it to the human; approximating the missing fact with",
		"  extra scripts, fixtures, or manifests is the failure this protocol exists to prevent.",
	].join("\n");
}
