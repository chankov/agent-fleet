import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildConductorCommand,
	conductorProcessEnv,
	loadConductorContext,
	parseConductorArgs,
	type ConductorContext,
} from "./codex-conductor.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fixture(t: { after(fn: () => void): void }): { root: string; configPath: string; conductorCwd: string; comsDir: string } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-conductor-test-"));
	const root = path.join(base, "repo");
	const bin = path.join(base, "fake-codex");
	const runtimeDir = path.join(base, "runtime", "codex-conductor");
	const conductorCwd = path.join(runtimeDir, "workspace");
	const comsDir = path.join(base, "coms");
	const configPath = path.join(base, "config.json");
	fs.mkdirSync(conductorCwd, { recursive: true });
	fs.mkdirSync(path.join(root, "codex"), { recursive: true });
	fs.mkdirSync(comsDir, { recursive: true });
	fs.writeFileSync(path.join(root, "codex", "CONDUCTOR.md"), "# test\n");
	fs.writeFileSync(path.join(conductorCwd, "AGENTS.md"), "<!-- Managed by agent-fleet Codex conductor -->\n# test\n");
	fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
	fs.writeFileSync(configPath, JSON.stringify({
		marker: "agent-fleet-codex-remote-control-v1",
		codexBin: bin,
		repoRoot: root,
		runtimeDir,
		comsDir,
		project: "af",
		team: "docs",
		name: "codex-docs-conductor",
		timeoutMs: 300_000,
	}));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	return { root, configPath, conductorCwd, comsDir };
}

test("wrapper allows only list and one configured serialized send", (t) => {
	const { root, configPath, conductorCwd, comsDir } = fixture(t);
	const context = loadConductorContext({ configPath, cwd: conductorCwd, checkoutRoot: root });
	assert.deepEqual(context, {
		repoRoot: root,
		project: "af",
		name: "codex-docs-conductor",
		timeoutMs: 300_000,
		conductorCwd,
		comsDir,
	});
	assert.deepEqual(conductorProcessEnv(context, { PATH: "/usr/bin", PI_COMS_DIR: "/wrong" }), {
		PATH: "/usr/bin",
		PI_COMS_DIR: comsDir,
	});
	assert.deepEqual(parseConductorArgs(["list"]), { operation: "list" });
	assert.deepEqual(parseConductorArgs(["send", "documenter", "Reply with pilot acknowledgement; no files changed"]), {
		operation: "send",
		peer: "documenter",
		prompt: "Reply with pilot acknowledgement; no files changed",
	});
	assert.deepEqual(buildConductorCommand(context, { operation: "list" }), [
		"list", "--project", "af", "--name", "codex-docs-conductor",
	]);
	assert.deepEqual(buildConductorCommand(context, {
		operation: "send", peer: "documenter", prompt: "Reply with pilot acknowledgement; no files changed",
	}), [
		"send", "documenter", "Reply with pilot acknowledgement; no files changed",
		"--project", "af", "--name", "codex-docs-conductor",
		"--await", "--timeout", "300000", "--conductor", "codex",
	]);
});

test("wrapper process uses the configured coms directory instead of ambient PI_COMS_DIR", (t) => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-conductor-home-"));
	const comsDir = path.join(home, "owned-coms");
	const configDir = path.join(home, ".config", "agent-fleet");
	const runtimeDir = path.join(home, ".local", "state", "agent-fleet", "codex-conductor");
	const agentsDir = path.join(comsDir, "projects", "af", "agents");
	const bin = path.join(home, "fake-codex");
	fs.mkdirSync(configDir, { recursive: true });
	fs.mkdirSync(path.join(runtimeDir, "workspace"), { recursive: true });
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
	fs.writeFileSync(path.join(configDir, "codex-remote-control.json"), JSON.stringify({
		marker: "agent-fleet-codex-remote-control-v1",
		codexBin: bin,
		repoRoot: REPO_ROOT,
		runtimeDir,
		comsDir,
		project: "af",
		team: "docs",
		name: "codex-docs-conductor",
		timeoutMs: 300_000,
	}));
	fs.writeFileSync(path.join(runtimeDir, "workspace", "AGENTS.md"), "<!-- Managed by agent-fleet Codex conductor -->\n# test\n");
	fs.writeFileSync(path.join(agentsDir, "documenter.json"), JSON.stringify({
		session_id: "fixture",
		name: "documenter",
		purpose: "fixture peer",
		model: "test",
		color: "#fff",
		pid: process.pid,
		endpoint: path.join(comsDir, "sockets", "fixture.sock"),
		cwd: REPO_ROOT,
		started_at: new Date().toISOString(),
		explicit: false,
		version: 1,
	}));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));

	const result = spawnSync(process.execPath, [
		"--experimental-strip-types",
		path.join(REPO_ROOT, "scripts", "codex-conductor.ts"),
		"list",
	], {
		cwd: path.join(runtimeDir, "workspace"),
		encoding: "utf8",
		env: { ...process.env, HOME: home, PI_COMS_DIR: path.join(home, "wrong-coms") },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^documenter\ttest\tfixture peer$/m);
});

test("wrapper rejects flags before config access and fails closed on cwd or checkout mismatch", (t) => {
	const { root, configPath, conductorCwd } = fixture(t);
	assert.throws(() => parseConductorArgs(["list", "--project", "other"]), /overrides are not allowed/);
	assert.throws(() => parseConductorArgs(["list", "--x", "--x"]), /may only be provided once/);
	assert.throws(() => parseConductorArgs(["send", "documenter"]), /requires exactly a peer and prompt/);
	assert.throws(
		() => loadConductorContext({ configPath, cwd: root, checkoutRoot: root }),
		/working directory must be/,
	);
	const other = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-other-"));
	t.after(() => fs.rmSync(other, { recursive: true, force: true }));
	assert.throws(
		() => loadConductorContext({ configPath, cwd: conductorCwd, checkoutRoot: other }),
		/configured repository does not match/,
	);
});
