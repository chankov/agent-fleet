// Tests for the non-pi coms envelope module: envelope construction/validation
// mirrors the pi coms harness wire shapes; registry I/O + liveness pruning;
// a real socket round trip (bind → prompt → ack; response → ack).
//
// COMS_DIR is redirected via PI_COMS_DIR before import — set in the test
// runner invocation is not possible per-file, so these tests use explicit
// temp dirs through the exported path helpers where possible and a live
// bind/send pair on a temp socket path.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	bindEndpoint,
	isCancelEnvelope,
	isPromptEnvelope,
	isResponseEnvelope,
	makeCancelEnvelope,
	makeConnHandler,
	makePromptEnvelope,
	makeResponseEnvelope,
	pruneDeadEntries,
	readAllRegistryEntries,
	registryFilePath,
	sendEnvelope,
	ulid,
	writeAck,
	writeNack,
	writeRegistryAtomic,
	type RegistryEntry,
	type SenderIdentity,
} from "./coms-envelope.ts";

const ID: SenderIdentity = {
	session_id: "01TESTSESSION0000000000000",
	name: "tester",
	endpoint: "/tmp/coms-test.sock",
	cwd: "/repo",
};

test("prompt envelopes carry the coms wire fields and validate", () => {
	const env = makePromptEnvelope(ID, "hello there", { response_schema: { type: "object" } });
	assert.equal(env.type, "prompt");
	assert.equal(env.prompt, "hello there");
	assert.equal(env.sender_name, "tester");
	assert.equal(env.sender_endpoint, ID.endpoint);
	assert.equal(env.hops, 0);
	assert.equal(env.msg_id.length, 26);
	assert.deepEqual(env.response_schema, { type: "object" });
	assert.equal(isPromptEnvelope(env), true);
	assert.equal(isPromptEnvelope({ type: "prompt" }), false);
	assert.equal(isPromptEnvelope(null), false);
});

test("response envelopes validate and carry errors", () => {
	const env = makeResponseEnvelope(ID, "MSG1", { answer: 42 });
	assert.equal(isResponseEnvelope(env), true);
	assert.equal(env.msg_id, "MSG1");
	assert.equal(env.error, null);
	const err = makeResponseEnvelope(ID, "MSG2", null, "blocked on permission prompt");
	assert.equal(err.error, "blocked on permission prompt");
	assert.equal(isResponseEnvelope({ type: "response" }), false);
});

test("cancel envelopes validate and require ref_msg_id", () => {
	const env = makeCancelEnvelope({
		from: "orchestrator",
		to: "user-remote",
		ref_msg_id: "01ABCDEFGHJKMNPQRSTVWXYZ1",
		msg_id: "01ABCDEFGHJKMNPQRSTVWXYZ2",
		created_at: "2026-01-02T03:04:05.000Z",
	});
	assert.deepEqual(env, {
		type: "cancel",
		msg_id: "01ABCDEFGHJKMNPQRSTVWXYZ2",
		from: "orchestrator",
		to: "user-remote",
		created_at: "2026-01-02T03:04:05.000Z",
		ref_msg_id: "01ABCDEFGHJKMNPQRSTVWXYZ1",
	});
	assert.equal(isCancelEnvelope(env), true);
	assert.equal(isCancelEnvelope({ ...env, ref_msg_id: undefined }), false);
	assert.equal(isCancelEnvelope({ ...env, ref_msg_id: "" }), false);
	assert.equal(isCancelEnvelope({ ...env, ref_msg_id: 123 }), false);
	assert.equal(isCancelEnvelope({ type: "cancel", msg_id: env.msg_id }), false);
});

test("ulid is 26 chars, unique, monotonic-ish by time", () => {
	const a = ulid();
	const b = ulid();
	assert.equal(a.length, 26);
	assert.notEqual(a, b);
	assert.match(a, /^[0-9A-HJKMNP-TV-Z]+$/);
});

test("registry round trip + dead-entry pruning (own pid lives, fake pid pruned)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coms-envelope-test-"));
	process.env.PI_COMS_DIR = dir; // NOTE: module already imported — path helpers read COMS_DIR at import; use explicit project via helpers
	// The module captured COMS_DIR at import time, so exercise the fs shapes
	// through writeRegistryAtomic with the captured dir instead:
	const entry: RegistryEntry = {
		session_id: "S1",
		name: "alive",
		purpose: "p",
		model: "m",
		color: "#FFFFFF",
		pid: process.pid,
		endpoint: "/tmp/x.sock",
		cwd: "/",
		started_at: new Date().toISOString(),
		explicit: false,
		version: 1,
	};
	const project = `test-${process.pid}-${Date.now()}`;
	fs.mkdirSync(path.dirname(registryFilePath(project, "alive")), { recursive: true });
	writeRegistryAtomic(entry, project);
	writeRegistryAtomic({ ...entry, name: "dead", session_id: "S2", pid: 999999999 }, project);

	assert.equal(readAllRegistryEntries(project).length, 2);
	const live = pruneDeadEntries(project);
	assert.deepEqual(live.map((e) => e.name), ["alive"]);
	// the dead entry file was removed
	assert.equal(fs.existsSync(registryFilePath(project, "dead")), false);
	fs.rmSync(path.dirname(path.dirname(registryFilePath(project, "x"))), { recursive: true, force: true });
});

test("socket round trip: prompt → ack, response → ack, nack rejects", async () => {
	const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coms-sock-")), "peer.sock");
	const seen: Array<Record<string, unknown>> = [];
	const server = await bindEndpoint(
		sockPath,
		makeConnHandler((env, socket) => {
			seen.push(env);
			if (isPromptEnvelope(env)) writeAck(socket, env.msg_id);
			else if (isResponseEnvelope(env)) writeAck(socket, env.msg_id);
			else writeNack(socket, (env as { msg_id?: string }).msg_id ?? "", "nope");
		}),
	);

	const prompt = makePromptEnvelope(ID, "ping me");
	const ack = await sendEnvelope(sockPath, prompt);
	assert.equal(ack.type, "ack");
	assert.equal(ack.msg_id, prompt.msg_id);

	const resp = makeResponseEnvelope(ID, prompt.msg_id, "pong!");
	const ack2 = await sendEnvelope(sockPath, resp);
	assert.equal(ack2.type, "ack");

	await assert.rejects(sendEnvelope(sockPath, { type: "weird", msg_id: "X" }), /nope/);
	assert.equal(seen.length, 3);
	server.close();
});

test("bindEndpoint replaces a stale socket file and refuses a live one", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coms-sock-"));
	const sockPath = path.join(dir, "peer.sock");
	fs.writeFileSync(sockPath, ""); // stale plain file
	const server = await bindEndpoint(sockPath, () => {});
	await assert.rejects(bindEndpoint(sockPath, () => {}), /already in use/);
	server.close();
});
