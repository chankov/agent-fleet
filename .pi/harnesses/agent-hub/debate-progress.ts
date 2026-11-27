/**
 * One compact Debate block per run, shared by `debate_panel` and `/af-debate`.
 * Events update an immutable snapshot that both entry points redraw in place: the resolved panel,
 * the current round of the total, one stable row per voice, then the outcome or the failure reason.
 * UI-free so it runs under `node --test` without the TUI package.
 */
import { PLAIN_POLL_STYLE, type PollBlockStyle, type PollPanelSource } from "./poll-progress.ts";

export type DebateBlockStatus = "resolving" | "running" | "succeeded" | "failed";
/** `out`: failed in an earlier round, so it takes no part in later ones. `stopped`: the run ended first. */
export type DebateVoiceState = "waiting" | "running" | "ok" | "failed" | "out" | "stopped";

/** One voice's report in one round, as the progress events carry it. */
export interface DebateVoiceTurn {
	name: string;
	model: string;
	round: number;
	ok: boolean;
	position?: string;
	changed?: boolean;
	reason?: string;
	/** The round artifact, as the operator can open it. */
	path?: string;
}

/** A voice's position change: the round it changed in, the position before, and the evidence that moved it. */
export interface DebatePositionChange { round: number; from?: string; evidence: string[] }

/** A voice at the end of the debate. */
export interface DebateVoiceOutcome {
	name: string;
	model: string;
	/** The last round with a successful report; 0 when the voice never produced one. */
	finalRound: number;
	position?: string;
	changes: DebatePositionChange[];
	alignedWith: string[];
	refutes: string[];
	/** Set when the voice failed in a round and dropped out. */
	failedRound?: number;
	reason?: string;
	/** The artifact of its final successful round, or of its failure. */
	path?: string;
}

export interface DebateRoundSummary {
	round: number;
	directory: string;
	voices: { name: string; ok: boolean; changed?: boolean; reason?: string; path: string }[];
}

/** The structured Debate result: what the digest, the block and the tool details are built from. */
export interface AfDebateResult {
	panel: string;
	question: string;
	/** Requested rounds (2–5). */
	rounds: number;
	roundsRun: number;
	/** Every requested round ran and the last one had at least two successful voices. */
	complete: boolean;
	stopReason?: string;
	voices: DebateVoiceOutcome[];
	/** Each final-round refutation, attributed to the voice that made it. No judge decides them. */
	disagreements: { voice: string; statement: string }[];
	roundDetails: DebateRoundSummary[];
	/** The whole debate on disk, resolvable from the operator's working directory. */
	directory: string;
}

export interface DebateBlockVoice {
	name: string;
	model: string;
	state: DebateVoiceState;
	/** The round of the current state. */
	round?: number;
	position?: string;
	changed?: boolean;
	reason?: string;
}

export interface DebateBlock {
	version: 1;
	kind: "debate";
	status: DebateBlockStatus;
	question: string;
	panel?: string;
	source?: PollPanelSource;
	persona?: string;
	worktree?: string;
	/** Requested rounds, known once accepted. */
	rounds?: number;
	/** The round running now, or the last one that ran. */
	round?: number;
	voices: DebateBlockVoice[];
	result?: AfDebateResult;
	failure?: string;
	directory?: string;
}

export type DebateEvent =
	| { type: "accepted"; panel: string; source: PollPanelSource; persona: string; worktree?: string; rounds: number; voices: { name: string; model: string }[] }
	| { type: "round"; round: number; voices: string[] }
	| { type: "voice"; turn: DebateVoiceTurn }
	| { type: "succeeded"; result: AfDebateResult }
	| { type: "failed"; reason: string; directory?: string };

export function initialDebateBlock(question: string): DebateBlock {
	return { version: 1, kind: "debate", status: "resolving", question, voices: [] };
}

export function failedDebateBlock(question: string, reason: string): DebateBlock {
	return applyDebateEvent(initialDebateBlock(question), { type: "failed", reason });
}

function upsert(voices: DebateBlockVoice[], name: string, model: string, update: (voice: DebateBlockVoice) => DebateBlockVoice): DebateBlockVoice[] {
	const index = voices.findIndex(voice => voice.name === name);
	if (index < 0) return [...voices, update({ name, model, state: "waiting" })];
	return voices.map((voice, at) => at === index ? update(voice) : voice);
}

const terminal = (status: DebateBlockStatus) => status === "succeeded" || status === "failed";

