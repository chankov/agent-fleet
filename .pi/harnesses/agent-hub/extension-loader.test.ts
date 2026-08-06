import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const piExecutable = join(repoRoot, "node_modules", ".bin", "pi");

const extensionPaths = [
	".pi/harnesses/damage-control-continue/index.ts",
	".pi/harnesses/ask-user-remote/index.ts",
	".pi/harnesses/agent-hub/index.ts",
];

function runExtensionStack(cwd: string, extraArgs: string[] = []) {
	return spawnSync(
		piExecutable,
		[
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			...extensionPaths.flatMap((extensionPath) => ["-e", extensionPath]),
			...extraArgs,
		],
		{
			cwd,
			encoding: "utf8",
			env: { ...process.env, PI_OFFLINE: "1" },
		},
	);
}

function assertExtensionStackLoaded(result: ReturnType<typeof spawnSync>) {
	if (result.error) {
		assert.fail(`Failed to spawn repo-local Pi executable "${piExecutable}": ${result.error.message ?? String(result.error)}`);
	}

	const output = `${result.stdout}\n${result.stderr}`;
	assert.equal(result.status, 0, `Pi failed to start (exit ${result.status}):\n${output}`);
	assert.doesNotMatch(output, /Failed to load extension "[^"]+":/);
	assert.doesNotMatch(output, /failed to load pi-ask-user/);
	assert.doesNotMatch(output, /Unknown option: --solo/);
}

test("Pi loads the guarded agent-hub extension stack through jiti", () => {
	assertExtensionStackLoaded(runExtensionStack(repoRoot));
});

test("Pi loads a symlinked hub after a package-only update", () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-fleet-symlink-loader-"));
	try {
		for (const harness of ["damage-control-continue", "ask-user-remote", "agent-hub", "lib"]) {
			const target = join(workspace, ".pi", "harnesses", harness);
			mkdirSync(dirname(target), { recursive: true });
			symlinkSync(join(repoRoot, ".pi", "harnesses", harness), target, "dir");
		}
		// A package-only install hoists agent-fleet's production dependencies into
		// the consuming workspace's node_modules; it does not install the nested
		// .pi/harnesses/package.json. Mirror that layout so this regression test
		// cannot pass only because a developer ran `just fleet install` locally.
		symlinkSync(join(repoRoot, "node_modules"), join(workspace, "node_modules"), "dir");

		const manifest = JSON.parse(readFileSync(join(repoRoot, "bin", "catalog", "harness-runtime-closure.json"), "utf8"));
		for (const relativePath of manifest.files.filter((value: string) => value.startsWith("scripts/"))) {
			const target = join(workspace, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			cpSync(join(repoRoot, relativePath), target);
		}

		assertExtensionStackLoaded(runExtensionStack(workspace, ["--solo"]));
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
