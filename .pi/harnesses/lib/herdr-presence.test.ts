// Tests for the herdr presence backend against a mock server speaking the
// observed wire dialect (one request per connection; long-lived subscribe
// streams). The mock defaults to the herdr >= 0.7.4 schema, where
// `custom_status` was REMOVED from pane.report_metadata — set
// `mock.dialect = "custom_status"` to get a 0.7.3 server back.

import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import {
	CUSTOM_STATUS_MAX,
	formatPeerStatus,
	HerdrAgentWatch,
	HerdrPresence,
	herdrPaneId,
	herdrPresenceAvailable,
	parsePeerName,
	peerNameFrom,
	peerProjectFrom,
	peerTokens,
	type AnnotationDialect,
	type HerdrAgentInfo,
} from "./herdr-presence.ts";

interface MockState {
	agents: Array<Record<string, unknown>>;
	reports: Array<Record<string, unknown>>;
	streams: net.Socket[];
	// Which annotation field pane.report_metadata accepts. The real 0.7.4
	// rejects the whole request when the other one is sent.
	dialect: AnnotationDialect;
	// Total events.subscribe requests ever received — churn detector: a
	// healthy watcher opens ONE stream and keeps it.
	subscribes: number;
	emit(event: string, data: Record<string, unknown>): void;
}

function mockServer(): MockState & { socketPath: string; close: () => Promise<void> } {
	const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "herdr-presence-")), "herdr.sock");
	const state: MockState = {
		agents: [],
		reports: [],
		streams: [],
		dialect: "tokens",
		subscribes: 0,
		emit(event, data) {
			for (const s of state.streams) {
				try {
					s.write(JSON.stringify({ event, data }) + "\n");
				} catch {
					// closed
				}
			}
		},
	};
	const server = net.createServer((sock) => {
		let buf = "";
		sock.on("error", () => {});
		sock.on("close", () => {
			const i = state.streams.indexOf(sock);
			if (i >= 0) state.streams.splice(i, 1);
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				const msg = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
				switch (msg.method) {
					case "ping":
						sock.end(JSON.stringify({ id: msg.id, result: { type: "pong", version: "0.7.1", protocol: 14 } }) + "\n");
						break;
					case "agent.list":
						sock.end(JSON.stringify({ id: msg.id, result: { type: "agent_list", agents: state.agents } }) + "\n");
						break;
					case "pane.report_agent": {
						// 0.7.4 has no custom_status here either; it is dropped
						// rather than rejected, which is why this call kept
						// succeeding while the annotation silently vanished.
						const p = { ...msg.params };
						delete p.custom_status;
						state.reports.push(p);
						sock.end(JSON.stringify({ id: msg.id, result: { type: "ok" } }) + "\n");
						break;
					}
					case "pane.report_metadata": {
						const p = { ...msg.params, metadata: true };
						const sent: AnnotationDialect = p.tokens !== undefined ? "tokens" : "custom_status";
						if (sent !== state.dialect) {
							sock.end(
								JSON.stringify({
									id: msg.id,
									error: { code: "invalid_request", message: `unknown field: ${sent}` },
								}) + "\n",
							);
							break;
						}
						// mimic the server-side 32-char cap of the legacy field
						if (typeof p.custom_status === "string") p.custom_status = p.custom_status.slice(0, 32);
						state.reports.push(p);
						sock.end(JSON.stringify({ id: msg.id, result: { type: "ok" } }) + "\n");
						break;
					}
					case "pane.release_agent":
						state.reports.push({ released: true, ...msg.params });
						sock.end(JSON.stringify({ id: msg.id, result: { type: "ok" } }) + "\n");
						break;
					case "events.subscribe":
						state.subscribes++;
						state.streams.push(sock);
						sock.write(JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n");
						break;
					default:
						sock.end(JSON.stringify({ id: "", error: { code: "invalid_request", message: `unknown ${msg.method}` } }) + "\n");
				}
			}
		});
	});
	server.listen(socketPath);
	return Object.assign(state, {
		socketPath,
		close: () => new Promise<void>((res) => server.close(() => res())),
	});
}

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

