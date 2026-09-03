import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface SpawnPiAgentOptions {
	model: string; tools: string; thinking: string; systemPrompt?: string; noSkills?: boolean; noContextFiles?: boolean;
	sessionFile: string; resume?: boolean; prompt: string; cwd?: string; extensions?: string[]; detached?: boolean;
	signal?: AbortSignal; toolWatchdog?: { timeoutMs: number | null }; turnDeadlineMs?: number | null;
}
interface SpawnPiAgentResult { output: string; exitCode: number | null; assistantError?: string; spawnError?: string; stderr?: string }
interface SpawnCallbacks { onProcess?(process: ChildProcess): void; onUsage?(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): void }
type SpawnFallback = (options: SpawnPiAgentOptions, fallbackModel?: string, callbacks?: SpawnCallbacks, fallbackOptions?: { midRun?: boolean }) => Promise<SpawnPiAgentResult>;
const promptModulePath: string = "../../../.pi/harnesses/lib/context-budget-child-prompt.ts";
const contextModulePath: string = "../../../.pi/harnesses/agent-hub/context-window.js";
const spawnModulePath: string = "../../../.pi/harnesses/agent-hub/spawn.ts";
const { buildSpecialistContextManifest, nativeSpecialistSystemPrompt } = await import(promptModulePath) as {
	buildSpecialistContextManifest(options: Record<string, unknown>): unknown;
	nativeSpecialistSystemPrompt(options: Record<string, unknown>): string;
};
const { estimatePromptTokens, resolveContextWindow, shouldRecycleBeforeSpawn } = await import(contextModulePath) as {
	estimatePromptTokens(text: string): number;
	resolveContextWindow(model: string, options: { lookup?: AgentPhaseOptions["modelLookup"]; fallbackWindow?: number }): { window: number };
	shouldRecycleBeforeSpawn(options: { priorTokens: number; promptTokens: number; window: number }): { message: string } | null;
};
const { spawnPiAgentWithModelFallback } = await import(spawnModulePath) as { spawnPiAgentWithModelFallback: SpawnFallback };
import { envelopePrompt, parseWithCorrections, type EnvelopeName } from "./envelopes.ts";
import { gateCorrectionPrompt, type Gate, type GateReport } from "./gates.ts";
import { enforce, snapshot, type PermissionPolicy } from "./permissions.ts";
import { resolvePhaseModel, resolvePhaseThinking, type PersonaDefinition } from "./personas.ts";
import type { Run } from "./run.ts";

export type SpawnAgent = SpawnFallback;
export interface AgentPhaseOptions<T = unknown> {
	run: Run; persona: PersonaDefinition; task: string; envelope: EnvelopeName; cwd?: string;
	spawn?: SpawnAgent; modelLookup?: (provider: string, modelId: string) => unknown; contextWindow?: number;
	toolWatchdogMs?: number; turnDeadlineMs?: number; rulesPaths?: string[]; docsPaths?: string[];
	gates?: Gate<T>[]; gateRetries?: number; protectedGlobs?: string[]; permissionPolicy?: PermissionPolicy;
	model?: string; thinking?: string; sessionTag?: string;
}

