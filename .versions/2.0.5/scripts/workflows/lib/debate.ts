import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAgentPhase, type SpawnAgent } from "./agent-phase.ts";
import type { DebateReport } from "./envelopes.ts";
import type { PersonaDefinition } from "./personas.ts";
import { POLL_PERMISSION_POLICY, POLL_TOOLS, pollArtifactDir } from "./poll.ts";
import type { Run } from "./run.ts";
import { resolvePanel, type Voice } from "./voices.ts";

export const DEBATE_DEFAULT_ROUNDS = 3;
export const DEBATE_MIN_ROUNDS = 2;
export const DEBATE_MAX_ROUNDS = 5;
export const DEBATE_FOREIGN_PACKET_MAX_BYTES = 16_384;

export interface DebateVoiceSuccess { ok: true; voice: Voice; round: number; report: DebateReport; path: string }
export interface DebateVoiceFailure { ok: false; voice: Voice; round: number; reason: string; path: string }
export type DebateVoiceResult = DebateVoiceSuccess | DebateVoiceFailure;
export interface DebateRoundResult { round: number; results: DebateVoiceResult[] }
export interface DebateResult { panel: string; directory: string; rounds: number; roundsRun: DebateRoundResult[] }

export interface DebateVoiceRoundOptions {
	run: Run; cwd: string; persona: PersonaDefinition; voice: Voice; task: string; panel: string;
	round: number; rounds: number; others: DebateVoiceSuccess[];
	spawn?: SpawnAgent; runAgent?: typeof runAgentPhase<DebateReport>;
}
export interface DebateOptions {
	run: Run; cwd: string; persona: PersonaDefinition; panel: string; task: string;
	rounds?: number; voices?: Voice[];
	spawn?: SpawnAgent; runAgent?: typeof runAgentPhase<DebateReport>;
	onVoice?: (result: DebateVoiceResult, round: number) => void | Promise<void>;
}

export function resolveDebateRounds(value?: number): number {
	const rounds = value ?? DEBATE_DEFAULT_ROUNDS;
	if (!Number.isInteger(rounds) || rounds < DEBATE_MIN_ROUNDS || rounds > DEBATE_MAX_ROUNDS) {
		throw Object.assign(new Error(`debate --rounds must be an integer from ${DEBATE_MIN_ROUNDS} to ${DEBATE_MAX_ROUNDS} (got ${value ?? rounds})`), { exitCode: 2 });
	}
	return rounds;
}

export function debateArtifactDir(cwd: string, runId: string): string {
	return resolve(pollArtifactDir(cwd, runId), "debate");
}

export function debateRoundDir(cwd: string, runId: string, round: number): string {
	return resolve(debateArtifactDir(cwd, runId), `round-${round}`);
}

export function debateVoicePath(cwd: string, runId: string, round: number, voiceName: string): string {
	return resolve(debateRoundDir(cwd, runId, round), `${voiceName}.md`);
}

export function formatForeignPacket(others: DebateVoiceSuccess[]): string {
	if (!others.length) return "";
	const blocks = others.map(item => `## ${item.voice.name} (${item.voice.model})\n\n\`\`\`json\n${JSON.stringify(item.report, null, 2)}\n\`\`\``);
	return ["Labeled positions from the previous round:", "", ...blocks].join("\n");
}

export function assertForeignPacketSize(packet: string): void {
	const bytes = Buffer.byteLength(packet, "utf8");
	if (bytes > DEBATE_FOREIGN_PACKET_MAX_BYTES) {
		throw new Error(`Debate refused: foreign opinion packet is ${bytes} bytes (cap ${DEBATE_FOREIGN_PACKET_MAX_BYTES})`);
	}
}

export function debateRoundTask(question: string, round: number, total: number, others: DebateVoiceSuccess[]): string {
	const packet = formatForeignPacket(others);
	assertForeignPacketSize(packet);
	return [
		`Debate round ${round} of ${total}.`,
		"You are one voice answering the same question. When labeled positions from other voices are present, address them by name.",
		"Keep your own session; do not pretend to be another voice. There is no judge.",
		"",
		`Question:\n${question}`,
		packet ? `\n${packet}` : "",
	].filter(Boolean).join("\n");
}

