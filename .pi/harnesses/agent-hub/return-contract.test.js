import { test } from "node:test";
import assert from "node:assert/strict";

import { crossCheck, extractAssertionIds, parseStructuredReturn } from "./return-contract.js";

test("extractAssertionIds dedupes assertion ids in first-seen order", () => {
	assert.deepEqual(extractAssertionIds("A1 then A3, A1 again, not BA2 or A2b, then A2"), ["A1", "A3", "A2"]);
});

test("parseStructuredReturn accepts key lines", () => {
	const parsed = parseStructuredReturn(`changed_files: [src/a.ts:1 — note]
assertions_proven: [A1: works ✓ — evidence: npm test → pass]
assertions_unproven: [A2: not checked]
assertions_failed: []
tests_run: [npm test → pass]
open_risks: []
requires_user_decision: []`);

	assert.equal(parsed.assertions_proven[0].id, "A1");
	assert.equal(parsed.assertions_proven[0].evidence, "npm test → pass");
	assert.equal(parsed.assertions_unproven[0].id, "A2");
});

test("parseStructuredReturn accepts the ASSERTION line form specialists actually emit", () => {
	// Verbatim from a plan-reviewer return that the old parser scored as
	// "no structured return", so all of its assertions were treated as unproven.
	const parsed = parseStructuredReturn(
		"Reviewed the plan against the repo.\n\n" +
		"ASSERTION A1: PASS — Conventional Hermes plan path and required opening sections are present\n" +
		"ASSERTION A2: FAIL — Task 4 touches 9 files, over the ~5 file ceiling\n" +
		"A3: UNPROVEN — could not verify the CI job name\n",
	);

	assert.equal(parsed.assertions_proven.length, 1);
	assert.equal(parsed.assertions_proven[0].id, "A1");
	assert.equal(parsed.assertions_proven[0].evidence, "Conventional Hermes plan path and required opening sections are present");
	assert.equal(parsed.assertions_failed[0].id, "A2");
	assert.equal(parsed.assertions_unproven[0].id, "A3");
});

test("parseStructuredReturn reads bullet, bold, and bare line forms", () => {
	const parsed = parseStructuredReturn(
		"- **A1: PASS** — npm test → 42 passing\n" +
		"2) A2 — PASSED: scripts/x.test.ts:88\n" +
		"A3: PASS\n" +
		"* A4: BLOCKED — needs a decision\n",
	);

	assert.deepEqual(parsed.assertions_proven.map(e => e.id), ["A1", "A2", "A3"]);
	assert.equal(parsed.assertions_proven[0].evidence, "npm test → 42 passing");
	assert.equal(parsed.assertions_proven[1].evidence, "scripts/x.test.ts:88");
	// A bare verdict names no evidence, so it must stay demotable.
	assert.equal(parsed.assertions_proven[2].evidence, null);
	assert.deepEqual(crossCheck(parsed, ["A3"]), [{ type: "proven_without_evidence", id: "A3", note: "" }]);
	assert.equal(parsed.assertions_failed[0].id, "A4");
});

test("line-form parsing never fires on prose or overrides a declared block", () => {
	// No separator after the status → prose, not a verdict.
	assert.equal(parseStructuredReturn("A1: PASS is not achievable without a rewrite"), null);
	assert.equal(parseStructuredReturn("We think A1 passes and A2 fails."), null);

	// A declared block wins; the stray line form is ignored for that key.
	const parsed = parseStructuredReturn(
		"assertions_proven:\n- A1: real note — evidence: npm test\n\nASSERTION A1: FAIL — stale summary\n",
	);
	assert.equal(parsed.assertions_proven[0].evidence, "npm test");
	assert.equal(parsed.assertions_failed.length, 0);
});

