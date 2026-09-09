import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Run } from "./run.ts";

export interface QualityResult { argv: string[]; exitCode: number; stdout: string; stderr: string; logPath: string; passed: boolean }
export interface VerifyEnvelope { status: "success" | "fail"; summary: string; artifacts: string[]; notes_for_next_agent: string; tests_run: string[] }

function splitArgv(value: string): string[] {
	const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	return matches.map(part => part.replace(/^("|')|("|')$/g, ""));
}

export function qualityCommand(cwd = process.cwd()): string[] {
	const override = resolve(cwd, ".ai", "agent-fleet-overrides.md");
	if (!existsSync(override)) throw Object.assign(new Error("Flow start refused: configure `quality:` under `## workflows` in .ai/agent-fleet-overrides.md."), { exitCode: 3 });
	const text = readFileSync(override, "utf8");
	const heading = text.match(/^## workflows\s*$/m);
	const sectionStart = heading == null ? -1 : heading.index! + heading[0].length;
	const tail = sectionStart < 0 ? "" : text.slice(sectionStart);
	const nextHeading = tail.search(/^##\s/m);
	const section = nextHeading < 0 ? tail : tail.slice(0, nextHeading);
	const configured = section.match(/^quality\s*:\s*(.+)$/m)?.[1]?.trim();
	const argv = configured ? splitArgv(configured) : [];
	if (!argv.length) throw Object.assign(new Error("Flow start refused: configure a non-empty `quality:` argv under `## workflows` in .ai/agent-fleet-overrides.md."), { exitCode: 3 });
	return argv;
}

export async function executeQuality(argv: string[], options: { cwd?: string; logPath: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<QualityResult> {
	const cwd = options.cwd ?? process.cwd();
	const timeoutMs = (options.timeoutSeconds ?? 1800) * 1000;
	if (!argv.length || !argv[0]) throw new Error("Quality command requires a non-empty argv list");
	const result = await new Promise<{ code: number; stdout: string; stderr: string }>(resolveResult => {
		const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "", settled = false;
		let timer: NodeJS.Timeout;
		const onAbort = () => { stderr += "\nCancelled by flow signal"; child.kill("SIGTERM"); };
		const finish = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); resolveResult({ code, stdout, stderr }); } };
		if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", chunk => { stdout += chunk; });
		child.stderr?.on("data", chunk => { stderr += chunk; });
		child.on("error", error => { stderr += error.message; finish((error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1); });
		child.on("close", code => finish(code ?? 1));
		timer = setTimeout(() => { stderr += `\nTimed out after ${timeoutMs}ms`; child.kill("SIGTERM"); finish(1); }, timeoutMs);
	});
	const body = [`$ ${argv.join(" ")}`, result.stdout, result.stderr, `exit ${result.code}`].filter(Boolean).join("\n");
	writeFileSync(options.logPath, body, "utf8");
	return { argv, exitCode: result.code, stdout: result.stdout, stderr: result.stderr, logPath: options.logPath, passed: result.code === 0 };
}

export async function runTests(run: Run, options: { cwd?: string; argv?: string[]; timeoutSeconds?: number } = {}): Promise<QualityResult> {
	const cwd = options.cwd ?? process.cwd();
	return executeQuality(options.argv ?? qualityCommand(cwd), { cwd, timeoutSeconds: options.timeoutSeconds, signal: run.signal, logPath: resolve(run.trace.directory, "command.log") });
}

export function asEnvelope(result: QualityResult, what: string): VerifyEnvelope {
	return {
		status: result.passed ? "success" : "fail",
		summary: result.passed ? `${what} passed` : `${what} failed with exit ${result.exitCode}`,
		artifacts: [result.logPath],
		notes_for_next_agent: result.passed ? "" : (result.stderr || result.stdout).slice(-4000),
		tests_run: [`${result.argv.join(" ")} → ${result.exitCode}`],
	};
}
