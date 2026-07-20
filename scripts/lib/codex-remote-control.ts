// Validated, non-secret lifecycle helpers for the experimental Codex user unit.
// `active (exited)` is only systemd's requested state; it is never health.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const UNIT_NAME = "agent-fleet-codex-remote-control.service";
export const CONFIG_MARKER = "agent-fleet-codex-remote-control-v1";
export const UNIT_MARKER = "# Managed by agent-fleet codex remote-control";
export const EMERGENCY_STOP_CONFIRMATION = "emergency-stop-confirmed";
export const CODEX_CONTRACT_IDENTITY = "agent-fleet-codex-conductor-pilot-v1";
const RECOVERY_CONFIRMATION = "operator-confirmed";
const MAX_TIMEOUT_MS = 0x7fffffff;
// Observed remote-control teardown needs a bounded settle period before a
// fresh daemon start; this is not a health probe or a transport assumption.
const RESTART_SETTLE_MS = 8_000;
const NAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PROJECT_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CommandOptions {
	stdio?: "inherit";
	env?: Record<string, string | undefined>;
}

export type CommandRunner = (file: string, args: string[], options?: CommandOptions) => CommandResult;

export interface LifecycleConfig {
	marker: typeof CONFIG_MARKER;
	codexBin: string;
	repoRoot: string;
	comsDir: string;
	project: string;
	team: string;
	name: string;
	timeoutMs: number;
}

export interface LifecyclePaths {
	configPath: string;
	unitPath: string;
}

export interface RenderOptions {
	nodeBin: string;
	scriptPath: string;
	configPath: string;
}

function fail(message: string): never {
	throw new Error(message);
}

