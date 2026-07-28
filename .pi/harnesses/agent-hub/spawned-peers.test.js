import test from "node:test";
import assert from "node:assert/strict";

import {
	PEER_READY_BACKOFF_MS,
	PEER_READY_TIMEOUT_MS,
	launchPeerInPane,
	looksLikeShellPrompt,
	paneLaunchLine,
	peerReadyDelayMs,
	peerReadyVerdict,
	spawnStaggerSeconds,
	unaddressedPeerSweep,
} from "./spawned-peers.js";

/** herdr client double recording the exact call sequence a launch makes. */
function fakePane(reads) {
	const calls = [];
	const queue = [...reads];
	return {
		calls,
		paneRead: async ({ pane_id, lines }) => {
			calls.push(["read", pane_id, lines]);
			const next = queue.length > 1 ? queue.shift() : queue[0];
			if (next instanceof Error) throw next;
			return { read: { pane_id, text: next ?? "" } };
		},
		paneSendText: async (paneId, text) => {
			calls.push(["text", paneId, text]);
		},
		paneSendKeys: async (paneId, keys) => {
			calls.push(["keys", paneId, keys]);
		},
	};
}

test("readiness backoff climbs and then repeats its last step", () => {
	assert.equal(peerReadyDelayMs(0), PEER_READY_BACKOFF_MS[0]);
	assert.equal(peerReadyDelayMs(2), PEER_READY_BACKOFF_MS[2]);
	const last = PEER_READY_BACKOFF_MS[PEER_READY_BACKOFF_MS.length - 1];
	assert.equal(peerReadyDelayMs(PEER_READY_BACKOFF_MS.length), last);
	assert.equal(peerReadyDelayMs(999), last);
	assert.equal(peerReadyDelayMs(-3), PEER_READY_BACKOFF_MS[0]);
	assert.equal(peerReadyDelayMs(undefined), PEER_READY_BACKOFF_MS[0]);
});

test("a registered peer reports ready with its coms name", () => {
	const v = peerReadyVerdict({ name: "repair-builder", paneId: "w3:p2", found: true, waitedMs: 4200 });
	assert.equal(v.peer_ready, true);
	assert.equal(v.peer_name, "repair-builder");
	assert.equal(v.pane_id, "w3:p2");
	assert.equal(v.waited_ms, 4200);
	assert.match(v.message, /coms_send/);
	assert.match(v.message, /repair-builder/);
	// The spawn itself delivers no work — say so at the spawn, not in a post-mortem.
	assert.match(v.message, /boots idle/);
});

test("an unregistered peer is reported as failed to start, not slow", () => {
	const v = peerReadyVerdict({ name: "slow-peer", paneId: "w1:p9", found: false, waitedMs: PEER_READY_TIMEOUT_MS });
	assert.equal(v.peer_ready, false);
	assert.match(v.message, /failed to start/);
	assert.match(v.message, /Do not coms_send/);
	assert.match(v.message, new RegExp(String(Math.round(PEER_READY_TIMEOUT_MS / 1000))));
	assert.match(v.message, /coms_list/);
	assert.equal(v.pane_tail, null);
});

test("a failed spawn carries the pane's last output as evidence", () => {
	const v = peerReadyVerdict({
		name: "dead-peer",
		paneId: "w1:p9",
		found: false,
		waitedMs: 1000,
		paneTail: "  error: Recipe `_peer` could not be run\n",
	});
	assert.equal(v.pane_tail, "error: Recipe `_peer` could not be run");
	assert.match(v.message, /Last output of pane w1:p9/);
	assert.match(v.message, /could not be run/);
});

test("a ready peer carries no pane tail", () => {
	const v = peerReadyVerdict({ name: "ok", paneId: "w1:p1", found: true, waitedMs: 10, paneTail: "noise" });
	assert.equal(v.pane_tail, undefined);
	assert.doesNotMatch(v.message, /noise/);
});

// pane.split cannot launch a command, so the argv is typed into the pane's
// shell — quoting is what keeps that equivalent to an exec.
test("a launch line quotes empty positionals and shell metacharacters", () => {
	assert.equal(
		paneLaunchLine(["just", "_peer", "builder", "plan32-builder"]),
		"just _peer builder plan32-builder\n",
	);
	// The recipes use empty positionals to keep later ones aligned; unquoted
	// they would vanish and shift --project into the model slot.
	assert.equal(
		paneLaunchLine(["just", "_peer", "builder", "b", "", "", "rin-prd"]),
		"just _peer builder b '' '' rin-prd\n",
	);
	assert.equal(
		paneLaunchLine(["bash", "-lc", "echo hi && ls"]),
		"bash -lc 'echo hi && ls'\n",
	);
	assert.equal(paneLaunchLine(["echo", "it's"]), "echo 'it'\\''s'\n");
	assert.throws(() => paneLaunchLine([]), /empty argv/);
	assert.throws(() => paneLaunchLine(undefined), /empty argv/);
});

