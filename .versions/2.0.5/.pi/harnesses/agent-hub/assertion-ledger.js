// Assertion-ledger contract — pure validation for the `set_assertions` tool.
//
// Two rules, both drawn from the post-mortem of the hub sessions that declared
// 30 assertions (GO1–GO5, A1–A25) in one call and then spent a dispatch plus an
// ASK_USER cycle answering "where were A9–A16 defined?":
//
//   1. Every assertion names its origin, so an id can always be traced back to
//      the plan/spec line it came from. Refused when missing — a sourceless id
//      is exactly the failure that cost the cycle.
//   2. The open ledger is capped at MAX_OPEN_ASSERTIONS per batch. Warned, not
//      refused: a large task legitimately has many assertions, they just should
//      not all be open at once. Declare the rest when their batch starts.

export const MAX_OPEN_ASSERTIONS = 8;

const str = (v) => String(v ?? "").trim();

/**
 * Validate + normalize one `set_assertions` batch.
 * Returns { ok, refusal?, warning, assertions } — `assertions` is empty on a
 * refusal so a rejected batch can never half-replace the live ledger.
 */
export function validateAssertionBatch(input) {
	const batch = Array.isArray(input) ? input : [];

	const sourceless = batch
		.map((a, i) => (str(a?.source) === "" ? str(a?.id) || `#${i + 1}` : null))
		.filter((label) => label !== null);

	if (sourceless.length > 0) {
		return {
			ok: false,
			refusal:
				`Ledger unchanged: ${sourceless.length} assertion(s) declare no source — ${sourceless.join(", ")}. ` +
				"Every assertion must name where it comes from (e.g. source: \"PLAN-x.md:585-595\", " +
				"\"user request\", \"review finding F3\") so a specialist asked to prove it can read the origin " +
				"instead of asking. Re-send the batch with a source on each.",
			warning: null,
			assertions: [],
		};
	}

	const assertions = batch.map((a) => ({
		id: str(a?.id),
		tag: str(a?.tag),
		text: str(a?.text),
		source: str(a?.source),
	}));

	const warning =
		assertions.length > MAX_OPEN_ASSERTIONS
			? `⚠ ${assertions.length} assertions are open at once (soft cap ${MAX_OPEN_ASSERTIONS}). ` +
				"Keep this batch to the assertions the next dispatches actually prove and defer the rest — " +
				"declare them with a fresh set_assertions when their batch starts. Accepted as-is."
			: null;

	return { ok: true, warning, assertions };
}
