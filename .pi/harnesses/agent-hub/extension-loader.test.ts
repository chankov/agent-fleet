import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const piExecutable = join(repoRoot, "node_modules", ".bin", "pi");

const extensionPaths = [
	".pi/harnesses/damage-control-continue/index.ts",
	".pi/harnesses/ask-user-remote/index.ts",
	".pi/harnesses/agent-hub/index.ts",
];

test("Pi loads the guarded agent-hub extension stack through jiti", () => {
	const result = spawnSync(
		piExecutable,
		[
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			...extensionPaths.flatMap((extensionPath) => ["-e", extensionPath]),
		],
		{
			cwd: new URL("../../..", import.meta.url),
			encoding: "utf8",
			env: { ...process.env, PI_OFFLINE: "1" },
		},
	);

	if (result.error) {
		assert.fail(`Failed to spawn repo-local Pi executable "${piExecutable}": ${result.error.message ?? String(result.error)}`);
	}

	const output = `${result.stdout}\n${result.stderr}`;
	assert.equal(result.status, 0, `Pi failed to start (exit ${result.status}):\n${output}`);
	assert.doesNotMatch(output, /Failed to load extension "[^"]+":/);
});