/** Pure reducer; a finished block ignores late events. */
export function applyDebateEvent(block: DebateBlock, event: DebateEvent): DebateBlock {
	if (terminal(block.status)) return block;
	switch (event.type) {
		case "accepted":
			return {
				...block, status: "running", panel: event.panel, source: event.source, persona: event.persona, worktree: event.worktree,
				rounds: event.rounds, voices: event.voices.map(voice => ({ name: voice.name, model: voice.model, state: "waiting" as const })),
			};
		case "round": {
			const taking = new Set(event.voices);
			let voices = block.voices;
			for (const name of event.voices) if (!voices.some(voice => voice.name === name)) voices = [...voices, { name, model: "", state: "waiting" }];
			voices = voices.map(voice => taking.has(voice.name)
				? { ...voice, state: "running" as const, round: event.round }
				: voice.state === "failed" ? { ...voice, state: "out" as const } : voice);
			return { ...block, round: event.round, voices };
		}
		case "voice": {
			const turn = event.turn;
			return {
				...block,
				voices: upsert(block.voices, turn.name, turn.model, voice => turn.ok
					? { ...voice, model: turn.model || voice.model, state: "ok", round: turn.round, position: turn.position, changed: turn.changed, reason: undefined }
					: { ...voice, model: turn.model || voice.model, state: "failed", round: turn.round, reason: turn.reason ?? "unknown error" }),
			};
		}
		case "succeeded": {
			const result = event.result;
			let voices = block.voices;
			for (const outcome of result.voices) {
				voices = upsert(voices, outcome.name, outcome.model, voice => outcome.failedRound !== undefined
					? { ...voice, model: outcome.model, state: "failed", round: outcome.failedRound, reason: outcome.reason ?? "unknown error", position: outcome.position }
					: { ...voice, model: outcome.model, state: "ok", round: outcome.finalRound, position: outcome.position, changed: outcome.changes.length > 0, reason: undefined });
			}
			return { ...block, status: "succeeded", panel: result.panel, round: result.roundsRun, rounds: result.rounds, voices, result, directory: result.directory };
		}
		case "failed":
			return {
				...block, status: "failed", failure: event.reason, directory: event.directory ?? block.directory,
				voices: block.voices.map(voice => voice.state === "running" || voice.state === "waiting" ? { ...voice, state: "stopped" as const } : voice),
			};
	}
}

const COLLAPSED_TEXT = 72;
const COLLAPSED_OUTCOME = 200;

