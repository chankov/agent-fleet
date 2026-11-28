/**
 * Hub Debate runtime shared by `/af-debate` and `debate_panel`: Poll's Git target and roster rules,
 * read-only rounds in the validated worktree, and a judge-free summary derived from the voices' own
 * reports (D26): who changed position in which round and why, and each final-round refutation.
 */
import { isAbsolute, join, relative, sep } from "node:path";
import type { SpawnAgent } from "../../agent-fleet/scripts/workflows/lib/agent-phase.ts";
import { debateArtifactDir, runDebate, type DebateResult, type DebateVoiceResult } from "../../agent-fleet/scripts/workflows/lib/debate.ts";
import { checkChildVisibility, type ChildVisibilityReport } from "../../agent-fleet/scripts/workflows/lib/model-visibility.ts";
import { resolvePersona } from "../../agent-fleet/scripts/workflows/lib/personas.ts";
import { Run } from "../../agent-fleet/scripts/workflows/lib/run.ts";
import { listPanelNames, resolvePanel } from "../../agent-fleet/scripts/workflows/lib/voices.ts";
import type { AfDebateHandleInput } from "./debate-command.ts";
import type { AfDebateResult, DebateRoundSummary, DebateVoiceOutcome, DebateVoiceTurn } from "./debate-progress.ts";
import { reportedPollDirectory, resolvePanelTarget } from "./poll-runtime.ts";

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A path as the operator can open it: relative inside the checkout, absolute outside. */
export function reportedPath(executionRoot: string, path: string): string {
	const rel = relative(executionRoot, path);
	return !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? path : rel;
}

export function debateTurn(result: DebateVoiceResult, executionRoot: string): DebateVoiceTurn {
	const base = { name: result.voice.name, model: result.voice.model, round: result.round, path: reportedPath(executionRoot, result.path) };
	return result.ok
		? { ...base, ok: true, position: result.report.position, changed: result.report.changed }
		: { ...base, ok: false, reason: result.reason };
}

/**
 * The judge-free result. A change counts from round 2 on, when the voice had a position to change
 * (round 1 is independent). Disagreements are the final-round `refutes` of the voices in that round.
 */
export function summarizeDebate(debate: DebateResult, options: { question: string; executionRoot: string }): AfDebateResult {
	const directory = reportedPollDirectory(options.executionRoot, debate.directory);
	const outcomes = new Map<string, DebateVoiceOutcome>();
	const order: string[] = [];
	const roundDetails: DebateRoundSummary[] = [];
	for (const round of debate.roundsRun) {
		roundDetails.push({
			round: round.round,
			directory: reportedPollDirectory(options.executionRoot, join(debate.directory, `round-${round.round}`)),
			voices: round.results.map(item => ({ name: item.voice.name, ok: item.ok, changed: item.ok ? item.report.changed : undefined, reason: item.ok ? undefined : item.reason, path: reportedPath(options.executionRoot, item.path) })),
		});
		for (const item of round.results) {
			if (!outcomes.has(item.voice.name)) {
				order.push(item.voice.name);
				outcomes.set(item.voice.name, { name: item.voice.name, model: item.voice.model, finalRound: 0, changes: [], alignedWith: [], refutes: [] });
			}
			const outcome = outcomes.get(item.voice.name)!;
			if (!item.ok) {
				outcome.failedRound = item.round;
				outcome.reason = item.reason;
				outcome.path = reportedPath(options.executionRoot, item.path);
				continue;
			}
			if (item.round > 1 && item.report.changed) {
				outcome.changes.push({ round: item.round, from: outcome.position, evidence: [...item.report.evidence_that_moved_me] });
			}
			outcome.finalRound = item.round;
			outcome.position = item.report.position;
			outcome.alignedWith = [...item.report.aligned_with];
			outcome.refutes = [...item.report.refutes];
			outcome.path = reportedPath(options.executionRoot, item.path);
		}
	}
	const last = debate.roundsRun.at(-1);
	const lastOk = last?.results.filter(item => item.ok) ?? [];
	const roundsRun = debate.roundsRun.length;
	const complete = roundsRun === debate.rounds && lastOk.length >= 2;
	let stopReason: string | undefined;
	if (!complete) {
		stopReason = last && lastOk.length < 2
			? `round ${last.round} had ${lastOk.length} successful voice${lastOk.length === 1 ? "" : "s"}; a round needs at least 2`
			: `${roundsRun} of ${debate.rounds} rounds ran`;
	}
	// Positions at the end are those of the final round's successful voices; earlier dropouts keep their failure.
	const finalVoices = new Set(lastOk.map(item => item.voice.name));
	const disagreements = order
		.map(name => outcomes.get(name)!)
		.filter(outcome => finalVoices.has(outcome.name))
		.flatMap(outcome => outcome.refutes.filter(statement => statement.trim()).map(statement => ({ voice: outcome.name, statement })));
	return {
		panel: debate.panel, question: options.question, rounds: debate.rounds, roundsRun, complete, stopReason,
		voices: order.map(name => outcomes.get(name)!), disagreements, roundDetails, directory,
	};
}

export interface HubDebateWorkflowOptions {
	/** Recorded in the run trace as the invoking entry point. */
	command: "/af-debate" | "debate_panel";
	/** Test seams: stub worker processes and clean-room model visibility. */
	spawn?: SpawnAgent;
	checkVisibility?: (models: string[]) => ChildVisibilityReport;
}

/** Target, roster, preflight and execution ports; the Hub adds budget and configured-panel ports. */
export function hubDebateWorkflowPorts(options: HubDebateWorkflowOptions): Pick<AfDebateHandleInput, "resolveTarget" | "listPanels" | "panelVoices" | "preflight" | "execute"> {
	return {
		resolveTarget: cwd => resolvePanelTarget(cwd, "Debate"),
		listPanels: workspace => listPanelNames(workspace),
		panelVoices: (panel, target) => resolvePanel(panel, target.workspaceRoot).map(voice => ({ name: voice.name, model: voice.model })),
		preflight: ({ panel, persona, target }) => {
			let voices;
			try {
				resolvePersona(persona, target.workspaceRoot);
				voices = resolvePanel(panel, target.workspaceRoot);
			} catch (error) { return message(error); }
			const report = (options.checkVisibility ?? checkChildVisibility)(voices.map(voice => voice.model));
			if (report.diagnostic) return `could not verify clean-room model visibility (${report.diagnostic})`;
			const hidden = report.models.filter(model => !model.ok);
			if (hidden.length) {
				return `panel "${panel}" has models not visible to a clean-room child: ${hidden.map(model => model.reasons[0] ?? model.model).join("; ")}`;
			}
			return null;
		},
		execute: async ({ panel, persona, question, rounds, target, emit }) => {
			const cwd = target.executionRoot;
			const run = new Run({ cwd, command: [options.command, "--panel", panel, "--rounds", String(rounds), question] });
			const personaDef = resolvePersona(persona, target.workspaceRoot);
			const voices = resolvePanel(panel, target.workspaceRoot);
			let debate: DebateResult;
			try {
				debate = await runDebate({
					run, cwd, persona: personaDef, panel, task: question, rounds, voices, spawn: options.spawn,
					onRound: (round, taking) => emit({ type: "round", round, voices: taking.map(voice => voice.name) }),
					onVoice: result => emit({ type: "voice", turn: debateTurn(result, cwd) }),
				});
			} catch (error) {
				throw Object.assign(new Error(message(error)), { debateDirectory: reportedPollDirectory(cwd, debateArtifactDir(cwd, run.trace.runId)) });
			}
			return summarizeDebate(debate, { question, executionRoot: cwd });
		},
	};
}
