/** Pure `/af-debate` argument, panel, and digest helpers. The hub command is a thin consumer. */

import { DEBATE_DEFAULT_ROUNDS, resolveDebateRounds } from "../../../scripts/workflows/lib/debate.ts";
import { HUB_POLL_DEFAULT_PERSONA, resolveAfPollPanel } from "./poll-command.ts";

export interface ParsedAfDebateArgs {
	panel?: string;
	persona: string;
	rounds: number;
	question: string;
	error?: string;
}

export interface AfDebateVoiceDigest {
	name: string;
	model: string;
	ok: boolean;
	round: number;
	position?: string;
	changed?: boolean;
	reason?: string;
}

export interface AfDebateDigestInput {
	panel: string;
	directory: string;
	rounds: number;
	voices: AfDebateVoiceDigest[];
}

export interface AfDebateHandleInput {
	args: string;
	cwd: string;
	pollPanelOverride?: string | null;
	listPanels: (cwd: string) => string[] | Promise<string[]>;
	preflight?: (options: { panel: string; persona: string; cwd: string }) => string | null | Promise<string | null>;
	checkBudget: () => string | null;
	chargeBudget: () => void;
	onAccepted?: (info: { panel: string; persona: string; question: string; rounds: number }) => void | Promise<void>;
	execute: (options: { panel: string; persona: string; question: string; rounds: number; cwd: string }) => Promise<AfDebateDigestInput>;
}

export interface AfDebateHandleResult {
	ok: boolean;
	message: string;
	digest?: string;
	dispatcherNote?: string;
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

export function parseAfDebateArgs(args: string): ParsedAfDebateArgs {
	const tokens = tokenize(args ?? "");
	let panel: string | undefined;
	let persona: string | undefined;
	let rounds: number | undefined;
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--panel") {
			const value = tokens[++i];
			if (!value || value.startsWith("--")) return { persona: HUB_POLL_DEFAULT_PERSONA, rounds: DEBATE_DEFAULT_ROUNDS, question: "", error: "/af-debate --panel requires a panel name" };
			panel = value;
			continue;
		}
		if (token === "--persona") {
			const value = tokens[++i];
			if (!value || value.startsWith("--")) return { persona: HUB_POLL_DEFAULT_PERSONA, rounds: DEBATE_DEFAULT_ROUNDS, question: "", error: "/af-debate --persona requires a persona name" };
			persona = value;
			continue;
		}
		if (token === "--rounds") {
			const value = tokens[++i];
			if (!value || value.startsWith("--") || !/^\d+$/.test(value)) {
				return { persona: HUB_POLL_DEFAULT_PERSONA, rounds: DEBATE_DEFAULT_ROUNDS, question: "", error: "/af-debate --rounds requires an integer" };
			}
			rounds = Number(value);
			continue;
		}
		rest.push(token);
	}
	const question = rest.join(" ").trim();
	if (!question) {
		return {
			panel, persona: persona ?? HUB_POLL_DEFAULT_PERSONA, rounds: rounds ?? DEBATE_DEFAULT_ROUNDS, question: "",
			error: "Usage: /af-debate [--panel NAME] [--persona NAME] [--rounds N] <question>",
		};
	}
	try {
		return { panel, persona: persona ?? HUB_POLL_DEFAULT_PERSONA, rounds: resolveDebateRounds(rounds), question };
	} catch (error) {
		return { panel, persona: persona ?? HUB_POLL_DEFAULT_PERSONA, rounds: rounds ?? DEBATE_DEFAULT_ROUNDS, question, error: error instanceof Error ? error.message : String(error) };
	}
}

export function formatAfDebateDigest(input: AfDebateDigestInput): string {
	const blocks = input.voices.map(voice => {
		const header = `${voice.name} · ${voice.model} · round ${voice.round}`;
		if (!voice.ok) return `${header}\n  failed: ${voice.reason ?? "unknown error"}`;
		return `${header}\n  position: ${voice.position ?? ""}\n  changed: ${voice.changed === true ? "yes" : "no"}`;
	});
	return `${blocks.join("\n\n")}\n\nFull debate: ${input.directory}`;
}

export function formatAfDebateStarted(info: { panel: string; persona: string; question: string; rounds: number; voices?: { name: string; model: string }[] }): string {
	const roster = info.voices?.length
		? info.voices.map(voice => `${voice.name} · ${voice.model}`).join("\n")
		: "(voices loading)";
	return [
		`DEBATE STARTED (panel ${info.panel}, persona ${info.persona}, rounds ${info.rounds})`,
		"",
		`Question: ${info.question}`,
		"",
		"Voices:",
		roster,
		"",
		"Running read-only. There is no judge. Full conclusions stay on disk; a digest follows when the last round finishes.",
	].join("\n");
}

export function formatAfDebateVoiceProgress(voice: AfDebateVoiceDigest): string {
	if (!voice.ok) return `DEBATE VOICE ${voice.name} · round ${voice.round}\n  failed: ${voice.reason ?? "unknown error"}`;
	return `DEBATE VOICE ${voice.name} · round ${voice.round}\n  position: ${voice.position ?? ""}\n  changed: ${voice.changed === true ? "yes" : "no"}`;
}

export function formatAfDebateDispatcherNote(input: AfDebateDigestInput, digest: string): string {
	return [
		`DEBATE RESULT (panel ${input.panel}, ${input.rounds} rounds)`,
		"",
		digest,
		"",
		"The digest above is the whole payload. Do not paste full voice conclusions into this session; cite the path if you need more.",
	].join("\n");
}

export async function handleAfDebate(input: AfDebateHandleInput): Promise<AfDebateHandleResult> {
	const parsed = parseAfDebateArgs(input.args);
	if (parsed.error) return { ok: false, message: parsed.error };
	const available = await input.listPanels(input.cwd);
	const panel = resolveAfPollPanel(parsed.panel, input.pollPanelOverride, available);
	if ("error" in panel) return { ok: false, message: panel.error };
	const blocked = await input.preflight?.({ panel: panel.panel, persona: parsed.persona, cwd: input.cwd });
	if (blocked) return { ok: false, message: blocked };
	const budget = input.checkBudget();
	if (budget) return { ok: false, message: budget };
	input.chargeBudget();
	try { await input.onAccepted?.({ panel: panel.panel, persona: parsed.persona, question: parsed.question, rounds: parsed.rounds }); } catch { /* progress is best-effort */ }
	try {
		const digestInput = await input.execute({ panel: panel.panel, persona: parsed.persona, question: parsed.question, rounds: parsed.rounds, cwd: input.cwd });
		const digest = formatAfDebateDigest(digestInput);
		return { ok: true, message: digest, digest, dispatcherNote: formatAfDebateDispatcherNote(digestInput, digest) };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
