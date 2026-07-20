// Process-level contract tests for the standalone coms CLI. Each child receives
// its own PI_COMS_DIR so validation failures can prove they occur before any
// registry or spool filesystem access.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve("scripts/coms-cli.ts");
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

interface Fixture {
	root: string;
	coms: string;
}

interface Result {
	code: number | null;
	stdout: string;
	stderr: string;
}

function makeFixture(t: { after(fn: () => void): void }): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "coms-cli-test-"));
	const fixture = { root, coms: path.join(root, "coms") };
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return fixture;
}

function runCli(fixture: Fixture, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
	const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
		env: { ...process.env, PI_COMS_DIR: fixture.coms, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
	return new Promise((resolve) => child.once("exit", (code) => resolve({ code, stdout, stderr })));
}

function startCli(fixture: Fixture, args: string[]): { child: ReturnType<typeof spawn>; output: () => { stdout: string; stderr: string } } {
	const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
		env: { ...process.env, PI_COMS_DIR: fixture.coms },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
	return { child, output: () => ({ stdout, stderr }) };
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = fn();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out after ${timeoutMs}ms`);
}

function writeRegistryPeer(fixture: Fixture, project: string, name: string, endpoint: string, explicit = false): void {
	const dir = path.join(fixture.coms, "projects", project, "agents");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
		session_id: ID,
		name,
		purpose: "test peer",
		model: "test",
		color: "#FFFFFF",
		pid: process.pid,
		endpoint,
		cwd: process.cwd(),
		started_at: new Date().toISOString(),
		explicit,
		version: 1,
	}));
}

function readLine(socket: net.Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf-8");
			const newline = buf.indexOf("\n");
			if (newline >= 0) resolve(buf.slice(0, newline));
		});
		socket.once("error", reject);
	});
}

async function replyToPrompt(prompt: Record<string, unknown>, response: unknown): Promise<void> {
	const socket = net.createConnection({ path: String(prompt.sender_endpoint) });
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	socket.write(`${JSON.stringify({ type: "response", msg_id: prompt.msg_id, response, error: null })}\n`);
	await readLine(socket);
	socket.end();
}

test("rejects unsafe scope, ids, timeouts, duplicate flags, and unknown flags before filesystem access", async (t) => {
	const fixture = makeFixture(t);
	const cases: Array<{ args: string[]; expected: RegExp }> = [
		{ args: ["list", "--project", "../escape", "--name", "caller"], expected: /Invalid project name/ },
		{ args: ["list", "--project", "safe", "--name", "../caller"], expected: /Invalid coms name/ },
		{ args: ["send", "worker", "hello", "--project", "safe", "--name", "caller", "--await", "--timeout", "1", "--bogus"], expected: /unknown flag: --bogus/ },
		{ args: ["await", ID, "--project", "safe", "--name", "caller", "--timeout", "1", "--timeout", "2"], expected: /--timeout may only be provided once/ },
		{ args: ["await", "bad", "--project", "safe", "--name", "caller", "--timeout", "1"], expected: /Invalid msg_id/ },
		{ args: ["_listen", "--project", "safe", "--name", "caller", "--session", "bad", "--ttl", "1"], expected: /Invalid listen session/ },
		{ args: ["reply", ID, "answer", "--project", "safe", "--name", "caller", "--wat"], expected: /unknown flag: --wat/ },
		{ args: ["await", ID, "--project", "safe", "--name", "caller", "--timeout", "1.5"], expected: /Invalid timeout/ },
	];
	for (const item of cases) {
		const result = await runCli(fixture, item.args);
		assert.equal(result.code, 1, item.args.join(" "));
		assert.match(result.stderr, item.expected, item.args.join(" "));
	}
	assert.equal(fs.existsSync(fixture.coms), false);
});

test("explicit validated flags override environment defaults, while invalid env defaults fail closed", async (t) => {
	const fixture = makeFixture(t);
	const overridden = await runCli(fixture, ["list", "--project", "flag-project", "--name", "flag-name"], {
		COMS_CLI_PROJECT: "../unsafe-project",
		COMS_CLI_NAME: "../unsafe-name",
	});
	assert.equal(overridden.code, 0);
	assert.match(overridden.stdout, /project "flag-project"/);

	const rejected = await runCli(fixture, ["list"], { COMS_CLI_PROJECT: "../unsafe-project" });
	assert.equal(rejected.code, 1);
	assert.match(rejected.stderr, /Invalid project name/);
});

test("never falls back to an explicit peer absent from the current scoped list", async (t) => {
	const fixture = makeFixture(t);
	const endpoint = path.join(fixture.root, "explicit.sock");
	writeRegistryPeer(fixture, "safe", "hidden-peer", endpoint, true);
	const result = await runCli(fixture, ["send", "hidden-peer", "hello", "--project", "safe", "--name", "caller", "--await", "--timeout", "10"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /not found in project "safe"/);
	assert.equal(fs.existsSync(path.join(fixture.coms, "cli")), false);
});

test("refuses legacy name-only spools instead of silently consuming them across projects", async (t) => {
	const fixture = makeFixture(t);
	const legacy = path.join(fixture.coms, "cli", "caller", "responses");
	fs.mkdirSync(legacy, { recursive: true });
	fs.writeFileSync(path.join(legacy, `${ID}.json`), JSON.stringify({ response: "legacy", error: null }));

	const result = await runCli(fixture, ["await", ID, "--project", "project-b", "--name", "caller", "--timeout", "1"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Legacy name-only coms spool exists/);
	assert.equal(fs.existsSync(path.join(fixture.coms, "cli", "projects", "project-b", "caller")), false);
});

test("await reads only the validated project-specific spool", async (t) => {
	const fixture = makeFixture(t);
	const source = path.join(fixture.coms, "cli", "projects", "project-a", "caller", "responses");
	fs.mkdirSync(source, { recursive: true });
	fs.writeFileSync(path.join(source, `${ID}.json`), JSON.stringify({ response: "project-a", error: null }));

	const result = await runCli(fixture, ["await", ID, "--project", "project-b", "--name", "caller", "--timeout", "1"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /timeout: no reply/);
	assert.equal(fs.existsSync(path.join(fixture.coms, "cli", "projects", "project-b", "caller", "responses", `${ID}.json`)), false);
});

test("_listen rejects an invalid incoming msg_id before creating a spool file", async (t) => {
	const fixture = makeFixture(t);
	const listener = startCli(fixture, ["_listen", "--project", "safe", "--name", "caller", "--session", ID, "--ttl", "5000"]);
	t.after(() => { if (listener.child.exitCode === null) listener.child.kill("SIGTERM"); });
	await waitFor(() => listener.output().stdout.includes("READY"));
	const endpoint = path.join(fixture.coms, "sockets", `${ID}.sock`);
	const socket = net.createConnection({ path: endpoint });
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	socket.write(`${JSON.stringify({ type: "response", msg_id: "../../escape", response: "nope" })}\n`);
	assert.match(await readLine(socket), /"type":"nack"/);
	socket.end();
	const spool = path.join(fixture.coms, "cli", "projects", "safe", "caller");
	assert.deepEqual(fs.readdirSync(path.join(spool, "responses")), []);
	assert.equal(fs.existsSync(path.join(spool, "escape.json")), false);
	listener.child.kill("SIGTERM");
	await new Promise((resolve) => listener.child.once("exit", resolve));
});

test("serializes Codex awaited sends with a process-level lock and releases it after a response", async (t) => {
	const fixture = makeFixture(t);
	const endpoint = path.join(fixture.root, "worker.sock");
	const prompts: Array<Record<string, unknown>> = [];
	const server = net.createServer((socket) => {
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf-8");
			const newline = buf.indexOf("\n");
			if (newline < 0) return;
			const prompt = JSON.parse(buf.slice(0, newline)) as Record<string, unknown>;
			prompts.push(prompt);
			socket.write(`${JSON.stringify({ type: "ack", msg_id: prompt.msg_id })}\n`);
			socket.end();
		});
	});
	await new Promise<void>((resolve, reject) => server.listen(endpoint, () => resolve()).once("error", reject));
	t.after(() => server.close());
	writeRegistryPeer(fixture, "safe", "worker", endpoint);

	const common = ["send", "worker", "hold", "--project", "safe", "--name", "codex", "--await", "--timeout", "5000", "--conductor", "codex"];
	const first = startCli(fixture, common);
	t.after(() => { if (first.child.exitCode === null) first.child.kill("SIGTERM"); });
	await waitFor(() => prompts[0] && first.output().stderr.includes("awaiting reply"));
	assert.equal(fs.existsSync(path.join(fixture.coms, "locks", "codex-send.lock")), true);

	const second = await runCli(fixture, common);
	assert.equal(second.code, 1);
	assert.match(second.stderr, /Codex send lock is held/);
	assert.equal(prompts.length, 1);

	await replyToPrompt(prompts[0], "first complete");
	const firstExit = await new Promise<number | null>((resolve) => first.child.once("exit", resolve));
	assert.equal(firstExit, 0);
	assert.equal(fs.existsSync(path.join(fixture.coms, "locks", "codex-send.lock")), false);

	const third = startCli(fixture, common);
	t.after(() => { if (third.child.exitCode === null) third.child.kill("SIGTERM"); });
	await waitFor(() => prompts[1] && third.output().stderr.includes("awaiting reply"));
	await replyToPrompt(prompts[1], "third complete");
	const thirdExit = await new Promise<number | null>((resolve) => third.child.once("exit", resolve));
	assert.equal(thirdExit, 0);
});

test("Codex mode requires explicit scoped awaited options and rejects --all", async (t) => {
	const fixture = makeFixture(t);
	const cases = [
		["send", "worker", "hello", "--project", "safe", "--name", "codex", "--await", "--conductor", "codex"],
		["send", "worker", "hello", "--project", "safe", "--name", "codex", "--timeout", "1", "--conductor", "codex"],
		["send", "worker", "hello", "--project", "safe", "--name", "codex", "--await", "--timeout", "1", "--all", "--conductor", "codex"],
	];
	for (const args of cases) {
		const result = await runCli(fixture, args);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /Codex mode requires|Codex mode does not allow --all/);
	}
});
