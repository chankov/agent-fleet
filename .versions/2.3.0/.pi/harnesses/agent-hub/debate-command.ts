/**
 * `/af-debate` and the operator's `debate_panel` tool share one execution path (PLAN-11-01 task 11):
 * the same panel precedence and Git target preflight as Poll, then read-only rounds with no judge.
 * Pure argument, digest and presentation helpers; the Hub supplies the ports.
 */

import { DEBATE_DEFAULT_ROUNDS, DEBATE_MAX_ROUNDS, DEBATE_MIN_ROUNDS } from "../../agent-fleet/scripts/workflows/lib/debate.ts";
import { applyDebateEvent, failedDebateBlock, initialDebateBlock, type AfDebateResult, type DebateBlock, type DebateEvent } from "./debate-progress.ts";
import { AF_POLL_PANEL_FLAG, HUB_POLL_DEFAULT_PERSONA, resolvePollPanel, resolveVoicePersona, tokenizePanelArgs, type AfPollTarget, type AfPollTargetResolution } from "./poll-command.ts";
import type { PollPanelSource } from "./poll-progress.ts";

export const AF_DEBATE_MESSAGE = "af-debate";
export const AF_DEBATE_FAILED_MESSAGE = "af-debate-failed";
/** How `/af-debate` names its round count in diagnostics. */
export const AF_DEBATE_ROUNDS_FLAG = "--rounds N";
export const AF_DEBATE_USAGE = "Usage: /af-debate [--panel NAME] [--persona researcher|reviewer] [--rounds N] <question>";

export interface ParsedAfDebateArgs {
	panel?: string;
	persona: string;
	rounds?: number;
	question: string;
	error?: string;
}

export interface AfDebateHandleInput {
	cwd: string;
	/** The configured panel (active model profile, else `poll-panel:`), read once the target resolved. */
	configuredPanel?: (workspaceRoot: string) => string | null | undefined;
	/** How this entry point names a panel and the round count in diagnostics. */
	selectHint?: string;
	roundsHint?: string;
	/** Validates the assignment's Git target before anything is accepted; legacy cwd == workspace when omitted. */
	resolveTarget?: (cwd: string) => AfPollTargetResolution | Promise<AfPollTargetResolution>;
	listPanels: (workspaceRoot: string) => string[] | Promise<string[]>;
	/** Configured voices of the resolved panel, so the block has one stable row per voice from the start. */
	panelVoices?: (panel: string, target: AfPollTarget) => { name: string; model: string }[] | Promise<{ name: string; model: string }[]>;
	preflight?: (options: { panel: string; persona: string; cwd: string; target: AfPollTarget }) => string | null | Promise<string | null>;
	checkBudget: () => string | null | Promise<string | null>;
	chargeBudget: () => void;
	onAccepted?: (info: { panel: string; persona: string; question: string; rounds: number; source: PollPanelSource }) => void | Promise<void>;
	/** Receives every new block snapshot, starting before panel resolution. */
	onProgress?: (block: DebateBlock) => void;
	/** Runs the rounds. A thrown error may carry `debateDirectory` so the failure can point at the round artifacts. */
	execute: (options: { panel: string; persona: string; question: string; rounds: number; cwd: string; target: AfPollTarget; emit: (event: DebateEvent) => void }) => Promise<AfDebateResult>;
}

export interface AfDebateHandleResult {
	ok: boolean;
	message: string;
	digest?: string;
	dispatcherNote?: string;
	result?: AfDebateResult;
	/** The finished block: the outcome, or the reason the run failed. */
	block?: DebateBlock;
}

/** The round count both entry points accept: an integer from 2 to 5, default 3. */
export function checkDebateRounds(value: unknown, hint = AF_DEBATE_ROUNDS_FLAG): { rounds: number } | { error: string } {
	if (value === undefined || value === null) return { rounds: DEBATE_DEFAULT_ROUNDS };
	if (typeof value !== "number" || !Number.isInteger(value) || value < DEBATE_MIN_ROUNDS || value > DEBATE_MAX_ROUNDS) {
		return { error: `Debate rounds must be an integer from ${DEBATE_MIN_ROUNDS} to ${DEBATE_MAX_ROUNDS} (got ${JSON.stringify(value)}). Set ${hint}, or omit it for ${DEBATE_DEFAULT_ROUNDS}.` };
	}
	return { rounds: value };
}

