// Tests for the herdr socket client against a mock net.Server speaking the
// wire dialect observed live (see docs/plans/herdr/spike-notes.md): ndjson,
// one request per connection (server closes after responding), long-lived
// events.subscribe streams, parse errors with an empty id.

import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import {
	HerdrRequestError,
	HerdrUnavailableError,
	herdr,
	herdrAvailable,
	request,
	requireHerdr,
	resolveSocketPath,
	subscribe,
} from "./herdr-client.ts";

type Handler = (msg: { id: string; method: string; params: Record<string, unknown> }, sock: net.Socket) => void;

function tmpSock(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "herdr-mock-")), "herdr.sock");
}

// Mock server: per-line handler decides what to write; by default it closes
// the connection after the first response, mimicking the real server.
function mockServer(handler: Handler): { socketPath: string; server: net.Server; close: () => Promise<void> } {
	const socketPath = tmpSock();
	const server = net.createServer((sock) => {
		let buf = "";
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line) handler(JSON.parse(line), sock);
			}
		});
		sock.on("error", () => {});
	});
	server.listen(socketPath);
	return {
		socketPath,
		server,
		close: () => new Promise((res) => server.close(() => res())),
	};
}

test("request resolves the result and closes like the real server", async () => {
	const mock = mockServer((msg, sock) => {
		assert.equal(msg.method, "ping");
		sock.end(JSON.stringify({ id: msg.id, result: { type: "pong", version: "0.7.1", protocol: 14 } }) + "\n");
	});
	const pong = await request<{ type: string; version: string }>("ping", {}, { socketPath: mock.socketPath });
	assert.equal(pong.type, "pong");
	assert.equal(pong.version, "0.7.1");
	await mock.close();
});

test("unknown response fields pass through untouched", async () => {
	const mock = mockServer((msg, sock) => {
		sock.end(
			JSON.stringify({
				id: msg.id,
				result: { type: "pong", version: "9.9.9", protocol: 99, future_field: { deep: [1, 2, 3] } },
			}) + "\n",
		);
	});
	const pong = await request<Record<string, unknown>>("ping", {}, { socketPath: mock.socketPath });
	assert.deepEqual(pong.future_field, { deep: [1, 2, 3] });
	await mock.close();
});

test("responses for other ids are ignored until ours arrives", async () => {
	const mock = mockServer((msg, sock) => {
		sock.write(JSON.stringify({ id: "someone-else", result: { type: "noise" } }) + "\n");
		sock.end(JSON.stringify({ id: msg.id, result: { type: "mine" } }) + "\n");
	});
	const res = await request<{ type: string }>("x.y", {}, { socketPath: mock.socketPath });
	assert.equal(res.type, "mine");
	await mock.close();
});

test("error envelopes reject with HerdrRequestError, including empty-id parse errors", async () => {
	const mock = mockServer((msg, sock) => {
		if (msg.method === "bad.method") {
			sock.end(JSON.stringify({ id: "", error: { code: "invalid_request", message: "unknown variant" } }) + "\n");
		} else {
			sock.end(JSON.stringify({ id: msg.id, error: { code: "pane_not_found", message: "nope" } }) + "\n");
		}
	});
	await assert.rejects(
		request("bad.method", {}, { socketPath: mock.socketPath }),
		(err: HerdrRequestError) => err instanceof HerdrRequestError && err.code === "invalid_request",
	);
	await assert.rejects(
		request("pane.read", { pane_id: "w9:p9" }, { socketPath: mock.socketPath }),
		(err: HerdrRequestError) => err instanceof HerdrRequestError && err.code === "pane_not_found",
	);
	await mock.close();
});

test("request times out when the server never answers", async () => {
	const mock = mockServer(() => {
		// swallow the request, answer nothing
	});
	await assert.rejects(
		request("ping", {}, { socketPath: mock.socketPath, timeoutMs: 200 }),
		/timeout after 200ms waiting for ping/,
	);
	await mock.close();
});

test("connection closed before a response rejects readably", async () => {
	const mock = mockServer((_msg, sock) => sock.end());
	await assert.rejects(
		request("ping", {}, { socketPath: mock.socketPath, timeoutMs: 1000 }),
		/connection closed before a response to ping/,
	);
	await mock.close();
});

test("requireHerdr fails fast with the socket path when nothing listens", async () => {
	const missing = tmpSock(); // dir exists, socket file does not
	await assert.rejects(
		requireHerdr({ socketPath: missing }),
		(err: HerdrUnavailableError) =>
			err instanceof HerdrUnavailableError &&
			err.message.includes(missing) &&
			err.message.includes("Start herdr first"),
	);
	assert.equal(await herdrAvailable({ socketPath: missing }), null);
});

test("requireHerdr rejects servers older than the minimum tested protocol", async () => {
	const mock = mockServer((msg, sock) => {
		sock.end(JSON.stringify({ id: msg.id, result: { type: "pong", version: "0.1.0", protocol: 1 } }) + "\n");
	});
	await assert.rejects(requireHerdr({ socketPath: mock.socketPath }), /protocol 1 is older/);
	await mock.close();
});

