import { test } from "node:test";
import assert from "node:assert/strict";

import {
	EXTRACTION_DEADLINE_MS,
	EXTRACTION_MODEL,
	buildExtractionPrompt,
	extractionSessionName,
	shouldExtractReturn,
} from "./return-extract.js";
import { parseStructuredReturn } from "./return-contract.js";

test("shouldExtractReturn fires only when nothing parsed and assertions were tracked", () => {
	assert.equal(shouldExtractReturn(null, ["A1"]), true);
	// A parseable return needs no rescue.
	assert.equal(shouldExtractReturn({ assertions_proven: [] }, ["A1"]), false);
	// Nothing to recover without tracked assertions — raw output already flows through.
	assert.equal(shouldExtractReturn(null, []), false);
	assert.equal(shouldExtractReturn(null, undefined), false);
});

test("buildExtractionPrompt names the file, the ids, and forbids invented evidence", () => {
	const prompt = buildExtractionPrompt({
		returnPath: "/s/artifacts/returns/test-engineer-run3.md",
		assertionIds: ["A1", "A2"],
	});

	assert.match(prompt, /\/s\/artifacts\/returns\/test-engineer-run3\.md/);
	assert.match(prompt, /A1, A2/);
	assert.match(prompt, /Never write evidence of your own/);
	assert.match(prompt, /When in\s+doubt, unproven/);
	// It must not invite a verdict — that is the specialist's job, not the extractor's.
	assert.match(prompt, /You are not reviewing the work/);
});

test("buildExtractionPrompt tolerates a dispatch with no ids", () => {
	const prompt = buildExtractionPrompt({ returnPath: "/s/r.md" });
	assert.match(prompt, /\(none\)/);
});

test("the requested block shape round-trips through the real parser", () => {
	// The prompt is only useful if a compliant answer actually parses.
	const answer = `changed_files: [src/a.ts:12 — added the gate]
assertions_proven: [A1: gate fires — evidence: npm test → 42 passing]
assertions_unproven: [A2: no runtime check performed]
assertions_failed: []
tests_run: [npm test → pass]
open_risks: []
requires_user_decision: []`;

	const parsed = parseStructuredReturn(answer);
	assert.equal(parsed.assertions_proven[0].id, "A1");
	assert.equal(parsed.assertions_proven[0].evidence, "npm test → 42 passing");
	assert.equal(parsed.assertions_unproven[0].id, "A2");
});

test("the extraction pass uses the dedicated cheap model and a per-return session", () => {
	assert.equal(EXTRACTION_MODEL, "openai-codex/gpt-5.6-luna");
	assert.equal(extractionSessionName("/s/artifacts/returns/planner-run1.md"), "return-extract-planner-run1.json");
	assert.equal(extractionSessionName("/s/artifacts/returns/test-engineer-run2.md"), "return-extract-test-engineer-run2.json");
	assert.notEqual(
		extractionSessionName("/s/artifacts/returns/planner-run1.md"),
		extractionSessionName("/s/artifacts/returns/planner-run2.md"),
	);
});

test("the extraction pass is bounded", () => {
	assert.ok(EXTRACTION_DEADLINE_MS > 0);
	assert.ok(EXTRACTION_DEADLINE_MS <= 300_000);
});
