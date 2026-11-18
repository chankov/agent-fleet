/**
 * fleet-config/cli-bridge — run the deterministic Fleet CLI from a live
 * session and hand its JSON back to the screen.
 *
 * Decision D6 of the plan: prefer the recorded `sourceRoot` checkout or npm
 * root (`<sourceRoot>/bin/cli.js`); otherwise `npx` pinned to the recorded
 * package version — never `@latest`, which would plan an upgrade. Without a
 * recorded version the CLI is "unavailable", which the screen shows as such.
 *
 * Nothing here decides what the CLI does. Mutating flags are refused unless the
 * caller states a confirmed intent (phase 3), so a screen cannot write by
 * accident. The process is spawned without a shell and bounded in time.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_NAME } from "../update-check.ts";

export const FLEET_CLI_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const STDERR_EXCERPT = 2000;
/** Flags that make a Fleet verb write or run something. `--dry-run` previews stay allowed. */
export const MUTATING_FLAGS = new Set(["--yes", "-y", "--fix", "--force", "--allow-exec", "--purge-config", "--repair-config", "--migrate"]);

export type CliResolution =
	| { kind: "source"; command: string; args: string[]; root: string }
	| { kind: "npx"; command: string; args: string[]; version: string }
	| { kind: "unavailable"; reason: string };

export interface ResolveInput { sourceRoot: string | null; recordedVersion: string | null; exists?: (path: string) => boolean; nodePath?: string }

export function resolveFleetCli({ sourceRoot, recordedVersion, exists = existsSync, nodePath = process.execPath }: ResolveInput): CliResolution {
	if (sourceRoot) {
		const cli = join(sourceRoot, "bin", "cli.js");
		if (exists(cli)) return { kind: "source", command: nodePath, args: [cli], root: sourceRoot };
	}
	if (recordedVersion && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(recordedVersion)) {
		return { kind: "npx", command: "npx", args: ["--yes", `${PACKAGE_NAME}@${recordedVersion}`], version: recordedVersion };
	}
	return { kind: "unavailable", reason: sourceRoot ? `no bin/cli.js under ${sourceRoot} and no recorded package version to pin npx to` : "no recorded source root or package version" };
}

export interface CliRunResult { status: number | null; stdout: string; stderr: string; error?: string; timedOut?: boolean }
export type CliRunner = (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<CliRunResult>;

/** Default runner: no shell, stdin closed, bounded capture, SIGTERM then SIGKILL on timeout. */
export const spawnRunner: CliRunner = (command, args, { cwd, timeoutMs }) => new Promise(resolve => {
	let child;
	try { child = spawn(command, args, { cwd, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
	catch (error) { resolve({ status: null, stdout: "", stderr: "", error: (error as Error).message }); return; }
	let stdout = "", stderr = "", timedOut = false, settled = false;
	const finish = (result: CliRunResult) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killer); resolve(result); };
	const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGTERM"); } catch {} }, timeoutMs);
	const killer = setTimeout(() => { if (timedOut) { try { child.kill("SIGKILL"); } catch {} } }, timeoutMs + 5000);
	child.stdout.on("data", chunk => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += String(chunk); });
	child.stderr.on("data", chunk => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += String(chunk); });
	child.on("error", error => finish({ status: null, stdout, stderr, error: error.message, timedOut }));
	child.on("close", status => finish({ status, stdout, stderr, timedOut }));
});

export type FleetCliOutcome =
	| { ok: true; json: unknown; exitCode: number; resolution: CliResolution; stderr: string }
	| { ok: false; reason: "unavailable" | "refused" | "spawn" | "timeout" | "exit" | "not-json"; detail: string; resolution: CliResolution; exitCode?: number | null; stderr?: string };

export interface RunInput {
	cwd: string;
	/** Fleet verb and flags, e.g. ["inspect"]; `--workspace <cwd>` is appended when absent. */
	argv: string[];
	resolution: CliResolution;
	runner?: CliRunner;
	timeoutMs?: number;
	/** Phase 3 only: a confirmed human intent. Without it every mutating flag is refused before spawn. */
	allowMutation?: boolean;
}