test("parseStructuredReturn accepts fenced structured blocks", () => {
	const parsed = parseStructuredReturn(`Summary above.

\`\`\`
changed_files: []
assertions_proven:
- A4: return path written — evidence: .pi/harnesses/agent-hub/index.ts:10
assertions_unproven: []
assertions_failed: []
tests_run: []
open_risks: []
requires_user_decision: []
\`\`\``);

	assert.equal(parsed.assertions_proven[0].id, "A4");
	assert.equal(parsed.assertions_proven[0].evidence, ".pi/harnesses/agent-hub/index.ts:10");
});

test("parseStructuredReturn accepts markdown section lists", () => {
	const parsed = parseStructuredReturn(`# Return

## Assertions Proven
- A7: deliverable protocol documented — evidence: grep result

## Assertions Failed
- A8: missing docs — evidence: file not found

## Tests Run
- node --test → pass`);

	assert.equal(parsed.assertions_proven[0].id, "A7");
	assert.equal(parsed.assertions_failed[0].id, "A8");
	assert.deepEqual(parsed.tests_run, ["node --test → pass"]);
});

test("parseStructuredReturn keeps evidence-less proven entries with null evidence", () => {
	const parsed = parseStructuredReturn("assertions_proven: [A2: claimed done — evidence: ]");

	assert.deepEqual(parsed.assertions_proven[0], { id: "A2", note: "claimed done", evidence: null });
});

test("parseStructuredReturn keeps evidence mentioning another assertion id in the same entry", () => {
	const parsed = parseStructuredReturn("assertions_proven: [A1: checked related behavior — evidence: regression test also mentions A2]");

	assert.equal(parsed.assertions_proven.length, 1);
	assert.equal(parsed.assertions_proven[0].id, "A1");
	assert.equal(parsed.assertions_proven[0].evidence, "regression test also mentions A2");
});

test("parseStructuredReturn splits inline assertion entries only at assertion entry boundaries", () => {
	const parsed = parseStructuredReturn("assertions_proven: [A1: ok — evidence: npm test, A2: ok too — evidence: grep match]");

	assert.deepEqual(parsed.assertions_proven.map(e => e.id), ["A1", "A2"]);
	assert.equal(parsed.assertions_proven[0].evidence, "npm test");
});

test("parseStructuredReturn preserves comma-containing non-assertion list text", () => {
	const parsed = parseStructuredReturn(`changed_files: [src/a.ts:1 — one, two notes]
tests_run: [npm test, with coverage → pass]`);

	assert.deepEqual(parsed.changed_files, ["src/a.ts:1 — one, two notes"]);
	assert.deepEqual(parsed.tests_run, ["npm test, with coverage → pass"]);
});

test("parseStructuredReturn keeps bullet non-assertion entries as line entries", () => {
	const parsed = parseStructuredReturn(`tests_run:
- npm test, with coverage → pass
- node --check index.ts → pass`);

	assert.deepEqual(parsed.tests_run, ["npm test, with coverage → pass", "node --check index.ts → pass"]);
});

test("parseStructuredReturn returns null for prose-only output", () => {
	assert.equal(parseStructuredReturn("Looks good. I checked the thing and it passed."), null);
});

test("crossCheck reports missing dispatched ids", () => {
	const parsed = parseStructuredReturn("assertions_proven: [A1: ok — evidence: npm test]");

	assert.deepEqual(crossCheck(parsed, ["A1", "A2"]), [{ type: "missing", id: "A2" }]);
});

test("crossCheck reports proven entries without evidence", () => {
	const parsed = parseStructuredReturn("assertions_proven: [A1: ok]");

	assert.deepEqual(crossCheck(parsed, ["A1"]), [{ type: "proven_without_evidence", id: "A1", note: "ok" }]);
});

test("crossCheck reports no structured return only when assertions were dispatched", () => {
	assert.deepEqual(crossCheck(null, ["A1", "A2"]), [{ type: "no_structured_return", ids: ["A1", "A2"] }]);
	assert.deepEqual(crossCheck(null, []), []);
});