test("herdrPaneId requires HERDR_ENV=1 and a pane id", () => {
	assert.equal(herdrPaneId({}), null);
	assert.equal(herdrPaneId({ HERDR_ENV: "1" }), null);
	assert.equal(herdrPaneId({ HERDR_PANE_ID: "w1:p1" }), null);
	assert.equal(herdrPaneId({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), "w1:p1");
});

test("herdrPresenceAvailable needs both the pane env and a live server", async () => {
	const mock = mockServer();
	const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
	assert.equal(await herdrPresenceAvailable({ socketPath: mock.socketPath }, env), true);
	assert.equal(await herdrPresenceAvailable({ socketPath: mock.socketPath }, {}), false);
	await mock.close();
	assert.equal(await herdrPresenceAvailable({ socketPath: mock.socketPath, timeoutMs: 200 }, env), false);
});

test("formatPeerStatus stays within the 32-char cap; parsePeerName inverts it", () => {
	assert.equal(formatPeerStatus("documenter", 42.4, 0), "documenter 42% q0");
	assert.equal(parsePeerName("documenter 42% q0"), "documenter");
	const long = formatPeerStatus("a-very-long-peer-name-indeed-yes", 100, 12);
	assert.equal(long.length, CUSTOM_STATUS_MAX);
	// a truncated tail (`q` cut before its digits) still recovers the name
	assert.equal(parsePeerName("web-debugger 100% q"), "web-debugger");
	assert.equal(parsePeerName(""), null);
	assert.equal(parsePeerName(undefined), null);
});

test("peerTokens carries the project and never truncates the name", () => {
	const tokens = peerTokens({
		name: "a-very-long-peer-name-indeed-yes-and-then-some",
		project: "test-project",
		contextUsedPct: 42.4,
		queueDepth: 3,
	});
	assert.deepEqual(tokens, {
		coms: "a-very-long-peer-name-indeed-yes-and-then-some",
		proj: "test-project",
		ctx: "42%",
		q: "q3",
	});
	// Every key must satisfy herdr's token-name pattern, or the request fails.
	for (const key of Object.keys(tokens)) assert.match(key, /^[A-Za-z0-9_-]{1,32}$/);
	// No project: the key is absent, not empty — "unscoped" is a real answer.
	assert.equal("proj" in peerTokens({ name: "solo", contextUsedPct: 0, queueDepth: 0 }), false);
});

test("peerNameFrom/peerProjectFrom read both dialects, tokens first", () => {
	assert.equal(peerNameFrom({ pane_id: "w1:p1", tokens: { coms: "orchestrator", proj: "af" } }), "orchestrator");
	assert.equal(peerProjectFrom({ pane_id: "w1:p1", tokens: { coms: "orchestrator", proj: "af" } }), "af");
	// legacy pane: name recovered, project genuinely unknown
	assert.equal(peerNameFrom({ pane_id: "w1:p1", custom_status: "reviewer 3% q1" }), "reviewer");
	assert.equal(peerProjectFrom({ pane_id: "w1:p1", custom_status: "reviewer 3% q1" }), null);
	// `agent rename` is a human label, so it loses to both peer annotations
	assert.equal(peerNameFrom({ pane_id: "w1:p1", name: "scratch", tokens: { coms: "builder" } }), "builder");
	assert.equal(peerNameFrom({ pane_id: "w1:p1", name: "scratch" }), "scratch");
	// an unannotated pane is not a coms peer
	assert.equal(peerNameFrom({ pane_id: "w1:p1" }), null);
	assert.equal(peerNameFrom(null), null);
});

test("HerdrPresence reports agent state + metadata tokens and releases", async () => {
	const mock = mockServer();
	const presence = new HerdrPresence({
		paneId: "w1:p1",
		source: "coms:SESSION1",
		socketPath: mock.socketPath,
	});
	const peer = { name: "documenter", project: "af", contextUsedPct: 12, queueDepth: 0 };
	assert.equal(await presence.report("working", peer), true);
	await presence.release();
	// one report() = report_agent (state, for undetected panes) +
	// report_metadata (the peer annotation, for detection-owned panes)
	assert.equal(mock.reports.length, 3);
	assert.equal(mock.reports[0].pane_id, "w1:p1");
	assert.equal(mock.reports[0].source, "coms:SESSION1");
	assert.equal(mock.reports[0].agent, "pi");
	assert.equal(mock.reports[0].state, "working");
	assert.equal(mock.reports[1].metadata, true);
	assert.deepEqual(mock.reports[1].tokens, { coms: "documenter", proj: "af", ctx: "12%", q: "q0" });
	assert.equal(typeof mock.reports[1].ttl_ms, "number");
	assert.equal(mock.reports[2].released, true);
	assert.equal(presence.acceptedDialect(), "tokens");
	await mock.close();
});

test("HerdrPresence falls back to custom_status on an older herdr, once", async () => {
	const mock = mockServer();
	mock.dialect = "custom_status";
	const errors: AnnotationDialect[] = [];
	const presence = new HerdrPresence({
		paneId: "w1:p1",
		source: "coms:S",
		socketPath: mock.socketPath,
		onError: (_err, dialect) => errors.push(dialect),
	});
	const peer = { name: "documenter", project: "af", contextUsedPct: 12, queueDepth: 0 };

	assert.equal(await presence.report("idle", peer), true);
	assert.equal(presence.acceptedDialect(), "custom_status");
	// The rejected dialect is surfaced exactly once, not swallowed.
	assert.deepEqual(errors, ["tokens"]);
	const first = mock.reports.filter((r) => r.metadata);
	assert.equal(first.length, 1);
	assert.equal(first[0].custom_status, "documenter 12% q0");

	// Second report must not re-probe: one request on the wire, no new error.
	mock.reports.length = 0;
	assert.equal(await presence.report("working", peer), true);
	assert.equal(mock.reports.filter((r) => r.metadata).length, 1);
	assert.deepEqual(errors, ["tokens"]);
	await mock.close();
});

test("HerdrPresence.annotate writes the peer identity and claims no state", async () => {
	const mock = mockServer();
	const presence = new HerdrPresence({
		paneId: "w29:p3",
		source: "coms-bridge:SESSION1",
		agentLabel: "claude",
		socketPath: mock.socketPath,
	});
	const peer = { name: "plan-reviewer", project: "test-project", contextUsedPct: 0, queueDepth: 2 };

	assert.equal(await presence.annotate(peer), true);
	// The whole point for the Claude bridge: NO pane.report_agent, because it
	// polls that same agent_status back to decide a turn is over.
	assert.equal(mock.reports.length, 1);
	assert.equal(mock.reports[0].metadata, true);
	assert.equal(mock.reports[0].agent, "claude");
	assert.deepEqual(mock.reports[0].tokens, { coms: "plan-reviewer", proj: "test-project", ctx: "0%", q: "q2" });
	await mock.close();
});

test("HerdrPresence.annotate shares the dialect latch with report()", async () => {
	const mock = mockServer();
	mock.dialect = "custom_status";
	const errors: AnnotationDialect[] = [];
	const presence = new HerdrPresence({
		paneId: "w29:p3",
		source: "coms-bridge:S",
		agentLabel: "claude",
		socketPath: mock.socketPath,
		onError: (_err, dialect) => errors.push(dialect),
	});
	const peer = { name: "plan-reviewer", project: "test-project", contextUsedPct: 0, queueDepth: 0 };

	assert.equal(await presence.annotate(peer), true);
	assert.equal(presence.acceptedDialect(), "custom_status");
	assert.equal(mock.reports.at(-1)?.custom_status, "plan-reviewer 0% q0");

	mock.reports.length = 0;
	assert.equal(await presence.annotate(peer), true);
	assert.equal(mock.reports.length, 1);
	assert.deepEqual(errors, ["tokens"], "the rejected dialect is probed once, not once per keepalive");
	await mock.close();
});

test("HerdrPresence.report resolves false when the server is gone (never throws)", async () => {
	const presence = new HerdrPresence({
		paneId: "w1:p1",
		source: "coms:S",
		socketPath: path.join(os.tmpdir(), "definitely-not-a-herdr.sock"),
		timeoutMs: 200,
	});
	assert.equal(await presence.report("idle", { name: "x", contextUsedPct: 0, queueDepth: 0 }), false);
});

test("HerdrAgentWatch: snapshot, status push, exit prune, created resync", async () => {
	const mock = mockServer();
	mock.agents = [
		{ pane_id: "w1:p1", agent: "pi", agent_status: "idle", custom_status: "documenter 0% q0" },
		{ pane_id: "w1:p2", agent: "pi", agent_status: "idle", custom_status: "researcher 0% q0" },
		{ pane_id: "w1:p9", agent: "pi", agent_status: "idle", custom_status: "me 0% q0" },
	];
	const changes: HerdrAgentInfo[][] = [];
	const watch = new HerdrAgentWatch({
		socketPath: mock.socketPath,
		ownPaneId: "w1:p9",
		onChange: (agents) => changes.push(agents.map((a) => ({ ...a }))),
	});
	await watch.start();
	await wait(100);

	// initial snapshot: own pane excluded
	assert.equal(changes.length >= 1, true);
	assert.deepEqual(changes[0].map((a) => a.pane_id).sort(), ["w1:p1", "w1:p2"]);

	// push: status change arrives without any list call
	mock.emit("pane.agent_status_changed", { pane_id: "w1:p1", agent: "pi", agent_status: "working" });
	await wait(100);
	const afterStatus = changes[changes.length - 1];
	assert.equal(afterStatus.find((a) => a.pane_id === "w1:p1")?.agent_status, "working");

	// prune: pane.exited removes the peer immediately
	mock.agents = mock.agents.filter((a) => a.pane_id !== "w1:p2");
	mock.emit("pane.exited", { pane_id: "w1:p2" });
	await wait(400); // includes the debounced resync
	const afterExit = changes[changes.length - 1];
	assert.deepEqual(afterExit.map((a) => a.pane_id), ["w1:p1"]);

	// growth: pane.created triggers a resync that picks up the new agent
	mock.agents.push({ pane_id: "w2:p1", agent: "claude", agent_status: "idle" });
	mock.emit("pane.created", { pane_id: "w2:p1" });
	await wait(400);
	const afterCreate = changes[changes.length - 1];
	assert.deepEqual(afterCreate.map((a) => a.pane_id).sort(), ["w1:p1", "w2:p1"]);

	watch.stop();
	await mock.close();
});

// Regression: the watch used to resync on EVERY subscription ack, and every
// resync tore the stream down unconditionally — an infinite subscribe/close
// loop (~130+ "stream_closed" per minute per watcher) that pegged the herdr
// server's CPU. A healthy watcher holds ONE stream while nothing changes.
test("HerdrAgentWatch keeps one stream: no churn while idle, resubscribe only on set change, recover after drop", async () => {
	const mock = mockServer();
	mock.agents = [{ pane_id: "w1:p1", agent: "pi", agent_status: "idle" }];
	const changes: HerdrAgentInfo[][] = [];
	const watch = new HerdrAgentWatch({
		socketPath: mock.socketPath,
		reconnectDelayMs: 50,
		onChange: (agents) => changes.push(agents.map((a) => ({ ...a }))),
	});
	await watch.start();
	// Idle for several debounce windows: exactly one subscribe, still open.
	await wait(900);
	assert.equal(mock.subscribes, 1);
	assert.equal(mock.streams.length, 1);

	// Status push for a tracked pane and a pane.created that changes nothing
	// in the agent set: resync runs, but the stream must survive.
	mock.emit("pane.agent_status_changed", { pane_id: "w1:p1", agent_status: "working" });
	mock.emit("pane.created", { pane_id: "w1:p7" });
	await wait(600);
	assert.equal(mock.subscribes, 1);
	assert.equal(mock.streams.length, 1);

	// A REAL set change (new agent pane) rebuilds the subscription once.
	mock.agents.push({ pane_id: "w2:p1", agent: "pi", agent_status: "idle" });
	mock.emit("pane.created", { pane_id: "w2:p1" });
	await wait(600);
	assert.equal(mock.subscribes, 2);
	assert.equal(mock.streams.length, 1);
	assert.deepEqual(changes[changes.length - 1].map((a) => a.pane_id).sort(), ["w1:p1", "w2:p1"]);

	// Server-side drop: the stream reconnects and resyncs the snapshot it may
	// have missed — then settles again (no loop).
	mock.agents = mock.agents.filter((a) => a.pane_id !== "w2:p1");
	mock.streams[0].destroy();
	await wait(900);
	assert.deepEqual(changes[changes.length - 1].map((a) => a.pane_id), ["w1:p1"]);
	assert.equal(mock.streams.length, 1);
	const settled = mock.subscribes;
	await wait(600);
	assert.equal(mock.subscribes, settled);

	watch.stop();
	await mock.close();
});