export async function runFleetCli({ cwd, argv, resolution, runner = spawnRunner, timeoutMs = FLEET_CLI_TIMEOUT_MS, allowMutation = false }: RunInput): Promise<FleetCliOutcome> {
	if (resolution.kind === "unavailable") return { ok: false, reason: "unavailable", detail: resolution.reason, resolution };
	const mutating = argv.filter(flag => MUTATING_FLAGS.has(flag));
	if (mutating.length && !allowMutation) return { ok: false, reason: "refused", detail: `mutating flag${mutating.length === 1 ? "" : "s"} ${mutating.join(" ")} without a confirmed intent`, resolution };
	const args = [...resolution.args, ...argv, ...(argv.includes("--workspace") ? [] : ["--workspace", cwd])];
	const result = await runner(resolution.command, args, { cwd, timeoutMs });
	const stderr = result.stderr.slice(0, STDERR_EXCERPT);
	if (result.error) return { ok: false, reason: "spawn", detail: result.error, resolution, stderr };
	if (result.timedOut) return { ok: false, reason: "timeout", detail: `no result within ${Math.round(timeoutMs / 1000)}s`, resolution, exitCode: result.status, stderr };
	const text = result.stdout.trim();
	if (text.startsWith("{") || text.startsWith("[")) {
		try { return { ok: true, json: JSON.parse(text), exitCode: result.status ?? 0, resolution, stderr }; } catch { /* fall through */ }
	}
	if (result.status !== 0) return { ok: false, reason: "exit", detail: `exit ${result.status}${stderr ? `: ${stderr.split("\n")[0]}` : ""}`, resolution, exitCode: result.status, stderr };
	return { ok: false, reason: "not-json", detail: "the CLI did not print a JSON document", resolution, exitCode: result.status, stderr };
}

/** The shape the screen consumes from `agent-fleet inspect` (fields it does not render are untyped). */
export interface InspectReport {
	schemaVersion: number; verb: "inspect"; packageVersion: string; platform: string; agent: string | null;
	installation: { status: string; reason: string | null };
	verify?: { error?: string; recordedVersion?: string | null; stateSource?: string; baseAvailable?: boolean; summary?: { total: number; installed: number; present: number; broken: number; upgradable: number; findings: number; problems: number; advisories: number; versionDrift: boolean; byState: Record<string, number> }; items?: Array<{ id: string; kind: string; state: string; owned: boolean; target: string | null; detail: string | null; retired: boolean; changedFiles: Array<{ path: string; state: string; detail: string | null }>; obsoleteFiles: number }>; findings?: Array<{ type: string; path: string; issue: string; fix: string; severity?: string }> };
	doctor?: { error?: string; findings?: Array<{ type: string; path: string; issue: string; fix: string; classification?: string }>; preflight?: { status: string; missingFiles: string[]; tools: Array<{ itemId: string; probe: string; status: string }>; remediation: string[] } };
	desired?: { error?: string | null; status?: string; preset?: string | null; enabled?: string[]; presets?: string[]; effective?: { preset: string; features: string[]; roots: number; selected: number } | null; featureError?: string | null; catalogue?: Array<{ name: string; title: string; stability: string; platform: string; requiresFeatures: string[]; items: string[]; enabled: boolean; effective: boolean; available: boolean }> };
	provenance?: { error?: string | null; status?: string; entries?: number };
}

export function isInspectReport(value: unknown): value is InspectReport {
	return !!value && typeof value === "object" && (value as { verb?: unknown }).verb === "inspect";
}

export async function runInspectCli(input: Omit<RunInput, "argv">): Promise<FleetCliOutcome> {
	const outcome = await runFleetCli({ ...input, argv: ["inspect"] });
	if (outcome.ok && !isInspectReport(outcome.json)) return { ok: false, reason: "not-json", detail: "the CLI answered, but not with an inspect report", resolution: outcome.resolution, exitCode: outcome.exitCode, stderr: outcome.stderr };
	return outcome;
}
