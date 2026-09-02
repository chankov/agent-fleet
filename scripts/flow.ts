#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeRunId } from "../.pi/harnesses/agent-hub/run-namespace.js";
import { parseFlowCommand, type FlowCommand } from "./lib/flow-command.ts";
import { loadEnv } from "./workflows/lib/env.ts";
import { createFlowBranch, requireCleanTree, StartRefusedError } from "./workflows/lib/git.ts";
import { snapshot } from "./workflows/lib/permissions.ts";
import { Run, type FinishResult } from "./workflows/lib/run.ts";
import { buildTestWorkflow, buildTestWorkflowPreflight } from "./workflows/wf-build-test.ts";
import { documentWorkflow, documentWorkflowPreflight } from "./workflows/wf-document.ts";
import { qualityWorkflow, qualityWorkflowPreflight } from "./workflows/wf-quality.ts";
import { scoutWorkflow, scoutWorkflowPreflight } from "./workflows/wf-scout.ts";

export type Workflow = (run: Run, input: { args: string[]; dryRun: boolean; cwd: string }) => Promise<FinishResult>;
export interface WorkflowDefinition { run: Workflow; validate?: (args: string[]) => void; preflight?: (cwd: string) => void }
export const workflows: Record<string, WorkflowDefinition> = {
	"build-test": {
		run: buildTestWorkflow,
		validate: args => { if (!args.join(" ").trim()) throw Object.assign(new Error("build-test flow requires an implementation request"), { exitCode: 2 }); },
		preflight: buildTestWorkflowPreflight,
	},
	document: { run: documentWorkflow, preflight: documentWorkflowPreflight },
	quality: { run: qualityWorkflow, preflight: qualityWorkflowPreflight },
	scout: {
		run: scoutWorkflow,
		validate: args => { if (!args.join(" ").trim()) throw Object.assign(new Error("scout flow requires a question"), { exitCode: 2 }); },
		preflight: scoutWorkflowPreflight,
	},
};

function workflowExportName(name: string): string {
	return `${name.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())}Workflow`;
}

export async function resolveWorkflow(name: string, workflowsDir = resolve(dirname(fileURLToPath(import.meta.url)), "workflows")): Promise<WorkflowDefinition | undefined> {
	if (workflows[name]) return workflows[name];
	const path = resolve(workflowsDir, `wf-${name}.ts`);
	if (!existsSync(path)) return undefined;
	const module = await import(`${pathToFileURL(path).href}?flow=${Date.now()}`) as Record<string, unknown>;
	const exportName = workflowExportName(name);
	const run = module[exportName];
	if (typeof run !== "function") throw Object.assign(new Error(`Flow ${name} must export ${exportName}().`), { exitCode: 2 });
	const preflight = module[`${exportName}Preflight`];
	if (preflight !== undefined && typeof preflight !== "function") throw Object.assign(new Error(`Flow ${name} has an invalid ${exportName}Preflight export.`), { exitCode: 2 });
	return { run: run as Workflow, ...(typeof preflight === "function" ? { preflight: preflight as (cwd: string) => void } : {}) };
}

export async function executeFlow(command: FlowCommand, options: { cwd?: string; command?: string[]; workflowsDir?: string } = {}): Promise<FinishResult> {
	const cwd = options.cwd ?? process.cwd();
	const workflow = await resolveWorkflow(command.name, options.workflowsDir);
	if (!workflow) throw Object.assign(new Error(`Unknown flow: ${command.name}`), { exitCode: 2 });
	workflow.validate?.(command.args);
	loadEnv(cwd);
	// All refusal checks precede branch creation and the FlowTrace constructor.
	requireCleanTree(cwd, command.allowDirty);
	workflow.preflight?.(cwd);
	const runId = command.runId ?? makeRunId();
	const repositoryBaseline = snapshot(cwd);
	createFlowBranch(command.name, runId, cwd);
	const run = new Run({ cwd, runId, command: options.command ?? process.argv, repositoryBaseline });
	let interruption: FinishResult | undefined;
	const onSignal = (signal: NodeJS.Signals) => {
		if (interruption) return;
		interruption = run.interrupt(signal);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		const result = await workflow.run(run, { args: command.args, dryRun: command.dryRun, cwd });
		const finalResult = interruption ?? result;
		console.error(finalResult.banner);
		return finalResult;
	} catch (error) {
		if (!interruption) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(run.abort(message).banner);
			throw error;
		}
		console.error(interruption.banner);
		return interruption;
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
	}
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	let parsed: FlowCommand;
	try { parsed = parseFlowCommand(argv); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
	try {
		return (await executeFlow(parsed)).exitCode;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		return Number((error as { exitCode?: number })?.exitCode ?? (error instanceof StartRefusedError ? 3 : 1));
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
