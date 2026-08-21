import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import {
	createFleetTranscriptStore,
	readFleetTranscript,
	readFleetTranscriptBefore,
	readFleetTranscriptTail,
	redactSecrets,
	redactTimelineEvent,
	type FleetTranscriptEvent,
} from "./fleet-transcript-store.ts";

const event = (content: string, timestamp = 1): FleetTranscriptEvent => ({
	kind: "text",
	title: "Assistant",
	content,
	timestamp,
});

test("redactSecrets removes common credentials without hiding ordinary prose", () => {
	const input = [
		"Authorization: Bearer abc.def-123_456",
		"api_key=super-secret-value",
		"{\"api_key\":\"json-secret\",\"Authorization\":\"Bearer json-bearer\"}",
		"MY_PASSWORD=env-secret",
		"password: hunter2",
		"OPENAI_API_KEY='sk-proj-abcdefghijklmnopqrstuvwxyz'",
		"github ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"aws AKIAIOSFODNN7EXAMPLE",
		"-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----",
	].join("\n");
	const safe = redactSecrets(input);
	for (const secret of ["abc.def-123_456", "super-secret-value", "json-secret", "json-bearer", "env-secret", "hunter2", "sk-proj-abcdefghijklmnopqrstuvwxyz", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "AKIAIOSFODNN7EXAMPLE", "private material"]) {
		assert.equal(safe.includes(secret), false, secret);
	}
	assert.match(safe, /Authorization: Bearer \[REDACTED\]/);
	assert.match(safe, /api_key=\[REDACTED\]/);
	assert.equal(redactSecrets("token count is 42; password policy is strict"), "token count is 42; password policy is strict");
});

test("redactTimelineEvent applies defence-in-depth to every string payload", () => {
	const safe = redactTimelineEvent({
		kind: "tool-result",
		title: "Tool: bash",
		content: "stdout token=secret-value",
		timestamp: 2,
		callId: "call-secret",
		status: "error",
		durationMs: 12,
	});
	assert.equal(safe.content, "stdout token=[REDACTED]");
	assert.equal(safe.callId, "call-secret");
	assert.equal(safe.status, "error");
});

test("secure JSONL append is ordered, redacted, cursor-readable, and owner-only", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "fleet-transcript-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "nested", "builder.jsonl");
	const store = createFleetTranscriptStore(path);
	store.append(event("first api_key=do-not-write", 1));
	const first = readFleetTranscript(path, { after: 0, limit: 10 });
	assert.equal(first.events.length, 1);
	assert.equal(first.events[0].content, "first api_key=[REDACTED]");
	store.append({ ...event("second", 2), kind: "thinking", title: "Thinking" });
	const second = readFleetTranscript(path, { after: first.nextOffset, limit: 10 });
	assert.deepEqual(second.events.map(item => item.content), ["second"]);
	assert.ok(second.nextOffset > first.nextOffset);
	assert.equal(readFileSync(path, "utf8").includes("do-not-write"), false);
	if (process.platform !== "win32") {
		assert.equal(lstatSync(join(root, "nested")).mode & 0o777, 0o700);
		assert.equal(lstatSync(path).mode & 0o777, 0o600);
	}
});

test("reader ignores a partial final record and resumes when it is completed", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "fleet-transcript-partial-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "events.jsonl");
	mkdirSync(root, { recursive: true });
	const one = `${JSON.stringify(event("one"))}\n`;
	const two = JSON.stringify(event("two", 2));
	writeFileSync(path, one + two.slice(0, 10), { mode: 0o600 });
	const partial = readFleetTranscript(path, { after: 0, limit: 10 });
	assert.deepEqual(partial.events.map(item => item.content), ["one"]);
	assert.equal(partial.nextOffset, Buffer.byteLength(one));
	writeFileSync(path, one + two + "\n", { mode: 0o600 });
	const complete = readFleetTranscript(path, { after: partial.nextOffset, limit: 10 });
	assert.deepEqual(complete.events.map(item => item.content), ["two"]);
});

test("reader enforces limits and skips malformed complete records", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "fleet-transcript-limit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "events.jsonl");
	writeFileSync(path, `${JSON.stringify(event("one", 1))}\nnot-json\n${JSON.stringify({ ...event("forged", 2), status: "maybe", extra: "ignored" })}\n${JSON.stringify(event("two", 3))}\n`, { mode: 0o600 });
	const first = readFleetTranscript(path, { limit: 1 });
	assert.deepEqual(first.events.map(item => item.content), ["one"]);
	const rest = readFleetTranscript(path, { after: first.nextOffset, limit: 10 });
	assert.deepEqual(rest.events.map(item => item.content), ["two"]);
});

test("tail and before pages navigate a complete transcript with bounded windows", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "fleet-transcript-pages-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "events.jsonl");
	const store = createFleetTranscriptStore(path);
	for (let i = 0; i < 20; i++) store.append(event(`event-${i}`, i));
	const tail = readFleetTranscriptTail(path, { limit: 5 });
	assert.deepEqual(tail.events.map(item => item.content), ["event-15", "event-16", "event-17", "event-18", "event-19"]);
	assert.equal(tail.eof, true);
	assert.ok(tail.startOffset > 0);
	assert.equal(tail.records[0].startOffset, tail.startOffset);
	const before = readFleetTranscriptBefore(path, { before: tail.startOffset, limit: 5 });
	assert.deepEqual(before.events.map(item => item.content), ["event-10", "event-11", "event-12", "event-13", "event-14"]);
	assert.equal(before.nextOffset, tail.startOffset);
	assert.ok(before.startOffset < tail.startOffset);
});

test("store refuses to append through a symlink", async (t) => {
	if (process.platform === "win32") return t.skip("symlink permissions differ on Windows");
	const root = await mkdtemp(join(tmpdir(), "fleet-transcript-link-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const target = join(root, "target");
	const link = join(root, "events.jsonl");
	writeFileSync(target, "", { mode: 0o600 });
	symlinkSync(target, link);
	assert.throws(() => createFleetTranscriptStore(link).append(event("nope")), /symlink|refused/i);
	chmodSync(target, 0o600);
});
