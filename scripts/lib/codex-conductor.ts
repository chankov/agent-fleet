// Fail-closed command construction for the pilot-only external Codex conductor.
// It deliberately exposes only the two contract-approved coms operations.

import * as fs from "node:fs";
import * as path from "node:path";

import { validateComsName, validateComsProject } from "./coms-envelope.ts";
import { loadOwnedConfig } from "./codex-remote-control.ts";

export interface ConductorContext {
	repoRoot: string;
	project: string;
	name: string;
	timeoutMs: number;
	conductorCwd: string;
	comsDir: string;
}

export type ConductorOperation =
	| { operation: "list" }
	| { operation: "send"; peer: string; prompt: string };

function realDirectory(value: string, label: string): string {
	try {
		const resolved = fs.realpathSync(value);
		if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
		return resolved;
	} catch {
		throw new Error(`${label} must resolve to an existing directory`);
	}
}

/** Parse before any config/filesystem/process access. No scope overrides exist. */
export function parseConductorArgs(argv: string[]): ConductorOperation {
	const flags = new Set<string>();
	for (const arg of argv) {
		if (!arg.startsWith("--")) continue;
		if (flags.has(arg)) throw new Error(`${arg} may only be provided once`);
		flags.add(arg);
	}
	if (flags.size > 0) throw new Error("flags and scope overrides are not allowed; the owned configuration is authoritative");
	if (argv[0] === "list" && argv.length === 1) return { operation: "list" };
	if (argv[0] === "send") {
		if (argv.length !== 3) throw new Error("send requires exactly a peer and prompt");
		return { operation: "send", peer: argv[1], prompt: argv[2] };
	}
	throw new Error("usage: codex-conductor <list|send <listed-peer> <bounded-prompt>>");
}

export function loadConductorContext(input: { configPath: string; cwd: string; checkoutRoot: string }): ConductorContext {
	const config = loadOwnedConfig(input.configPath);
	const checkoutRoot = realDirectory(input.checkoutRoot, "checkout root");
	if (config.repoRoot !== checkoutRoot) {
		throw new Error("configured repository does not match this checkout");
	}
	const conductorCwd = path.join(config.repoRoot, "codex", "conductor");
	if (realDirectory(input.cwd, "working directory") !== conductorCwd) {
		throw new Error(`working directory must be ${conductorCwd}`);
	}
	validateComsProject(config.project);
	validateComsName(config.name);
	return {
		repoRoot: config.repoRoot,
		project: config.project,
		name: config.name,
		timeoutMs: config.timeoutMs,
		conductorCwd,
		comsDir: realDirectory(config.comsDir, "coms directory"),
	};
}

export function conductorProcessEnv(
	context: ConductorContext,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return { ...base, PI_COMS_DIR: context.comsDir };
}

export function buildConductorCommand(context: ConductorContext, operation: ConductorOperation): string[] {
	if (operation.operation === "list") {
		return ["list", "--project", context.project, "--name", context.name];
	}
	return [
		"send", operation.peer, operation.prompt,
		"--project", context.project, "--name", context.name,
		"--await", "--timeout", String(context.timeoutMs), "--conductor", "codex",
	];
}
