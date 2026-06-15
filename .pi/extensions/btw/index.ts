/**
 * btw — in-process side tasks for pi with a live modal, modeled on Claude Code's `/btw`.
 *
 * `/btw <task>` forks the CURRENT session into an in-process sub-session
 * (`createAgentSession`) that inherits the full conversation as context, works the
 * side task in the same cwd, and streams into a modal overlay with its own
 * transcript + follow-up composer. A compact result card lands in the main
 * transcript when the session next goes idle.
 *
 * Design constraints (all intentional — see .pi/extensions/btw/README.md):
 *   - Command-only surface. No model-callable tool, no subcommands. `/btw <task>`
 *     starts a task and opens the modal; `/btw` (no args) or `Alt+Shift+B` reopens it.
 *   - In-process sub-session, NOT a child `pi` process. The fork is a real
 *     `AgentSession` with fixed built-in tools and NO extensions/custom tools (the
 *     sub-session loads no extension runtime → no recursion, mirroring the old
 *     `--no-extensions` child).
 *   - The modal is the primary surface: it opens immediately, streams the
 *     sub-session live, and accepts follow-ups (mid-run follow-ups steer the active
 *     run; idle follow-ups start a fresh turn). `Esc` hides it (the task keeps
 *     running); completion only toasts — it never steals focus.
 *   - Each completed turn writes `.pi/btw-sessions/<id>.result.md` and queues a
 *     COMPACT card (✓/✗ + note + elapsed + first lines + artifact path) for the
 *     main transcript, delivered only when idle and kept OUT of the main agent's
 *     LLM context via an on("context") filter.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	MessageRenderer,
	ContextEvent,
	Theme,
	AgentSession,
	AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import {
	getMarkdownTheme,
	copyToClipboard,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	getAgentDir,
	DynamicBorder,
} from "@mariozechner/pi-coding-agent";
import {
	Text,
	Box,
	Container,
	Spacer,
	Markdown,
	Input,
	matchesKey,
	Key,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	MAX_RETAINED_TERMINAL_THREADS,
	appendTimelineDelta as appendTimelineDeltaState,
	appendTimelineEntry as appendTimelineEntryState,
	beginTurn,
	capSelectedMarkdown,
	clampModalView,
	finishTurn,
	formatBtwCardPreview,
	formatBtwResultMarkdown,
	isTerminalStatus,
	planTerminalRetention,
	reconcileThreadView,
	resolveThreadId,
	shiftModalViewForPrunedEntries,
	steerTurn,
	turnElapsedMs,
} from "./state.js";

const RESULT_TYPE = "btw-result";
const STATUS_KEY = "btw";
// Background artifacts (forked session JSONL + result.md) older than this are pruned
// on session_start. They are pure debugging aids — the result also lives in the chat.
const CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Coding tools the sub-session runs with (matches pi's default built-in set).
const SUBSESSION_TOOLS = ["read", "bash", "edit", "write"];
// Modal sizing.
const MODAL_WIDTH = "78%";
const MODAL_MAX_HEIGHT = "80%";
// Transcript body height budget inside the modal (rows). Keeps the composer visible.
const BODY_ROWS = 20;
// One entry in a thread's live transcript. Consecutive text/thinking deltas are
// coalesced into the trailing entry of the same kind; each tool call and each
// operator follow-up is its own entry.
interface TimelineEntry {
	kind: "text" | "tool" | "thinking" | "user";
	title: string;
	content: string;
	timestamp: number;
	toolCallId?: string;
}

// A running (or finished) btw side task. Multiple may run concurrently; the modal
// binds to one at a time (`render` is set only while it is the shown thread).
interface BtwThread {
	id: string;
	note: string;
	session: AgentSession;
	status: "running" | "done" | "error";
	timeline: TimelineEntry[];
	// Lifetime marker for the retained thread; current-turn timing is separate.
	startedAt: number;
	turnStartedAt?: number;
	turnFinishedAt?: number;
	turns: number;
	sessionFile: string;
	resultPath: string;
	unsubscribe?: () => void;
	disposed?: boolean;
	render?: (force?: boolean) => void;
}

interface BtwDetails {
	id: string;
	note: string;
	ok: boolean;
	elapsedMs: number;
	resultPath: string;
}

interface PendingResult {
	content: string;
	details: BtwDetails;
}

interface CurrentModalHandle {
	show: (id: string) => void;
	currentId: () => string | undefined;
	timelinePruned: (id: string, prunedCount: number) => void;
	clamp: () => void;
}

export default function btwExtension(pi: ExtensionAPI) {
	// Live threads keyed by btw id; `order` tracks creation order for ←/→ cycling
	// and "most recent" defaults.
	const threads = new Map<string, BtwThread>();
	const order: string[] = [];
	// Compact result cards waiting for the session to go idle before they are shown.
	const pending: PendingResult[] = [];
	// Most-recent context, refreshed on every hook so deferred delivery, status, and
	// the modal always have a live handle after the original command returned.
	let latestCtx: ExtensionContext | undefined;
	// Modal lifecycle: guard against double-open, remember last-viewed thread, and
	// expose a handle so a fresh /btw can retarget an already-open modal.
	let modalOpen = false;
	let lastViewedId: string | undefined;
	let currentModal: CurrentModalHandle | undefined;
	// Set on session_shutdown so abort()-driven prompt rejections don't push cards.
	let shuttingDown = false;

	function sessionsDir(ctx: ExtensionContext): string {
		return join(ctx.cwd, ".pi", "btw-sessions");
	}

	function mostRecentId(): string | undefined {
		return resolveThreadId(undefined, order);
	}

	function runningCount(): number {
		let n = 0;
		for (const t of threads.values()) if (t.status === "running") n++;
		return n;
	}

	function updateStatus(ctx: ExtensionContext | undefined): void {
		const n = runningCount();
		ctx?.ui.setStatus(STATUS_KEY, n > 0 ? `btw: ${n} running` : undefined);
	}

	function threadElapsedMs(t: BtwThread): number {
		return turnElapsedMs(t, Date.now());
	}

	function fmtDuration(ms: number): string {
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		return `${Math.floor(s / 60)}m ${s % 60}s`;
	}

	// Deliver queued cards, but ONLY when idle. During streaming, sendMessage would
	// steer/follow-up the active turn; the no-options call lands in the "append +
	// display, no turn" branch only when not streaming. agent_end re-drives this.
	function flush(): void {
		const ctx = latestCtx;
		if (!ctx || !ctx.isIdle() || pending.length === 0) return;
		const batch = pending.splice(0);
		for (const r of batch) {
			pi.sendMessage({ customType: RESULT_TYPE, content: r.content, display: true, details: r.details });
		}
	}

	function cleanupOldArtifacts(ctx: ExtensionContext): void {
		const dir = sessionsDir(ctx);
		if (!existsSync(dir)) return;
		const cutoff = Date.now() - CLEANUP_MAX_AGE_MS;
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			try {
				if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
			} catch {
				/* best-effort */
			}
		}
	}

	function unsubscribeThread(t: BtwThread): void {
		const unsubscribe = t.unsubscribe;
		if (!unsubscribe) return;
		t.unsubscribe = undefined;
		try {
			unsubscribe();
		} catch {
			/* best-effort */
		}
	}

	function ensureSubscribed(t: BtwThread): void {
		if (t.disposed || t.unsubscribe) return;
		t.unsubscribe = t.session.subscribe((ev) => handleEvent(t, ev));
	}

	function disposeThread(t: BtwThread): void {
		if (t.disposed) return;
		unsubscribeThread(t);
		t.render = undefined;
		t.disposed = true;
		try {
			t.session.dispose();
		} catch {
			/* best-effort */
		}
	}

	function reconcileThreadPointers(): void {
		const currentId = currentModal?.currentId();
		const view = reconcileThreadView({ order, lastViewedId, currentId });
		lastViewedId = view.lastViewedId;
		if (!currentModal) return;
		if (view.currentId && view.currentId !== currentId) currentModal.show(view.currentId);
		else currentModal.clamp();
	}

	function enforceTerminalRetention(): void {
		const statuses = new Map<string, BtwThread["status"]>();
		for (const id of order) {
			const t = threads.get(id);
			if (t) statuses.set(id, t.status);
		}
		const plan = planTerminalRetention(order, statuses, MAX_RETAINED_TERMINAL_THREADS);
		if (plan.evictedIds.length === 0) return;

		const evicted = new Set<string>();
		for (const id of plan.evictedIds) {
			const t = threads.get(id);
			if (!t || !isTerminalStatus(t.status)) continue;
			disposeThread(t);
			threads.delete(id);
			evicted.add(id);
		}
		if (evicted.size === 0) return;
		order.length = 0;
		order.push(...plan.order.filter((id) => threads.has(id) && !evicted.has(id)));
		reconcileThreadPointers();
	}

	function applyTimelineResult(t: BtwThread, result: { timeline: TimelineEntry[]; prunedCount: number }): void {
		t.timeline = result.timeline;
		if (result.prunedCount > 0) currentModal?.timelinePruned(t.id, result.prunedCount);
	}

	function addTimelineEntry(t: BtwThread, entry: Omit<TimelineEntry, "timestamp"> & { timestamp?: number }): void {
		applyTimelineResult(t, appendTimelineEntryState(t.timeline, entry, Date.now()));
	}

	// Framing for the side task. Unlike the old child-process version there IS now an
	// interactive surface (the modal composer), so the "unattended" instruction is
	// gone; the scoping + summary instructions stay.
	function framedTask(note: string): string {
		return [
			"You have been resumed into a copy of another pi session — the conversation",
			"history above is your full context. You are working a side task while the main",
			"session continues. An operator is watching this side task in a modal and can send",
			"you follow-up messages, so ask a brief clarifying question only if you are truly",
			"blocked. Your file changes land in the same working directory as the main session,",
			"so keep them scoped to exactly what the task asks.",
			"",
			`Side task: ${note}`,
			"",
			"End your reply with a concise summary of what you did and any result the main",
			"session needs.",
		].join("\n");
	}

	// Coalesce a streaming text/thinking delta: extend the trailing entry when it is
	// the same kind, otherwise start a new one. The state helper caps entry content
	// and prunes old transcript entries before the modal sees the update.
	function appendDelta(t: BtwThread, kind: "text" | "thinking", delta: string): void {
		applyTimelineResult(t, appendTimelineDeltaState(t.timeline, kind, delta, Date.now()));
	}

	function summarizeToolArgs(toolName: string, args: unknown): string {
		if (args && typeof args === "object") {
			const a = args as Record<string, unknown>;
			const path = a.file_path ?? a.path;
			if (typeof path === "string") return path;
			if (typeof a.command === "string") return a.command;
			if (typeof a.pattern === "string") return a.pattern;
		}
		try {
			const json = JSON.stringify(args);
			return json && json !== "{}" ? truncateToWidth(json, 200) : "";
		} catch {
			return "";
		}
	}

	// Translate sub-session events into transcript entries.
	function handleEvent(t: BtwThread, ev: AgentSessionEvent): void {
		if (ev.type === "message_update") {
			const a = ev.assistantMessageEvent;
			if (a.type === "text_delta") appendDelta(t, "text", a.delta);
			else if (a.type === "thinking_delta") appendDelta(t, "thinking", a.delta);
			else return;
		} else if (ev.type === "tool_execution_start") {
			addTimelineEntry(t, {
				kind: "tool",
				title: ev.toolName || "tool",
				content: summarizeToolArgs(ev.toolName, ev.args),
				toolCallId: ev.toolCallId,
			});
		} else if (ev.type === "tool_execution_end") {
			for (let i = t.timeline.length - 1; i >= 0; i--) {
				const e = t.timeline[i];
				if (e.kind === "tool" && e.toolCallId === ev.toolCallId) {
					e.title = `${ev.toolName || "tool"} — ${ev.isError ? "✗ error" : "✓ done"}`;
					break;
				}
			}
		} else {
			return;
		}
		t.render?.(false);
	}

	function writeResult(t: BtwThread, ok: boolean, answer: string, elapsedMs: number): void {
		try {
			writeFileSync(
				t.resultPath,
				formatBtwResultMarkdown({
					note: t.note,
					ok,
					elapsedMs,
					sessionFile: t.sessionFile,
					answer,
				}),
			);
		} catch {
			/* best-effort */
		}
	}

	function pushCard(t: BtwThread, ok: boolean, answer: string, elapsedMs: number): void {
		pending.push({
			content: formatBtwCardPreview(answer),
			details: { id: t.id, note: t.note, ok, elapsedMs, resultPath: t.resultPath },
		});
	}

	function onTurnDone(t: BtwThread): void {
		// abort() during shutdown resolves the prompt too — don't emit a card then.
		if (shuttingDown) return;
		t.turns += 1;
		Object.assign(t, finishTurn(t, Date.now(), "done"));
		unsubscribeThread(t);
		const elapsedMs = threadElapsedMs(t);
		const answer = (t.session.getLastAssistantText() || "").trim() || "_(side task finished but produced no text output)_";
		writeResult(t, true, answer, elapsedMs);
		pushCard(t, true, answer, elapsedMs);
		updateStatus(latestCtx);
		t.render?.(true);
		latestCtx?.ui.notify(`btw done (${fmtDuration(elapsedMs)}): ${t.note}`, "info");
		enforceTerminalRetention();
		flush();
	}

	function onTurnError(t: BtwThread, err: unknown): void {
		if (shuttingDown) return;
		Object.assign(t, finishTurn(t, Date.now(), "error"));
		unsubscribeThread(t);
		const elapsedMs = threadElapsedMs(t);
		const message = err instanceof Error ? err.message : String(err);
		const answer = `**Side task failed.**\n\n\`\`\`\n${message}\n\`\`\``;
		addTimelineEntry(t, { kind: "text", title: "Error", content: answer });
		writeResult(t, false, answer, elapsedMs);
		pushCard(t, false, answer, elapsedMs);
		updateStatus(latestCtx);
		t.render?.(true);
		latestCtx?.ui.notify(`btw error: ${t.note}`, "error");
		enforceTerminalRetention();
		flush();
	}

	// Start a fresh turn on an idle thread (initial task or an idle follow-up). The
	// prompt() promise resolves at the real agent_end, so it is our completion signal.
	function startTurn(t: BtwThread, text: string): void {
		Object.assign(t, beginTurn(t, Date.now()));
		ensureSubscribed(t);
		updateStatus(latestCtx);
		t.session.prompt(text).then(
			() => onTurnDone(t),
			(err) => onTurnError(t, err),
		);
	}

	// Submit an operator follow-up. Mid-run it steers the active turn (and folds into
	// that run's completion, so we do NOT attach a second completion handler); idle it
	// starts a fresh turn.
	function submitFollowUp(id: string, text: string): void {
		const t = threads.get(id);
		if (!t) return;
		addTimelineEntry(t, { kind: "user", title: "You", content: text });
		if (t.session.isStreaming) {
			Object.assign(t, steerTurn(t));
			t.session.prompt(text, { streamingBehavior: "steer" }).catch((err) => {
				// Race: the run finished between the check and the queue → run it fresh.
				if (!t.session.isStreaming) startTurn(t, text);
				else latestCtx?.ui.notify(`btw: follow-up failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			});
			updateStatus(latestCtx);
		} else {
			startTurn(t, text);
		}
		t.render?.(true);
	}

	async function launch(ctx: ExtensionCommandContext, note: string): Promise<void> {
		const mainSession = ctx.sessionManager.getSessionFile();
		if (!mainSession || !existsSync(mainSession)) {
			ctx.ui.notify("btw: no session file to fork yet — send a message first.", "error");
			return;
		}

		const dir = sessionsDir(ctx);
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			/* recursive mkdir tolerates an existing dir */
		}

		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

		// Fork the main session into our own dir, then wrap it in an in-process
		// sub-session. A custom resource loader with noExtensions:true mirrors the old
		// `--no-extensions` child — the sub-session loads no extension runtime, so it
		// never re-runs this (or any) extension factory.
		let session: AgentSession;
		let sessionFile: string;
		try {
			const sm = SessionManager.forkFrom(mainSession, ctx.cwd, dir);
			sessionFile = sm.getSessionFile() ?? join(dir, `${id}.jsonl`);
			const loader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: getAgentDir(), noExtensions: true });
			await loader.reload();
			const result = await createAgentSession({
				cwd: ctx.cwd,
				sessionManager: sm,
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				tools: SUBSESSION_TOOLS,
				resourceLoader: loader,
			});
			session = result.session;
		} catch (err) {
			ctx.ui.notify(`btw: could not start side task — ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		const thread: BtwThread = {
			id,
			note,
			session,
			status: "running",
			timeline: [],
			startedAt: Date.now(),
			turns: 0,
			sessionFile,
			resultPath: join(dir, `${id}.result.md`),
		};
		threads.set(id, thread);
		order.push(id);

		startTurn(thread, framedTask(note));
		updateStatus(ctx);
		ctx.ui.notify(`btw started: ${note}`, "info");

		// Open the modal immediately on this thread, or retarget an open modal.
		if (modalOpen && currentModal) currentModal.show(id);
		else void openModal(ctx, id);
	}

	// ── Modal overlay ────────────────────────────────
	// Top-center overlay with a live transcript (icons/markdown like agent-hub's
	// ZoomUI) and a follow-up composer. Read-only navigation keys are intercepted
	// here; everything else feeds the composer.
	class BtwModal {
		private selectedIndex = 0;
		private scrollOffset = 0;
		private followTail = true;
		readonly input = new Input();

		constructor(
			public currentId: string,
			private onFollowUp: (text: string) => void,
			private notify: (m: string, type?: "info" | "warning" | "error" | "success") => void,
			private close: () => void,
		) {
			this.input.focused = true;
			this.input.onSubmit = (val: string) => {
				const text = val.trim();
				if (!text) return;
				this.input.setValue("");
				this.onFollowUp(text);
			};
			this.input.onEscape = () => this.close();
		}

		private get thread(): BtwThread | undefined {
			return threads.get(this.currentId);
		}

		private applyViewState(state: { selectedIndex: number; scrollOffset: number; followTail: boolean }): void {
			this.selectedIndex = state.selectedIndex;
			this.scrollOffset = state.scrollOffset;
			this.followTail = state.followTail;
		}

		clamp(): void {
			this.applyViewState(
				clampModalView(
					{ selectedIndex: this.selectedIndex, scrollOffset: this.scrollOffset, followTail: this.followTail },
					this.thread?.timeline.length ?? 0,
					BODY_ROWS,
				),
			);
		}

		timelinePruned(id: string, prunedCount: number): void {
			if (id !== this.currentId) return;
			this.applyViewState(
				shiftModalViewForPrunedEntries(
					{ selectedIndex: this.selectedIndex, scrollOffset: this.scrollOffset, followTail: this.followTail },
					prunedCount,
					this.thread?.timeline.length ?? 0,
					BODY_ROWS,
				),
			);
		}

		show(id: string): void {
			const next = resolveThreadId(id, order);
			if (!next || !threads.has(next)) return;
			this.currentId = next;
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.followTail = true;
			this.clamp();
		}

		private switchThread(dir: 1 | -1): void {
			if (order.length < 2) return;
			const i = order.indexOf(this.currentId);
			const start = i >= 0 ? i : order.length - 1;
			const next = order[(start + dir + order.length) % order.length];
			this.show(next);
		}

		handleInput(data: string, tui: { requestRender: () => void }): void {
			this.clamp();
			const t = this.thread;
			const n = t ? t.timeline.length : 0;
			const maxIndex = Math.max(0, n - 1);
			const multi = order.length >= 2;
			if (matchesKey(data, Key.up)) {
				this.followTail = false;
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			} else if (matchesKey(data, Key.down)) {
				this.selectedIndex = Math.min(maxIndex, this.selectedIndex + 1);
				if (n === 0 || this.selectedIndex >= maxIndex) this.followTail = true;
			} else if (multi && matchesKey(data, Key.left)) {
				this.switchThread(-1);
				lastViewedId = this.currentId;
			} else if (multi && matchesKey(data, Key.right)) {
				this.switchThread(1);
				lastViewedId = this.currentId;
			} else if (matchesKey(data, Key.ctrl("c"))) {
				void this.copySelected();
			} else if (matchesKey(data, Key.escape)) {
				this.close();
				return;
			} else {
				// Composer handles printable text, Enter (submit), backspace, etc.
				this.input.handleInput(data);
			}
			this.clamp();
			tui.requestRender();
		}

		private async copySelected(): Promise<void> {
			this.clamp();
			const t = this.thread;
			const item = t?.timeline[this.selectedIndex];
			if (!item) return;
			try {
				await copyToClipboard(item.content);
				this.notify("Copied entry", "success");
			} catch (err) {
				this.notify(`Copy failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		}

		private renderEntry(entry: TimelineEntry, isSelected: boolean, width: number, theme: Theme, mdTheme: ReturnType<typeof getMarkdownTheme>): string[] {
			const box = new Box(1, 0, (s: string) => (isSelected ? theme.bg("selectedBg", s) : s));
			let icon = "○";
			let color = "dim";
			if (entry.kind === "text") {
				icon = "🤖";
				color = "accent";
			} else if (entry.kind === "tool") {
				icon = "🛠";
				color = "warning";
			} else if (entry.kind === "thinking") {
				icon = "💭";
				color = "dim";
			} else if (entry.kind === "user") {
				icon = "🧑";
				color = "success";
			}
			box.addChild(new Text(`${theme.fg(color, icon)} ${theme.bold(entry.title)}`, 0, 0));
			if (isSelected) {
				box.addChild(new Markdown(capSelectedMarkdown(entry.content || "(empty)"), 2, 0, mdTheme));
			} else {
				const flat = (entry.content || "").replace(/\s+/g, " ").trim();
				box.addChild(new Text(theme.fg("dim", "  " + (truncateToWidth(flat, Math.max(0, width - 8)) || "…")), 0, 0));
			}
			return box.render(width);
		}

		render(width: number, theme: Theme): string[] {
			const lines: string[] = [];
			const mdTheme = getMarkdownTheme();
			const t = this.thread;

			// ── Header: BTW │ note │ status │ elapsed │ N/M ──
			const head = new Container();
			head.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			if (t) {
				const st = t.status;
				const sc = st === "error" ? "error" : st === "running" ? "warning" : "success";
				const idx = order.indexOf(this.currentId);
				const pos = `${idx >= 0 ? idx + 1 : 1}/${order.length}`;
				const noteShort = truncateToWidth(t.note, Math.max(10, width - 36));
				const sep = theme.fg("dim", "│");
				head.addChild(
					new Text(
						`${theme.fg("accent", theme.bold(" BTW"))} ${sep} ${theme.bold(noteShort)} ${sep} ${theme.fg(sc, st)} ${sep} ${theme.fg("dim", fmtDuration(threadElapsedMs(t)))} ${sep} ${theme.fg("success", pos)}`,
						1,
						0,
					),
				);
			} else {
				head.addChild(new Text(theme.fg("dim", " btw — no side task"), 1, 0));
			}
			lines.push(...head.render(width));

			// ── Body: transcript (selected entry expanded, others previewed) ──
			const items = t?.timeline ?? [];
			this.clamp();

			const bodyLines: string[] = [];
			if (items.length === 0) {
				bodyLines.push(theme.fg("dim", "  Working…"));
			} else {
				for (let i = this.scrollOffset; i < items.length; i++) {
					const card = this.renderEntry(items[i], i === this.selectedIndex, width, theme, mdTheme);
					if (bodyLines.length > 0 && bodyLines.length + card.length > BODY_ROWS) break;
					bodyLines.push(...card);
				}
			}
			while (bodyLines.length < BODY_ROWS) bodyLines.push("");
			if (bodyLines.length > BODY_ROWS) bodyLines.length = BODY_ROWS;
			lines.push(...bodyLines);

			// ── Footer: composer + key hints ──
			const footer = new Container();
			footer.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			footer.addChild(new Text(theme.fg("dim", " follow-up:"), 1, 0));
			lines.push(...footer.render(width));
			lines.push(...this.input.render(width));
			const switchHint = order.length >= 2 ? " · ←/→ switch" : "";
			lines.push(theme.fg("dim", ` Enter send · Esc hide · ↑/↓ scroll${switchHint} · Ctrl+C copy`));

			return lines;
		}
	}

	async function openModal(ctx: ExtensionContext, startId?: string): Promise<void> {
		if (modalOpen) {
			if (startId && currentModal) currentModal.show(startId);
			return;
		}
		const initial = resolveThreadId(startId, order) ?? mostRecentId();
		if (!initial) {
			ctx.ui.notify("No btw side tasks yet — /btw <task> to start one.", "info");
			return;
		}
		modalOpen = true;
		lastViewedId = initial;
		let ticker: ReturnType<typeof setInterval> | undefined;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const modal = new BtwModal(
						initial,
						(text) => submitFollowUp(modal.currentId, text),
						(m, type) => ctx.ui.notify(m, (type === "success" ? "info" : type) as "info" | "warning" | "error"),
						() => done(undefined),
					);

					// Throttle live refreshes to ~12fps; force pushes the final frame.
					let lastRender = 0;
					const requestRender = (force?: boolean) => {
						const now = Date.now();
						if (force || now - lastRender > 80) {
							lastRender = now;
							tui.requestRender();
						}
					};
					// Bind the render hook to whichever thread the modal currently shows.
					const bindRender = () => {
						for (const th of threads.values()) th.render = undefined;
						const cur = threads.get(modal.currentId);
						if (cur) cur.render = requestRender;
					};
					bindRender();

					// Let a fresh /btw retarget this open modal and keep selection valid when
					// retention/pruning changes the backing thread list.
					currentModal = {
						show: (id: string) => {
							modal.show(id);
							bindRender();
							lastViewedId = modal.currentId;
							tui.requestRender();
						},
						currentId: () => modal.currentId,
						timelinePruned: (id: string, prunedCount: number) => {
							modal.timelinePruned(id, prunedCount);
							tui.requestRender();
						},
						clamp: () => {
							modal.clamp();
							tui.requestRender();
						},
					};

					// Keep elapsed/spinner live even between stream events.
					ticker = setInterval(() => tui.requestRender(), 500);

					return {
						render: (w: number) => modal.render(w, theme as Theme),
						handleInput: (data: string) => {
							const before = modal.currentId;
							modal.handleInput(data, tui);
							if (modal.currentId !== before) {
								bindRender();
								lastViewedId = modal.currentId;
							}
						},
						invalidate: () => {},
						dispose: () => {
							if (ticker) clearInterval(ticker);
						},
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "top-center", width: MODAL_WIDTH, maxHeight: MODAL_MAX_HEIGHT, nonCapturing: true },
					onHandle: (h) => h.focus(),
				},
			);
		} finally {
			if (ticker) clearInterval(ticker);
			currentModal = undefined;
			for (const th of threads.values()) th.render = undefined;
			modalOpen = false;
		}
	}

	pi.registerCommand("btw", {
		description: "Start a side task in a live modal (full session context), or reopen the modal. Usage: /btw [task]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			latestCtx = ctx;
			const note = args.trim();
			if (!note) {
				if (threads.size > 0) {
					await openModal(ctx, lastViewedId);
				} else {
					ctx.ui.notify("Usage: /btw <task> — runs a side task with this session's full context.", "warning");
				}
				return;
			}
			await launch(ctx, note);
		},
	});

	// Alt+Shift+B, not Alt+B: pi reserves alt+b for the editor's cursor-word-left.
	pi.registerShortcut("alt+shift+b", {
		description: "Open the btw side-task modal",
		handler: async (ctx) => {
			latestCtx = ctx;
			if (threads.size === 0) {
				ctx.ui.notify("No btw side tasks yet — /btw <task> to start one.", "info");
				return;
			}
			await openModal(ctx, lastViewedId);
		},
	});

	// Render the compact result card: header (✓/✗ + note + elapsed), the first lines
	// of the final answer, and the artifact path. The full answer lives in result.md.
	const renderer: MessageRenderer<BtwDetails> = (message, _options, theme) => {
		const d = message.details;
		const body =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c) => c.type === "text")
						.map((c) => (c as { text: string }).text)
						.join("\n");

		const container = new Container();
		container.addChild(new Spacer(1));
		const box = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
		const icon = d?.ok === false ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const elapsed = d ? theme.fg("dim", ` · ${fmtDuration(d.elapsedMs)}`) : "";
		box.addChild(new Text(`${icon} ${theme.bold(`btw${d?.note ? `: ${d.note}` : ""}`)}${elapsed}`, 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(new Markdown(body || "_(no output)_", 0, 0, getMarkdownTheme()));
		if (d?.resultPath) {
			box.addChild(new Spacer(1));
			box.addChild(new Text(theme.fg("dim", `full result: ${d.resultPath}`), 0, 0));
		}
		container.addChild(box);
		return container;
	};
	pi.registerMessageRenderer<BtwDetails>(RESULT_TYPE, renderer);

	// Keep btw cards visible in the transcript but OUT of the main agent's LLM
	// context — they are for the human, and must not derail the main reasoning.
	pi.on("context", (ev: ContextEvent) => {
		const filtered = ev.messages.filter(
			(m) => !(m.role === "custom" && (m as { customType?: string }).customType === RESULT_TYPE),
		);
		if (filtered.length !== ev.messages.length) return { messages: filtered };
	});

	pi.on("session_start", async (_ev, ctx) => {
		latestCtx = ctx;
		cleanupOldArtifacts(ctx);
		updateStatus(ctx);
	});

	pi.on("agent_end", async (_ev, ctx) => {
		latestCtx = ctx;
		// The main turn just ended → we are (about to be) idle. Defer one tick so the
		// streaming flag is fully cleared before flush() checks isIdle().
		setTimeout(flush, 0);
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		pending.length = 0;
		const retained = [...threads.values()];
		for (const t of retained) {
			try {
				await t.session.abort();
			} catch {
				/* best-effort */
			}
			disposeThread(t);
		}
		threads.clear();
		order.length = 0;
		lastViewedId = undefined;
		currentModal?.clamp();
		updateStatus(latestCtx);
	});
}
