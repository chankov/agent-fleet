import { mkdirSync, writeFileSync } from "node:fs";
import { runAgentPhase, type SpawnAgent } from "./agent-phase.ts";
import type { MergeReport } from "./envelopes.ts";
import type { PermissionPolicy } from "./permissions.ts";
import type { PersonaDefinition } from "./personas.ts";
import type { Run } from "./run.ts";
import { integratorVoice, resolvePanel, type Voice } from "./voices.ts";
import { POLL_PERMISSION_POLICY, POLL_TOOLS, pollArtifactDir, type PollVoiceResult } from "./poll.ts";
import { withWriterLease, writerLeaseFile, WriterLeaseHeldError } from "./writer-lease.ts";

export const MERGE_APPLY_TOOLS = "read,grep,find,ls,edit,write";
export const MERGE_APPLY_PERMISSION_POLICY: PermissionPolicy = { writes: ["**"] };

export class MergeUnavailableError extends Error {
	constructor(panel: string) {
		super(`Merge is unavailable: panel "${panel}" has no voice with integrator: true.`);
		this.name = "MergeUnavailableError";
	}
}

export interface MergeOptions {
	run: Run; cwd: string; persona: PersonaDefinition; panel: string; task: string; opinions: PollVoiceResult[];
	voices?: Voice[]; spawn?: SpawnAgent; runAgent?: typeof runAgentPhase<MergeReport>;
	apply?: boolean; command?: string;
}

export function mergedPath(cwd: string, runId: string): string {
	return `${pollArtifactDir(cwd, runId)}/merged.md`;
}

export function mergeTask(question: string, opinions: PollVoiceResult[], apply = false): string {
	const blocks = opinions.map(opinion => {
		const body = opinion.ok ? `\`\`\`json\n${JSON.stringify(opinion.report, null, 2)}\n\`\`\`` : `FAILED: ${opinion.reason}`;
		return `## ${opinion.voice.name} (${opinion.voice.model})\n\n${body}`;
	});
	return [
		"Merge the independent poll opinions below into one attributed recommendation.",
		"Do not invent claims that no voice made. Every consensus, divergence, minority, and rejected item must name a voice.",
		"A minority opinion must not be dropped silently; rejecting it requires a reason.",
		apply ? "You have write tools. Apply the recommendation to the working tree; stay inside the writes policy." : "You are read-only. Do not modify the working tree.",
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
	const apply = Boolean(options.apply);
	const agent = options.runAgent ?? runAgentPhase<MergeReport>;
	const spawnIntegrator = () => agent({
		run: options.run,
		persona: {
			...options.persona,
			tools: apply ? MERGE_APPLY_TOOLS : POLL_TOOLS,
			writes: apply ? MERGE_APPLY_PERMISSION_POLICY.writes : [],
		},
		task: mergeTask(options.task, options.opinions, apply),
		envelope: "merge", cwd: options.cwd, spawn: options.spawn,
		model: integrator.model, thinking: integrator.thinking,
		sessionTag: "merge",
		permissionPolicy: apply ? MERGE_APPLY_PERMISSION_POLICY : POLL_PERMISSION_POLICY,
	});
	if (!apply) {
		const report = await spawnIntegrator();
		return { report, integrator, path: writeMerged(options.cwd, options.run.trace.runId, integrator, report) };
	}
	const command = options.command ?? (options.run.command.join(" ") || "flow poll --apply");
	try {
		const merged = await withWriterLease({ cwd: options.cwd, owner: `merge:${integrator.name}`, command }, async lease => {
			options.run.trace.write("log", { phase: "merge", message: "writer lease acquired", lease: lease.file, owner: lease.record.owner, ownerCommand: lease.record.command });
			const report = await spawnIntegrator();
			return { report, integrator, path: writeMerged(options.cwd, options.run.trace.runId, integrator, report) };
		});
		options.run.trace.write("log", { phase: "merge", message: "writer lease released", lease: writerLeaseFile(options.cwd) });
		return merged;
	} catch (error) {
		if (error instanceof WriterLeaseHeldError) {
			options.run.trace.write("error", { phase: "merge", message: error.message, lease: error.file, owner: error.record.owner, ownerCommand: error.record.command });
		}
		throw error;
	}
}
