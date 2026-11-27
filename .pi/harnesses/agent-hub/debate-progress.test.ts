import assert from "node:assert/strict";
import test from "node:test";
import { debateFixture } from "./fixtures/debate-result.ts";
import { applyDebateEvent, debateBlockHeadline, failedDebateBlock, initialDebateBlock, renderDebateBlock, type DebateBlock, type DebateEvent } from "./debate-progress.ts";

const accepted: DebateEvent = {
	type: "accepted", panel: "default", source: "configured", persona: "researcher", worktree: "/repo", rounds: 3,
	voices: [{ name: "sol", model: "a/sol" }, { name: "grok", model: "b/grok" }, { name: "opus", model: "c/opus" }],
};

function replay(...events: DebateEvent[]): DebateBlock {
	return events.reduce(applyDebateEvent, initialDebateBlock("Extract the parser now?"));
}

test("before resolution the block names no panel; a failure there is one line", () => {
	assert.equal(debateBlockHeadline(initialDebateBlock("q")), "◌ Debate · resolving panel…");
	const failed = failedDebateBlock("q", "Unknown panel \"typo\". Available panels: default.");
	assert.deepEqual(renderDebateBlock(failed, { expanded: true }), ["✗ Debate failed", "  Unknown panel \"typo\". Available panels: default."]);
});

test("rows stay stable while voices finish out of order; a failed voice is out of later rounds", () => {
	const round1 = replay(accepted, { type: "round", round: 1, voices: ["sol", "grok", "opus"] },
		{ type: "voice", turn: { name: "opus", model: "c/opus", round: 1, ok: true, position: "Behind a flag." } });
	assert.deepEqual(round1.voices.map(voice => [voice.name, voice.state]), [["sol", "running"], ["grok", "running"], ["opus", "ok"]]);
	assert.equal(debateBlockHeadline(round1), "● Debate · panel default · round 1/3 · 1/3 voices");

	const round2 = [
		{ type: "voice", turn: { name: "grok", model: "b/grok", round: 1, ok: false, reason: "timeout" } },
		{ type: "voice", turn: { name: "sol", model: "a/sol", round: 1, ok: true, position: "Now." } },
		{ type: "round", round: 2, voices: ["sol", "opus"] },
		{ type: "voice", turn: { name: "sol", model: "a/sol", round: 2, ok: true, position: "After the release.", changed: true } },
	].reduce((block, event) => applyDebateEvent(block, event as DebateEvent), round1);
	assert.deepEqual(round2.voices.map(voice => [voice.name, voice.state, voice.round]), [["sol", "ok", 2], ["grok", "out", 1], ["opus", "running", 2]]);
	assert.equal(debateBlockHeadline(round2), "● Debate · panel default · round 2/3 · 1/2 voices", "the dropped voice is not counted");
	const lines = renderDebateBlock(round2, { expanded: false });
	assert.equal(lines.length, 4);
	assert.match(lines[1], /✓ sol · r2 · changed · After the release\./);
	assert.match(lines[2], /✗ grok · failed in r1: timeout/);
	assert.match(lines[3], /○ opus · r2 · running…/);
});

test("the finished block ignores late events, and expansion adds the question, selection and evidence", () => {
	const done = replay(accepted, { type: "succeeded", result: debateFixture() });
	assert.equal(applyDebateEvent(done, { type: "voice", turn: { name: "sol", model: "a/sol", round: 4, ok: false, reason: "late" } }), done);
	const expanded = renderDebateBlock(done, { expanded: true }).join("\n");
	assert.match(expanded, /question: Extract the parser now\?/);
	assert.match(expanded, /persona researcher · panel default \(configured\) · 3 rounds/);
	assert.match(expanded, /worktree \/repo/);
	assert.match(expanded, /aligned with: opus/);
	assert.match(expanded, /open disagreements:\n      opus: sol's plan skips the flag/);
	assert.match(expanded, /full debate: polls\/r\/debate\//);
	assert.ok(renderDebateBlock(done, { expanded: false }).length < expanded.split("\n").length);
});

test("a failure while running stops the voices that had not finished", () => {
	const failed = replay(accepted, { type: "round", round: 1, voices: ["sol", "grok", "opus"] },
		{ type: "voice", turn: { name: "sol", model: "a/sol", round: 1, ok: true, position: "Now." } },
		{ type: "failed", reason: "Debate failed: 1 of 3 voices succeeded in round 1", directory: "polls/r/debate/" });
	assert.deepEqual(failed.voices.map(voice => voice.state), ["ok", "stopped", "stopped"]);
	assert.equal(debateBlockHeadline(failed), "✗ Debate failed · panel default · round 1/3");
});
