/**
 * Hub Poll runtime shared by `/af-poll` and `poll_panel`: the assignment's Git target and the
 * workflow ports that carry it through Git checks, voices and synthesis.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { sessionGitEnv, sessionRootsFromEnv } from "../lib/workspace-context.ts";
import type { SpawnAgent } from "../../agent-fleet/scripts/workflows/lib/agent-phase.ts";
import { runMerge } from "../../agent-fleet/scripts/workflows/lib/merge.ts";
import { checkChildVisibility, type ChildVisibilityReport } from "../../agent-fleet/scripts/workflows/lib/model-visibility.ts";
import { resolvePersona } from "../../agent-fleet/scripts/workflows/lib/personas.ts";
import { runPoll, type PollVoiceResult } from "../../agent-fleet/scripts/workflows/lib/poll.ts";
import { Run } from "../../agent-fleet/scripts/workflows/lib/run.ts";
import { integratorVoice, listPanelNames, resolvePanel } from "../../agent-fleet/scripts/workflows/lib/voices.ts";
import type { AfPollHandleInput, AfPollTargetResolution, AfPollVoiceDigest } from "./poll-command.ts";

const refused = (label: PanelRunLabel) => `${label} refused before any voice started:`;
const START_SELECTED = "Start a new Hub session from the Fleet workspace with `just fleet --worktree <path>` naming the checkout the voices should inspect.";

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function gitToplevel(path: string): string | undefined {
	try {
		const out = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: { ...sessionGitEnv(), GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
		return realpathSync(out.replace(/\n$/, ""));
	} catch { return undefined; }
}

/** Immediate child checkouts, named only so the refusal can say what to select. Never used to pick one. */
function childCheckouts(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, ".git")))
			.map(entry => entry.name).sort().slice(0, 12);
	} catch { return []; }
}

/**
 * The assignment's authorized Git target: the session binding's selected checkout, or — without a selector —
 * the legacy workspace when it is itself a Git checkout. Missing, invalid, out-of-scope or ambiguous targets
 * return one actionable refusal; child repositories of a non-Git workspace are never guessed.
 */
export type PanelRunLabel = "Poll" | "Debate";

export function resolvePollTarget(cwd: string): AfPollTargetResolution {
	return resolvePanelTarget(cwd, "Poll");
}

/** The same Git target rule for Debate; only the wording of the refusal names the entry point. */
export function resolvePanelTarget(cwd: string, label: PanelRunLabel): AfPollTargetResolution {
	const REFUSED = refused(label);
	let roots: ReturnType<typeof sessionRootsFromEnv>;
	try { roots = sessionRootsFromEnv(); }
	catch (error) {
		return { error: `${REFUSED} this session's assigned worktree no longer validates (${message(error)}). ${START_SELECTED}` };
	}
	let current: string;
	try { current = realpathSync(cwd); }
	catch (error) { return { error: `${REFUSED} the working directory ${cwd} is unavailable (${message(error)}).` }; }
	if (roots && current !== roots.executionRoot) {
		return { error: `${REFUSED} the working directory ${current} is outside this session's assigned worktree ${roots.executionRoot}. Run it from the assigned worktree, or start a separate session with \`just fleet --worktree <path>\` for the other checkout.` };
	}
	if (roots?.mode === "targeted") {
		// resolveSessionRoots/validateSessionRoots already proved a registered, non-bare checkout root.
		return { mode: "targeted", workspaceRoot: roots.workspaceRoot, executionRoot: roots.executionRoot };
	}
	if (gitToplevel(current)) return { mode: "legacy", workspaceRoot: current, executionRoot: current };
	const children = childCheckouts(current);
	if (!children.length) {
		return { error: `${REFUSED} the Fleet workspace ${current} is not a Git repository and this session has no assigned worktree. ${START_SELECTED}` };
	}
	return { error: `${REFUSED} the Fleet workspace ${current} is not a Git repository and this session has no assigned worktree; ${label} never chooses among its repositories (${children.join(", ")}). ${START_SELECTED} For example: \`just fleet --worktree ${children[0]}\`.` };
}

function voiceDigest(result: PollVoiceResult): AfPollVoiceDigest {
	return result.ok
		? { name: result.voice.name, model: result.voice.model, ok: true, position: result.report.position, confidence: result.report.confidence }
		: { name: result.voice.name, model: result.voice.model, ok: false, reason: result.reason };
}

/** The opinions directory as the operator can open it: relative inside its checkout, absolute outside. */
export function reportedPollDirectory(executionRoot: string, directory: string): string {
	const rel = relative(executionRoot, directory);
	const shown = !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? directory : rel;
	return shown.endsWith(sep) ? shown : `${shown}${sep}`;
}

export interface HubPollWorkflowOptions {
	/** Recorded in the run trace as the invoking entry point. */
	command: "/af-poll" | "poll_panel";
	/** Test seams: stub worker processes and clean-room model visibility. */
	spawn?: SpawnAgent;
	checkVisibility?: (models: string[]) => ChildVisibilityReport;
}

/** Target, roster, preflight and execution ports; the Hub adds budget and configured-panel ports. */
export function hubPollWorkflowPorts(options: HubPollWorkflowOptions): Pick<AfPollHandleInput, "resolveTarget" | "listPanels" | "panelVoices" | "preflight" | "execute"> {
	return {
		resolveTarget: resolvePollTarget,
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
		execute: async ({ panel, persona, question, target, emit }) => {
			const cwd = target.executionRoot;
			const run = new Run({ cwd, command: [options.command, "--panel", panel, question] });
			const personaDef = resolvePersona(persona, target.workspaceRoot);
			const voices = resolvePanel(panel, target.workspaceRoot);
			const poll = await runPoll({
				run, cwd, persona: personaDef, panel, task: question, voices, spawn: options.spawn,
				onVoice: result => emit({ type: "voice", voice: voiceDigest(result) }),
			});
			const integrator = integratorVoice(voices);
			emit({ type: "synthesis", integrator: integrator && { name: integrator.name, model: integrator.model } });
			const merge = await runMerge({ run, cwd, persona: personaDef, panel, task: question, opinions: poll.results, voices, spawn: options.spawn });
			return {
				panel,
				directory: reportedPollDirectory(cwd, poll.directory),
				voices: poll.results.map(voiceDigest),
				recommendation: merge.report.recommendation,
				integrator: merge.integrator.name,
			};
		},
	};
}
