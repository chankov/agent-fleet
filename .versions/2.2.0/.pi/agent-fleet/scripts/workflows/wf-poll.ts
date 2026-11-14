import { ENVELOPE_EXAMPLES, validateEnvelope, type MergeReport, type PollReport } from "./lib/envelopes.ts";
import { StartRefusedError } from "./lib/git.ts";
import { runMerge, MergeUnavailableError } from "./lib/merge.ts";
import { checkChildVisibility, type ChildVisibilityReport } from "./lib/model-visibility.ts";
import { resolvePersona, type PersonaDefinition } from "./lib/personas.ts";
import { POLL_PERMISSION_POLICY, pollVoice, writeVoiceArtifact, type PollVoiceResult } from "./lib/poll.ts";
import type { FinishResult, Run } from "./lib/run.ts";
import { integratorVoice, listPanelNames, resolvePanel, type Voice } from "./lib/voices.ts";

export interface PollWorkflowDeps {
	persona?: PersonaDefinition;
	voices?: Voice[];
	poll?: typeof pollVoice;
	merge?: typeof runMerge;
	checkVisibility?: (models: string[]) => ChildVisibilityReport;
}

function stubPoll(): PollReport {
	const parsed = validateEnvelope<PollReport>("poll", JSON.stringify(ENVELOPE_EXAMPLES.poll));
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.value!;
}

function stubMerge(): MergeReport {
	const parsed = validateEnvelope<MergeReport>("merge", JSON.stringify(ENVELOPE_EXAMPLES.merge));
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.value!;
}

export function pollWorkflowValidate(command: { panel?: string; args: string[] }, cwd: string): void {
	if (!command.panel) {
		const available = listPanelNames(cwd);
		throw Object.assign(new Error(`poll flow requires --panel. Available panels: ${available.length ? available.join(", ") : "(none)"}`), { exitCode: 2 });
	}
	if (!command.args.join(" ").trim()) throw Object.assign(new Error("poll flow requires a question"), { exitCode: 2 });
	resolvePanel(command.panel, cwd);
}

export function pollWorkflowPreflight(cwd: string, command?: { panel?: string }, deps: PollWorkflowDeps = {}): void {
	resolvePersona("researcher", cwd);
	const panel = command?.panel;
	if (!panel) return;
	const voices = deps.voices ?? resolvePanel(panel, cwd);
	const report = (deps.checkVisibility ?? checkChildVisibility)(voices.map(voice => voice.model));
	if (report.diagnostic) throw new StartRefusedError(`Flow start refused: could not verify clean-room model visibility (${report.diagnostic}).`);
	const hidden = report.models.filter(model => !model.ok);
	if (hidden.length) {
		throw new StartRefusedError(`Flow start refused: panel "${panel}" has models not visible to a clean-room child: ${hidden.map(model => model.reasons[0] ?? model.model).join("; ")}`);
	}
}

/** Phases: engineer(request) → agent×N(poll, parallel) → code(collect) → agent(merge) */
export async function pollWorkflow(run: Run, input: { args: string[]; dryRun: boolean; cwd: string; panel?: string; apply?: boolean }, deps: PollWorkflowDeps = {}): Promise<FinishResult> {
	const request = input.args.join(" ").trim();
	if (!request) throw Object.assign(new Error("poll flow requires a question"), { exitCode: 2 });
	if (!input.panel) throw Object.assign(new Error("poll flow requires --panel"), { exitCode: 2 });
	const persona = deps.persona ?? resolvePersona("researcher", input.cwd);
	const voices = deps.voices ?? resolvePanel(input.panel, input.cwd);
	const poll = deps.poll ?? pollVoice;
	const merge = deps.merge ?? runMerge;
	await run.phase({ name: "request", kind: "engineer", owner: "operator", description: "Preserve the exact question every panel voice must answer" }, phase => phase.log(request));
	const opinions = await Promise.all(voices.map(voice => run.phase({
		name: `poll-${voice.name}`, kind: "agent", owner: voice.name,
		description: "Collect an independent read-only opinion from this panel voice",
	}, async (): Promise<PollVoiceResult> => {
		if (input.dryRun) {
			const stub: PollVoiceResult = { ok: true, voice, report: stubPoll(), path: "" };
			stub.path = writeVoiceArtifact(input.cwd, run.trace.runId, stub);
			return stub;
		}
		return poll({ run, cwd: input.cwd, persona, voice, task: request, panel: input.panel!, spawn: undefined });
	})));
	const succeeded = opinions.filter(item => item.ok);
	if (succeeded.length < 2) {
		return run.finish({ accepted: false, reason: `poll produced ${succeeded.length} of ${voices.length} successful voices; at least 2 are required` });
	}
	await run.phase({ name: "collect", kind: "code", owner: "poll", description: "Write each voice opinion to disk before the integrator reads them" }, phase => {
		phase.log("voice opinions collected", { count: opinions.length, paths: opinions.map(item => item.path) });
	});
	const integrator = integratorVoice(voices);
	if (!integrator) {
		return run.finish({ accepted: false, reason: new MergeUnavailableError(input.panel).message });
	}
	const merged = await run.phase({
		name: "merge", kind: "agent", owner: integrator.name,
		description: "Synthesize attributed consensus from the independent voice opinions",
	}, async () => {
		if (input.dryRun) return { report: stubMerge(), integrator, path: "" };
		return merge({ run, cwd: input.cwd, persona, panel: input.panel!, task: request, opinions, voices, apply: input.apply });
	});
	run.trace.write("log", { phase: "merge", message: merged.report.summary, recommendation: merged.report.recommendation });
	return run.finish({ accepted: Boolean(merged.report) });
}

export { POLL_PERMISSION_POLICY };