function runOrFail(run: CommandRunner, file: string, args: string[], options?: CommandOptions): CommandResult {
	const result = run(file, args, options);
	if (result.code !== 0) fail(`${file} ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
	return result;
}

export const systemRunner: CommandRunner = (file, args, options = {}) => {
	const result = spawnSync(file, args, {
		encoding: "utf8",
		stdio: options.stdio === "inherit" ? "inherit" : "pipe",
		env: options.env ? { ...process.env, ...options.env } : process.env,
	});
	if (result.error) throw result.error;
	return {
		code: result.status ?? 1,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
};

function absoluteFile(value: string, label: string): string {
	if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
	try {
		return fs.realpathSync(value);
	} catch {
		fail(`${label} must resolve to an existing path: ${value}`);
	}
}

function safeValue(value: string, label: string, safe: RegExp): string {
	if (!safe.test(value) || value.includes("..")) fail(`Invalid ${label}: ${JSON.stringify(value)}`);
	return value;
}

export function validateConfig(input: LifecycleConfig): LifecycleConfig {
	if (!input || input.marker !== CONFIG_MARKER) fail("Codex lifecycle config is not owned by agent-fleet");
	const codexBin = absoluteFile(input.codexBin, "codexBin");
	const repoRoot = absoluteFile(input.repoRoot, "repoRoot");
	if (!fs.statSync(repoRoot).isDirectory()) fail("repoRoot must be a directory");
	// `comsDir` was added after the first pilot config was installed. Loading an
	// owned v1 config may derive the same user-scoped default once, while every
	// newly written config persists the validated absolute path explicitly.
	const comsDir = absoluteFile(input.comsDir ?? path.join(os.homedir(), ".pi", "coms"), "comsDir");
	if (!fs.statSync(comsDir).isDirectory()) fail("comsDir must be a directory");
	const project = safeValue(input.project, "project", PROJECT_SAFE);
	const team = safeValue(input.team, "team", NAME_SAFE);
	const name = safeValue(input.name, "name", NAME_SAFE);
	if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMEOUT_MS) {
		fail(`Invalid timeoutMs: ${JSON.stringify(input.timeoutMs)}`);
	}
	return { marker: CONFIG_MARKER, codexBin, repoRoot, comsDir, project, team, name, timeoutMs: input.timeoutMs };
}

function capability(run: CommandRunner, bin: string, command: "start" | "stop" | "pair"): void {
	const result = run(bin, ["remote-control", command, "--help"]);
	if (result.code !== 0) fail(`Missing required Codex capability: remote-control ${command}`);
}

function requireGlobalOnRequest(run: CommandRunner, bin: string): void {
	const output = runOrFail(run, bin, ["doctor", "--json"]).stdout;
	let policy: unknown;
	try {
		const report = JSON.parse(output) as {
			checks?: Record<string, { details?: Record<string, unknown> }>;
		};
		policy = report.checks?.["sandbox.helpers"]?.details?.["approval policy"];
	} catch {
		fail("Unable to parse redacted Codex doctor output while checking approval policy");
	}
	if (policy !== "OnRequest") {
		fail(`Codex global approval_policy must be on-request for mobile approvals (doctor reported ${JSON.stringify(policy)})`);
	}
}

/** Non-mutating compatibility gate for every normal start/setup lifecycle path. */
export function preflight(input: LifecycleConfig, run: CommandRunner = systemRunner): LifecycleConfig {
	const config = validateConfig(input);
	const version = runOrFail(run, config.codexBin, ["--version"]).stdout.trim();
	if (!/^codex-cli 0\.144\.\d+(?:\s|$)/.test(version)) {
		fail(`Unsupported Codex CLI version: ${JSON.stringify(version)}; only codex-cli 0.144.x is supported`);
	}
	requireGlobalOnRequest(run, config.codexBin);
	const remoteHelp = runOrFail(run, config.codexBin, ["remote-control", "--help"]).stdout;
	for (const command of ["start", "stop", "pair"] as const) {
		if (!new RegExp(`(?:^|\\s)${command}(?:\\s|$)`, "m").test(remoteHelp)) {
			fail(`Missing required Codex capability: remote-control ${command}`);
		}
		capability(run, config.codexBin, command);
	}
	return config;
}

/** The sole version-drift exception: prove only the exact stop command, then run it. */
export function verifyEmergencyStopCapability(input: LifecycleConfig, run: CommandRunner = systemRunner, confirmation?: string): LifecycleConfig {
	if (confirmation !== EMERGENCY_STOP_CONFIRMATION) fail("Emergency stop requires explicit operator confirmation");
	const config = validateConfig(input);
	const remoteHelp = runOrFail(run, config.codexBin, ["remote-control", "--help"]).stdout;
	if (!/(?:^|\s)stop(?:\s|$)/m.test(remoteHelp)) fail("Missing required Codex stop capability");
	const stopHelp = run(config.codexBin, ["remote-control", "stop", "--help"]);
	if (stopHelp.code !== 0) fail("Missing required Codex stop capability");
	return config;
}

export function emergencyStop(input: LifecycleConfig, run: CommandRunner = systemRunner, confirmation?: string): void {
	const config = verifyEmergencyStopCapability(input, run, confirmation);
	runOrFail(run, config.codexBin, ["remote-control", "stop"]);
}

export function remoteThreadEnv(input: LifecycleConfig): Record<string, string> {
	const config = validateConfig(input);
	const contractPath = path.join(config.repoRoot, "codex", "conductor", "AGENTS.md");
	if (absoluteFile(contractPath, "contractPath") !== contractPath) {
		fail("Dedicated Codex conductor contract path must be a real path under repoRoot");
	}
	return {
		AGENT_FLEET_REPO_ROOT: config.repoRoot,
		PI_COMS_DIR: config.comsDir,
		COMS_CLI_PROJECT: config.project,
		COMS_CLI_NAME: config.name,
		COMS_CLI_TIMEOUT_MS: String(config.timeoutMs),
		AGENT_FLEET_CODEX_CONTRACT_PATH: contractPath,
		AGENT_FLEET_CODEX_CONTRACT_IDENTITY: CODEX_CONTRACT_IDENTITY,
		AGENT_FLEET_CONDUCTOR_BACKEND: "codex",
	};
}

export function remoteControlStartArgs(input: LifecycleConfig): string[] {
	const config = validateConfig(input);
	return [
		"remote-control", "start",
		"-c", 'approval_policy="on-request"',
		"-c", 'sandbox_mode="workspace-write"',
		"-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([config.comsDir])}`,
	];
}

/** Used by ExecStart, so direct systemctl starts cannot skip the verified posture. */
export function unitStart(input: LifecycleConfig, run: CommandRunner = systemRunner): void {
	const config = preflight(input, run);
	runOrFail(run, config.codexBin, remoteControlStartArgs(config), { env: remoteThreadEnv(config) });
}

/** Used by ExecStop. It intentionally supports only the checked emergency-stop path. */
export function unitStop(input: LifecycleConfig, run: CommandRunner = systemRunner): void {
	emergencyStop(input, run, EMERGENCY_STOP_CONFIRMATION);
}

export function assertConductorContext(
	input: LifecycleConfig,
	expected: { repoRoot: string; project: string; team: string; name: string; timeoutMs: number; contractPath: string; contractIdentity: string },
): LifecycleConfig {
	const config = validateConfig(input);
	if (
		config.repoRoot !== expected.repoRoot ||
		config.project !== expected.project ||
		config.team !== expected.team ||
		config.name !== expected.name ||
		config.timeoutMs !== expected.timeoutMs ||
		expected.contractIdentity !== CODEX_CONTRACT_IDENTITY
	) {
		fail("Configured Codex conductor context does not match the requested repository/project/conductor identity");
	}
	const expectedContract = path.join(config.repoRoot, "codex", "conductor", "AGENTS.md");
	if (expected.contractPath !== expectedContract || absoluteFile(expected.contractPath, "contractPath") !== expectedContract) {
		fail("Configured Codex contract path does not match the dedicated conductor contract");
	}
	return config;
}