function readOnlyPersona(persona: PersonaDefinition): PersonaDefinition {
	return { ...persona, tools: POLL_TOOLS, writes: [] };
}

export function formatDebateArtifact(result: DebateVoiceResult): string {
	const header = [`# ${result.voice.name}`, "", `- model: ${result.voice.model}`, `- round: ${result.round}`, `- thinking: ${result.voice.thinking ?? "medium"}`];
	if (!result.ok) return `${header.join("\n")}\n- status: failed\n- reason: ${result.reason}\n`;
	return `${header.join("\n")}\n- status: success\n\n## Report\n\n\`\`\`json\n${JSON.stringify(result.report, null, 2)}\n\`\`\`\n`;
}

export function writeDebateArtifact(cwd: string, runId: string, result: DebateVoiceResult): string {
	const directory = debateRoundDir(cwd, runId, result.round);
	mkdirSync(directory, { recursive: true });
	const path = debateVoicePath(cwd, runId, result.round, result.voice.name);
	writeFileSync(path, formatDebateArtifact(result), "utf8");
	return path;
}

export async function debateVoiceRound(options: DebateVoiceRoundOptions): Promise<DebateVoiceResult> {
	const path = debateVoicePath(options.cwd, options.run.trace.runId, options.round, options.voice.name);
	const agent = options.runAgent ?? runAgentPhase<DebateReport>;
	try {
		const report = await agent({
			run: options.run, persona: readOnlyPersona(options.persona),
			task: debateRoundTask(options.task, options.round, options.rounds, options.others),
			envelope: "debate", cwd: options.cwd, spawn: options.spawn,
			model: options.voice.model, thinking: options.voice.thinking,
			sessionTag: options.voice.name, permissionPolicy: POLL_PERMISSION_POLICY,
		});
		const result: DebateVoiceSuccess = { ok: true, voice: options.voice, round: options.round, report, path };
		result.path = writeDebateArtifact(options.cwd, options.run.trace.runId, result);
		return result;
	} catch (error) {
		const result: DebateVoiceFailure = {
			ok: false, voice: options.voice, round: options.round,
			reason: error instanceof Error ? error.message : String(error), path,
		};
		result.path = writeDebateArtifact(options.cwd, options.run.trace.runId, result);
		return result;
	}
}

export async function runDebate(options: DebateOptions): Promise<DebateResult> {
	const rounds = resolveDebateRounds(options.rounds);
	const voices = options.voices ?? resolvePanel(options.panel, options.cwd);
	let active = [...voices];
	const roundsRun: DebateRoundResult[] = [];
	let previousSuccesses: DebateVoiceSuccess[] = [];
	for (let round = 1; round <= rounds; round++) {
		if (active.length < 2) break;
		const results = await Promise.all(active.map(async voice => {
			const others = previousSuccesses.filter(item => item.voice.name !== voice.name);
			assertForeignPacketSize(formatForeignPacket(others));
			const result = await debateVoiceRound({ ...options, voice, round, rounds, others });
			try { await options.onVoice?.(result, round); } catch { /* progress is best-effort */ }
			return result;
		}));
		roundsRun.push({ round, results });
		const succeeded = results.filter((item): item is DebateVoiceSuccess => item.ok);
		if (succeeded.length < 2) {
			if (round === 1) {
				const failures = results.filter(item => !item.ok).map(item => `${item.voice.name}: ${item.reason}`).join("; ");
				throw new Error(`Debate failed: ${succeeded.length} of ${active.length} voices succeeded in round 1${failures ? ` (${failures})` : ""}`);
			}
			break;
		}
		previousSuccesses = succeeded;
		active = succeeded.map(item => item.voice);
	}
	return { panel: options.panel, directory: debateArtifactDir(options.cwd, options.run.trace.runId), rounds, roundsRun };
}
