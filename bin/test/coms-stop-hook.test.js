// The coms Stop hook hands each Claude Code turn's reply to the bridge. A reply
// from an earlier turn must never be delivered as the answer to the current one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = join(root, ".pi/agent-fleet/hooks/coms-stop-hook.mjs");
const PANE = "wT:p1";

const prompt = (text) => ({ type: "user", message: { role: "user", content: text } });
const toolResult = () => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
const assistant = (stop, ...content) => ({ type: "assistant", message: { role: "assistant", stop_reason: stop, content } });
const text = (value) => ({ type: "text", text: value });
const toolUse = () => ({ type: "tool_use", id: "t1", name: "Read", input: {} });
const lines = (...entries) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

function fixture(entries) {
	const home = mkdtempSync(join(tmpdir(), "af-stop-hook-"));
	const transcript = join(home, "transcript.jsonl");
	writeFileSync(transcript, lines(...entries));
	const record = join(home, ".pi/coms/claude-bridge/wT_p1/last-message.json");
	return { home, transcript, record, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runHook(f, input, { onStart } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [HOOK], { env: { ...process.env, HOME: f.home, HERDR_PANE_ID: PANE }, stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code, stderr }));
		child.stdin.end(JSON.stringify({ session_id: "s1", transcript_path: f.transcript, hook_event_name: "Stop", ...input }));
		onStart?.();
	});
}

const written = (f) => (existsSync(f.record) ? JSON.parse(readFileSync(f.record, "utf8")).text : null);

// The previous turn ended with an APPROVE; the current turn's final text is not on disk yet.
const raced = [
	prompt("[coms message from hub] REVIEW R1"),
	assistant("end_turn", text("R1 verdict: APPROVE")),
	prompt("[coms message from hub] REVIEW R2"),
	assistant("tool_use", text("Checking the remaining files."), toolUse()),
	toolResult(),
];

test("the reply Claude Code passes to the Stop hook wins over a transcript that has not caught up", async () => {
	const f = fixture(raced);
	try {
		const result = await runHook(f, { last_assistant_message: "R2 verdict: CHANGES_REQUIRED" });
		assert.equal(result.code, 0);
		assert.equal(written(f), "R2 verdict: CHANGES_REQUIRED");
	} finally { f.cleanup(); }
});

test("without that field, the hook waits for the current turn's final text instead of returning an earlier reply", async () => {
	const f = fixture(raced);
	try {
		const result = await runHook(f, {}, {
			onStart: () => setTimeout(() => appendFileSync(f.transcript, lines(assistant("end_turn", text("R2 verdict: CHANGES_REQUIRED")))), 300),
		});
		assert.equal(result.code, 0);
		assert.equal(written(f), "R2 verdict: CHANGES_REQUIRED");
	} finally { f.cleanup(); }
});

test("a turn whose final text never reaches the transcript writes no record rather than a stale or interim one", async () => {
	const f = fixture(raced);
	try {
		const result = await runHook(f, {});
		assert.equal(result.code, 0, "the hook never fails the turn");
		assert.equal(written(f), null);
	} finally { f.cleanup(); }
});

test("a complete transcript still yields the current turn's final text", async () => {
	const f = fixture([...raced, assistant("end_turn", text("R2 verdict: CHANGES_REQUIRED"))]);
	try {
		await runHook(f, {});
		assert.equal(written(f), "R2 verdict: CHANGES_REQUIRED");
	} finally { f.cleanup(); }
});

test("outside a herdr pane the hook does nothing", async () => {
	const f = fixture(raced);
	try {
		const child = spawn(process.execPath, [HOOK], { env: { ...process.env, HOME: f.home, HERDR_PANE_ID: "" }, stdio: ["pipe", "ignore", "ignore"] });
		child.stdin.end(JSON.stringify({ transcript_path: f.transcript, last_assistant_message: "x" }));
		const code = await new Promise((r) => child.on("close", r));
		assert.equal(code, 0);
		assert.equal(written(f), null);
	} finally { f.cleanup(); }
});
