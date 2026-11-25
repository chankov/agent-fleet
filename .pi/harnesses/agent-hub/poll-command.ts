/** Pure `/af-poll` argument, panel, digest and presentation helpers. The hub command is a thin consumer. */

import { VOICES_REL } from "../../agent-fleet/scripts/workflows/lib/voices.ts";
import { applyPollEvent, failedPollBlock, initialPollBlock, type PollBlock, type PollEvent, type PollPanelSource } from "./poll-progress.ts";

export const HUB_POLL_DEFAULT_PERSONA = "researcher";
/** Selected when neither an explicit nor a configured panel names one, and only if the roster has it. */
export const POLL_DEFAULT_PANEL = "default";
/** How `/af-poll` names a panel in diagnostics. */
export const AF_POLL_PANEL_FLAG = "--panel NAME";
export const AF_POLL_MESSAGE = "af-poll";
export const AF_POLL_FAILED_MESSAGE = "af-poll-failed";

export interface ParsedAfPollArgs {
	panel?: string;
	persona: string;
	question: string;
	error?: string;
}

export interface AfPollVoiceDigest {
	name: string;
	model: string;
	ok: boolean;
	position?: string;
	confidence?: string;
	reason?: string;
}

export interface AfPollDigestInput {
	panel: string;
	directory: string;
	voices: AfPollVoiceDigest[];
	recommendation?: string;
	integrator?: string;
}

/**
 * Where one poll runs. Project configuration, personas, the panel roster, run records and opinion
 * artifacts stay at `workspaceRoot`; Git checks, every voice and the synthesis worker use `executionRoot`.
 */
export interface AfPollTarget {
	mode: "legacy" | "targeted";
	workspaceRoot: string;
	executionRoot: string;
}

export type AfPollTargetResolution = AfPollTarget | { error: string };

export interface AfPollHandleInput {
	args: string;
	cwd: string;
	/** The configured Poll panel (active model profile, else `poll-panel:`), read once the target resolved. */
	configuredPanel?: (workspaceRoot: string) => string | null | undefined;
	/** How this entry point names a panel in diagnostics, e.g. `--panel NAME`. */
	selectHint?: string;
	/** Validates the assignment's Git target before anything is accepted; legacy cwd == workspace when omitted. */
	resolveTarget?: (cwd: string) => AfPollTargetResolution | Promise<AfPollTargetResolution>;
	listPanels: (workspaceRoot: string) => string[] | Promise<string[]>;
	/** Configured voices of the resolved panel, so the block has one stable row per voice from the start. */
	panelVoices?: (panel: string, target: AfPollTarget) => { name: string; model: string }[] | Promise<{ name: string; model: string }[]>;
	preflight?: (options: { panel: string; persona: string; cwd: string; target: AfPollTarget }) => string | null | Promise<string | null>;
	checkBudget: () => string | null | Promise<string | null>;
	chargeBudget: () => void;
	onAccepted?: (info: { panel: string; persona: string; question: string; source: PollPanelSource }) => void | Promise<void>;
	/** Receives every new block snapshot, starting before panel resolution. */
	onProgress?: (block: PollBlock) => void;
	execute: (options: { panel: string; persona: string; question: string; cwd: string; target: AfPollTarget; emit: (event: PollEvent) => void }) => Promise<AfPollDigestInput>;
}

export interface AfPollHandleResult {
	ok: boolean;
	message: string;
	digest?: string;
	dispatcherNote?: string;
	/** The finished block: the recommendation, or the reason the run failed. */
	block?: PollBlock;
}

function tokenize(args: string): string[] {
	const tokens: string[] = [];
	const input = args.trim();
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "\"" || ch === "'") { quote = ch; continue; }
		if (/\s/.test(ch)) {
			if (current) { tokens.push(current); current = ""; }
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

export function parseAfPollArgs(args: string): ParsedAfPollArgs {
	const tokens = tokenize(args ?? "");
	let panel: string | undefined;
	let persona: string | undefined;
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--panel") {
			const value = tokens[++i];
			if (!value || value.startsWith("--")) return { persona: HUB_POLL_DEFAULT_PERSONA, question: "", error: "/af-poll --panel requires a panel name" };
			panel = value;
			continue;
		}
		if (token === "--persona") {
			const value = tokens[++i];
			if (!value || value.startsWith("--")) return { persona: HUB_POLL_DEFAULT_PERSONA, question: "", error: "/af-poll --persona requires a persona name" };
			persona = value;
			continue;
		}
		rest.push(token);
	}
	const question = rest.join(" ").trim();
	if (!question) {
		return {
			panel, persona: persona ?? HUB_POLL_DEFAULT_PERSONA, question: "",
			error: "Usage: /af-poll [--panel NAME] [--persona NAME] <question>",
		};
	}
	return { panel, persona: persona ?? HUB_POLL_DEFAULT_PERSONA, question };
}

