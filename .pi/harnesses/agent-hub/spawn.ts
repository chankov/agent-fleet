/**
 * spawnPiAgent — the ONE place agent-hub code spawns a headless `pi` child and
 * parses its JSON event stream. Research helpers and read-only delegate children
 * opt into the per-tool watchdog here, rather than trusting an agent-side timer.
 */

import { spawn, type ChildProcess } from "child_process";

export interface PiUsage {
	input?: number;
	output?: number;
	[k: string]: any;
}

export interface ToolTimeout {
	toolCallId: string;
	toolName: string;
	args: string;
	startedAt: number;
	deadlineAt: number;
}

export interface Termination {
	reason: "tool_timeout" | "turn_timeout" | "drift_stop" | "cancelled";
	confirmed: boolean;
	escalated: boolean;
	tool?: ToolTimeout;
}

/** External run control handed to the caller via onControl (drift watchdog). */
export interface PiRunControl {
	/** Terminate the child group with the given classification (default "drift_stop"). */
	terminate(reason?: "drift_stop" | "cancelled"): void;
}

export interface ToolWatchdogOptions {
	/** Per read-only tool call deadline. null disables the watchdog. */
	timeoutMs: number | null;
	/** Grace after SIGTERM, followed by SIGKILL. Kept injectable for focused tests. */
	termGraceMs?: number;
	/** Bound on final settlement; never wait forever for close or inherited pipes. */
	settleGraceMs?: number;
	/** Only these tool names are watched (research/delegate read-only surface). */
	tools?: readonly string[];
}

export interface SpawnPiAgentOptions {
	model: string;
	tools: string;
	thinking: string;
	appendSystemPrompt: string;
	sessionFile: string;
	resume?: boolean;
	prompt: string;
	extensions?: string[];
	env?: Record<string, string>;
	/** Own a process group. Required for a watchdog/cancellation kill cascade. */
	detached?: boolean;
	cwd?: string;
	/** Parent tool cancellation; classified separately from a tool timeout. */
	signal?: AbortSignal;
	toolWatchdog?: ToolWatchdogOptions;
	/**
	 * Whole-run deadline: one timer from spawn start; on expiry the child group is
	 * terminated with reason "turn_timeout" (same SIGTERM→SIGKILL→settle cascade as
	 * the per-tool watchdog). null/undefined disables it. Unlike the tool watchdog
	 * this bounds the ENTIRE run, thinking and non-watched tools included.
	 */
	turnDeadlineMs?: number | null;
}

export interface SpawnPiAgentCallbacks {
	onProcess?(proc: ChildProcess): void;
	/** Receives a terminate handle for parent-side classified stops (drift watchdog). */
	onControl?(control: PiRunControl): void;
	onTextDelta?(delta: string): void;
	onThinkingDelta?(delta: string): void;
	onToolStart?(toolName: string, argStr: string, toolCallId?: string): void;
	/** isError is present only when the event stream carries an error flag. */
	onToolEnd?(toolName: string, toolCallId?: string, isError?: boolean): void;
	onUsage?(usage: PiUsage, source: "message_end" | "agent_end"): void;
}

export interface SpawnPiAgentResult {
	output: string;
	exitCode: number | null;
	stderr: string;
	spawnError?: string;
	/** Present only when parent-side bounded termination was requested. */
	termination?: Termination;
}

const DEFAULT_TERM_GRACE_MS = 1_000;
const DEFAULT_SETTLE_GRACE_MS = 1_000;
const WATCHED_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Signal an explicitly owned process group, falling back only for legacy callers. */
export function killPiTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
	const pid = proc.pid;
	if (pid == null) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try { proc.kill(signal); } catch {}
	}
}

