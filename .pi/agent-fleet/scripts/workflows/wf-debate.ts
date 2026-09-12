import { ENVELOPE_EXAMPLES, validateEnvelope, type DebateReport } from "./lib/envelopes.ts";
import { StartRefusedError } from "./lib/git.ts";
import { debateVoiceRound, resolveDebateRounds, writeDebateArtifact, type DebateVoiceResult } from "./lib/debate.ts";
import { checkChildVisibility, type ChildVisibilityReport } from "./lib/model-visibility.ts";
import { resolvePersona, type PersonaDefinition } from "./lib/personas.ts";
import type { FinishResult, Run } from "./lib/run.ts";
import { listPanelNames, resolvePanel, type Voice } from "./lib/voices.ts";

export interface DebateWorkflowDeps {
	persona?: PersonaDefinition;
	voices?: Voice[];
	debate?: typeof debateVoiceRound;
	checkVisibility?: (models: string[]) => ChildVisibilityReport;
}

function stubDebate(): DebateReport {
	const parsed = validateEnvelope<DebateReport>("debate", JSON.stringify(ENVELOPE_EXAMPLES.debate));
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.value!;
}

export function debateWorkflowValidate(command: { panel?: string; args: string[]; rounds?: number; apply?: boolean }, cwd: string): void {
	if (command.apply) throw Object.assign(new Error("debate flow is read-only and does not take --apply"), { exitCode: 2 });
	if (!command.panel) {
		const available = listPanelNames(cwd);
		throw Object.assign(new Error(`debate flow requires --panel. Available panels: ${available.length ? available.join(", ") : "(none)"}`), { exitCode: 2 });
	}
	if (!command.args.join(" ").trim()) throw Object.assign(new Error("debate flow requires a question"), { exitCode: 2 });
	resolveDebateRounds(command.rounds);
	resolvePanel(command.panel, cwd);
}

export function debateWorkflowPreflight(cwd: string, command?: { panel?: string }, deps: DebateWorkflowDeps = {}): void {
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

/** Phases: engineer(request) → for each round: agent×N(debate) → code(collect). No judge. */
export async function debateWorkflow(run: Run, input: { args: string[]; dryRun: boolean; cwd: string; panel?: string; rounds?: number; apply?: boolean }, deps: DebateWorkflowDeps = {}): Promise<FinishResult> {
	const request = input.args.join(" ").trim();
	if (!request) throw Object.assign(new Error("debate flow requires a question"), { exitCode: 2 });
	if (!input.panel) throw Object.assign(new Error("debate flow requires --panel"), { exitCode: 2 });
	if (input.apply) throw Object.assign(new Error("debate flow is read-only and does not take --apply"), { exitCode: 2 });
	const rounds = resolveDebateRounds(input.rounds);
	const persona = deps.persona ?? resolvePersona("researcher", input.cwd);
	const voices = deps.voices ?? resolvePanel(input.panel, input.cwd);
	const debate = deps.debate ?? debateVoiceRound;
	await run.phase({ name: "request", kind: "engineer", owner: "operator", description: "Preserve the exact question every panel voice must debate" }, phase => phase.log(request));
	let active = [...voices];
	let previous: Extract<DebateVoiceResult, { ok: true }>[] = [];
	for (let round = 1; round <= rounds; round++) {
		if (active.length < 2) break;
		const results = await Promise.all(active.map(voice => run.phase({
			name: `debate-${voice.name}-r${round}`, kind: "agent", owner: voice.name,
			description: `Collect a labeled debate turn from this panel voice in round ${round}`,
		}, async (): Promise<DebateVoiceResult> => {
			if (input.dryRun) {
				const stub: DebateVoiceResult = { ok: true, voice, round, report: stubDebate(), path: "" };
				stub.path = writeDebateArtifact(input.cwd, run.trace.runId, stub);
				return stub;
			}
			const others = previous.filter(item => item.voice.name !== voice.name);
			return debate({ run, cwd: input.cwd, persona, voice, task: request, panel: input.panel!, round, rounds, others });
		})));
		await run.phase({ name: `collect-r${round}`, kind: "code", owner: "debate", description: `Write round ${round} voice conclusions to disk before the next round` }, phase => {
			phase.log("debate round collected", { round, count: results.length, paths: results.map(item => item.path) });
		});
		const succeeded = results.filter((item): item is Extract<DebateVoiceResult, { ok: true }> => item.ok);
		if (succeeded.length < 2) {
			if (round === 1) {
				return run.finish({ accepted: false, reason: `debate produced ${succeeded.length} of ${active.length} successful voices in round 1; at least 2 are required` });
			}
			break;
		}
		previous = succeeded;
		active = succeeded.map(item => item.voice);
	}
	return run.finish({ accepted: previous.length >= 2 });
}
