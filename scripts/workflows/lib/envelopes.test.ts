import assert from "node:assert/strict";
import test from "node:test";
import { ENVELOPE_EXAMPLES, correctionPrompt, parseWithCorrections, validateEnvelope } from "./envelopes.ts";

test("TypeBox envelopes accept exact valid Report JSON", () => {
	for (const [name, example] of Object.entries(ENVELOPE_EXAMPLES)) {
		const result = validateEnvelope(name as keyof typeof ENVELOPE_EXAMPLES, `\`\`\`json\n${JSON.stringify(example)}\n\`\`\``);
		assert.equal(result.ok, true, `${name}: ${result.errors.join(", ")}`);
	}
});

test("hub-first parsing selects an exact Report JSON object", () => {
	const wrapped = validateEnvelope("scout", `Here is the report:\n\`\`\`json\n${JSON.stringify(ENVELOPE_EXAMPLES.scout)}\n\`\`\`\nDone.`);
	assert.equal(wrapped.ok, true, wrapped.errors.join("; "));
	const last = validateEnvelope("scout", `unfinished prose {\n${JSON.stringify({ ignored: true })}\n${JSON.stringify(ENVELOPE_EXAMPLES.scout)}`);
	assert.equal(last.ok, true, last.errors.join("; "));
	const nested = validateEnvelope("scout", JSON.stringify({ ...ENVELOPE_EXAMPLES.scout, findings: [JSON.stringify({ path: "src/x.ts" })] }));
	assert.equal(nested.ok, true, nested.errors.join("; "));
});

test("hub markdown is still rejected by the exact TypeBox plan contract", () => {
	const markdown = validateEnvelope("plan", "changed_files: [docs/plan.md]\ntests_run: npm test passed");
	assert.equal(markdown.ok, false);
	assert.ok(markdown.errors.some(error => error === "missing required field: status"));
	assert.ok(markdown.errors.some(error => error === "missing required field: commit_message"));
	assert.match(markdown.errors.join("; "), /changed_files: unexpected field for plan envelope/);
});

test("envelopes reject missing, extra, partial, and self-failed reports", () => {
	const missing = validateEnvelope("build", JSON.stringify({ status: "success", summary: "x", artifacts: [], notes_for_next_agent: "", commit_message: "x" }));
	assert.equal(missing.ok, false);
	assert.ok(missing.errors.some(error => error.includes("changed_files")));
	const extra = validateEnvelope("scout", JSON.stringify({ ...ENVELOPE_EXAMPLES.scout, approved: true }));
	assert.equal(extra.ok, false);
	assert.match(extra.errors.join("; "), /approved: unexpected field/);
	const pollExtra = validateEnvelope("poll", JSON.stringify({ ...ENVELOPE_EXAMPLES.poll, judge: true }));
	assert.equal(pollExtra.ok, false);
	assert.match(pollExtra.errors.join("; "), /judge: unexpected field for poll envelope/);
	const pollMissing = validateEnvelope("poll", JSON.stringify({ status: "success", summary: "x", artifacts: [], notes_for_next_agent: "", position: "A", case: [], confidence: "high" }));
	assert.equal(pollMissing.ok, false, "would_change_my_mind must not be defaulted");
	assert.ok(pollMissing.errors.some(error => error.includes("would_change_my_mind")));
	const mergeMissingVoice = validateEnvelope("merge", JSON.stringify({ ...ENVELOPE_EXAMPLES.merge, consensus: [{ statement: "A" }] }));
	assert.equal(mergeMissingVoice.ok, false);
	const partial = validateEnvelope("scout", JSON.stringify({ status: "success", findings: [] }));
	assert.equal(partial.ok, false, "missing envelope fields must not be synthesized");
	assert.doesNotMatch(partial.errors.join("; "), /assertions_proven|tests_run|response: Expected all values/);
	const hubDefaults = validateEnvelope("review", "changed_files: []");
	assert.equal(hubDefaults.ok, false, "empty arrays synthesized by the hub parser must not satisfy required review fields");
	assert.ok(hubDefaults.errors.some(error => error === "missing required field: assertions_proven"));
	const failed = validateEnvelope("scout", JSON.stringify({ ...ENVELOPE_EXAMPLES.scout, status: "fail", summary: "could not search" }));
	assert.equal(failed.ok, false);
	assert.match(failed.errors[0], /agent declared fail.*could not search/);
});

test("correction names exact invalid fields and resumes at most twice", async () => {
	const prompts: string[] = [];
	const result = await parseWithCorrections("build", JSON.stringify({ status: "success", summary: "x", commit_message: "x" }), async prompt => {
		prompts.push(prompt);
		return JSON.stringify(ENVELOPE_EXAMPLES.build);
	});
	assert.deepEqual(result, ENVELOPE_EXAMPLES.build);
	assert.equal(prompts.length, 1);
	assert.match(prompts[0], /changed_files/);
	assert.equal(correctionPrompt(["missing required field: changed_files"]).includes("missing required field: changed_files"), true);

	let corrections = 0;
	await assert.rejects(parseWithCorrections("scout", "not json", async () => { corrections++; return "still not json"; }), /invalid after 3 attempts/);
	assert.equal(corrections, 2);
});

test("declared status fail is terminal and is not corrected", async () => {
	let corrections = 0;
	await assert.rejects(parseWithCorrections("scout", JSON.stringify({ ...ENVELOPE_EXAMPLES.scout, status: "fail" }), async () => { corrections++; return ""; }), /agent declared fail/);
	assert.equal(corrections, 0);
});