/** Debate's selection for this slice: explicit, then configured, else a refusal (task 11 adopts the Poll fallback). */
export function resolveAfPollPanel(flag: string | undefined, override: string | null | undefined, available: string[]): { panel: string } | { error: string } {
	const named = flag?.trim() || override?.trim() || "";
	const list = available.length ? available.join(", ") : "(none)";
	if (!named) {
		return { error: `--panel is required (or set poll-panel: in ## agent-hub). Available panels: ${list}` };
	}
	if (available.length > 0 && !available.includes(named)) {
		return { error: `Unknown panel "${named}". Available panels: ${list}` };
	}
	return { panel: named };
}

/**
 * Poll panel precedence, identical for `poll_panel` and `/af-poll`: an explicit name, then the configured
 * Poll panel, then a panel named `default` when the roster has one. The chosen name must be in the roster;
 * an unknown explicit name fails even when a fallback would be valid.
 */
export function resolvePollPanel(input: { explicit?: string; configured?: string | null; available: readonly string[]; select?: string }): { panel: string; source: PollPanelSource } | { error: string } {
	const select = input.select ?? AF_POLL_PANEL_FLAG;
	const available = [...input.available];
	const roster = available.length
		? `Available panels: ${available.join(", ")}.`
		: `The roster is empty: ${VOICES_REL} in the Fleet workspace defines no panels.`;
	const explicit = input.explicit?.trim();
	if (explicit) {
		if (available.includes(explicit)) return { panel: explicit, source: "explicit" };
		return { error: `Unknown panel "${explicit}". ${roster} ${available.length ? `Select one with ${select}.` : "Add a panel with 2–5 voices first."}` };
	}
	const configured = input.configured?.trim();
	if (configured) {
		if (available.includes(configured)) return { panel: configured, source: "configured" };
		return { error: `The configured Poll panel "${configured}" (poll-panel: in ## agent-hub, or the active model profile) is not in the roster. ${roster} Correct poll-panel: or select a panel with ${select}.` };
	}
	if (available.includes(POLL_DEFAULT_PANEL)) return { panel: POLL_DEFAULT_PANEL, source: "default" };
	if (!available.length) {
		return { error: `No Poll panel is available. ${roster} Add a panel named "${POLL_DEFAULT_PANEL}" with 2–5 voices, or add any panel and select it with ${select}.` };
	}
	return { error: `No Poll panel was selected and none is named "${POLL_DEFAULT_PANEL}". ${roster} Select one with ${select}, or set poll-panel: NAME in ## agent-hub of .ai/agent-fleet-overrides.md.` };
}

export function formatAfPollDigest(input: AfPollDigestInput): string {
	const blocks = input.voices.map(voice => {
		const header = `${voice.name} · ${voice.model}`;
		if (!voice.ok) return `${header}\n  failed: ${voice.reason ?? "unknown error"}`;
		return `${header}\n  position: ${voice.position ?? ""}\n  confidence: ${voice.confidence ?? ""}`;
	});
	const merge = input.recommendation
		? `\nmerge${input.integrator ? ` · ${input.integrator}` : ""}\n  recommendation: ${input.recommendation}`
		: "";
	return `${blocks.join("\n\n")}${merge}\n\nFull opinions: ${input.directory}`;
}

