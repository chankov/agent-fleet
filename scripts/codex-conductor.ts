#!/usr/bin/env node
// Pilot-only external Codex conductor wrapper. It exposes no lifecycle,
// pairing, authentication, Herdr, or scope-override functionality.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildConductorCommand, conductorProcessEnv, loadConductorContext, parseConductorArgs } from "./lib/codex-conductor.ts";
import { lifecyclePaths } from "./lib/codex-remote-control.ts";

function main(): void {
	// Parse flags before config or filesystem access, then bind all scope from
	// the owned configuration and the dedicated conductor working directory.
	const operation = parseConductorArgs(process.argv.slice(2));
	const checkoutRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
	const context = loadConductorContext({
		configPath: lifecyclePaths().configPath,
		cwd: process.cwd(),
		checkoutRoot,
	});
	const result = spawnSync(process.execPath, [
		"--experimental-strip-types",
		path.join(context.repoRoot, "scripts", "coms-cli.ts"),
		...buildConductorCommand(context, operation),
	], {
		cwd: context.conductorCwd,
		stdio: "inherit",
		env: conductorProcessEnv(context),
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