export function spawnPiAgent(
	opts: SpawnPiAgentOptions,
	cbs: SpawnPiAgentCallbacks = {},
): Promise<SpawnPiAgentResult> {
	const args = [
		"--mode", "json", "-p", "--no-extensions",
		...(opts.extensions || []).flatMap(e => ["-e", e]),
		"--model", opts.model, "--tools", opts.tools, "--thinking", opts.thinking,
		"--append-system-prompt", opts.appendSystemPrompt, "--session", opts.sessionFile,
	];
	if (opts.resume) args.push("-c");

	const watchdog = opts.toolWatchdog;
	const turnDeadlineMs = opts.turnDeadlineMs ?? null;
	// A watchdog or deadline must own its group: group signalling remains valid even
	// after the pi leader exits while an inherited-stdio descendant is still alive.
	const ownsGroup = opts.detached === true || watchdog !== undefined || opts.signal !== undefined || turnDeadlineMs != null || cbs.onControl !== undefined;
	const watchedTools = new Set(watchdog?.tools ?? WATCHED_TOOLS);
	const timeoutMs = watchdog?.timeoutMs ?? null;
	const termGraceMs = watchdog?.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
	const settleGraceMs = watchdog?.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;

	const textChunks: string[] = [];
	const stderrChunks: string[] = [];
	return new Promise((resolve) => {
		const proc = spawn("pi", args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...(opts.env || {}) },
			...(opts.cwd ? { cwd: opts.cwd } : {}),
			...(ownsGroup ? { detached: true } : {}),
		});
		cbs.onProcess?.(proc);
		proc.stdin?.on("error", () => {});
		proc.stdin?.end(opts.prompt);

		let buffer = "";
		let settled = false;
		let closeSeen = false;
		let termination: Termination | undefined;
		let termTimer: ReturnType<typeof setTimeout> | undefined;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const calls = new Map<string, ToolTimeout & { timer: ReturnType<typeof setTimeout> }>();

		const clearCalls = () => {
			for (const call of calls.values()) clearTimeout(call.timer);
			calls.clear();
		};
		const cleanup = () => {
			clearCalls();
			if (termTimer) clearTimeout(termTimer);
			if (settleTimer) clearTimeout(settleTimer);
			if (deadlineTimer) clearTimeout(deadlineTimer);
			opts.signal?.removeEventListener("abort", onAbort);
		};
		const settle = (code: number | null, spawnError?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (termination) termination.confirmed = closeSeen;
			// A pipe held by a descendant must not hold the caller forever.
			try { proc.stdin?.destroy(); } catch {}
			try { proc.stdout?.destroy(); } catch {}
			try { proc.stderr?.destroy(); } catch {}
			resolve({ output: textChunks.join(""), exitCode: code, stderr: stderrChunks.join(""), ...(spawnError ? { spawnError } : {}), ...(termination ? { termination } : {}) });
		};
		const terminate = (reason: Termination["reason"], tool?: ToolTimeout) => {
			// The first classification wins; later cancellation/exit events keep it.
			if (termination) return;
			termination = { reason, confirmed: false, escalated: false, ...(tool ? { tool } : {}) };
			clearCalls();
			killPiTree(proc, "SIGTERM");
			termTimer = setTimeout(() => {
				if (settled) return;
				termination!.escalated = true;
				killPiTree(proc, "SIGKILL");
			}, termGraceMs);
			settleTimer = setTimeout(() => settle(null), termGraceMs + settleGraceMs);
		};
		const onAbort = () => terminate("cancelled");
		if (opts.signal?.aborted) onAbort();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });
		// External classified stop (drift watchdog): same first-classification-wins
		// cascade as every other termination path; harmless after settle.
		cbs.onControl?.({ terminate: (reason = "drift_stop") => { if (!settled) terminate(reason); } });
		if (turnDeadlineMs != null) {
			deadlineTimer = setTimeout(() => terminate("turn_timeout"), turnDeadlineMs);
		}

		const toolId = (event: any) => String(event.toolCallId ?? event.tool_call_id ?? event.id ?? "");
		const handleEvent = (event: any) => {
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta") { textChunks.push(delta.delta || ""); cbs.onTextDelta?.(delta.delta || ""); }
				else if (delta?.type === "thinking_delta") cbs.onThinkingDelta?.(delta.delta || "");
			} else if (event.type === "tool_execution_start") {
				let argStr = "";
				try { argStr = event.args != null ? JSON.stringify(event.args) : ""; } catch {}
				const id = toolId(event);
				const name = event.toolName || "tool";
				cbs.onToolStart?.(name, argStr, id || undefined);
				if (timeoutMs != null && id && watchedTools.has(name) && !calls.has(id)) {
					const startedAt = Date.now();
					const call: ToolTimeout = { toolCallId: id, toolName: name, args: argStr, startedAt, deadlineAt: startedAt + timeoutMs };
					calls.set(id, { ...call, timer: setTimeout(() => terminate("tool_timeout", call), timeoutMs) });
				}
			} else if (event.type === "tool_execution_end") {
				const id = toolId(event);
				if (id) {
					const call = calls.get(id);
					if (call) { clearTimeout(call.timer); calls.delete(id); }
				}
				const rawIsError = event.isError ?? event.is_error ?? event.result?.isError ?? event.result?.is_error;
				cbs.onToolEnd?.(event.toolName || "tool", id || undefined, typeof rawIsError === "boolean" ? rawIsError : undefined);
			} else if (event.type === "message_end") {
				if (event.message?.usage) cbs.onUsage?.(event.message.usage, "message_end");
			} else if (event.type === "agent_end") {
				const last = [...(event.messages || [])].reverse().find((m: any) => m.role === "assistant");
				if (last?.usage) cbs.onUsage?.(last.usage, "agent_end");
			}
		};

		proc.stdout!.setEncoding("utf-8");
		proc.stdout!.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) { if (line.trim()) try { handleEvent(JSON.parse(line)); } catch {} }
		});
		proc.stderr!.setEncoding("utf-8");
		proc.stderr!.on("data", (chunk: string) => stderrChunks.push(chunk));
		proc.on("close", (code) => {
			closeSeen = true;
			if (buffer.trim()) try { handleEvent(JSON.parse(buffer)); } catch {}
			settle(code);
		});
		proc.on("error", (err) => settle(1, err.message));
	});
}