export function parseAfDebateArgs(args: string): ParsedAfDebateArgs {
	const tokens = tokenizePanelArgs(args ?? "");
	let panel: string | undefined;
	let persona: string | undefined;
	let rounds: number | undefined;
	const rest: string[] = [];
	const refuse = (error: string): ParsedAfDebateArgs => ({ panel, persona: persona ?? HUB_POLL_DEFAULT_PERSONA, rounds, question: "", error });
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--panel") {
			const value = tokens[++i];
			if (!value || value.startsWith("--")) return refuse("/af-debate --panel requires a panel name");
			panel = value;
			continue;
		}
		if (token === "--persona") {
			const value = tokens[++i];
			if (!value || value.startsWith("--")) return refuse("/af-debate --persona requires a persona name");
			persona = value;
			continue;
		}
		if (token === "--rounds") {
			const value = tokens[++i];
			if (!value || value.startsWith("--") || !/^\d+$/.test(value)) return refuse(`/af-debate --rounds requires an integer from ${DEBATE_MIN_ROUNDS} to ${DEBATE_MAX_ROUNDS}`);
			rounds = Number(value);
			const checked = checkDebateRounds(rounds);
			if ("error" in checked) return refuse(checked.error);
			continue;
		}
		rest.push(token);
	}
	const question = rest.join(" ").trim();
	if (!question) return refuse(AF_DEBATE_USAGE);
	return { panel, persona: persona ?? HUB_POLL_DEFAULT_PERSONA, rounds, question };
}

/** Header of the model-facing result, e.g. `panel default, 3 of 3 rounds, complete`. */
export function debateResultLabel(result: AfDebateResult): string {
	const ran = `${result.roundsRun} of ${result.rounds} rounds`;
	return `panel ${result.panel}, ${ran}, ${result.complete ? "complete" : `stopped: ${result.stopReason ?? "incomplete"}`}`;
}

/**
 * The compact, model-facing digest: each final position, what changed and why, failed voices,
 * the open disagreements and where the round artifacts are. Full voice reports stay on disk.
 */
export function formatAfDebateDigest(result: AfDebateResult): string {
	// The same change history whether the voice finished or dropped out later.
	const history = (voice: AfDebateResult["voices"][number]): string[] => {
		const lines = voice.changes.length ? [] : ["  changed: no"];
		for (const change of voice.changes) {
			lines.push(`  changed: round ${change.round} — moved by: ${change.evidence.length ? change.evidence.join("; ") : "(no evidence given)"}`);
		}
		const first = voice.changes[0]?.from;
		if (first) lines.push(`  first position: ${first}`);
		return lines;
	};
	const voices = result.voices.map(voice => {
		if (voice.failedRound !== undefined) {
			const lines = [`${voice.name} · ${voice.model} · failed in round ${voice.failedRound}: ${voice.reason ?? "unknown error"}`];
			if (voice.position) lines.push(`  last position (round ${voice.finalRound}): ${voice.position}`, ...history(voice));
			return lines.join("\n");
		}
		return [`${voice.name} · ${voice.model} · round ${voice.finalRound}`, `  position: ${voice.position ?? ""}`, ...history(voice)].join("\n");
	});
	const disagreements = result.disagreements.length
		? result.disagreements.map(item => `- ${item.voice}: ${item.statement}`)
		: ["- none reported by the voices"];
	const rounds = result.roundDetails
		.map(round => `round ${round.round} ${round.voices.filter(voice => voice.ok).length}/${round.voices.length} ok`)
		.join(" · ");
	return [
		`Question: ${result.question}`,
		"",
		"Final positions:",
		voices.join("\n"),
		"",
		"Open disagreements (final-round refutations):",
		...disagreements,
		"",
		`Rounds: ${rounds || "none"}. Each voice's report: ${result.directory}round-<N>/<voice>.md`,
		`Full debate: ${result.directory}`,
	].join("\n");
}

