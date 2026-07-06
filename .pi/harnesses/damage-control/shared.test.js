import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as net from "node:net";

import {
	appendExemptionToFile,
	fileExemptionsFor,
	readExemptionsFile,
	removeExemptionFromFile,
	requestAccessFromHub,
} from "./shared.ts";

function tempFile() {
	return join(mkdtempSync(join(tmpdir(), "dc-shared-")), "exemptions.json");
}

function exemption(pattern, agent) {
	return { pattern, scope: "session", agent, grantedVia: "command", grantedAt: new Date().toISOString() };
}

test("readExemptionsFile: missing/malformed file yields []", () => {
	assert.deepEqual(readExemptionsFile(undefined), []);
	assert.deepEqual(readExemptionsFile("/nonexistent/exemptions.json"), []);
});

test("appendExemptionToFile: creates parent dir, appends, dedupes", () => {
	const file = join(mkdtempSync(join(tmpdir(), "dc-shared-")), "nested", "exemptions.json");
	appendExemptionToFile(file, exemption(".env"));
	appendExemptionToFile(file, exemption(".env")); // duplicate
	appendExemptionToFile(file, exemption(".env", "builder")); // same pattern, agent-scoped → distinct
	const entries = readExemptionsFile(file);
	assert.equal(entries.length, 2);
	assert.ok(existsSync(file));
	// valid JSON on disk
	assert.doesNotThrow(() => JSON.parse(readFileSync(file, "utf-8")));
});

test("fileExemptionsFor: agent-scoped entries only reach their agent", () => {
	const file = tempFile();
	appendExemptionToFile(file, exemption(".env"));
	appendExemptionToFile(file, exemption("*.pem", "builder"));
	assert.deepEqual(fileExemptionsFor(file, "researcher").map((e) => e.pattern), [".env"]);
	assert.deepEqual(fileExemptionsFor(file, "builder").map((e) => e.pattern), [".env", "*.pem"]);
});

test("removeExemptionFromFile: removes all entries for a pattern", () => {
	const file = tempFile();
	appendExemptionToFile(file, exemption(".env"));
	appendExemptionToFile(file, exemption(".env", "builder"));
	appendExemptionToFile(file, exemption("*.pem"));
	assert.equal(removeExemptionFromFile(file, ".env"), true);
	assert.deepEqual(readExemptionsFile(file).map((e) => e.pattern), ["*.pem"]);
	assert.equal(removeExemptionFromFile(file, ".env"), false);
});

// ── escalation client ──

function fakeHub(socketPath, onRequest) {
	const server = net.createServer((socket) => {
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf-8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const req = JSON.parse(buf.slice(0, nl));
			onRequest(req, socket);
		});
	});
	return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

function request(pattern = ".env") {
	return {
		type: "access_request",
		msg_id: "m1",
		sender_session: "researcher-r1",
		sender_endpoint: "",
		hops: 0,
		timestamp: new Date().toISOString(),
		agent: "researcher-r1",
		tool: "read",
		rule: `Access to zero-access path restricted: ${pattern}`,
		pattern,
		invocation: `{"path":"${pattern}"}`,
	};
}

test("requestAccessFromHub: receives the hub's decision", async () => {
	const sock = join(mkdtempSync(join(tmpdir(), "dc-shared-")), "hub.sock");
	const server = await fakeHub(sock, (req, socket) => {
		assert.equal(req.type, "access_request");
		assert.equal(req.pattern, ".env");
		socket.write(JSON.stringify({ type: "access_decision", msg_id: req.msg_id, decision: "allow_once" }) + "\n");
		socket.end();
	});
	try {
		assert.equal(await requestAccessFromHub(sock, request(), 2000), "allow_once");
	} finally {
		server.close();
	}
});

test("requestAccessFromHub: times out fail-closed when the hub stays silent", async () => {
	const sock = join(mkdtempSync(join(tmpdir(), "dc-shared-")), "hub.sock");
	const server = await fakeHub(sock, () => { /* never answer */ });
	try {
		assert.equal(await requestAccessFromHub(sock, request(), 200), "timeout");
	} finally {
		server.close();
	}
});

test("requestAccessFromHub: unreachable endpoint or nack resolves error", async () => {
	assert.equal(await requestAccessFromHub("/nonexistent/hub.sock", request(), 500), "error");

	const sock = join(mkdtempSync(join(tmpdir(), "dc-shared-")), "hub.sock");
	// an older hub without escalation support nacks unknown envelope types
	const server = await fakeHub(sock, (req, socket) => {
		socket.write(JSON.stringify({ type: "nack", msg_id: req.msg_id, error: "unknown type" }) + "\n");
		socket.end();
	});
	try {
		assert.equal(await requestAccessFromHub(sock, request(), 2000), "error");
	} finally {
		server.close();
	}
});
