#!/usr/bin/env node
// Repository-side lifecycle CLI. It never pairs automatically and exposes no
// health, PID, or transport assumptions.

import * as os from "node:os";
import * as path from "node:path";

import {
	CONFIG_MARKER,
	EMERGENCY_STOP_CONFIRMATION,
	emergencySystemdStop,
	lifecyclePaths,
	loadOwnedConfig,
	preflight,
	restart,
	setup,
	start,
	status,
	stop,
	systemRunner,
	uninstall,
	unitStart,
	unitStop,
	validateConfig,
	type LifecycleConfig,
} from "./lib/codex-remote-control.ts";

type Flag = "config" | "codex-bin" | "repo-root" | "coms-dir" | "project" | "team" | "name" | "timeout" | "home" | "confirm" | "emergency-confirm";
const FLAGS = new Set<Flag>(["config", "codex-bin", "repo-root", "coms-dir", "project", "team", "name", "timeout", "home", "confirm", "emergency-confirm"]);

function fail(message: string): never { throw new Error(message); }

function parse(argv: string[]): { command: string; flags: Map<Flag, string> } {
	const command = argv[0];
	if (!command) fail("Usage: codex-remote-control <preflight|setup|reconfigure|setup-conductor|reconfigure-conductor|setup-pilot|reconfigure-pilot|pair|start|stop|emergency-stop|status|restart|recover|uninstall|control-pane|unit-start|unit-stop>");
	const flags = new Map<Flag, string>();
	for (let i = 1; i < argv.length; i++) {
		const raw = argv[i];
		if (!raw.startsWith("--")) fail(`Unexpected argument: ${raw}`);
		const flag = raw.slice(2) as Flag;
		if (!FLAGS.has(flag)) fail(`Unknown flag: ${raw}`);
		if (flags.has(flag)) fail(`${raw} may only be provided once`);
		const value = argv[++i];
		if (!value || value.startsWith("--")) fail(`${raw} requires a value`);
		flags.set(flag, value);
	}
	return { command, flags };
}

function required(flags: Map<Flag, string>, flag: Flag): string {
	return flags.get(flag) ?? fail(`--${flag} is required`);
}

function configFromFlags(flags: Map<Flag, string>): LifecycleConfig {
	return validateConfig({
		marker: CONFIG_MARKER,
		codexBin: required(flags, "codex-bin"),
		repoRoot: required(flags, "repo-root"),
		comsDir: required(flags, "coms-dir"),
		project: required(flags, "project"),
		team: required(flags, "team"),
		name: required(flags, "name"),
		timeoutMs: Number(required(flags, "timeout")),
	});
}

function conductorConfigFromFlags(flags: Map<Flag, string>): LifecycleConfig {
	const team = required(flags, "team");
	const project = flags.get("project") ?? "default";
	return validateConfig({
		marker: CONFIG_MARKER,
		codexBin: required(flags, "codex-bin"),
		repoRoot: required(flags, "repo-root"),
		comsDir: required(flags, "coms-dir"),
		project,
		team,
		name: `codex-${team}-conductor`,
		timeoutMs: Number(required(flags, "timeout")),
	});
}

function configPath(flags: Map<Flag, string>): string {
	return flags.get("config") ?? lifecyclePaths(flags.get("home")).configPath;
}

function configured(flags: Map<Flag, string>): LifecycleConfig {
	return loadOwnedConfig(configPath(flags));
}

function pair(config: LifecycleConfig): void {
	const checked = preflight(config);
	const result = systemRunner(checked.codexBin, ["remote-control", "pair"], { stdio: "inherit" });
	if (result.code !== 0) fail(`codex remote-control pair failed (${result.code})`);
}

function controlPane(): void {
	console.log("Codex control pane: displaying requested systemd state only; this is not daemon health.");
	const report = () => console.log(status());
	report();
	const timer = setInterval(report, 5_000);
	const close = () => clearInterval(timer);
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
}

function main(): void {
	const { command, flags } = parse(process.argv.slice(2));
	switch (command) {
		case "preflight": {
			const config = flags.has("repo-root") ? configFromFlags(flags) : validateConfig({
				marker: CONFIG_MARKER,
				codexBin: required(flags, "codex-bin"),
				repoRoot: process.cwd(), comsDir: path.join(os.homedir(), ".pi", "coms"),
				project: "default", team: "codex", name: "codex", timeoutMs: 300_000,
			});
			preflight(config);
			console.log("Codex 0.144.x remote-control start|stop|pair preflight passed");
			return;
		}
		case "setup":
		case "reconfigure":
		case "setup-conductor":
		case "reconfigure-conductor":
		case "setup-pilot":
		case "reconfigure-pilot": {
			const scoped = command.endsWith("-conductor") || command.endsWith("-pilot");
			const paths = setup(scoped ? conductorConfigFromFlags(flags) : configFromFlags(flags), systemRunner, {
				home: flags.get("home"),
				reconfigure: command.startsWith("reconfigure"),
			});
			console.log(`${command} complete: ${paths.unitPath}`);
			return;
		}
		case "pair": pair(configured(flags)); return;
		case "start": console.log(start(configured(flags))); return;
		case "stop": console.log(stop(configured(flags))); return;
		case "emergency-stop": console.log(emergencySystemdStop(configured(flags), systemRunner, required(flags, "confirm"))); return;
		case "status": console.log(status()); return;
		case "control-pane": controlPane(); return;
		case "restart":
		case "recover": console.log(restart(configured(flags), systemRunner, required(flags, "confirm"))); return;
		case "uninstall": {
			const paths = lifecyclePaths(flags.get("home"));
			uninstall(paths, systemRunner, {
				confirmation: required(flags, "confirm"),
				emergencyConfirmation: flags.get("emergency-confirm") === EMERGENCY_STOP_CONFIRMATION ? EMERGENCY_STOP_CONFIRMATION : undefined,
			});
			return;
		}
		case "unit-start": unitStart(configured(flags)); return;
		case "unit-stop": unitStop(configured(flags)); return;
		default: fail(`Unknown command: ${command}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
