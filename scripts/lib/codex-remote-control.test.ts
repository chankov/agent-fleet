import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	EMERGENCY_STOP_CONFIRMATION,
	UNIT_NAME,
	emergencyStop,
	emergencySystemdStop,
	loadOwnedConfig,
	preflight,
	renderUnit,
	restart,
	setup,
	start,
	status,
	stop,
	unitStart,
	uninstall,
	type CommandRunner,
	type LifecycleConfig,
} from "./codex-remote-control.ts";

interface Call { file: string; args: string[]; options?: { stdio?: "inherit"; env?: Record<string, string | undefined> }; }

function fixture(t: { after(fn: () => void): void }): { root: string; config: LifecycleConfig } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-codex-test-"));
	const repo = path.join(root, "repo");
	const bin = path.join(root, "codex");
	const comsDir = path.join(root, "coms");
	fs.mkdirSync(path.join(repo, "codex", "conductor"), { recursive: true });
	fs.mkdirSync(comsDir, { recursive: true });
	fs.writeFileSync(path.join(repo, "codex", "conductor", "AGENTS.md"), "# test contract\n");
	fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return {
		root,
		config: {
			marker: "agent-fleet-codex-remote-control-v1",
			codexBin: bin,
			repoRoot: repo,
			comsDir,
			project: "af",
			team: "docs",
			name: "codex-conductor",
			timeoutMs: 30_000,
		},
	};
}

