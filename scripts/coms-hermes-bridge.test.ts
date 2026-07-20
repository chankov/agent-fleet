// Daemon-level tests for scripts/coms-hermes-bridge.ts. These use temp
// HOME/PI_COMS_DIR roots and a fake `hermes` binary; no live Telegram needed.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PROJECT = "hermes-bridge-test";
const BRIDGE = "scripts/coms-hermes-bridge.ts";
const CLI = "scripts/coms-cli.ts";
const OTHER_QID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

interface Fixture {
	root: string;
	home: string;
	coms: string;
	bin: string;
	hermesLog: string;
	env: NodeJS.ProcessEnv;
}

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "coms-hermes-bridge-test-"));
	const home = path.join(root, "home");
	const coms = path.join(root, "coms");
	const bin = path.join(root, "bin");
	const hermesLog = path.join(root, "hermes-calls.ndjson");
	fs.mkdirSync(bin, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const hermes = path.join(bin, "hermes");
	fs.writeFileSync(hermes, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const message = args[args.length - 1] || "";
const log = process.env.HERMES_FAKE_LOG;
if (log) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), args, message }) + "\\n");
}
const fail = process.env.HERMES_FAIL_PATTERN;
if (fail && message.includes(fail)) {
  console.error("fake hermes failure for " + fail);
  process.exit(42);
}
process.exit(0);
`);
	fs.chmodSync(hermes, 0o755);
	return {
		root,
		home,
		coms,
		bin,
		hermesLog,
		env: {
			...process.env,
			HOME: home,
			PI_COMS_DIR: coms,
			HERMES_FAKE_LOG: hermesLog,
			PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 5_000, intervalMs = 25): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = fn();
			if (value) return value;
		} catch (err) {
			lastError = err;
		}
		await sleep(intervalMs);
	}
	throw lastError instanceof Error ? lastError : new Error(`timed out after ${timeoutMs}ms`);
}

function registryFile(f: Fixture, name = "user-remote"): string {
	return path.join(f.coms, "projects", PROJECT, "agents", `${name}.json`);
}

function questionsDir(f: Fixture): string {
	return path.join(f.home, ".pi", "coms", "hermes-bridge", "questions");
}

function bridgeLogFile(f: Fixture): string {
	return path.join(f.home, ".pi", "coms", "hermes-bridge", "log.ndjson");
}

function readJsonLines(file: string): any[] {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function readHermesCalls(f: Fixture): Array<{ args: string[]; message: string }> {
	return readJsonLines(f.hermesLog) as Array<{ args: string[]; message: string }>;
}

function extractQid(calls: Array<{ message: string }>): string | null {
	for (const call of calls) {
		const match = call.message.match(/\[HUB-Q:([0-9A-HJKMNP-TV-Z]{26})\]/);
		if (match) return match[1];
	}
	return null;
}

function writeAnswer(f: Fixture, qid: string, answer = "Remote answer"): string {
	const dir = questionsDir(f);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${qid}.answer.json`);
	fs.writeFileSync(file, JSON.stringify({
		qid,
		answer,
		answered_by: "telegram:test-user",
		at: "2026-07-08T12:34:56.000Z",
	}));
	return file;
}

