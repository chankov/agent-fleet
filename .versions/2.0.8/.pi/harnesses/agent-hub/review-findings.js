// Review-finding accounting — counts what a review actually returned so the hub
// can say, in the dispatch result, whether the finding budget was honored.
//
// This module deliberately COUNTS and REPORTS; it never rewrites a review. The
// tempting version — cap the blocking findings and auto-relabel the overflow as
// non-blocking — is unsafe, and the reason is worth stating where it will be read
// before someone "fixes" it: no rule the hub can evaluate distinguishes "invents a
// manifest nobody asked for" from "this logs a connection string". Both are a
// heading and a bullet. Demoting the fifth Critical finding by position would, on
// the day it matters, move a real security finding into the section nobody acts
// on, and it would do so silently.
//
// So the enforcement lives where the hub has authority over its own behaviour —
// the review ROUND cap in run-budget.js — and this module supplies the visible
// accounting that makes an over-budget review obvious to the dispatcher and to
// the human reading the transcript.

// Heading forms the review personas emit: "### Critical Issues", "## Important",
// "#### Blocking findings". Also matches the bare label form ("**Critical:**").
const BLOCKING_HEADING = /^(#{1,6})\s*(?:\d+[.)]\s*)?\**\s*(critical|important|blocking)\b/i;
const NONBLOCKING_HEADING = /^(#{1,6})\s*\**\s*(non[- ]?blocking|suggestions?|nits?|minor|optional|what'?s done well|strengths)\b/i;
const ANY_HEADING = /^(#{1,6})\s/;

// A finding inside a section: a bullet, a numbered item, or a bolded lead-in.
const FINDING_ITEM = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;

// Inline forms used when a reviewer skips headings entirely:
// "CRITICAL: the token is logged", "- **Important** — retries are unbounded".
const INLINE_BLOCKING = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\**\s*(critical|important|blocker|blocking)\b\s*\**\s*[:—-]/i;

/**
 * Count blocking vs non-blocking findings in a review's text.
 * Returns { blocking, nonBlocking, sections, sawHeadings } — `sections` names the
 * blocking headings that were found, for the notice.
 */
export function countReviewFindings(text) {
	const lines = String(text || "").split("\n");
	let mode = "none"; // none | blocking | nonblocking
	let blocking = 0;
	let nonBlocking = 0;
	let sawHeadings = false;
	const sections = [];
	let inFence = false;

	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, "");
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		if (ANY_HEADING.test(line)) {
			sawHeadings = true;
			if (BLOCKING_HEADING.test(line)) {
				mode = "blocking";
				sections.push(line.replace(/^#{1,6}\s*/, "").replace(/\**/g, "").trim());
			} else if (NONBLOCKING_HEADING.test(line)) {
				mode = "nonblocking";
			} else {
				mode = "none";
			}
			continue;
		}

		if (FINDING_ITEM.test(line)) {
			if (mode === "blocking") blocking++;
			else if (mode === "nonblocking") nonBlocking++;
			else if (INLINE_BLOCKING.test(line)) blocking++;
			continue;
		}
		// Un-bulleted inline label outside any section ("CRITICAL: ...").
		if (mode === "none" && INLINE_BLOCKING.test(line)) blocking++;
	}

	return { blocking, nonBlocking, sections, sawHeadings };
}

/**
 * The notice appended to a review dispatch's result when the return carried more
 * blocking findings than the tier's cap. Instructional, never corrective: the
 * dispatcher is told to rank and close, and told what NOT to do with the rest.
 * Returns null when the review is within budget or there is nothing to judge.
 */
export function findingBudgetNotice(agent, tierCap, counts, roundsSpent = null, roundCap = null) {
	if (tierCap == null || !counts) return null;
	if (counts.blocking <= tierCap) return null;
	const roundLine = roundCap == null
		? ""
		: `\nReview rounds on this task: ${roundsSpent ?? "?"}/${roundCap}. ` +
			(roundsSpent != null && roundsSpent >= roundCap
				? "No further review dispatch will be accepted for this task — this IS the gate."
				: "Spending the next round on the overflow is exactly the ratchet.");
	return `\n\n⚠ FINDING BUDGET EXCEEDED — ${agent} returned ${counts.blocking} blocking finding(s) against a cap of ${tierCap}` +
		(counts.sections.length > 0 ? ` (sections: ${counts.sections.slice(0, 4).join(", ")})` : "") + `.\n` +
		`The hub does NOT reclassify findings — a cap cannot tell "invents a new manifest" from "this leaks a credential", ` +
		`so you rank them, not a regex.\n` +
		`Act on the ${tierCap} most severe as the gate. Treat the remainder as recommendations for the human: report them, ` +
		`do NOT schedule them as work, and do NOT let them reopen an assertion that a named piece of evidence already closed. ` +
		`A finding that asks for a NEW invariant, evidence artifact, script, manifest, or process step is scope growth — ` +
		`surface it to the human as a choice rather than executing it.${roundLine}`;
}