export function formatAfDebateDispatcherNote(result: AfDebateResult, digest: string): string {
	return [
		`DEBATE RESULT (${debateResultLabel(result)})`,
		"",
		digest,
		"",
		"There is no judge: you own the decision. Weigh the positions, the evidence that moved them and the dissent; record the decision and why, and refer a reserved decision to the human.",
		"The digest above is the whole payload. Do not paste full voice reports into this session; read a round artifact only when the digest is insufficient.",
	].join("\n");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const legacyTarget = (cwd: string): AfPollTarget => ({ mode: "legacy", workspaceRoot: cwd, executionRoot: cwd });

export async function handleAfDebate(input: AfDebateHandleInput & { args: string }): Promise<AfDebateHandleResult> {
	const parsed = parseAfDebateArgs(input.args);
	if (parsed.error) return { ok: false, message: parsed.error, block: failedDebateBlock(parsed.question, parsed.error) };
	return runAfDebate({ ...input, selectHint: input.selectHint ?? AF_POLL_PANEL_FLAG, roundsHint: input.roundsHint ?? AF_DEBATE_ROUNDS_FLAG, panel: parsed.panel, persona: parsed.persona, rounds: parsed.rounds, question: parsed.question });
}

/**
 * Shared by `/af-debate` (parsed slash arguments) and `debate_panel` (typed parameters).
 * Order: question, persona, rounds, Git target, panel, preflight, budget. Any refusal there starts no voice.
 */
export async function runAfDebate(input: AfDebateHandleInput & { panel?: string; persona?: string; rounds?: unknown; question: string }): Promise<AfDebateHandleResult> {
	const question = String(input.question ?? "").trim();
	let block = initialDebateBlock(question);
	const show = () => { try { input.onProgress?.(block); } catch { /* progress is best-effort */ } };
	const publish = (event: DebateEvent) => { block = applyDebateEvent(block, event); show(); };
	const fail = (message: string, directory?: string): AfDebateHandleResult => { publish({ type: "failed", reason: message, directory }); return { ok: false, message, block }; };
	show();
	if (!question) return fail("A debate needs a non-empty decision question.");
	const voicePersona = resolveVoicePersona(input.persona);
	if ("error" in voicePersona) return fail(voicePersona.error);
	const persona = voicePersona.persona;
	const checkedRounds = checkDebateRounds(input.rounds, input.roundsHint ?? AF_DEBATE_ROUNDS_FLAG);
	if ("error" in checkedRounds) return fail(checkedRounds.error);
	const rounds = checkedRounds.rounds;
	let target: AfPollTarget;
	let selection: { panel: string; source: PollPanelSource };
	try {
		const resolved = await (input.resolveTarget ?? legacyTarget)(input.cwd);
		if ("error" in resolved) return fail(resolved.error);
		target = resolved;
		const available = await input.listPanels(target.workspaceRoot);
		const chosen = resolvePollPanel({ explicit: input.panel, configured: input.configuredPanel?.(target.workspaceRoot), available, select: input.selectHint, label: "Debate" });
		if ("error" in chosen) return fail(chosen.error);
		selection = chosen;
		const blocked = await input.preflight?.({ panel: selection.panel, persona, cwd: target.workspaceRoot, target });
		if (blocked) return fail(blocked);
		const budget = await input.checkBudget();
		if (budget) return fail(budget);
	} catch (error) {
		return fail(errorText(error));
	}
	input.chargeBudget();
	let voices: { name: string; model: string }[] = [];
	try { voices = await input.panelVoices?.(selection.panel, target) ?? []; } catch { /* rows then appear as voices report */ }
	publish({ type: "accepted", panel: selection.panel, source: selection.source, persona, worktree: target.executionRoot, rounds, voices });
	try { await input.onAccepted?.({ panel: selection.panel, persona, question, rounds, source: selection.source }); } catch { /* progress is best-effort */ }
	try {
		const emit = (event: DebateEvent) => { if (event.type === "round" || event.type === "voice") publish(event); };
		const result = { ...await input.execute({ panel: selection.panel, persona, question, rounds, cwd: target.executionRoot, target, emit }), panel: selection.panel, question };
		const digest = formatAfDebateDigest(result);
		publish({ type: "succeeded", result });
		return { ok: true, message: digest, digest, dispatcherNote: formatAfDebateDispatcherNote(result, digest), result, block };
	} catch (error) {
		const directory = (error as { debateDirectory?: string } | undefined)?.debateDirectory;
		return fail(directory ? `${errorText(error)}. Round artifacts: ${directory}` : errorText(error), directory);
	}
}

export interface AfDebateMessage { customType: string; content: string; display: true; details: { debate: DebateBlock } }

/** `/af-debate` presentation: one live block redrawn in place while running, then exactly one transcript entry. */
export interface AfDebateCommandUi {
	show(block: DebateBlock | undefined): void;
	send(message: AfDebateMessage, options: { deliverAs: "followUp"; triggerTurn: boolean }): void;
}

/** Success hands the dispatcher note to the model (one turn); a failure is shown once and starts no turn. */
export async function presentAfDebateCommand(input: AfDebateHandleInput & { args: string }, ui: AfDebateCommandUi): Promise<AfDebateHandleResult> {
	let result: AfDebateHandleResult;
	try { result = await handleAfDebate({ ...input, onProgress: block => ui.show(block) }); }
	finally { try { ui.show(undefined); } catch { /* the transcript entry still follows */ } }
	const debate = result.block ?? failedDebateBlock("", result.message);
	if (result.ok) {
		ui.send({ customType: AF_DEBATE_MESSAGE, content: result.dispatcherNote ?? result.message, display: true, details: { debate } }, { deliverAs: "followUp", triggerTurn: true });
	} else {
		ui.send({ customType: AF_DEBATE_FAILED_MESSAGE, content: `DEBATE FAILED\n\n${result.message}`, display: true, details: { debate } }, { deliverAs: "followUp", triggerTurn: false });
	}
	return result;
}
