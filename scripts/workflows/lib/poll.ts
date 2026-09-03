import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAgentPhase, type SpawnAgent } from "./agent-phase.ts";
import type { PollReport } from "./envelopes.ts";
import type { PermissionPolicy } from "./permissions.ts";
import type { PersonaDefinition } from "./personas.ts";
import type { Run } from "./run.ts";
import { resolvePanel, type Voice } from "./voices.ts";

export const POLL_TOOLS = "read,grep,find,ls";
export const POLL_PERMISSION_POLICY: PermissionPolicy = { writes: [] };
export const POLL_ARTIFACTS_REL = ".pi/agent-sessions/artifacts/polls";

export interface PollVoiceSuccess { ok: true; voice: Voice; report: PollReport; path: string }
export interface PollVoiceFailure { ok: false; voice: Voice; reason: string; path: string }
export type PollVoiceResult = PollVoiceSuccess | PollVoiceFailure;
export interface PollResult { panel: string; directory: string; results: PollVoiceResult[] }
export interface PollVoiceOptions {
	run: Run; cwd: string; persona: PersonaDefinition; voice: Voice; task: string; panel: string;
	spawn?: SpawnAgent; runAgent?: typeof runAgentPhase<PollReport>;
}
export interface PollOptions {
	run: Run; cwd: string; persona: PersonaDefinition; panel: string; task: string; voices?: Voice[];
	spawn?: SpawnAgent; runAgent?: typeof runAgentPhase<PollReport>;
}

export function pollArtifactDir(cwd: string, runId: string): string {
	return resolve(cwd, POLL_ARTIFACTS_REL, runId);
}

export function pollVoicePath(cwd: string, runId: string, voiceName: string): string {
	return resolve(pollArtifactDir(cwd, runId), `${voiceName}.md`);
}

export function formatVoiceArtifact(result: PollVoiceResult): string {
	const header = [`# ${result.voice.name}`, "", `- model: ${result.voice.model}`, `- thinking: ${result.voice.thinking ?? "medium"}`];
	if (!result.ok) return `${header.join("\n")}\n- status: failed\n- reason: ${result.reason}\n`;
	return `${header.join("\n")}\n- status: success\n\n## Report\n\n\`\`\`json\n${JSON.stringify(result.report, null, 2)}\n\`\`\`\n`;
}

export function writeVoiceArtifact(cwd: string, runId: string, result: PollVoiceResult): string {
	const directory = pollArtifactDir(cwd, runId);
	mkdirSync(directory, { recursive: true });
	const path = pollVoicePath(cwd, runId, result.voice.name);
	writeFileSync(path, formatVoiceArtifact(result), "utf8");
	return path;
}

function readOnlyPersona(persona: PersonaDefinition): PersonaDefinition {
	return { ...persona, tools: POLL_TOOLS, writes: [] };
}

export async function pollVoice(options: PollVoiceOptions): Promise<PollVoiceResult> {
	const path = pollVoicePath(options.cwd, options.run.trace.runId, options.voice.name);
	const agent = options.runAgent ?? runAgentPhase<PollReport>;
	try {
		const report = await agent({
			run: options.run, persona: readOnlyPersona(options.persona), task: options.task, envelope: "poll",
			cwd: options.cwd, spawn: options.spawn, model: options.voice.model, thinking: options.voice.thinking,
			sessionTag: options.voice.name, permissionPolicy: POLL_PERMISSION_POLICY,
		});
		const result: PollVoiceSuccess = { ok: true, voice: options.voice, report, path };
		result.path = writeVoiceArtifact(options.cwd, options.run.trace.runId, result);
		return result;
	} catch (error) {
		const result: PollVoiceFailure = { ok: false, voice: options.voice, reason: error instanceof Error ? error.message : String(error), path };
		result.path = writeVoiceArtifact(options.cwd, options.run.trace.runId, result);
		return result;
	}
}

export async function runPoll(options: PollOptions): Promise<PollResult> {
	const voices = options.voices ?? resolvePanel(options.panel, options.cwd);
	const results = await Promise.all(voices.map(voice => pollVoice({ ...options, voice })));
	const succeeded = results.filter(result => result.ok);
	if (succeeded.length < 2) {
		const failures = results.filter(result => !result.ok).map(result => `${result.voice.name}: ${result.reason}`).join("; ");
		throw new Error(`Poll failed: ${succeeded.length} of ${voices.length} voices succeeded${failures ? ` (${failures})` : ""}`);
	}
	return { panel: options.panel, directory: pollArtifactDir(options.cwd, options.run.trace.runId), results };
}