function runner(settings: { version?: string; missing?: string[]; state?: string; approvalPolicy?: string } = {}): { runner: CommandRunner; calls: Call[] } {
	const calls: Call[] = [];
	const missing = new Set(settings.missing ?? []);
	return {
		calls,
		runner: (file, args, options) => {
			calls.push({ file, args, options });
			if (args[0] === "--version") return { code: 0, stdout: settings.version ?? "codex-cli 0.144.6\n", stderr: "" };
			if (args.join(" ") === "doctor --json") return {
				code: 0,
				stdout: JSON.stringify({ checks: { "sandbox.helpers": { details: { "approval policy": settings.approvalPolicy ?? "OnRequest" } } } }),
				stderr: "",
			};
			if (args.join(" ") === "remote-control --help") return { code: 0, stdout: "Commands: start stop pair\n", stderr: "" };
			if (args[0] === "remote-control" && args[2] === "--help") {
				return missing.has(args[1]) ? { code: 2, stdout: "", stderr: "unknown command" } : { code: 0, stdout: `usage: remote-control ${args[1]}\n`, stderr: "" };
			}
			if (file === "systemctl" && args.includes("show")) return { code: 0, stdout: settings.state ?? "ActiveState=inactive\nSubState=dead\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	};
}

test("preflight accepts only codex-cli 0.144.x with all exact remote-control capabilities", (t) => {
	const { config } = fixture(t);
	const { runner: run, calls } = runner();
	assert.doesNotThrow(() => preflight(config, run));
	assert.deepEqual(calls.map(({ args }) => args), [
		["--version"],
		["doctor", "--json"],
		["remote-control", "--help"],
		["remote-control", "start", "--help"],
		["remote-control", "stop", "--help"],
		["remote-control", "pair", "--help"],
	]);
});

test("preflight rejects version drift, non-interactive global approval, and missing capabilities before any start", (t) => {
	const { config } = fixture(t);
	for (const options of [
		{ version: "codex-cli 0.145.0\n" },
		{ approvalPolicy: "Never" },
		{ missing: ["pair"] },
	]) {
		const { runner: run, calls } = runner(options);
		assert.throws(() => preflight(config, run), /Unsupported Codex CLI|approval_policy must be on-request|Missing required Codex capability/);
		assert.equal(calls.some(({ args }) => args.join(" ") === "remote-control start"), false);
	}
});

test("unit start always preflights immediately before the daemonizing start command", (t) => {
	const { config } = fixture(t);
	const { runner: run, calls } = runner();
	unitStart(config, run);
	assert.deepEqual(calls.at(-1)?.file, config.codexBin);
	assert.deepEqual(calls.at(-1)?.args, [
		"remote-control", "start",
		"-c", 'approval_policy="on-request"',
		"-c", 'sandbox_mode="workspace-write"',
		"-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([config.comsDir])}`,
	]);
	assert.deepEqual(calls.at(-1)?.options?.env, {
		AGENT_FLEET_REPO_ROOT: config.repoRoot,
		PI_COMS_DIR: config.comsDir,
		COMS_CLI_PROJECT: "af",
		COMS_CLI_NAME: "codex-conductor",
		COMS_CLI_TIMEOUT_MS: "30000",
		AGENT_FLEET_CODEX_CONTRACT_PATH: path.join(config.repoRoot, "codex", "conductor", "AGENTS.md"),
		AGENT_FLEET_CODEX_CONTRACT_IDENTITY: "agent-fleet-codex-conductor-pilot-v1",
		AGENT_FLEET_CONDUCTOR_BACKEND: "codex",
	});
	assert.deepEqual(calls.slice(-2).map(({ args }) => args), [
		["remote-control", "pair", "--help"],
		[
			"remote-control", "start",
			"-c", 'approval_policy="on-request"',
			"-c", 'sandbox_mode="workspace-write"',
			"-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([config.comsDir])}`,
		],
	]);
});

test("unit start rejects invalid context before spawning Codex", (t) => {
	const { config } = fixture(t);
	const fake = runner();
	assert.throws(() => unitStart({ ...config, project: "../other" }, fake.runner), /Invalid project/);
	assert.equal(fake.calls.length, 0);
});

test("emergency stop after version drift requires only a currently proven exact stop capability", (t) => {
	const { config } = fixture(t);
	const supported = runner({ version: "codex-cli 0.145.0\n" });
	emergencyStop(config, supported.runner, EMERGENCY_STOP_CONFIRMATION);
	assert.deepEqual(supported.calls.at(-1)?.file, config.codexBin);
	assert.deepEqual(supported.calls.at(-1)?.args, ["remote-control", "stop"]);
	assert.equal(supported.calls.some(({ args }) => args[0] === "--version"), false);

	const unsupported = runner({ version: "codex-cli 0.145.0\n", missing: ["stop"] });
	assert.throws(() => emergencyStop(config, unsupported.runner, EMERGENCY_STOP_CONFIRMATION), /Missing required Codex stop capability/);
	assert.equal(unsupported.calls.some(({ args }) => args.join(" ") === "remote-control stop"), false);
});

test("operator emergency stop keeps systemd as service owner after version drift", (t) => {
	const { config } = fixture(t);
	const drifted = runner({ version: "codex-cli 0.145.0\n", state: "ActiveState=active\nSubState=exited\n" });
	assert.equal(emergencySystemdStop(config, drifted.runner, EMERGENCY_STOP_CONFIRMATION), "stopped");
	assert.equal(drifted.calls.some(({ args }) => args.join(" ") === "remote-control stop"), false);
	assert.equal(drifted.calls.at(-1)?.args.join(" "), `--user stop ${UNIT_NAME}`);
});

test("normal start fails closed on version drift before systemd start", (t) => {
	const { config } = fixture(t);
	const drifted = runner({ version: "codex-cli 0.145.0\n" });
	assert.throws(() => start(config, drifted.runner), /Unsupported Codex CLI/);
	assert.equal(drifted.calls.some(({ file, args }) => file === "systemctl" && args.includes("start")), false);
});

test("rendered user unit uses oneshot requested-state semantics and invokes helper entrypoints", (t) => {
	const { root, config } = fixture(t);
	const unit = renderUnit(config, {
		nodeBin: "/usr/bin/node",
		scriptPath: path.join(root, "scripts", "codex-remote-control.ts"),
		configPath: path.join(root, "config.json"),
	});
	assert.match(unit, /^Type=oneshot$/m);
	assert.match(unit, /^RemainAfterExit=yes$/m);
	assert.match(unit, /ExecStart=.* unit-start --config /);
	assert.match(unit, /ExecStop=.* unit-stop --config /);
	assert.match(unit, new RegExp(`Environment=AGENT_FLEET_REPO_ROOT=${config.repoRoot}`));
	assert.match(unit, new RegExp(`Environment=PI_COMS_DIR=${config.comsDir}`));
	assert.match(unit, /Environment=COMS_CLI_PROJECT=af/);
	assert.match(unit, /Environment=COMS_CLI_NAME=codex-conductor/);
	assert.doesNotMatch(unit, /^Restart=/m);
	assert.doesNotMatch(unit, /remote-control (?:start|stop|pair)/);
	assert.doesNotMatch(unit, /(?:token|password|credential|pairing code|api[_-]?key)=/i);
});

test("setup renders owned files, reloads, and enables without pairing or starting", (t) => {
	const { root, config } = fixture(t);
	const fake = runner();
	const paths = setup(config, fake.runner, { home: root, nodeBin: "/usr/bin/node", scriptPath: "/opt/scripts/codex-remote-control.ts" });
	assert.equal(fs.statSync(paths.configPath).mode & 0o777, 0o600);
	assert.match(fs.readFileSync(paths.unitPath, "utf8"), /Agent Fleet Codex remote-control/);
	assert.deepEqual(fake.calls.slice(-2).map(({ file, args }) => [file, args]), [
		["systemctl", ["--user", "daemon-reload"]],
		["systemctl", ["--user", "enable", UNIT_NAME]],
	]);
	assert.equal(fake.calls.some(({ args }) => args.join(" ") === "remote-control pair" || args.join(" ") === "remote-control start"), false);
	assert.equal(loadOwnedConfig(paths.configPath).codexBin, config.codexBin);
});

test("requested-state lifecycle is idempotent only for active exited or inactive states", (t) => {
	const { root, config } = fixture(t);
	const active = runner({ state: "ActiveState=active\nSubState=exited\n" });
	assert.equal(start(config, active.runner), "already-active");
	assert.equal(active.calls.some(({ file, args }) => file === "systemctl" && args.includes("start")), false);

	const inactive = runner({ state: "ActiveState=inactive\nSubState=dead\n" });
	assert.equal(start(config, inactive.runner), "started");
	assert.equal(inactive.calls.at(-1)?.args.join(" "), `--user start ${UNIT_NAME}`);
	assert.equal(stop(config, inactive.runner), "already-inactive");

	const unknown = runner({ state: "ActiveState=failed\nSubState=failed\n" });
	assert.throws(() => start(config, unknown.runner), /Refusing start/);
	assert.throws(() => stop(config, unknown.runner), /Refusing stop/);
	assert.match(status(unknown.runner), /requested systemd state: failed \(failed\)/);

	const recovered = runner({ state: "ActiveState=active\nSubState=exited\n" });
	assert.equal(restart(config, recovered.runner, "operator-confirmed"), "restarted");
	assert.equal(recovered.calls.at(-1)?.args.join(" "), `--user start ${UNIT_NAME}`);
	assert.ok(recovered.calls.some(({ args }) => args.join(" ") === `--user stop ${UNIT_NAME}`));
});

test("uninstall refuses non-owned files and removes only owned files after confirmed drift-safe stop", (t) => {
	const { root, config } = fixture(t);
	const paths = { configPath: path.join(root, "config.json"), unitPath: path.join(root, "unit.service") };
	fs.writeFileSync(paths.configPath, JSON.stringify(config), { mode: 0o600 });
	fs.writeFileSync(paths.unitPath, "# Managed by agent-fleet codex remote-control\n", { mode: 0o644 });
	const fake = runner({ version: "codex-cli 0.145.0\n", state: "ActiveState=active\nSubState=exited\n" });
	uninstall(paths, fake.runner, { confirmation: "operator-confirmed", emergencyConfirmation: EMERGENCY_STOP_CONFIRMATION });
	assert.equal(fs.existsSync(paths.configPath), false);
	assert.equal(fs.existsSync(paths.unitPath), false);
	assert.ok(fake.calls.some(({ args }) => args.join(" ") === `--user stop ${UNIT_NAME}`));
	assert.ok(fake.calls.some(({ args }) => args.join(" ") === `--user disable ${UNIT_NAME}`));

	fs.writeFileSync(paths.unitPath, "[Service]\n");
	assert.throws(() => uninstall(paths, runner().runner, { confirmation: "operator-confirmed" }), /not owned/);
});
