/**
 * One compact Poll block per run, shared by `poll_panel` and `/af-poll`.
 * Events update an immutable snapshot that both entry points redraw in place.
 * UI-free so it runs under `node --test` without the TUI package.
 */
import type { AfPollDigestInput, AfPollVoiceDigest } from "./poll-command.ts";

export type PollPanelSource = "explicit" | "configured" | "default";
export type PollBlockStatus = "resolving" | "running" | "synthesizing" | "succeeded" | "failed";
export type PollVoiceState = "running" | "ok" | "failed" | "stopped";

export interface PollBlockVoice {
	name: string;
	model: string;
	state: PollVoiceState;
	position?: string;
	confidence?: string;
	reason?: string;
}

export interface PollBlockSynthesis { name?: string; model?: string; state: "running" | "ok" | "failed" }

export interface PollBlock {
	version: 1;
	status: PollBlockStatus;
	question: string;
	/** Set only once the panel resolved and the run was accepted. */
	panel?: string;
	source?: PollPanelSource;
	persona?: string;
	/** The validated checkout every voice and the synthesis worker ran in. */
	worktree?: string;
	/** One stable row per configured voice, in panel order. */
	voices: PollBlockVoice[];
	synthesis?: PollBlockSynthesis;
	recommendation?: string;
	failure?: string;
	/** Where the full opinions are, resolvable from the operator's working directory. */
	directory?: string;
}

export type PollEvent =
	| { type: "accepted"; panel: string; source: PollPanelSource; persona: string; worktree?: string; voices: { name: string; model: string }[] }
	| { type: "voice"; voice: AfPollVoiceDigest }
	| { type: "synthesis"; integrator?: { name: string; model: string } }
	| { type: "succeeded"; result: AfPollDigestInput }
	| { type: "failed"; reason: string };

export function initialPollBlock(question: string): PollBlock {
	return { version: 1, status: "resolving", question, voices: [] };
}

export function failedPollBlock(question: string, reason: string): PollBlock {
	return applyPollEvent(initialPollBlock(question), { type: "failed", reason });
}

function voiceRow(voice: AfPollVoiceDigest): PollBlockVoice {
	return voice.ok
		? { name: voice.name, model: voice.model, state: "ok", position: voice.position, confidence: voice.confidence }
		: { name: voice.name, model: voice.model, state: "failed", reason: voice.reason ?? "unknown error" };
}

function withVoice(voices: PollBlockVoice[], row: PollBlockVoice): PollBlockVoice[] {
	const index = voices.findIndex(voice => voice.name === row.name);
	if (index < 0) return [...voices, row];
	return voices.map((voice, at) => at === index ? row : voice);
}

const terminal = (status: PollBlockStatus) => status === "succeeded" || status === "failed";

/** Pure reducer; a finished block ignores late events. */
export function applyPollEvent(block: PollBlock, event: PollEvent): PollBlock {
	if (terminal(block.status)) return block;
	switch (event.type) {
		case "accepted":
			return {
				...block, status: "running", panel: event.panel, source: event.source, persona: event.persona, worktree: event.worktree,
				voices: event.voices.map(voice => ({ name: voice.name, model: voice.model, state: "running" as const })),
			};
		case "voice":
			return { ...block, voices: withVoice(block.voices, voiceRow(event.voice)) };
		case "synthesis":
			return { ...block, status: "synthesizing", synthesis: { name: event.integrator?.name, model: event.integrator?.model, state: "running" } };
		case "succeeded": {
			let voices = block.voices;
			for (const voice of event.result.voices) voices = withVoice(voices, voiceRow(voice));
			const integrator = event.result.integrator ?? block.synthesis?.name;
			return {
				...block, status: "succeeded", panel: event.result.panel, voices,
				synthesis: integrator || block.synthesis ? { ...block.synthesis, name: integrator, state: "ok" } : undefined,
				recommendation: event.result.recommendation, directory: event.result.directory,
			};
		}
		case "failed":
			return {
				...block, status: "failed", failure: event.reason,
				voices: block.voices.map(voice => voice.state === "running" ? { ...voice, state: "stopped" as const } : voice),
				...(block.synthesis?.state === "running" ? { synthesis: { ...block.synthesis, state: "failed" as const } } : {}),
			};
	}
}

export type PollColor = "accent" | "dim" | "muted" | "success" | "error" | "warning" | "toolTitle" | "text";
/** Structural subset of pi's Theme, so the same renderer serves the TUI and plain-text tests. */
export interface PollBlockStyle { fg(color: PollColor, text: string): string; bold(text: string): string }
export const PLAIN_POLL_STYLE: PollBlockStyle = { fg: (_color, text) => text, bold: text => text };

const COLLAPSED_TEXT = 72;
const COLLAPSED_OUTCOME = 200;