test("requireHerdr resolves with the pong on a healthy server", async () => {
	const mock = mockServer((msg, sock) => {
		sock.end(JSON.stringify({ id: msg.id, result: { type: "pong", version: "0.7.1", protocol: 14 } }) + "\n");
	});
	const pong = await requireHerdr({ socketPath: mock.socketPath });
	assert.equal(pong.protocol, 14);
	await mock.close();
});

test("subscribe delivers events and survives a socket drop (auto-reconnect)", async () => {
	let connections = 0;
	const sockets: net.Socket[] = [];
	const mock = mockServer((msg, sock) => {
		assert.equal(msg.method, "events.subscribe");
		connections++;
		sockets.push(sock);
		sock.write(JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n");
		sock.write(
			JSON.stringify({ event: "pane.created", data: { pane_id: `w1:p${connections}` } }) + "\n",
		);
	});

	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	let connects = 0;
	const handle = subscribe(
		[{ type: "pane.created" }],
		(ev) => events.push(ev),
		{ socketPath: mock.socketPath, reconnectDelayMs: 50, onConnect: () => connects++ },
	);

	await new Promise((res) => setTimeout(res, 150));
	assert.equal(events.length, 1);
	assert.deepEqual(events[0], { event: "pane.created", data: { pane_id: "w1:p1" } });

	sockets[0].destroy(); // simulate server drop
	await new Promise((res) => setTimeout(res, 300));
	assert.equal(connections >= 2, true, `expected a reconnect, got ${connections} connection(s)`);
	assert.equal(events.length >= 2, true);
	assert.equal(connects >= 2, true);

	handle.close();
	await new Promise((res) => setTimeout(res, 150));
	const closedAt = connections;
	await new Promise((res) => setTimeout(res, 200));
	assert.equal(connections, closedAt, "no reconnects after close()");
	await mock.close();
});

test("subscribe surfaces a rejected subscription and stops retrying", async () => {
	let connections = 0;
	const mock = mockServer((_msg, sock) => {
		connections++;
		sock.end(JSON.stringify({ id: "", error: { code: "invalid_request", message: "missing field pane_id" } }) + "\n");
	});
	const errors: Error[] = [];
	const handle = subscribe([{ type: "pane.agent_status_changed" }], () => {}, {
		socketPath: mock.socketPath,
		reconnectDelayMs: 30,
		onError: (e) => errors.push(e),
	});
	await new Promise((res) => setTimeout(res, 250));
	assert.equal(connections, 1, "a rejected subscription must not retry");
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /missing field pane_id/);
	handle.close();
	await mock.close();
});

test("typed wrappers send exact wire param names", async () => {
	const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
	const mock = mockServer((msg, sock) => {
		seen.push({ method: msg.method, params: msg.params });
		sock.end(JSON.stringify({ id: msg.id, result: { type: "ok", pane: { pane_id: "w2:p2" }, read: { pane_id: "w2:p2", text: "" } } }) + "\n");
	});
	const opts = { socketPath: mock.socketPath };

	await herdr.paneSplit({ target_pane_id: "w2:p1", direction: "right", ratio: 0.4 }, opts);
	await herdr.paneReportAgent(
		{ pane_id: "w2:p2", source: "coms:web", agent: "pi", state: "working", custom_status: "{}" },
		opts,
	);
	await herdr.paneRead({ pane_id: "w2:p2", lines: 40 }, opts);
	await herdr.paneSendKeys("w2:p2", ["enter"], opts);

	assert.equal(seen[0].method, "pane.split");
	assert.equal(seen[0].params.target_pane_id, "w2:p1");
	assert.equal("pane_id" in seen[0].params, false, "pane.split must not send pane_id");
	assert.equal(seen[1].method, "pane.report_agent");
	assert.equal(seen[1].params.source, "coms:web");
	assert.equal(seen[2].method, "pane.read");
	// defaults observed from the herdr CLI wire traffic
	assert.equal(seen[2].params.source, "recent");
	assert.equal(seen[2].params.strip_ansi, true);
	assert.deepEqual(seen[3].params, { pane_id: "w2:p2", keys: ["enter"] });
	await mock.close();
});

test("resolveSocketPath prefers explicit arg over env over default", () => {
	const prev = process.env.HERDR_SOCKET_PATH;
	try {
		process.env.HERDR_SOCKET_PATH = "/tmp/env.sock";
		assert.equal(resolveSocketPath("/tmp/explicit.sock"), "/tmp/explicit.sock");
		assert.equal(resolveSocketPath(), "/tmp/env.sock");
		delete process.env.HERDR_SOCKET_PATH;
		assert.equal(resolveSocketPath(), path.join(os.homedir(), ".config", "herdr", "herdr.sock"));
	} finally {
		if (prev === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = prev;
	}
});
