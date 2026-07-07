// Tests for the herdr presence backend against a mock server speaking the
// observed wire dialect (one request per connection; long-lived subscribe
// streams; 32-char custom_status cap).

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
	type HerdrAgentInfo,
} from "./herdr-presence.ts";

interface MockState {
	agents: Array<Record<string, unknown>>;
	reports: Array<Record<string, unknown>>;
	streams: net.Socket[];
	emit(event: string, data: Record<string, unknown>): void;
}

function mockServer(): MockState & { socketPath: string; close: () => Promise<void> } {
	const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "herdr-presence-")), "herdr.sock");
	const state: MockState = {
		agents: [],
		reports: [],
		streams: [],
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
						// mimic the server-side 32-char truncation
						const p = { ...msg.params };
						if (typeof p.custom_status === "string") p.custom_status = p.custom_status.slice(0, 32);
						state.reports.push(p);
						sock.end(JSON.stringify({ id: msg.id, result: { type: "ok" } }) + "\n");
						break;
					}
					case "pane.report_metadata": {
						const p = { ...msg.params, metadata: true };
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

test("HerdrPresence reports agent state + metadata custom_status and releases", async () => {
	const mock = mockServer();
	const presence = new HerdrPresence({
		paneId: "w1:p1",
		source: "coms:SESSION1",
		socketPath: mock.socketPath,
	});
	assert.equal(await presence.report("working", "x".repeat(50)), true);
	await presence.release();
	// one report() = report_agent (state, for undetected panes) +
	// report_metadata (custom_status, for detection-owned panes)
	assert.equal(mock.reports.length, 3);
	assert.equal(mock.reports[0].pane_id, "w1:p1");
	assert.equal(mock.reports[0].source, "coms:SESSION1");
	assert.equal(mock.reports[0].agent, "pi");
	assert.equal(mock.reports[0].state, "working");
	assert.equal((mock.reports[0].custom_status as string).length, 32);
	assert.equal(mock.reports[1].metadata, true);
	assert.equal((mock.reports[1].custom_status as string).length, 32);
	assert.equal(typeof mock.reports[1].ttl_ms, "number");
	assert.equal(mock.reports[2].released, true);
	await mock.close();
});

test("HerdrPresence.report resolves false when the server is gone (never throws)", async () => {
	const presence = new HerdrPresence({
		paneId: "w1:p1",
		source: "coms:S",
		socketPath: path.join(os.tmpdir(), "definitely-not-a-herdr.sock"),
		timeoutMs: 200,
	});
	assert.equal(await presence.report("idle", "x"), false);
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