function oneLine(text: string, max?: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return max !== undefined && flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function counted(block: PollBlock): string {
	const done = block.voices.filter(voice => voice.state === "ok" || voice.state === "failed").length;
	return `${done}/${block.voices.length} voices`;
}

/** The block's first line; also the plain-text content of partial tool updates. */
export function pollBlockHeadline(block: PollBlock, style: PollBlockStyle = PLAIN_POLL_STYLE): string {
	const panel = block.panel ? ` · panel ${style.fg("accent", block.panel)}` : "";
	switch (block.status) {
		case "resolving": return `${style.fg("dim", "◌")} ${style.bold("Poll")} ${style.fg("dim", "· resolving panel…")}`;
		case "running": return `${style.fg("accent", "●")} ${style.bold("Poll")}${panel} ${style.fg("dim", `· ${counted(block)}`)}`;
		case "synthesizing": return `${style.fg("accent", "●")} ${style.bold("Poll")}${panel} ${style.fg("dim", `· ${counted(block)} · synthesizing`)}`;
		case "succeeded": return `${style.fg("success", "✓")} ${style.bold("Poll")}${panel} ${style.fg("dim", `· ${counted(block)}`)}`;
		case "failed": return `${style.fg("error", "✗")} ${style.bold("Poll failed")}${panel}`;
	}
}

export function pollBlockHasDetails(block: PollBlock): boolean {
	return block.voices.length > 0;
}

function voiceLine(voice: PollBlockVoice, expanded: boolean, style: PollBlockStyle): string[] {
	const limit = expanded ? undefined : COLLAPSED_TEXT;
	const name = expanded ? `${voice.name} · ${style.fg("dim", voice.model)}` : voice.name;
	switch (voice.state) {
		case "running": return [`  ${style.fg("accent", "○")} ${name} ${style.fg("dim", "· running…")}`];
		case "stopped": return [`  ${style.fg("dim", "–")} ${name} ${style.fg("dim", "· not completed")}`];
		case "failed": {
			const reason = oneLine(voice.reason ?? "unknown error", limit);
			return expanded
				? [`  ${style.fg("error", "✗")} ${name}`, `      ${style.fg("error", `failed: ${reason}`)}`]
				: [`  ${style.fg("error", "✗")} ${name} ${style.fg("error", `· failed: ${reason}`)}`];
		}
		case "ok": {
			const confidence = voice.confidence ? `${voice.confidence} · ` : "";
			const position = oneLine(voice.position ?? "", limit);
			return expanded
				? [`  ${style.fg("success", "✓")} ${name}${voice.confidence ? ` ${style.fg("dim", `· ${voice.confidence}`)}` : ""}`, `      ${style.fg("muted", position)}`]
				: [`  ${style.fg("success", "✓")} ${name} ${style.fg("muted", `· ${confidence}${position}`)}`];
		}
	}
}

function synthesisLine(block: PollBlock, expanded: boolean, style: PollBlockStyle): string | undefined {
	const synthesis = block.synthesis;
	if (!synthesis) return undefined;
	const who = synthesis.name ? `synthesis · ${synthesis.name}${expanded && synthesis.model ? ` · ${style.fg("dim", synthesis.model)}` : ""}` : "synthesis · no integrator";
	if (synthesis.state === "running") return `  ${style.fg("accent", "●")} ${who} ${style.fg("dim", "· integrating opinions…")}`;
	if (synthesis.state === "failed") return `  ${style.fg("error", "✗")} ${who} ${style.fg("error", "· failed")}`;
	return `  ${style.fg("success", "✓")} ${who}`;
}

/**
 * Collapsed: headline, one row per voice, the synthesis row, then the outcome.
 * Expanded adds the question, selection, worktree, full positions and reasons, and the opinions path.
 */
export function renderPollBlock(block: PollBlock, options: { expanded: boolean }, style: PollBlockStyle = PLAIN_POLL_STYLE): string[] {
	const expanded = options.expanded && pollBlockHasDetails(block);
	const lines = [pollBlockHeadline(block, style)];
	if (expanded) {
		lines.push(`  ${style.fg("dim", "question:")} ${oneLine(block.question)}`);
		const selection = [block.persona ? `persona ${block.persona}` : "", block.panel ? `panel ${block.panel}${block.source ? ` (${block.source})` : ""}` : ""].filter(Boolean).join(" · ");
		if (selection) lines.push(`  ${style.fg("dim", selection)}`);
		if (block.worktree) lines.push(`  ${style.fg("dim", `worktree ${block.worktree}`)}`);
	}
	for (const voice of block.voices) lines.push(...voiceLine(voice, expanded, style));
	const synthesis = synthesisLine(block, expanded, style);
	if (synthesis) lines.push(synthesis);
	if (block.status === "succeeded" && block.recommendation) {
		lines.push(`  ${style.fg("success", "→")} ${style.fg("text", oneLine(block.recommendation, expanded ? undefined : COLLAPSED_OUTCOME))}`);
	}
	if (block.status === "failed" && block.failure) lines.push(`  ${style.fg("error", block.failure)}`);
	if (expanded && block.directory) lines.push(`  ${style.fg("dim", `full opinions: ${block.directory}`)}`);
	return lines;
}
