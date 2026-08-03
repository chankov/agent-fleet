import test from "node:test";
import assert from "node:assert/strict";

import { countReviewFindings, findingBudgetNotice } from "./review-findings.js";

const TEMPLATE_REVIEW = `# Review Summary

The change is sound overall.

### Critical Issues

- The connection string is written to the log at Startup.cs:41.
- Retries are unbounded on a 500 response.

### Important Issues

1. The new provider swallows AuthenticationFailedException.
2. No test covers the local client-secret path.

### Suggestions

- Consider renaming LiveKeyVaultBootstrap.
- The XML docs could name the filter.

### What's Done Well

- The 14-key filter is exact and tested.
`;

test("countReviewFindings counts blocking and non-blocking sections separately", () => {
	const counts = countReviewFindings(TEMPLATE_REVIEW);
	assert.equal(counts.blocking, 4);
	assert.equal(counts.nonBlocking, 3);
	assert.deepEqual(counts.sections, ["Critical Issues", "Important Issues"]);
	assert.equal(counts.sawHeadings, true);
});

test("countReviewFindings ignores bullets inside fenced code", () => {
	const text = [
		"### Critical Issues",
		"",
		"- Real finding.",
		"",
		"```diff",
		"- removed line that looks like a bullet",
		"- another removed line",
		"```",
		"",
		"- Second real finding.",
	].join("\n");
	assert.equal(countReviewFindings(text).blocking, 2);
});

test("countReviewFindings handles reviewers that skip headings", () => {
	const text = [
		"CRITICAL: the token is logged in plaintext",
		"- **Important** — the retry loop is unbounded",
		"Everything else looks fine.",
	].join("\n");
	assert.equal(countReviewFindings(text).blocking, 2);
	assert.equal(countReviewFindings(text).sawHeadings, false);
});

test("countReviewFindings does not count prose or unrelated sections", () => {
	const text = [
		"## Review Summary",
		"- The change is small and well tested.",
		"## Verification Story",
		"- npm test: 126 passed.",
	].join("\n");
	const counts = countReviewFindings(text);
	assert.equal(counts.blocking, 0);
	assert.equal(counts.nonBlocking, 0);
});

test("countReviewFindings recognises the non-blocking heading the clause asks for", () => {
	const text = "## Non-blocking (optional)\n- rename this\n- extract that\n";
	const counts = countReviewFindings(text);
	assert.equal(counts.nonBlocking, 2);
	assert.equal(counts.blocking, 0);
});

test("countReviewFindings tolerates empty and junk input", () => {
	for (const input of ["", undefined, null, "no findings at all"]) {
		const counts = countReviewFindings(input);
		assert.equal(counts.blocking, 0);
		assert.equal(counts.nonBlocking, 0);
	}
});

test("findingBudgetNotice stays silent while the review is within budget", () => {
	assert.equal(findingBudgetNotice("code-reviewer", 5, { blocking: 4, sections: [] }), null);
	assert.equal(findingBudgetNotice("code-reviewer", 5, { blocking: 5, sections: [] }), null);
	assert.equal(findingBudgetNotice("code-reviewer", null, { blocking: 99, sections: [] }), null, "project tier is uncapped");
	assert.equal(findingBudgetNotice("code-reviewer", 2, null), null);
});

test("findingBudgetNotice reports the overflow without reclassifying it", () => {
	const notice = findingBudgetNotice("code-reviewer", 2, countReviewFindings(TEMPLATE_REVIEW));
	assert.ok(notice);
	assert.match(notice, /4 blocking finding\(s\) against a cap of 2/);
	assert.match(notice, /Critical Issues, Important Issues/);
	// The safety property this module exists for: the hub reports, the dispatcher ranks.
	assert.match(notice, /does NOT reclassify/);
	assert.match(notice, /you rank them, not a regex/);
	assert.match(notice, /do NOT schedule them as work/);
});

test("findingBudgetNotice names the remaining review rounds when it knows them", () => {
	const counts = { blocking: 4, sections: [] };
	const mid = findingBudgetNotice("code-reviewer", 2, counts, 1, 2);
	assert.match(mid, /Review rounds on this task: 1\/2/);
	assert.match(mid, /exactly the ratchet/);
	const last = findingBudgetNotice("code-reviewer", 2, counts, 2, 2);
	assert.match(last, /No further review dispatch will be accepted/);
	assert.ok(!findingBudgetNotice("code-reviewer", 2, counts).includes("Review rounds"));
});
