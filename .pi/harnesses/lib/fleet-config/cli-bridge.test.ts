import assert from "node:assert/strict";
import test from "node:test";
import { FLEET_CLI_TIMEOUT_MS, resolveFleetCli, runFleetCli, runInspectCli, spawnRunner, type CliRunner } from "./cli-bridge.ts";

const source = resolveFleetCli({ sourceRoot: "/pkg", recordedVersion: "2.0.14", exists: path => path === "/pkg/bin/cli.js", nodePath: "/usr/bin/node" });
const fake = (result: Partial<Awaited<ReturnType<CliRunner>>>, calls: unknown[] = []): CliRunner => async (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: "", stderr: "", ...result }; };

test("D6 resolution: source root first, then npx pinned to the recorded version, never @latest", () => {
	assert.deepEqual(source, { kind: "source", command: "/usr/bin/node", args: ["/pkg/bin/cli.js"], root: "/pkg" });
	const npx = resolveFleetCli({ sourceRoot: "/gone", recordedVersion: "2.0.14", exists: () => false });
	assert.deepEqual(npx, { kind: "npx", command: "npx", args: ["--yes", "@chankov/agent-fleet@2.0.14"], version: "2.0.14" });
	assert.ok(!JSON.stringify(npx).includes("latest"));
	assert.equal(resolveFleetCli({ sourceRoot: null, recordedVersion: null }).kind, "unavailable");
	assert.equal(resolveFleetCli({ sourceRoot: "/gone", recordedVersion: "not a version", exists: () => false }).kind, "unavailable");
});

test("mutating flags are refused before any spawn unless a confirmed intent is passed", async () => {
	const calls: unknown[] = [];
	const refused = await runFleetCli({ cwd: "/ws", argv: ["setup", "--yes"], resolution: source, runner: fake({}, calls) });
	assert.deepEqual(refused, { ok: false, reason: "refused", detail: "mutating flag --yes without a confirmed intent", resolution: source });
	assert.equal(calls.length, 0);
	const preview = await runFleetCli({ cwd: "/ws", argv: ["setup", "--dry-run", "--json"], resolution: source, runner: fake({ stdout: '{"stage":"preview","conflicts":[]}', status: 3 }, calls) });
	assert.ok(preview.ok); assert.equal(preview.exitCode, 3, "a conflict preview still returns its JSON with the exit code");
	assert.deepEqual((calls[0] as any).args, ["/pkg/bin/cli.js", "setup", "--dry-run", "--json", "--workspace", "/ws"]);
	assert.equal((calls[0] as any).options.timeoutMs, FLEET_CLI_TIMEOUT_MS);
	const allowed = await runFleetCli({ cwd: "/ws", argv: ["setup", "--yes", "--json"], resolution: source, runner: fake({ stdout: "{}" }, calls), allowMutation: true });
	assert.ok(allowed.ok); assert.equal(calls.length, 2);
});

test("outcomes: unavailable, spawn error, timeout, non-zero exit, non-JSON, and an inspect report check", async () => {
	const unavailable = resolveFleetCli({ sourceRoot: null, recordedVersion: null });
	assert.equal((await runFleetCli({ cwd: "/ws", argv: ["inspect"], resolution: unavailable, runner: fake({}) })).ok, false);
	assert.equal((await runFleetCli({ cwd: "/ws", argv: ["inspect"], resolution: source, runner: fake({ error: "ENOENT", status: null }) }) as any).reason, "spawn");
	assert.equal((await runFleetCli({ cwd: "/ws", argv: ["inspect"], resolution: source, runner: fake({ timedOut: true, status: null }) }) as any).reason, "timeout");
	const exit = await runFleetCli({ cwd: "/ws", argv: ["inspect"], resolution: source, runner: fake({ status: 1, stderr: "agent-fleet: workspace is not a directory\nmore" }) });
	assert.deepEqual([(exit as any).reason, (exit as any).detail], ["exit", "exit 1: agent-fleet: workspace is not a directory"]);
	assert.equal((await runFleetCli({ cwd: "/ws", argv: ["inspect"], resolution: source, runner: fake({ stdout: "Workspace: /ws\n" }) }) as any).reason, "not-json");
	const wrong = await runInspectCli({ cwd: "/ws", resolution: source, runner: fake({ stdout: '{"verb":"verify"}' }) });
	assert.equal((wrong as any).reason, "not-json");
	const right = await runInspectCli({ cwd: "/ws", resolution: source, runner: fake({ stdout: '{"verb":"inspect","schemaVersion":1}' }) });
	assert.ok(right.ok && (right.json as any).verb === "inspect");
});

test("the default runner spawns without a shell, preserves argument boundaries and enforces the timeout", async () => {
	const echo = await spawnRunner(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", "a b", "$HOME", "`x`"], { cwd: process.cwd(), timeoutMs: 10_000 });
	assert.equal(echo.status, 0); assert.deepEqual(JSON.parse(echo.stdout), ["a b", "$HOME", "`x`"]);
	const slow = await spawnRunner(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: process.cwd(), timeoutMs: 200 });
	assert.equal(slow.timedOut, true);
	const missing = await spawnRunner("/definitely/not/a/binary", [], { cwd: process.cwd(), timeoutMs: 1000 });
	assert.ok(missing.error);
});