export function lifecyclePaths(home = os.homedir()): LifecyclePaths {
	return {
		configPath: path.join(home, ".config", "agent-fleet", "codex-remote-control.json"),
		unitPath: path.join(home, ".config", "systemd", "user", UNIT_NAME),
	};
}

function unitEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/ /g, "\\x20").replace(/"/g, "\\\"");
}

function sourceTemplatePath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "systemd", "user", "agent-fleet-codex-remote-control.service.in");
}

export function renderUnit(input: LifecycleConfig, options: RenderOptions): string {
	const config = validateConfig(input);
	for (const [label, value] of Object.entries(options)) {
		if (!path.isAbsolute(value)) fail(`${label} must be an absolute path`);
	}
	const template = fs.readFileSync(sourceTemplatePath(), "utf8");
	const environment = remoteThreadEnv(config);
	const values: Record<string, string> = {
		"{{WORKING_DIRECTORY}}": unitEscape(config.repoRoot),
		"{{NODE_BIN}}": unitEscape(options.nodeBin),
		"{{SCRIPT_PATH}}": unitEscape(options.scriptPath),
		"{{CONFIG_PATH}}": unitEscape(options.configPath),
		"{{AGENT_FLEET_REPO_ROOT}}": unitEscape(environment.AGENT_FLEET_REPO_ROOT),
		"{{PI_COMS_DIR}}": unitEscape(environment.PI_COMS_DIR),
		"{{COMS_CLI_PROJECT}}": unitEscape(environment.COMS_CLI_PROJECT),
		"{{COMS_CLI_NAME}}": unitEscape(environment.COMS_CLI_NAME),
		"{{COMS_CLI_TIMEOUT_MS}}": unitEscape(environment.COMS_CLI_TIMEOUT_MS),
		"{{AGENT_FLEET_CODEX_CONTRACT_PATH}}": unitEscape(environment.AGENT_FLEET_CODEX_CONTRACT_PATH),
		"{{AGENT_FLEET_CODEX_CONTRACT_IDENTITY}}": unitEscape(environment.AGENT_FLEET_CODEX_CONTRACT_IDENTITY),
		"{{AGENT_FLEET_CONDUCTOR_BACKEND}}": unitEscape(environment.AGENT_FLEET_CONDUCTOR_BACKEND),
	};
	return Object.entries(values).reduce((rendered, [token, value]) => rendered.replaceAll(token, value), template);
}

function writeAtomic(filePath: string, contents: string, mode: number): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
	fs.writeFileSync(temporary, contents, { mode });
	fs.chmodSync(temporary, mode);
	fs.renameSync(temporary, filePath);
}

export function loadOwnedConfig(configPath: string): LifecycleConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch {
		fail(`Unable to read owned Codex lifecycle config: ${configPath}`);
	}
	return validateConfig(parsed as LifecycleConfig);
}

function unitOwned(unitPath: string): boolean {
	try { return fs.readFileSync(unitPath, "utf8").startsWith(UNIT_MARKER); } catch { return false; }
}

function assertNoForeignFiles(paths: LifecyclePaths, reconfigure: boolean): void {
	if (fs.existsSync(paths.configPath)) {
		loadOwnedConfig(paths.configPath);
		if (!reconfigure) fail(`Owned Codex lifecycle config already exists; use reconfigure instead of setup`);
	}
	if (fs.existsSync(paths.unitPath) && !unitOwned(paths.unitPath)) fail(`Refusing to replace unit not owned by agent-fleet: ${paths.unitPath}`);
}

export function setup(input: LifecycleConfig, run: CommandRunner = systemRunner, options: Partial<RenderOptions & { home: string; reconfigure: boolean }> = {}): LifecyclePaths {
	const config = preflight(input, run);
	const paths = lifecyclePaths(options.home);
	assertNoForeignFiles(paths, options.reconfigure === true);
	const nodeBin = options.nodeBin ?? process.execPath;
	const scriptPath = options.scriptPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "codex-remote-control.ts");
	writeAtomic(paths.configPath, `${JSON.stringify(config, null, "\t")}\n`, 0o600);
	writeAtomic(paths.unitPath, renderUnit(config, { nodeBin, scriptPath, configPath: paths.configPath }), 0o644);
	runOrFail(run, "systemctl", ["--user", "daemon-reload"]);
	runOrFail(run, "systemctl", ["--user", "enable", UNIT_NAME]);
	return paths;
}

