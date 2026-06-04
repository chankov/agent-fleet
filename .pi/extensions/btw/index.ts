/**
 * btw — fire-and-forget side tasks for pi, modeled on Claude Code's `/btw`.
 *
 * `/btw <task>` forks the CURRENT session (a byte copy of its append-only JSONL)
 * into a background child `pi` run that inherits the full conversation as its
 * context, works the side task in the same cwd, and reports back as a chat card
 * when it finishes.
 *
 * Design constraints (all intentional — see .pi/extensions/btw/README.md):
 *   - Command-only surface. No model-callable tool, no subcommands.
 *   - Runs even while the main agent is streaming. pi executes extension commands
 *     immediately in prompt(), BEFORE the streaming queue, so `/btw` never waits.
 *   - Never interrupts the main agent. The result card is delivered only when the
 *     session is idle (deferred to agent_end while streaming), so it never steers
 *     or follow-ups the active turn.
 *   - Result stays in chat history, rendered EXPANDED by default, and is kept OUT
 *     of the main agent's LLM context via an on("context") filter.
 *   - No worktree / no isolation. The child shares the parent's cwd.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	MessageRenderer,
	ContextEvent,
} from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Text, Box, Container, Spacer, Markdown } from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import {
	mkdirSync,
	copyFileSync,
	writeFileSync,
	existsSync,
	readdirSync,
	statSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";

const RESULT_TYPE = "btw-result";
const STATUS_KEY = "btw";
// Background artifacts (session copy, log, result) older than this are pruned on
// session_start. They are pure debugging aids — the result also lives in the chat.
const CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface BtwDetails {
	id: string;
	note: string;
	ok: boolean;
	elapsedMs: number;
	resultPath: string;
	logPath: string;
}

interface PendingResult {
	content: string;
	details: BtwDetails;
}

export default function btwExtension(pi: ExtensionAPI) {
	// Live child processes, keyed by btw id — SIGTERM'd on session shutdown.
	const running = new Map<string, ChildProcess>();
	// Results waiting for the session to go idle before they are shown as cards.
	const pending: PendingResult[] = [];
	// Most-recent context, refreshed on every hook so deferred delivery and footer
	// updates always have a live handle even after the original command returned.
	let latestCtx: ExtensionContext | undefined;

	function sessionsDir(ctx: ExtensionContext): string {
		return join(ctx.cwd, ".pi", "btw-sessions");
	}

	function updateStatus(ctx: ExtensionContext | undefined): void {
		ctx?.ui.setStatus(STATUS_KEY, running.size > 0 ? `btw: ${running.size} running` : undefined);
	}

	// Deliver queued results, but ONLY when idle. During streaming, sendMessage
	// would steer/follow-up the active turn (see core/agent-session.js
	// sendCustomMessage); the no-options call lands in the "append + display, no
	// turn" branch only when not streaming. agent_end re-drives this.
	function flush(): void {
		const ctx = latestCtx;
		if (!ctx || !ctx.isIdle() || pending.length === 0) return;
		const batch = pending.splice(0);
		for (const r of batch) {
			pi.sendMessage({
				customType: RESULT_TYPE,
				content: r.content,
				display: true,
				details: r.details,
			});
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

	function framedTask(note: string): string {
		return [
			"You have been resumed into a copy of another pi session — the conversation",
			"history above is your full context. This side task runs in the background and",
			"unattended: there is no interactive user, so make reasonable assumptions and",
			"proceed on your own judgment. Your file changes land in the same working",
			"directory as the main session, so keep them scoped to what the task asks.",
			"",
			`Side task: ${note}`,
			"",
			"When the task is done, end your final message with a concise summary of what",
			"you did and any result the main session needs.",
		].join("\n");
	}

	function launch(ctx: ExtensionCommandContext, note: string): void {
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
		const childSession = join(dir, `${id}.jsonl`);
		const logPath = join(dir, `${id}.log`);
		const resultPath = join(dir, `${id}.result.md`);

		// Fork = byte copy of the append-only JSONL. A torn final line (the parent may
		// be mid-write while streaming) is harmless: pi's loader skips malformed lines.
		try {
			copyFileSync(mainSession, childSession);
		} catch (err) {
			ctx.ui.notify(`btw: could not fork session — ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			...(model ? ["--model", model] : []),
			"--session", childSession,
			"-c",
			framedTask(note),
		];

		const startedAt = Date.now();
		let proc: ChildProcess;
		try {
			proc = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
		} catch (err) {
			ctx.ui.notify(`btw: failed to spawn child pi — ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		running.set(id, proc);
		updateStatus(ctx);
		ctx.ui.notify(`btw started: ${note}`, "info");

		const textChunks: string[] = [];
		const stderrChunks: string[] = [];
		const log: string[] = [];
		let buffer = "";
		// Guard against error+close both finalizing (e.g. when `pi` is not on PATH).
		let settled = false;

		const handleLine = (line: string): void => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					textChunks.push(event.assistantMessageEvent.delta || "");
				} else if (event.type === "tool_execution_start") {
					log.push(`[tool] ${event.toolName || "tool"}`);
				}
			} catch {
				/* ignore non-JSON lines */
			}
		};

		proc.stdout!.setEncoding("utf-8");
		proc.stdout!.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) handleLine(line);
		});

		proc.stderr!.setEncoding("utf-8");
		proc.stderr!.on("data", (chunk: string) => stderrChunks.push(chunk));

		proc.on("error", (err) => {
			if (settled) return;
			settled = true;
			running.delete(id);
			updateStatus(latestCtx);
			ctx.ui.notify(`btw failed to run: ${err.message}`, "error");
		});

		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (buffer.trim()) handleLine(buffer);
			running.delete(id);

			const elapsedMs = Date.now() - startedAt;
			const ok = code === 0;
			const fullText = textChunks.join("").trim();
			const stderr = stderrChunks.join("").trim();

			let content: string;
			if (ok && fullText) {
				content = fullText;
			} else if (ok) {
				content = "_(side task finished but produced no text output)_";
			} else {
				const tail = stderr.length > 1500 ? `…\n${stderr.slice(-1500)}` : stderr;
				content = [
					`**Side task failed** (exit ${code ?? "?"}).`,
					fullText ? `\n${fullText}` : "",
					tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : "",
				].join("");
			}

			const details: BtwDetails = { id, note, ok, elapsedMs, resultPath, logPath };

			// Persist the artifacts (debugging aid; the card carries the same result).
			try {
				writeFileSync(
					resultPath,
					`# btw result\n\n- task: ${note}\n- ok: ${ok}\n- exit: ${code ?? "?"}\n- elapsed: ${Math.round(elapsedMs / 1000)}s\n\n---\n\n${content}\n`,
				);
				if (log.length || stderr) {
					writeFileSync(logPath, `${log.join("\n")}\n${stderr ? `\n[stderr]\n${stderr}\n` : ""}`);
				}
			} catch {
				/* best-effort */
			}

			pending.push({ content, details });
			updateStatus(latestCtx);
			ctx.ui.notify(
				ok ? `btw done (${Math.round(elapsedMs / 1000)}s): ${note}` : `btw error: ${note}`,
				ok ? "info" : "error",
			);
			// Deliver now if idle; otherwise agent_end will re-drive flush().
			flush();
		});
	}

	pi.registerCommand("btw", {
		description: "Fork the current session into a background side task (fire-and-forget). Usage: /btw <task>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			latestCtx = ctx;
			const note = args.trim();
			if (!note) {
				ctx.ui.notify("Usage: /btw <task> — runs a side task with this session's full context.", "warning");
				return;
			}
			launch(ctx, note);
			// Return immediately — do NOT await the child. The main session is untouched.
		},
	});

	// Render the result EXPANDED by default: always paint the full markdown body,
	// ignoring the collapse state, so the side-task answer is never hidden.
	const renderer: MessageRenderer<BtwDetails> = (message, _options, theme) => {
		const d = message.details;
		const body =
			typeof message.content === "string"
				? message.content
				: message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");

		const container = new Container();
		container.addChild(new Spacer(1));
		const box = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
		const icon = d?.ok === false ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const header = `${icon} ${theme.bold(`btw${d?.note ? `: ${d.note}` : ""}`)}`;
		box.addChild(new Text(header, 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
		if (d?.resultPath) {
			box.addChild(new Spacer(1));
			box.addChild(new Text(theme.fg("dim", `saved: ${d.resultPath}`), 0, 0));
		}
		container.addChild(box);
		return container;
	};
	pi.registerMessageRenderer<BtwDetails>(RESULT_TYPE, renderer);

	// Keep btw results visible in the transcript but OUT of the main agent's LLM
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
		// The turn just ended → we are (about to be) idle. Defer one tick so the
		// streaming flag is fully cleared before flush() checks isIdle().
		setTimeout(flush, 0);
	});

	pi.on("session_shutdown", async () => {
		for (const proc of running.values()) {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* best-effort */
			}
		}
		running.clear();
	});
}
