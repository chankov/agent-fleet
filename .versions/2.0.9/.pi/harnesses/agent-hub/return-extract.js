// Second chance at a structured return — the pure policy behind it.
//
// When a specialist's report carries no parseable structured block, the hub
// declares every dispatched assertion unproven. That is correct as a default and
// ruinous as an outcome: one 1221-second test-engineer run returned nothing
// parseable, and 16 of 46 dispatches in the same session were written off the
// same way. Discarding twenty minutes of real work over a formatting miss is the
// most expensive failure mode in the system.
//
// So: ONE cheap read-only pass over the report that was already written to disk,
// asked to restate what is there — never to judge, and never to invent evidence.
// The caller labels the result as extracted, so recovered evidence is always
// visibly weaker than evidence the specialist declared itself.

/** The dedicated cheap model required by the recovery contract. */
export const EXTRACTION_MODEL = "openai-codex/gpt-5.6-luna";

/** Two minutes: the pass must read a file, but it may never become a real run. */
export const EXTRACTION_DEADLINE_MS = 120_000;

/** A unique throwaway session per return artifact, safe under parallel dispatches. */
export function extractionSessionName(returnPath) {
	const base = String(returnPath ?? "return")
		.replace(/\\/g, "/")
		.split("/")
		.pop()
		.replace(/\.md$/i, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-") || "return";
	return `return-extract-${base}.json`;
}

/**
 * Is a second chance warranted? Only when nothing parsed AND the dispatcher was
 * actually tracking assertions — with no assertions there is nothing to recover,
 * and the raw output already reaches the dispatcher untouched.
 */
export function shouldExtractReturn(parsed, dispatchedIds) {
	return !parsed && Array.isArray(dispatchedIds) && dispatchedIds.length > 0;
}

/** The extraction prompt: restate, never evaluate. */
export function buildExtractionPrompt({ returnPath, assertionIds = [] }) {
	return `A specialist agent has already finished its work and written its report to a file.
Your ONLY job is to restate what that report says in a fixed format.
You are not reviewing the work. You are not judging it. You add nothing.

## Report file
${returnPath}

Read it with your read tool.

## Assertion ids the dispatcher is tracking
${assertionIds.length > 0 ? assertionIds.join(", ") : "(none)"}

## Rules
- Put an id in assertions_proven ONLY if the report names concrete evidence for
  it: a test name, command output, or file:line. Copy that evidence VERBATIM
  from the report. Never write evidence of your own, never summarise it into a
  claim, and never mark something proven because it sounds done.
- An id the report does not clearly resolve goes in assertions_unproven. When in
  doubt, unproven — that is the safe answer and costs nothing.
- An id the report says failed, blocked, or regressed goes in assertions_failed.
- Every tracked id must appear in exactly one of the three lists.

## Your answer
Reply with ONLY the block below and nothing else — no preamble, no explanation:

changed_files: [<path:line — what changed>]
assertions_proven: [<id>: <what the report claims> — evidence: <verbatim evidence>]
assertions_unproven: [<id>: <why the report leaves it open>]
assertions_failed: [<id>: <what the report says went wrong>]
tests_run: [<command → result, as the report states it>]
open_risks: [<risk the report names>]
requires_user_decision: [<decision the report says is needed>]`;
}
