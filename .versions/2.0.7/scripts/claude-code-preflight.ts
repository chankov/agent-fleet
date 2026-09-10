// scripts/claude-code-preflight.ts
//
// Fail-fast health check shared by the standalone Fleet peer launcher and the
// `_claude-peer` recipe used by team layouts. Resolving `claude` on PATH is not
// enough: a broken npm install can leave a valid symlink pointing at a
// non-executable placeholder. Running the cheap, non-interactive version command
// proves that the resolved CLI can actually start before Fleet creates a pane or
// starts a coms bridge.

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_CODE_PREFLIGHT_TIMEOUT_MS = 10_000;

export interface ClaudeCodeProbeResult {
	status: number | null;
	signal?: NodeJS.Signals | null;
	stdout?: string | Buffer | null;
	stderr?: string | Buffer | null;
	error?: NodeJS.ErrnoException;
}

export type ClaudeCodeProbe = () => ClaudeCodeProbeResult;

function outputText(value: string | Buffer | null | undefined): string {
	return value == null ? "" : String(value).trim();
}

function detailFrom(result: ClaudeCodeProbeResult): string {
	const detail = outputText(result.stderr) || outputText(result.stdout);
	if (!detail) return "";
	return `: ${detail.replace(/\s+/g, " ").slice(0, 400)}`;
}

function repairHint(): string {
	return "Install or repair Claude Code, then confirm `claude --version` succeeds.";
}

/** Throws an actionable error unless `claude --version` starts and exits zero. */
export function assertClaudeCodeAvailable(
	probe: ClaudeCodeProbe = () =>
		spawnSync("claude", ["--version"], {
			encoding: "utf8",
			timeout: CLAUDE_CODE_PREFLIGHT_TIMEOUT_MS,
		}),
): string {
	const result = probe();
	if (result.error) {
		const code = result.error.code ? ` (${result.error.code})` : "";
		throw new Error(`Claude Code preflight failed: could not run \`claude --version\`${code}: ${result.error.message}. ${repairHint()}`);
	}
	if (result.status !== 0) {
		const outcome = result.signal ? `was terminated by ${result.signal}` : `exited with status ${result.status ?? "unknown"}`;
		throw new Error(`Claude Code preflight failed: \`claude --version\` ${outcome}${detailFrom(result)}. ${repairHint()}`);
	}
	return outputText(result.stdout) || outputText(result.stderr);
}

function main(): void {
	try {
		assertClaudeCodeAvailable();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main();