function startBridge(t: { after(fn: () => void | Promise<void>): void }, f: Fixture, opts: { args?: string[]; env?: NodeJS.ProcessEnv } = {}): ChildProcessWithoutNullStreams {
	const child = spawn(process.execPath, [
		"--experimental-strip-types",
		BRIDGE,
		"--project", PROJECT,
		"--poll-ms", "25",
		...(opts.args ?? []),
	], { env: { ...f.env, ...(opts.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
	child.once("exit", (code) => {
		if (code !== 0 && code !== null) process.stderr.write(`bridge exited ${code}: ${stderr}\n`);
	});
	t.after(async () => {
		if (child.exitCode === null && !child.killed) {
			child.kill("SIGTERM");
			await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(1_000)]);
		}
		fs.rmSync(f.root, { recursive: true, force: true });
	});
	return child;
}

async function waitForBridge(f: Fixture): Promise<{ endpoint: string }> {
	return await waitFor(() => {
		const file = registryFile(f);
		if (!fs.existsSync(file)) return null;
		return JSON.parse(fs.readFileSync(file, "utf-8")) as { endpoint: string };
	});
}

function runProcess(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, ["--experimental-strip-types", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
	return new Promise((resolve) => child.once("exit", (code) => resolve({ code, stdout, stderr })));
}

async function loadEnvelope(comsDir: string): Promise<typeof import("./lib/coms-envelope.ts")> {
	process.env.PI_COMS_DIR = comsDir;
	return await import(`./lib/coms-envelope.ts?case=${Date.now()}-${Math.random()}`) as typeof import("./lib/coms-envelope.ts");
}

async function directPrompt(f: Fixture, promptText: string): Promise<{
	envMod: typeof import("./lib/coms-envelope.ts");
	prompt: import("./lib/coms-envelope.ts").PromptEnvelope;
	bridgeEndpoint: string;
	response: Promise<import("./lib/coms-envelope.ts").ResponseEnvelope>;
	close: () => void;
}> {
	const bridge = await waitForBridge(f);
	const envMod = await loadEnvelope(f.coms);
	envMod.ensureComsDirs(PROJECT);
	const sender = {
		session_id: envMod.ulid(),
		name: "daemon-test-sender",
		endpoint: "",
		cwd: process.cwd(),
	};
	sender.endpoint = envMod.makeEndpoint(sender.session_id);
	let resolveResponse!: (env: import("./lib/coms-envelope.ts").ResponseEnvelope) => void;
	const response = new Promise<import("./lib/coms-envelope.ts").ResponseEnvelope>((resolve) => { resolveResponse = resolve; });
	const server = await envMod.bindEndpoint(
		sender.endpoint,
		envMod.makeConnHandler((env, socket) => {
			if (envMod.isResponseEnvelope(env)) {
				envMod.writeAck(socket, env.msg_id);
				resolveResponse(env);
			} else {
				envMod.writeNack(socket, (env as { msg_id?: string }).msg_id ?? "", "responses only");
			}
		}),
	);
	const prompt = envMod.makePromptEnvelope(sender, promptText);
	await envMod.sendEnvelope(bridge.endpoint, prompt);
	return {
		envMod,
		prompt,
		bridgeEndpoint: bridge.endpoint,
		response,
		close: () => {
			try { server.close(); } catch { /* ignore */ }
			try { fs.unlinkSync(sender.endpoint); } catch { /* ignore */ }
		},
	};
}

test("user-remote daemon round-trips coms-cli send --await via a hand-written answer file", async (t) => {
	const f = makeFixture();
	startBridge(t, f);
	await waitForBridge(f);

	const cli = runProcess([CLI, "send", "user-remote", "Can you answer?", "--await", "--project", PROJECT, "--timeout", "5000"], f.env);
	const qid = await waitFor(() => extractQid(readHermesCalls(f)));
	writeAnswer(f, qid, "Yes from Telegram");
	const result = await cli;

	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { kind: "freeform", text: "Yes from Telegram" });
	assert.equal(fs.existsSync(path.join(questionsDir(f), `${qid}.answer.json`)), false);
	const events = readJsonLines(bridgeLogFile(f)).map((r) => r.event);
	assert.deepEqual(events.filter((e) => ["question_received", "delivered", "answered"].includes(e)), ["question_received", "delivered", "answered"]);
});

test("cancel sends a note, emits no response, and late answers log late_answer plus a polite note", async (t) => {
	const f = makeFixture();
	startBridge(t, f);
	const client = await directPrompt(f, "Question to cancel");
	t.after(client.close);
	await waitFor(() => extractQid(readHermesCalls(f)));

	await client.envMod.sendEnvelope(client.bridgeEndpoint, client.envMod.makeCancelEnvelope({
		from: "daemon-test-sender",
		to: "user-remote",
		ref_msg_id: client.prompt.msg_id,
	}));
	await waitFor(() => readHermesCalls(f).find((call) => call.message.includes("was cancelled")));
	writeAnswer(f, client.prompt.msg_id, "Too late");
	await waitFor(() => readHermesCalls(f).find((call) => call.message.includes("already closed")));

	const gotResponse = await Promise.race([client.response.then(() => true), sleep(250).then(() => false)]);
	assert.equal(gotResponse, false);
	const events = readJsonLines(bridgeLogFile(f)).map((r) => r.event);
	assert.ok(events.includes("cancelled"));
	assert.ok(events.includes("late_answer"));
});

test("hermes send delivery failure returns an immediate error envelope", async (t) => {
	const f = makeFixture();
	startBridge(t, f, { env: { HERMES_FAIL_PATTERN: "FAIL_DELIVERY" } });
	await waitForBridge(f);

	const result = await runProcess([CLI, "send", "user-remote", "FAIL_DELIVERY please", "--await", "--project", PROJECT, "--timeout", "5000"], f.env);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /peer error: hermes send failed \(42\): fake hermes failure/);
	const events = readJsonLines(bridgeLogFile(f)).map((r) => r.event);
	assert.ok(events.includes("delivery_error"));
});

test("timeouts use PI_COMS_TIMEOUT_MS by default and return an error plus Telegram note", async (t) => {
	const f = makeFixture();
	startBridge(t, f, { env: { PI_COMS_TIMEOUT_MS: "120" } });
	const client = await directPrompt(f, "Please time out");
	t.after(client.close);

	const response = await client.response;
	assert.equal(response.response, null);
	assert.equal(response.error, "no remote answer within 120ms");
	await waitFor(() => readHermesCalls(f).find((call) => call.message.includes("timed out after 120ms")));
	const events = readJsonLines(bridgeLogFile(f)).map((r) => r.event);
	assert.ok(events.includes("timeout"));
});

test("malformed and foreign answer files are logged, ignored, and a later valid live answer is accepted", async (t) => {
	const f = makeFixture();
	startBridge(t, f);
	const client = await directPrompt(f, "Reject bad answer files first");
	t.after(client.close);
	await waitFor(() => extractQid(readHermesCalls(f)));

	writeAnswer(f, OTHER_QID, "Foreign");
	await waitFor(() => readJsonLines(bridgeLogFile(f)).find((r) => r.event === "answer_rejected" && r.detail.reason === "foreign_qid"));
	const invalidFile = path.join(questionsDir(f), `${client.prompt.msg_id}.answer.json`);
	fs.writeFileSync(invalidFile, JSON.stringify({ qid: client.prompt.msg_id, answer: "missing metadata" }));
	await waitFor(() => readJsonLines(bridgeLogFile(f)).find((r) => r.event === "answer_rejected" && r.detail.reason === "invalid_schema"));

	const earlyResponse = await Promise.race([client.response.then(() => true), sleep(150).then(() => false)]);
	assert.equal(earlyResponse, false);
	writeAnswer(f, client.prompt.msg_id, "Accepted after rejects");
	const response = await client.response;
	assert.deepEqual(response.response, { kind: "freeform", text: "Accepted after rejects" });
	const events = readJsonLines(bridgeLogFile(f)).map((r) => r.event);
	assert.ok(events.includes("answered"));
});

test("a partially written answer file survives one poll and is accepted once the write completes", async (t) => {
	const f = makeFixture();
	startBridge(t, f);
	const client = await directPrompt(f, "Tolerate my slow write");
	t.after(client.close);
	await waitFor(() => extractQid(readHermesCalls(f)));

	const file = path.join(questionsDir(f), `${client.prompt.msg_id}.answer.json`);
	fs.mkdirSync(questionsDir(f), { recursive: true });
	fs.writeFileSync(file, `{"qid": "${client.prompt.msg_id}", "answer": "half-writ`);
	await sleep(120); // several 25ms polls with the file still truncated
	assert.equal(fs.existsSync(file), true, "partial file must not be eaten on first sight");
	writeAnswer(f, client.prompt.msg_id, "Finished write");

	const response = await client.response;
	assert.deepEqual(response.response, { kind: "freeform", text: "Finished write" });
	const rejects = readJsonLines(bridgeLogFile(f)).filter((r) => r.event === "answer_rejected");
	assert.equal(rejects.filter((r) => r.detail.reason !== "invalid_json").length, 0);
});

test("a persistently invalid answer file is eventually rejected as invalid_json and removed", async (t) => {
	const f = makeFixture();
	startBridge(t, f);
	const client = await directPrompt(f, "Reject broken json");
	t.after(client.close);
	await waitFor(() => extractQid(readHermesCalls(f)));

	const file = path.join(questionsDir(f), `${client.prompt.msg_id}.answer.json`);
	fs.mkdirSync(questionsDir(f), { recursive: true });
	fs.writeFileSync(file, "not json at all");
	await waitFor(() => readJsonLines(bridgeLogFile(f)).find((r) => r.event === "answer_rejected" && r.detail.reason === "invalid_json"));
	assert.equal(fs.existsSync(file), false);
});

test("bridge exit removes its registry entry and socket", async () => {
	const f = makeFixture();
	const child = startBridge({ after: () => {} }, f);
	const entry = await waitForBridge(f);
	assert.equal(fs.existsSync(registryFile(f)), true);
	assert.equal(fs.existsSync(entry.endpoint), true);

	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	assert.equal(fs.existsSync(registryFile(f)), false);
	assert.equal(fs.existsSync(entry.endpoint), false);
	fs.rmSync(f.root, { recursive: true, force: true });
});