test("a shell prompt is recognized at the end of a pane read", () => {
	assert.equal(looksLikeShellPrompt("nchankov@Desktop-CM:/repos/ringithub$ "), true);
	assert.equal(looksLikeShellPrompt("boot noise\n\n~/repo ❯ \n\n"), true);
	assert.equal(looksLikeShellPrompt("root@box:/# "), true);
	assert.equal(looksLikeShellPrompt("Loading extensions…"), false);
	assert.equal(looksLikeShellPrompt(""), false);
	assert.equal(looksLikeShellPrompt("   \n  \n"), false);
	assert.equal(looksLikeShellPrompt(undefined), false);
});

test("a launch waits for the prompt, then sends the line and Enter separately", async () => {
	const client = fakePane(["booting…", "user@box:/repo$ "]);
	const result = await launchPeerInPane(client, "w2:p3", ["just", "_peer", "builder", "b", "", "", "rin"], {
		pollMs: 0,
		timeoutMs: 5_000,
	});
	assert.equal(result.promptSeen, true);
	assert.deepEqual(client.calls, [
		["read", "w2:p3", 5],
		["read", "w2:p3", 5],
		// No trailing newline in the text: bracketed paste would swallow it.
		["text", "w2:p3", "just _peer builder b '' '' rin"],
		["keys", "w2:p3", ["enter"]],
	]);
});

test("a pane that never prompts still gets the command, with promptSeen false", async () => {
	let clock = 0;
	const client = fakePane(["Loading…"]);
	const result = await launchPeerInPane(client, "w2:p4", ["just", "_peer", "builder", "b"], {
		pollMs: 0,
		timeoutMs: 1_000,
		now: () => (clock += 400),
		sleep: async () => {},
	});
	assert.equal(result.promptSeen, false);
	assert.equal(result.waitedMs > 0, true);
	assert.deepEqual(client.calls.filter(c => c[0] !== "read"), [
		["text", "w2:p4", "just _peer builder b"],
		["keys", "w2:p4", ["enter"]],
	]);
});

test("an unreadable pane does not abort the launch", async () => {
	const client = fakePane([new Error("pane_not_found"), "user@box:/repo$ "]);
	const result = await launchPeerInPane(client, "w2:p5", ["echo", "hi"], { pollMs: 0, timeoutMs: 5_000 });
	assert.equal(result.promptSeen, true);
	assert.deepEqual(client.calls.at(-2), ["text", "w2:p5", "echo hi"]);
});

test("only a spawn inside the warm-up window of another one waits", () => {
	const opts = { needed: true, warmupSeconds: 4 };
	// Nothing spawned yet: this peer is the warmer and starts immediately.
	assert.equal(spawnStaggerSeconds({ ...opts, lastSpawnAt: null, now: 1_000_000 }), 0);
	// A sibling launched 1s ago may still be holding the auth lock.
	assert.equal(spawnStaggerSeconds({ ...opts, lastSpawnAt: 1_000_000, now: 1_001_000 }), 4);
	// Past the window the warmer has landed a fresh token.
	assert.equal(spawnStaggerSeconds({ ...opts, lastSpawnAt: 1_000_000, now: 1_004_000 }), 0);
	// Fresh credentials never stagger.
	assert.equal(spawnStaggerSeconds({ needed: false, warmupSeconds: 4, lastSpawnAt: 1_000_000, now: 1_001_000 }), 0);
});

test("the sweep is silent when every spawned peer got work", () => {
	assert.equal(unaddressedPeerSweep([]), null);
	assert.equal(unaddressedPeerSweep(undefined), null);
	assert.equal(
		unaddressedPeerSweep([{ name: "code-reviewer", paneId: "w1:p2", addressed: true }]),
		null,
	);
});

test("the sweep names every peer that was never sent to", () => {
	const report = unaddressedPeerSweep([
		{ name: "code-reviewer", paneId: "w1:p2", addressed: true },
		{ name: "repair-builder", paneId: "w3:p2", addressed: false },
		{ name: "final-test-worker", paneId: "w3:p3", addressed: false },
	]);
	assert.equal(report.count, 2);
	assert.deepEqual(report.peers, [
		{ name: "repair-builder", pane_id: "w3:p2" },
		{ name: "final-test-worker", pane_id: "w3:p3" },
	]);
	assert.match(report.message, /repair-builder/);
	assert.match(report.message, /final-test-worker/);
	assert.doesNotMatch(report.message, /code-reviewer/);
	// Suggests, never closes: herdr_close_pane keeps its human confirmation.
	assert.match(report.message, /herdr_close_pane/);
	assert.match(report.message, /confirmation/);
});

test("a peer with no pane id still appears in the sweep", () => {
	const report = unaddressedPeerSweep([{ name: "ghost", addressed: false }]);
	assert.equal(report.count, 1);
	assert.deepEqual(report.peers, [{ name: "ghost", pane_id: null }]);
	assert.match(report.message, /ghost \(pane \?\)/);
});
