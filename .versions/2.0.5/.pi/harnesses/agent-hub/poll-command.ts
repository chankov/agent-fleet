/** Pure `/af-poll` argument, panel, and digest helpers. The hub command is a thin consumer. */

export const HUB_POLL_DEFAULT_PERSONA = "researcher";

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

export interface AfPollHandleInput {
	args: string;
	cwd: string;
	pollPanelOverride?: string | null;
	listPanels: (cwd: string) => string[] | Promise<string[]>;
	preflight?: (options: { panel: string; persona: string; cwd: string }) => string | null | Promise<string | null>;
	checkBudget: () => string | null;
	chargeBudget: () => void;
	onAccepted?: (info: { panel: string; persona: string; question: string }) => void | Promise<void>;
	execute: (options: { panel: string; persona: string; question: string; cwd: string }) => Promise<AfPollDigestInput>;
}

export interface AfPollHandleResult {
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

export function formatAfPollStarted(info: { panel: string; persona: string; question: string; voices?: { name: string; model: string }[] }): string {
	const roster = info.voices?.length
		? info.voices.map(voice => `${voice.name} · ${voice.model}`).join("\n")
		: "(voices loading)";
	return [
		`POLL STARTED (panel ${info.panel}, persona ${info.persona})`,
		"",
		`Question: ${info.question}`,
		"",
		"Voices:",
		roster,
		"",
		"Running read-only. Full opinions stay on disk; a digest follows when every voice and the merge finish.",
	].join("\n");
}

export function formatAfPollVoiceProgress(voice: AfPollVoiceDigest): string {
	if (!voice.ok) return `POLL VOICE ${voice.name} · ${voice.model}\n  failed: ${voice.reason ?? "unknown error"}`;
	return `POLL VOICE ${voice.name} · ${voice.model}\n  position: ${voice.position ?? ""}\n  confidence: ${voice.confidence ?? ""}`;
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

export async function handleAfPoll(input: AfPollHandleInput): Promise<AfPollHandleResult> {
	const parsed = parseAfPollArgs(input.args);
	if (parsed.error) return { ok: false, message: parsed.error };
	const available = await input.listPanels(input.cwd);
	const panel = resolveAfPollPanel(parsed.panel, input.pollPanelOverride, available);
	if ("error" in panel) return { ok: false, message: panel.error };
	const blocked = await input.preflight?.({ panel: panel.panel, persona: parsed.persona, cwd: input.cwd });
	if (blocked) return { ok: false, message: blocked };
	const budget = input.checkBudget();
	if (budget) return { ok: false, message: budget };
	input.chargeBudget();
	try { await input.onAccepted?.({ panel: panel.panel, persona: parsed.persona, question: parsed.question }); } catch { /* progress is best-effort */ }
	try {
		const digestInput = await input.execute({ panel: panel.panel, persona: parsed.persona, question: parsed.question, cwd: input.cwd });
		const digest = formatAfPollDigest(digestInput);
		return { ok: true, message: digest, digest, dispatcherNote: formatAfPollDispatcherNote(digestInput, digest) };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
