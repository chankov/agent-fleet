#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PHASE_DOCSTRING = /\/\*\*\s*Phases:\s*([^\n*]+)[\s\S]*?\*\//;
const SAFE_NAME = /^[a-z][a-z0-9-]*$/;
export type PhaseKind = "engineer" | "agent" | "code";
export interface WorkflowShape { path: string; name: string; source: string; phases: string[]; kinds: PhaseKind[] }
export interface CommandResult { status: number | null; stdout?: string; stderr?: string }
export type CommandRunner = (command: string, args: string[], cwd: string) => CommandResult;

export function parsePhaseList(value: string): string[] {
	const phases: string[] = [];
	let start = 0;
	let depth = 0;
	for (let index = 0; index < value.length; index++) {
		if (value[index] === "(") depth++;
		else if (value[index] === ")") {
			if (depth === 0) throw new Error("Unbalanced phase parentheses.");
			depth--;
		} else if (depth === 0 && (value[index] === "→" || value[index] === "," || value.slice(index, index + 2) === "->")) {
			const phase = value.slice(start, index).trim();
			if (phase) phases.push(phase);
			if (value.slice(index, index + 2) === "->") index++;
			start = index + 1;
		}
	}
	if (depth !== 0) throw new Error("Unbalanced phase parentheses.");
	const finalPhase = value.slice(start).trim();
	if (finalPhase) phases.push(finalPhase);
	if (!phases.length) throw new Error("At least one phase is required.");
	return phases;
}

