// Tests for the pure Claude-bridge logic (sentinels, prompt framing, hook
// records, reply extraction, serial queue) and the runner: claude-code
// command construction.

import test from "node:test";
import assert from "node:assert/strict";

import {
	completionSentinel,
	extractSentinelReply,
	formatPanePrompt,
	parseHookRecord,
	PromptQueue,
} from "./claude-bridge-core.ts";
import { peerCommand } from "./herdr-layout.ts";

const ENV = {
	prompt: "What is the answer?",
	sender_name: "orchestrator",
	sender_cwd: "/repo",
	msg_id: "01MSGID",
};

test("formatPanePrompt frames the sender; sentinel mode appends the marker request", () => {
	const plain = formatPanePrompt(ENV, false);
	assert.match(plain, /^\[coms message from orchestrator @ \/repo\] What is the answer\?$/);
	const sentinel = formatPanePrompt(ENV, true);
	assert.match(sentinel, /<<COMS_DONE:01MSGID>>/);
});

test("parseHookRecord accepts {text}, rejects garbage", () => {
	assert.deepEqual(parseHookRecord('{"text":"hi","written_at":"t"}'), { text: "hi", written_at: "t" });
	assert.equal(parseHookRecord("{"), null);
	assert.equal(parseHookRecord('{"no_text":1}'), null);
});

test("extractSentinelReply pulls the reply between prompt echo and sentinel", () => {
	const pane = [
		"❯ [coms message from orchestrator @ /repo] What is the answer?",
		`End your reply with this exact line so the bridge can capture it: ${completionSentinel("01MSGID")}`,
		"● The answer is 42.",
		"It always was.",
		completionSentinel("01MSGID"),
		"❯",
	].join("\n");
	assert.equal(extractSentinelReply(pane, "01MSGID"), "The answer is 42.\nIt always was.");
	// sentinel absent → null (keep waiting)
	assert.equal(extractSentinelReply("nothing here", "01MSGID"), null);
	// TUI rules stripped
	const framed = `x: ${completionSentinel("01MSGID")}\n━━━━━━\n● reply line\n━━━━━━\n${completionSentinel("01MSGID")}`;
	assert.equal(extractSentinelReply(framed, "01MSGID"), "reply line");
});

test("PromptQueue serializes strictly and reports depth", () => {
	const q = new PromptQueue<string>();
	assert.equal(q.depth, 0);
	q.push("a");
	q.push("b");
	assert.equal(q.depth, 2);
	const first = q.take();
	assert.equal(first?.envelope, "a");
	assert.equal(q.depth, 2); // 1 active + 1 waiting
	assert.equal(q.take(), null); // strictly serial
	q.done();
	assert.equal(q.take()?.envelope, "b");
	q.done();
	assert.equal(q.take(), null);
	assert.equal(q.depth, 0);
});

test("runner: claude-code peers build a _claude-peer command; misuse rejected", () => {
	assert.deepEqual(
		peerCommand({ name: "claude-main", runner: "claude-code", model: "opus" }, "t"),
		["just", "_claude-peer", "claude-main", "opus"],
	);
	assert.deepEqual(
		peerCommand({ name: "claude-main", runner: "claude-code", model: "opus" }, "t", undefined, "acme"),
		["just", "_claude-peer", "claude-main", "opus", "", "acme"],
	);
	// no persona required; resume ref (claude session id) fills the session slot
	assert.deepEqual(
		peerCommand({ name: "c", runner: "claude-code" }, "t", "b7cd33df-412f"),
		["just", "_claude-peer", "c", "", "b7cd33df-412f"],
	);
	assert.deepEqual(
		peerCommand({ name: "c", runner: "claude-code" }, "t", "b7cd33df-412f", "acme"),
		["just", "_claude-peer", "c", "", "b7cd33df-412f", "acme"],
	);
	assert.throws(() => peerCommand({ name: "x", runner: "cursor" }, "t"), /Unknown runner/);
	assert.throws(
		() => peerCommand({ name: "x", runner: "claude-code", extensions: "chrome-devtools-mcp" }, "t"),
		/pi-only/,
	);
	// pi peers still demand a persona
	assert.throws(() => peerCommand({ name: "x" }, "t"), /missing a persona/);
});
