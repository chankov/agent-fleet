// Tests for the pure Claude-bridge logic (sentinels, prompt framing, hook
// records, reply extraction, serial queue) and the runner: claude-code
// command construction.

import test from "node:test";
import assert from "node:assert/strict";

import {
	completionSentinel,
	extractSentinelReply,
	formatPanePrompt,
	IDLE_WAIT_BACKOFF_MS,
	IDLE_WAIT_CAP_MS,
	idleWaitBudgetMs,
	idleWaitDelayMs,
	parseHookRecord,
	PromptQueue,
	REPLY_TIMEOUT_HARD_CAP_MS,
	ReplyPendingError,
	isReplyPendingError,
	replyDeadlineAt,
	resolveReplyTimeoutMs,
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

test("resolveReplyTimeoutMs lets the caller's deadline win, clamped to the hard cap", () => {
	// The field failure: caller asked 1_800_000, bridge default was 600_000, and the
	// caller was failed at the bridge's number.
	assert.equal(resolveReplyTimeoutMs(1_800_000, 600_000), 1_800_000);
	// A caller may also ask for less than the bridge default.
	assert.equal(resolveReplyTimeoutMs(60_000, 600_000), 60_000);
	// No request → the bridge's configured value.
	assert.equal(resolveReplyTimeoutMs(null, 600_000), 600_000);
	assert.equal(resolveReplyTimeoutMs(undefined, 600_000), 600_000);
	// Junk and non-positive values fall back rather than producing an instant timeout.
	assert.equal(resolveReplyTimeoutMs("soon", 600_000), 600_000);
	assert.equal(resolveReplyTimeoutMs(0, 600_000), 600_000);
	assert.equal(resolveReplyTimeoutMs(-5, 600_000), 600_000);
	// Nobody holds a pane forever.
	assert.equal(resolveReplyTimeoutMs(99_999_999, 600_000), REPLY_TIMEOUT_HARD_CAP_MS);
	assert.equal(resolveReplyTimeoutMs(null, 99_999_999), REPLY_TIMEOUT_HARD_CAP_MS);
});

test("one absolute reply deadline includes the idle wait", () => {
	assert.equal(replyDeadlineAt(1_000, 60_000), 61_000);
	assert.equal(replyDeadlineAt(1_000, -1), 1_000);
});

test("reply deadline exhaustion is a pending outcome, not an error response", () => {
	const pending = new ReplyPendingError("still running");
	assert.equal(isReplyPendingError(pending), true);
	assert.equal(isReplyPendingError(new Error("permission denied")), false);
});

test("idle-wait backoff climbs and then holds", () => {
	assert.equal(idleWaitDelayMs(0), IDLE_WAIT_BACKOFF_MS[0]);
	assert.equal(idleWaitDelayMs(1), IDLE_WAIT_BACKOFF_MS[1]);
	// Past the last step the delay holds instead of growing without bound.
	const last = IDLE_WAIT_BACKOFF_MS[IDLE_WAIT_BACKOFF_MS.length - 1];
	assert.equal(idleWaitDelayMs(IDLE_WAIT_BACKOFF_MS.length), last);
	assert.equal(idleWaitDelayMs(999), last);
	// Defensive against a negative attempt counter.
	assert.equal(idleWaitDelayMs(-1), IDLE_WAIT_BACKOFF_MS[0]);
	// Strictly increasing until the plateau, so retries actually back off.
	for (let i = 1; i < IDLE_WAIT_BACKOFF_MS.length; i++) {
		assert.ok(IDLE_WAIT_BACKOFF_MS[i] > IDLE_WAIT_BACKOFF_MS[i - 1]);
	}
});

test("idle-wait budget never eats more than half the reply budget", () => {
	assert.equal(idleWaitBudgetMs(60_000), 30_000);
	// Capped, so a 30-minute request does not spend 15 minutes waiting to start.
	assert.equal(idleWaitBudgetMs(1_800_000), IDLE_WAIT_CAP_MS);
	// A zero/absent budget preserves the old fail-fast behaviour.
	assert.equal(idleWaitBudgetMs(0), 0);
	assert.equal(idleWaitBudgetMs(-1), 0);
	assert.equal(idleWaitBudgetMs(NaN), 0);
});