export function formatAfPollDispatcherNote(input: AfPollDigestInput, digest: string): string {
	return [
		`POLL RESULT (panel ${input.panel})`,
		"",
		digest,
		"",
		"The digest above is the whole payload. Do not paste full voice opinions into this session; cite the path if you need more.",
	].join("\n");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const legacyTarget = (cwd: string): AfPollTarget => ({ mode: "legacy", workspaceRoot: cwd, executionRoot: cwd });

export async function handleAfPoll(input: AfPollHandleInput): Promise<AfPollHandleResult> {
	const parsed = parseAfPollArgs(input.args);
	if (parsed.error) return { ok: false, message: parsed.error, block: failedPollBlock(parsed.question, parsed.error) };
	return runAfPoll({ ...input, selectHint: input.selectHint ?? AF_POLL_PANEL_FLAG, panel: parsed.panel, persona: parsed.persona, question: parsed.question });
}

/**
 * Shared by `/af-poll` (parsed slash arguments) and the operator's `poll_panel` tool (typed parameters).
 * Order: question, Git target, panel, preflight, budget. Any refusal there starts no voice.
 */
export async function runAfPoll(input: Omit<AfPollHandleInput, "args"> & { panel?: string; persona?: string; question: string }): Promise<AfPollHandleResult> {
	const question = String(input.question ?? "").trim();
	let block = initialPollBlock(question);
	const show = () => { try { input.onProgress?.(block); } catch { /* progress is best-effort */ } };
	const publish = (event: PollEvent) => { block = applyPollEvent(block, event); show(); };
	const fail = (message: string): AfPollHandleResult => { publish({ type: "failed", reason: message }); return { ok: false, message, block }; };
	show();
	if (!question) return fail("A poll needs a non-empty question.");
	const persona = input.persona?.trim() || HUB_POLL_DEFAULT_PERSONA;
	let target: AfPollTarget;
	let selection: { panel: string; source: PollPanelSource };
	try {
		const resolved = await (input.resolveTarget ?? legacyTarget)(input.cwd);
		if ("error" in resolved) return fail(resolved.error);
		target = resolved;
		const available = await input.listPanels(target.workspaceRoot);
		const chosen = resolvePollPanel({ explicit: input.panel, configured: input.configuredPanel?.(target.workspaceRoot), available, select: input.selectHint });
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
	publish({ type: "accepted", panel: selection.panel, source: selection.source, persona, worktree: target.executionRoot, voices });
	try { await input.onAccepted?.({ panel: selection.panel, persona, question, source: selection.source }); } catch { /* progress is best-effort */ }
	try {
		const emit = (event: PollEvent) => { if (event.type === "voice" || event.type === "synthesis") publish(event); };
		const digestInput = { ...await input.execute({ panel: selection.panel, persona, question, cwd: target.executionRoot, target, emit }), panel: selection.panel };
		const digest = formatAfPollDigest(digestInput);
		publish({ type: "succeeded", result: digestInput });
		return { ok: true, message: digest, digest, dispatcherNote: formatAfPollDispatcherNote(digestInput, digest), block };
	} catch (error) {
		return fail(errorText(error));
	}
}

export interface AfPollMessage { customType: string; content: string; display: true; details: { poll: PollBlock } }

/** `/af-poll` presentation: one live block redrawn in place while running, then exactly one transcript entry. */
export interface AfPollCommandUi {
	show(block: PollBlock | undefined): void;
	send(message: AfPollMessage, options: { deliverAs: "followUp"; triggerTurn: boolean }): void;
}

/** Success hands the dispatcher note to the model (one turn); a failure is shown once and starts no turn. */
export async function presentAfPollCommand(input: AfPollHandleInput, ui: AfPollCommandUi): Promise<AfPollHandleResult> {
	let result: AfPollHandleResult;
	try { result = await handleAfPoll({ ...input, onProgress: block => ui.show(block) }); }
	finally { try { ui.show(undefined); } catch { /* the transcript entry still follows */ } }
	const poll = result.block ?? failedPollBlock("", result.message);
	if (result.ok) {
		ui.send({ customType: AF_POLL_MESSAGE, content: result.dispatcherNote ?? result.message, display: true, details: { poll } }, { deliverAs: "followUp", triggerTurn: true });
	} else {
		ui.send({ customType: AF_POLL_FAILED_MESSAGE, content: `POLL FAILED\n\n${result.message}`, display: true, details: { poll } }, { deliverAs: "followUp", triggerTurn: false });
	}
	return result;
}
