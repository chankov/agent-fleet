import test from "node:test";
import assert from "node:assert/strict";

import {
	PEER_READY_BACKOFF_MS,
	PEER_READY_TIMEOUT_MS,
	peerReadyDelayMs,
	peerReadyVerdict,
	unaddressedPeerSweep,
} from "./spawned-peers.js";

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

test("an unregistered peer reports booting with the wait named", () => {
	const v = peerReadyVerdict({ name: "slow-peer", paneId: "w1:p9", found: false, waitedMs: PEER_READY_TIMEOUT_MS });
	assert.equal(v.peer_ready, false);
	assert.match(v.message, /still booting/);
	assert.match(v.message, new RegExp(String(Math.round(PEER_READY_TIMEOUT_MS / 1000))));
	assert.match(v.message, /coms_list/);
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