export function modelTag(model: string): string {
	return model.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function phaseSessionKey(personaName: string, modelOverride?: string, sessionTag?: string): string {
	const parts = [personaName.toLowerCase()];
	if (modelOverride !== undefined) parts.push(modelTag(modelOverride));
	if (sessionTag) parts.push(modelTag(sessionTag));
	return parts.join("-");
}

interface SessionMeta { contextTokens: number }
function readMeta(path: string): SessionMeta {
	try { const value = JSON.parse(readFileSync(path, "utf8")); return { contextTokens: Number(value.contextTokens) || 0 }; } catch { return { contextTokens: 0 }; }
}

export async function runAgentPhase<T = unknown>(options: AgentPhaseOptions<T>): Promise<T> {
	const cwd = options.cwd ?? process.cwd();
	const agentKey = options.persona.name.toLowerCase();
	const model = resolvePhaseModel(options.persona, options.model);
	const thinking = resolvePhaseThinking(options.persona, options.thinking);
	const directory = resolve(options.run.trace.directory, phaseSessionKey(options.persona.name, options.model, options.sessionTag));
	mkdirSync(directory, { recursive: true });
	const sessionFile = resolve(directory, "session.json");
	const metaFile = resolve(directory, "session-meta.json");
	let meta = readMeta(metaFile);
	let runNumber = 0;
	if (options.permissionPolicy === undefined && options.persona.writes === undefined) {
		throw new Error(`Flow agent persona ${options.persona.name} has no writes policy; declare persona writes or pass an explicit permissionPolicy.`);
	}
	let permissionBaseline = snapshot(cwd);
	const permissionPolicy: PermissionPolicy = {
		...(options.permissionPolicy ?? { writes: options.persona.writes }),
		protectedGlobs: options.protectedGlobs ?? options.permissionPolicy?.protectedGlobs,
		alwaysWritable: [...(options.permissionPolicy?.alwaysWritable ?? []), options.run.trace.directory],
	};
	const spawnAgent = options.spawn ?? spawnPiAgentWithModelFallback;
	const manifest = buildSpecialistContextManifest({
		personaName: options.persona.name, personaPath: options.persona.file, personaPrompt: options.persona.systemPrompt,
		task: options.task, rulesPaths: options.rulesPaths ?? [], docsPaths: options.docsPaths ?? [],
		hasAssertions: /\bA\d+\b/.test(options.task), hasScope: false, hasArtifacts: false, delegateRoles: [],
	});

	const invoke = async (prompt: string): Promise<string> => {
		runNumber++;
		const replacement = nativeSpecialistSystemPrompt({ manifest, userLanguage: "English", agentKey, runNumber });
		const window = resolveContextWindow(model, { lookup: options.modelLookup, fallbackWindow: options.contextWindow ?? Number(process.env.AGENT_FLEET_CONTEXT_WINDOW ?? 0) });
		let resume = existsSync(sessionFile);
		const overflow = resume ? shouldRecycleBeforeSpawn({ priorTokens: meta.contextTokens, promptTokens: estimatePromptTokens(prompt) + estimatePromptTokens(replacement), window: window.window }) : null;
		if (overflow) {
			try { unlinkSync(sessionFile); } catch {}
			meta = { contextTokens: 0 };
			resume = false;
			options.run.trace.write("log", { phase: options.persona.name, message: `session recycled before spawn — ${overflow.message}` });
		}
		let measuredTokens = meta.contextTokens;
		const result = await spawnAgent({
			model, tools: options.persona.tools, thinking,
			systemPrompt: replacement, noSkills: true, noContextFiles: true, sessionFile, resume, prompt, cwd,
			extensions: [".pi/harnesses/damage-control-continue/index.ts"], detached: true, signal: options.run.signal,
			toolWatchdog: { timeoutMs: options.toolWatchdogMs ?? 120_000 }, turnDeadlineMs: options.turnDeadlineMs ?? 1_200_000,
		}, options.persona.fallbackModel, {
			onProcess: process => options.run.registerProcess(process, options.persona.name),
			onUsage: usage => {
				measuredTokens = Math.max(measuredTokens, Number(usage.input ?? 0) + Number(usage.output ?? 0) + Number((usage as any).cacheRead ?? 0) + Number((usage as any).cacheWrite ?? 0));
			},
		}, { midRun: !/(^|,)(write|edit)(,|$)/.test(options.persona.tools) });
		meta = { contextTokens: measuredTokens };
		writeFileSync(metaFile, JSON.stringify(meta), "utf8");
		const after = snapshot(cwd);
		enforce(permissionBaseline, after, permissionPolicy);
		permissionBaseline = after;
		if (result.exitCode !== 0) throw new Error(`Persona ${options.persona.name} failed (exit ${result.exitCode ?? "unknown"}): ${result.assistantError || result.spawnError || result.stderr || "no diagnostic"}`);
		return result.output;
	};

	const parse = (output: string) => parseWithCorrections<T>(options.envelope, output, prompt => invoke(prompt), (attempt, errors) => {
		options.run.trace.write("error", { phase: options.persona.name, invalidEnvelope: true, attempt: attempt + 1, errors });
	});
	let report = await parse(await invoke(`${options.task}\n\n${envelopePrompt(options.envelope)}`));
	const retries = options.gateRetries ?? 0;
	for (let attempt = 0; ; attempt++) {
		const gateReports: GateReport[] = [];
		for (const gate of options.gates ?? []) gateReports.push(await gate(report, options.run));
		for (const gateReport of gateReports) {
			options.run.trace.write("gate_report", { phase: options.persona.name, gate: gateReport.gate, ok: gateReport.ok, checks: gateReport.checks });
		}
		if (gateReports.every(gate => gate.ok)) return report;
		if (attempt >= retries) throw Object.assign(new Error(`Executable gates failed after ${attempt + 1} attempt(s): ${gateReports.flatMap(gate => gate.failures().map(check => `${gate.gate}/${check.item}: ${check.note}`)).join("; ")}`), { terminal: true });
		report = await parse(await invoke(gateCorrectionPrompt(gateReports)));
	}
}