function oneLine(text: string, max?: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return max !== undefined && flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function roundOf(block: DebateBlock): string {
	return block.rounds ? `round ${block.round ?? 0}/${block.rounds}` : "";
}

/** The block's first line; also the plain-text content of partial tool updates. */
export function debateBlockHeadline(block: DebateBlock, style: PollBlockStyle = PLAIN_POLL_STYLE): string {
	const panel = block.panel ? ` · panel ${style.fg("accent", block.panel)}` : "";
	switch (block.status) {
		case "resolving": return `${style.fg("dim", "◌")} ${style.bold("Debate")} ${style.fg("dim", "· resolving panel…")}`;
		case "running": {
			const done = block.voices.filter(voice => voice.round === block.round && (voice.state === "ok" || voice.state === "failed")).length;
			const taking = block.voices.filter(voice => voice.round === block.round && voice.state !== "out").length;
			const progress = block.round ? `${roundOf(block)} · ${done}/${taking} voices` : `${block.rounds ?? "?"} rounds · starting`;
			return `${style.fg("accent", "●")} ${style.bold("Debate")}${panel} ${style.fg("dim", `· ${progress}`)}`;
		}
		case "succeeded": {
			const result = block.result;
			const ran = result ? `${result.roundsRun}/${result.rounds} rounds` : roundOf(block);
			return result && !result.complete
				? `${style.fg("warning", "◐")} ${style.bold("Debate")}${panel} ${style.fg("dim", `· ${ran} · stopped early`)}`
				: `${style.fg("success", "✓")} ${style.bold("Debate")}${panel} ${style.fg("dim", `· ${ran}`)}`;
		}
		case "failed": return `${style.fg("error", "✗")} ${style.bold("Debate failed")}${panel}${block.round ? ` ${style.fg("dim", `· ${roundOf(block)}`)}` : ""}`;
	}
}

export function debateBlockHasDetails(block: DebateBlock): boolean {
	return block.voices.length > 0;
}

function voiceLine(voice: DebateBlockVoice, block: DebateBlock, expanded: boolean, style: PollBlockStyle): string[] {
	const limit = expanded ? undefined : COLLAPSED_TEXT;
	const name = expanded && voice.model ? `${voice.name} · ${style.fg("dim", voice.model)}` : voice.name;
	const at = voice.round ? ` · r${voice.round}` : "";
	switch (voice.state) {
		case "waiting": return [`  ${style.fg("dim", "·")} ${name} ${style.fg("dim", "· waiting")}`];
		case "running": return [`  ${style.fg("accent", "○")} ${name} ${style.fg("dim", `· ${voice.round ? `r${voice.round} · ` : ""}running…`)}`];
		case "stopped": return [`  ${style.fg("dim", "–")} ${name} ${style.fg("dim", "· not completed")}`];
		case "out":
		case "failed": {
			const reason = oneLine(voice.reason ?? "unknown error", limit);
			const label = `failed in r${voice.round ?? "?"}: ${reason}`;
			return expanded
				? [`  ${style.fg("error", "✗")} ${name}`, `      ${style.fg("error", label)}`]
				: [`  ${style.fg("error", "✗")} ${name} ${style.fg("error", `· ${label}`)}`];
		}
		case "ok": {
			const outcome = block.result?.voices.find(item => item.name === voice.name);
			const change = outcome
				? (outcome.changes.length ? `changed in r${outcome.changes.map(item => item.round).join(", r")}` : "held")
				: (voice.round && voice.round > 1 ? (voice.changed ? "changed" : "held") : "");
			const tag = [at.replace(/^ · /, ""), change].filter(Boolean).join(" · ");
			const position = oneLine(voice.position ?? "", limit);
			if (!expanded) return [`  ${style.fg("success", "✓")} ${name} ${style.fg("muted", `· ${tag ? `${tag} · ` : ""}${position}`)}`];
			const lines = [`  ${style.fg("success", "✓")} ${name}${tag ? ` ${style.fg("dim", `· ${tag}`)}` : ""}`, `      ${style.fg("muted", position)}`];
			for (const item of outcome?.changes ?? []) {
				if (item.from) lines.push(`      ${style.fg("dim", `r${item.round} was: ${oneLine(item.from)}`)}`);
				lines.push(`      ${style.fg("dim", `r${item.round} moved by: ${item.evidence.length ? item.evidence.map(text => oneLine(text)).join("; ") : "(no evidence given)"}`)}`);
			}
			if (outcome?.alignedWith.length) lines.push(`      ${style.fg("dim", `aligned with: ${outcome.alignedWith.join(", ")}`)}`);
			return lines;
		}
	}
}

/**
 * Collapsed: headline, one row per voice, then the outcome (open disagreements) or the failure.
 * Expanded adds the question, selection, worktree, full positions, changes with evidence,
 * each disagreement, the round artifacts and the debate directory.
 */
export function renderDebateBlock(block: DebateBlock, options: { expanded: boolean }, style: PollBlockStyle = PLAIN_POLL_STYLE): string[] {
	const expanded = options.expanded && debateBlockHasDetails(block);
	const lines = [debateBlockHeadline(block, style)];
	if (expanded) {
		lines.push(`  ${style.fg("dim", "question:")} ${oneLine(block.question)}`);
		const selection = [
			block.persona ? `persona ${block.persona}` : "",
			block.panel ? `panel ${block.panel}${block.source ? ` (${block.source})` : ""}` : "",
			block.rounds ? `${block.rounds} rounds` : "",
		].filter(Boolean).join(" · ");
		if (selection) lines.push(`  ${style.fg("dim", selection)}`);
		if (block.worktree) lines.push(`  ${style.fg("dim", `worktree ${block.worktree}`)}`);
	}
	for (const voice of block.voices) lines.push(...voiceLine(voice, block, expanded, style));
	const result = block.result;
	if (block.status === "succeeded" && result) {
		if (result.stopReason) lines.push(`  ${style.fg("warning", `stopped: ${result.stopReason}`)}`);
		if (!result.disagreements.length) lines.push(`  ${style.fg("success", "→")} ${style.fg("text", "no open disagreement reported by the voices")}`);
		else if (!expanded) {
			const first = result.disagreements[0];
			const more = result.disagreements.length > 1 ? ` (+${result.disagreements.length - 1} more)` : "";
			lines.push(`  ${style.fg("warning", "⚑")} ${style.fg("text", oneLine(`${result.disagreements.length} open disagreement${result.disagreements.length > 1 ? "s" : ""} · ${first.voice}: ${first.statement}${more}`, COLLAPSED_OUTCOME))}`);
		} else {
			lines.push(`  ${style.fg("warning", "⚑")} ${style.fg("text", "open disagreements:")}`);
			for (const item of result.disagreements) lines.push(`      ${style.fg("text", `${item.voice}: ${oneLine(item.statement)}`)}`);
		}
		if (expanded) {
			for (const round of result.roundDetails) {
				const ok = round.voices.filter(voice => voice.ok).length;
				lines.push(`  ${style.fg("dim", `round ${round.round}: ${ok}/${round.voices.length} ok · ${round.directory}`)}`);
			}
		}
	}
	if (block.status === "failed" && block.failure) lines.push(`  ${style.fg("error", block.failure)}`);
	if (expanded && block.directory) lines.push(`  ${style.fg("dim", `full debate: ${block.directory}`)}`);
	return lines;
}
