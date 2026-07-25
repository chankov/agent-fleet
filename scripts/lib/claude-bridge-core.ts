// scripts/lib/claude-bridge-core.ts
//
// Pure logic for the Claude Code coms bridge (scripts/coms-claude-bridge.ts):
// prompt formatting, completion sentinels, hook-record parsing, reply
// extraction from pane text, and the serial prompt queue. No sockets, no fs,
// no herdr — everything here runs under node --test.

export const SENTINEL_PREFIX = "<<COMS_DONE:";

// ── reply-timeout and idle-wait policy ──
//
// Two field failures live here. First, the bridge only ever read its own
// --reply-timeout: a caller that asked for 1_800_000ms was still told "no reply
// within 600000ms", so a review that honestly takes more than ten minutes could
// not succeed at all. Second, a pane that was mid-turn threw instantly, which
// turned every busy moment into a hard error — ten of eighteen coms_await calls
// in one session died that way, the caller hot-retried every few seconds, and
// then fell back to reading the pane 127 times to watch progress by hand.

/** No caller may hold a pane hostage indefinitely. */
export const REPLY_TIMEOUT_HARD_CAP_MS = 3_600_000;

/** Backoff while waiting for a busy pane, in ms; the last step repeats. */
export const IDLE_WAIT_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

/** Longest we will ever wait for a pane to go idle before giving up. */
export const IDLE_WAIT_CAP_MS = 120_000;

/**
 * The caller's own deadline wins — it knows how long the work takes — falling
 * back to the bridge's configured timeout and always clamped to the hard cap.
 */
export function resolveReplyTimeoutMs(requested: unknown, fallbackMs: number, capMs = REPLY_TIMEOUT_HARD_CAP_MS): number {
	const asked = Number(requested);
	const base = Number.isFinite(asked) && asked > 0 ? asked : fallbackMs;
	return Math.max(1, Math.min(base, capMs));
}

/** Backoff delay for the nth idle-wait attempt (0-based); the last step repeats. */
export function idleWaitDelayMs(attempt: number): number {
	const i = Math.max(0, Math.min(Math.floor(attempt), IDLE_WAIT_BACKOFF_MS.length - 1));
	return IDLE_WAIT_BACKOFF_MS[i];
}

/**
 * How long to wait for a busy pane. Never more than half the caller's reply
 * budget — waiting to start must not consume the time meant for the answer.
 */
export function idleWaitBudgetMs(replyTimeoutMs: number, capMs = IDLE_WAIT_CAP_MS): number {
	const half = Math.floor((Number(replyTimeoutMs) || 0) / 2);
	return Math.max(0, Math.min(capMs, half));
}

export function completionSentinel(msgId: string): string {
	return `${SENTINEL_PREFIX}${msgId}>>`;
}

// The prompt as typed into the Claude Code pane. Mirrors the pi side's
// "[from name @ cwd]" framing so Claude knows who is asking; in sentinel mode
// (no Stop hook seen yet) it also asks for the completion marker.
export function formatPanePrompt(
	env: { prompt: string; sender_name: string; sender_cwd: string; msg_id: string },
	sentinelMode: boolean,
): string {
	const header = `[coms message from ${env.sender_name} @ ${env.sender_cwd}] `;
	const sentinelNote = sentinelMode
		? `\n\nEnd your reply with this exact line so the bridge can capture it: ${completionSentinel(env.msg_id)}`
		: "";
	return `${header}${env.prompt}${sentinelNote}`;
}

// Stop-hook record: the hook writes {text, session_id?, written_at} as JSON.
export interface HookRecord {
	text: string;
	written_at?: string;
	[key: string]: unknown;
}

export function parseHookRecord(raw: string): HookRecord | null {
	try {
		const rec = JSON.parse(raw);
		if (rec && typeof rec.text === "string") return rec as HookRecord;
		return null;
	} catch {
		return null;
	}
}

// Sentinel-mode fallback: pull the reply out of raw pane text. Takes
// everything between the last prompt echo (identified by the msg_id-bearing
// sentinel instruction OR the header line) and the sentinel line, stripped of
// obvious TUI furniture. Returns null when the sentinel has not appeared.
export function extractSentinelReply(paneText: string, msgId: string): string | null {
	const sentinel = completionSentinel(msgId);
	const at = paneText.lastIndexOf(sentinel);
	if (at === -1) return null;
	const before = paneText.slice(0, at);
	// Cut at the end of the prompt echo: the sentinel instruction line
	// contains the sentinel too, so use the LAST occurrence before the final
	// one — that's the echo; the reply follows it.
	const echoAt = before.lastIndexOf(sentinel);
	const replyRegion = echoAt !== -1 ? before.slice(echoAt + sentinel.length) : before;
	const lines = replyRegion
		.split("\n")
		.map((l) => l.replace(/^[●❯>\s]+/, "").trimEnd())
		.filter((l) => l.trim() !== "" && !/^[─━┏┗┃│]+/.test(l));
	return lines.join("\n").trim() || null;
}

// ━━ Serial prompt queue ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// One prompt at a time per pane; queue depth is reported in the agent card.

export interface QueuedPrompt<T> {
	envelope: T;
	enqueued_at: string;
}

export class PromptQueue<T> {
	private items: Array<QueuedPrompt<T>> = [];
	private active = false;

	get depth(): number {
		return this.items.length + (this.active ? 1 : 0);
	}

	push(envelope: T, now: () => string = () => new Date().toISOString()): void {
		this.items.push({ envelope, enqueued_at: now() });
	}

	// Take the next prompt if none is being processed. Callers MUST call
	// done() when processing finishes (success or failure).
	take(): QueuedPrompt<T> | null {
		if (this.active) return null;
		const next = this.items.shift();
		if (!next) return null;
		this.active = true;
		return next;
	}

	done(): void {
		this.active = false;
	}
}