interface RequestedState { active: string; sub: string; }

function requestedState(run: CommandRunner): RequestedState {
	const output = runOrFail(run, "systemctl", ["--user", "show", UNIT_NAME, "--property=ActiveState", "--property=SubState"]).stdout;
	const values = Object.fromEntries(output.split("\n").flatMap((line) => {
		const index = line.indexOf("=");
		return index < 0 ? [] : [[line.slice(0, index), line.slice(index + 1)]];
	}));
	return { active: values.ActiveState ?? "unknown", sub: values.SubState ?? "unknown" };
}

export function status(run: CommandRunner = systemRunner): string {
	const state = requestedState(run);
	return `requested systemd state: ${state.active} (${state.sub}); this is not daemon health`;
}

export function start(input: LifecycleConfig, run: CommandRunner = systemRunner): "started" | "already-active" {
	preflight(input, run);
	const state = requestedState(run);
	if (state.active === "active" && state.sub === "exited") return "already-active";
	if (state.active !== "inactive" || state.sub !== "dead") fail(`Refusing start from requested systemd state ${state.active} (${state.sub})`);
	runOrFail(run, "systemctl", ["--user", "start", UNIT_NAME]);
	return "started";
}

export function stop(input: LifecycleConfig, run: CommandRunner = systemRunner): "stopped" | "already-inactive" {
	preflight(input, run);
	const state = requestedState(run);
	if (state.active === "inactive" && state.sub === "dead") return "already-inactive";
	if (state.active !== "active" || state.sub !== "exited") fail(`Refusing stop from requested systemd state ${state.active} (${state.sub})`);
	runOrFail(run, "systemctl", ["--user", "stop", UNIT_NAME]);
	return "stopped";
}

/** Operator-facing drift exception: systemd remains the sole service owner. */
export function emergencySystemdStop(input: LifecycleConfig, run: CommandRunner = systemRunner, confirmation?: string): "stopped" | "already-inactive" {
	verifyEmergencyStopCapability(input, run, confirmation);
	const state = requestedState(run);
	if (state.active === "inactive" && state.sub === "dead") return "already-inactive";
	if (state.active !== "active" || state.sub !== "exited") fail(`Refusing emergency stop from requested systemd state ${state.active} (${state.sub})`);
	runOrFail(run, "systemctl", ["--user", "stop", UNIT_NAME]);
	return "stopped";
}

export function restart(input: LifecycleConfig, run: CommandRunner = systemRunner, confirmation?: string): "restarted" {
	if (confirmation !== RECOVERY_CONFIRMATION) fail("Recovery requires explicit operator confirmation");
	const config = preflight(input, run);
	const state = requestedState(run);
	if (state.active !== "active" || state.sub !== "exited") fail(`Refusing recovery from requested systemd state ${state.active} (${state.sub})`);
	runOrFail(run, "systemctl", ["--user", "stop", UNIT_NAME]);
	// Test runners are synchronous mocks; only the real lifecycle needs the
	// bounded teardown interval observed on the authorized host.
	if (run === systemRunner) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RESTART_SETTLE_MS);
	preflight(config, run);
	runOrFail(run, "systemctl", ["--user", "start", UNIT_NAME]);
	return "restarted";
}

export function uninstall(paths: LifecyclePaths, run: CommandRunner = systemRunner, options: { confirmation?: string; emergencyConfirmation?: string } = {}): void {
	if (options.confirmation !== RECOVERY_CONFIRMATION) fail("Uninstall requires explicit operator confirmation");
	if (!unitOwned(paths.unitPath)) fail(`Refusing to remove unit not owned by agent-fleet: ${paths.unitPath}`);
	const config = loadOwnedConfig(paths.configPath);
	try {
		preflight(config, run);
	} catch (error) {
		if (options.emergencyConfirmation !== EMERGENCY_STOP_CONFIRMATION) throw error;
		// Drift-safe removal is allowed only after the exact current stop command is proved.
		verifyEmergencyStopCapability(config, run, options.emergencyConfirmation);
	}
	const state = requestedState(run);
	if (state.active === "active" && state.sub === "exited") runOrFail(run, "systemctl", ["--user", "stop", UNIT_NAME]);
	else if (state.active !== "inactive" || state.sub !== "dead") fail(`Refusing uninstall from requested systemd state ${state.active} (${state.sub})`);
	runOrFail(run, "systemctl", ["--user", "disable", UNIT_NAME]);
	fs.unlinkSync(paths.unitPath);
	fs.unlinkSync(paths.configPath);
	runOrFail(run, "systemctl", ["--user", "daemon-reload"]);
	runOrFail(run, "systemctl", ["--user", "reset-failed", UNIT_NAME]);
}
