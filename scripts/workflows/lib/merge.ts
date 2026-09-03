import { mkdirSync, writeFileSync } from "node:fs";
import { runAgentPhase, type SpawnAgent } from "./agent-phase.ts";
import type { MergeReport } from "./envelopes.ts";
import type { PersonaDefinition } from "./personas.ts";
import type { Run } from "./run.ts";
import { integratorVoice, resolvePanel, type Voice } from "./voices.ts";
import { POLL_PERMISSION_POLICY, POLL_TOOLS, pollArtifactDir, type PollVoiceResult } from "./poll.ts";

export class MergeUnavailableError extends Error {
	constructor(panel: string) {
		super(`Merge is unavailable: panel "${panel}" has no voice with integrator: true.`);
		this.name = "MergeUnavailableError";
	}
}

export interface MergeOptions {
	run: Run; cwd: string; persona: PersonaDefinition; panel: string; task: string; opinions: PollVoiceResult[];
	voices?: Voice[]; spawn?: SpawnAgent; runAgent?: typeof runAgentPhase<MergeReport>;
}

export function mergedPath(cwd: string, runId: string): string {
	return `${pollArtifactDir(cwd, runId)}/merged.md`;
}

export function mergeTask(question: string, opinions: PollVoiceResult[]): string {
	const blocks = opinions.map(opinion => {
		const body = opinion.ok ? `\`\`\`json\n${JSON.stringify(opinion.report, null, 2)}\n\`\`\`` : `FAILED: ${opinion.reason}`;
		return `## ${opinion.voice.name} (${opinion.voice.model})\n\n${body}`;
	});
	return [
		"Merge the independent poll opinions below into one attributed recommendation.",
		"Do not invent claims that no voice made. Every consensus, divergence, minority, and rejected item must name a voice.",
		"A minority opinion must not be dropped silently; rejecting it requires a reason.",
		"",
		`Question:\n${question}`,
		"",
		"Opinions:",
		...blocks,
	].join("\n");
}

function writeMerged(cwd: string, runId: string, integrator: Voice, report: MergeReport): string {
	const directory = pollArtifactDir(cwd, runId);
	mkdirSync(directory, { recursive: true });
	const path = mergedPath(cwd, runId);
	writeFileSync(path, `# Merge (${integrator.name})\n\n- model: ${integrator.model}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`, "utf8");
	return path;
}

export async function runMerge(options: MergeOptions): Promise<{ report: MergeReport; integrator: Voice; path: string }> {
	const voices = options.voices ?? resolvePanel(options.panel, options.cwd);
	const integrator = integratorVoice(voices);
	if (!integrator) throw new MergeUnavailableError(options.panel);
	const agent = options.runAgent ?? runAgentPhase<MergeReport>;
	const report = await agent({
		run: options.run,
		persona: { ...options.persona, tools: POLL_TOOLS, writes: [] },
		task: mergeTask(options.task, options.opinions),
		envelope: "merge", cwd: options.cwd, spawn: options.spawn,
		model: integrator.model, thinking: integrator.thinking,
		sessionTag: "merge", permissionPolicy: POLL_PERMISSION_POLICY,
	});
	const path = writeMerged(options.cwd, options.run.trace.runId, integrator, report);
	return { report, integrator, path };
}