export function phaseKind(phase: string): PhaseKind {
	const explicit = phase.match(/^\s*(engineer|agent|code)\s*\(/i)?.[1]?.toLowerCase() as PhaseKind | undefined;
	if (explicit) return explicit;
	const name = phase.toLowerCase().replace(/[^a-z0-9-]/g, "");
	if (/^(request|input|brief|goal)/.test(name)) return "engineer";
	if (/^(test|quality|verify|lint|typecheck|commit|changes|capture)/.test(name)) return "code";
	return "agent";
}

export function readWorkflowShapes(workflowsDir: string): WorkflowShape[] {
	return readdirSync(workflowsDir)
		.filter(file => /^wf-[a-z0-9-]+\.ts$/.test(file))
		.sort()
		.map(file => {
			const path = resolve(workflowsDir, file);
			const source = readFileSync(path, "utf8");
			const match = source.match(PHASE_DOCSTRING);
			if (!match) throw new Error(`${file} has no /** Phases: ... */ docstring.`);
			const phases = parsePhaseList(match[1]);
			return { path, name: file.slice(3, -3), source, phases, kinds: phases.map(phaseKind) };
		});
}

function editDistance(left: PhaseKind[], right: PhaseKind[]): number {
	const row = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		let diagonal = row[0];
		row[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const above = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return row[right.length];
}

export function selectNearestWorkflow(shapes: WorkflowShape[], requestedPhases: string[]): WorkflowShape {
	if (!shapes.length) throw new Error("No scripts/workflows/wf-*.ts sources were found.");
	const requestedKinds = requestedPhases.map(phaseKind);
	return [...shapes].sort((left, right) => {
		const leftScore = editDistance(left.kinds, requestedKinds) * 100 + Math.abs(left.kinds.length - requestedKinds.length) * 10;
		const rightScore = editDistance(right.kinds, requestedKinds) * 100 + Math.abs(right.kinds.length - requestedKinds.length) * 10;
		return leftScore - rightScore || left.name.localeCompare(right.name);
	})[0];
}

export function workflowExportName(name: string): string {
	return `${name.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())}Workflow`;
}

export function renameWorkflowSymbols(source: string, sourceName: string, targetName: string): string {
	const sourceWorkflow = workflowExportName(sourceName);
	const targetWorkflow = workflowExportName(targetName);
	const sourcePreflight = `${sourceWorkflow}Preflight`;
	const targetPreflight = `${targetWorkflow}Preflight`;
	return source
		.replace(new RegExp(`\\b${sourcePreflight}\\b`, "g"), targetPreflight)
		.replace(new RegExp(`\\b${sourceWorkflow}\\b`, "g"), targetWorkflow);
}

export function replacePhaseDocstring(source: string, phases: string[]): string {
	if (!PHASE_DOCSTRING.test(source)) throw new Error("Source workflow has no phase docstring to replace.");
	const phaseList = phases.join(" → ");
	const replacement = `/** Phases: ${phaseList}\n * TODO: Choose executable gates for claims that require repository evidence.\n * TODO: Choose bounded retry limits for phases that can be corrected safely.\n * TODO: Define the final acceptance condition independently from phase completion.\n */`;
	return source.replace(PHASE_DOCSTRING, replacement);
}

const defaultRunner: CommandRunner = (command, args, cwd) => {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr || result.error?.message };
};

function gateFailure(label: string, result: CommandResult): Error {
	const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	return new Error(`${label} failed${result.status === null ? " to start" : ` with exit ${result.status}`}${detail ? `:\n${detail}` : "."}`);
}

export function makeWorkflow(options: {
	cwd: string; name: string; phases: string[]; workflowsDir?: string; runner?: CommandRunner;
}): { outputPath: string; sourcePath: string; phases: string[] } {
	if (!SAFE_NAME.test(options.name)) throw new Error(`Invalid workflow name: ${options.name}`);
	const workflowsDir = resolve(options.workflowsDir ?? resolve(options.cwd, "scripts/workflows"));
	const outputPath = resolve(workflowsDir, `wf-${options.name}.ts`);
	if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing workflow: ${outputPath}`);
	const nearest = selectNearestWorkflow(readWorkflowShapes(workflowsDir), options.phases);
	const copied = renameWorkflowSymbols(nearest.source, nearest.name, options.name);
	writeFileSync(outputPath, replacePhaseDocstring(copied, options.phases), "utf8");
	const runner = options.runner ?? defaultRunner;
	try {
		const tsc = resolve(options.cwd, "node_modules/.bin/tsc");
		const compile = runner(tsc, ["-p", resolve(workflowsDir, "tsconfig.json"), "--noEmit"], options.cwd);
		if (compile.status !== 0) throw gateFailure("Scoped workflow typecheck", compile);
		const dryRun = runner(process.execPath, ["--experimental-strip-types", resolve(options.cwd, "skills/drafting-workflows/scripts/make-workflow.ts"), "--verify-draft", outputPath], options.cwd);
		if (dryRun.status !== 0) throw gateFailure("Generated workflow dry run", dryRun);
		return { outputPath, sourcePath: nearest.path, phases: [...options.phases] };
	} catch (error) {
		rmSync(outputPath, { force: true });
		throw error;
	}
}

export async function verifyDraft(path: string, cwd = process.cwd()): Promise<void> {
	const resolvedPath = resolve(path);
	const workflowName = basename(resolvedPath).replace(/^wf-/, "").replace(/\.ts$/, "");
	const flowModulePath = resolve(cwd, "scripts/flow.ts");
	const { resolveWorkflow } = await import(`${pathToFileURL(flowModulePath).href}?verify=${Date.now()}`) as {
		resolveWorkflow(name: string, workflowsDir?: string): Promise<{ run: (run: unknown, input: { args: string[]; dryRun: boolean; cwd: string }) => Promise<{ accepted: boolean }> } | undefined>;
	};
	const entry = await resolveWorkflow(workflowName, dirname(resolvedPath));
	if (!entry) throw new Error(`${basename(path)} is not reachable as flow ${workflowName}.`);
	const runModulePath: string = resolve(dirname(path), "lib/run.ts");
	const { Run } = await import(pathToFileURL(runModulePath).href) as { Run: new (options: { cwd: string; runId: string; command: string[] }) => unknown };
	const run = new Run({ cwd, runId: `draft-${process.pid}-${Date.now()}`, command: ["make-workflow", "--verify-draft", path] });
	const result = await entry.run(run, {
		args: ["generated workflow acceptance request"], dryRun: true, cwd,
	});
	if (!result?.accepted) throw new Error(`${basename(path)} dry run was not accepted.`);
}

async function main(argv: string[]): Promise<number> {
	try {
		if (argv[0] === "--verify-draft") {
			if (!argv[1]) throw new Error("--verify-draft requires a workflow path.");
			await verifyDraft(argv[1]);
			return 0;
		}
		if (argv.length < 2) throw new Error("Usage: make-workflow <name> '<phase → phase → phase>'");
		const phases = parsePhaseList(argv.slice(1).join(" "));
		const result = makeWorkflow({ cwd: process.cwd(), name: argv[0], phases });
		console.log(JSON.stringify({ workflow: result.outputPath, copiedFrom: result.sourcePath, phases: result.phases }));
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
