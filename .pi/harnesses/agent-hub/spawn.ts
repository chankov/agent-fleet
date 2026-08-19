/**
 * spawnPiAgent — the ONE place agent-hub code spawns a headless `pi` child and
 * parses its JSON event stream. Research helpers and read-only delegate children
 * opt into the per-tool watchdog here, rather than trusting an agent-side timer.
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

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
	/** Replacement prompt; mutually exclusive with appendSystemPrompt when spawning. */
	systemPrompt?: string;
	/** Prompt appended to Pi's inherited prompt (legacy/default child policy). */
	appendSystemPrompt?: string;
	/** Disable automatic global skill discovery for a minimized child. */
	noSkills?: boolean;
	/** Disable AGENTS.md/CLAUDE.md and other automatic context-file discovery. */
	noContextFiles?: boolean;
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

export interface ModelFallbackNotice {
	from: string;
	to: string;
	reason: string;
}

export interface SpawnPiAgentCallbacks {
	onProcess?(proc: ChildProcess): void;
	onModelFallback?(notice: ModelFallbackNotice): void;
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
	/** Assistant-level provider/model failure reported in Pi's JSON stream. */
	assistantError?: string;
	toolCallsStarted: number;
	modelUsed: string;
	modelFallback?: ModelFallbackNotice;
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
	const promptArg = opts.systemPrompt !== undefined
		? ["--system-prompt", opts.systemPrompt]
		: ["--append-system-prompt", opts.appendSystemPrompt ?? ""];
	const args = [
		"--mode", "json", "-p", "--no-extensions",
		...(opts.noSkills ? ["--no-skills"] : []),
		...(opts.noContextFiles ? ["--no-context-files"] : []),
		...(opts.extensions || []).flatMap(e => ["-e", e]),
		"--model", opts.model, "--tools", opts.tools, "--thinking", opts.thinking,
		...promptArg, "--session", opts.sessionFile,
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
		let assistantError: string | undefined;
		let toolCallsStarted = 0;
		const settle = (code: number | null, spawnError?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (termination) termination.confirmed = closeSeen;
			// A pipe held by a descendant must not hold the caller forever.
			try { proc.stdin?.destroy(); } catch {}
			try { proc.stdout?.destroy(); } catch {}
			try { proc.stderr?.destroy(); } catch {}
			resolve({
				output: textChunks.join(""),
				// Pi's headless process can exit 0 while the assistant message itself
				// reports stopReason:error. Normalize that to a failed run so callers
				// never mark a provider/model error as successful.
				exitCode: assistantError && code === 0 ? 1 : code,
				stderr: stderrChunks.join(""),
				toolCallsStarted,
				modelUsed: opts.model,
				...(spawnError ? { spawnError } : {}),
				...(assistantError ? { assistantError } : {}),
				...(termination ? { termination } : {}),
			});
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
				toolCallsStarted++;
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
				if (event.message?.role === "assistant"
					&& (event.message.stopReason === "error" || event.message.stopReason === "aborted")) {
					assistantError = String(event.message.errorMessage
						|| (event.message.stopReason === "aborted" ? "assistant model request aborted" : "assistant model run failed"));
				}
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

const PROVIDER_FAILURE_RE = /\b(provider unavailable|service unavailable|overloaded|rate limit|too many requests|out of memory|oom|memory limit|resource exhausted|econn(?:reset|refused)|connection (?:reset|refused)|fetch failed|network error|gateway timeout|http\s*5\d\d|\b429\b)\b/i;

function modelFallbackReason(result: SpawnPiAgentResult, midRun = false): string | null {
	// A terminated run (watchdog, deadline, cancellation) is a verdict on the
	// work, not a provider outage — never retry it. A spawn failure never
	// reached a provider at all.
	if (result.spawnError || result.termination) return null;
	const workStarted = result.toolCallsStarted > 0 || Boolean(result.output.trim());
	if (!midRun && workStarted) return null;
	const reason = result.assistantError
		? result.assistantError.slice(-500)
		: result.exitCode !== 0
			? (result.stderr.trim().slice(-500) || `pi exited with code ${result.exitCode ?? "unknown"}`)
			: null;
	if (!reason) return null;
	// Once work began, only a recognizable provider/transport failure is safe to
	// route to another model. Deterministic session/configuration/harness errors
	// must remain visible instead of being masked by an expensive second run.
	if (midRun && workStarted && !PROVIDER_FAILURE_RE.test(reason)) return null;
	return reason;
}

export interface ModelFallbackOptions {
	/**
	 * Retry even when the failed attempt had already started tools or emitted
	 * text. Only pass this for a run that holds NO write-capable tools: the
	 * retry re-executes whatever the first attempt did, which is harmless for a
	 * reader and duplicates edits for a writer. Use `isReadOnlyToolList` on the
	 * effective tool list rather than assuming.
	 */
	midRun?: boolean;
}

/**
 * Run an overridden model and retry once on the original persona model when the
 * first attempt failed for a provider-level reason. By default that means
 * "failed before producing text or starting a tool"; `midRun` extends it to
 * read-only runs, where a provider dying halfway through would otherwise throw
 * the whole run away — and those are exactly the children that exist to protect
 * their parent's context. The session file is restored before the retry so the
 * failed turn never enters the resumable conversation.
 */
export async function spawnPiAgentWithModelFallback(
	opts: SpawnPiAgentOptions,
	fallbackModel?: string,
	cbs: SpawnPiAgentCallbacks = {},
	fallbackOptions: ModelFallbackOptions = {},
): Promise<SpawnPiAgentResult> {
	if (!fallbackModel || fallbackModel === opts.model) return spawnPiAgent(opts, cbs);

	const sessionExisted = existsSync(opts.sessionFile);
	let sessionSnapshot: Buffer | undefined;
	if (sessionExisted) {
		try { sessionSnapshot = readFileSync(opts.sessionFile); } catch {}
	}

	const primary = await spawnPiAgent(opts, cbs);
	const reason = modelFallbackReason(primary, fallbackOptions.midRun === true);
	// If an existing resumable session could not be snapshotted, fail closed:
	// retrying would preserve the failed turn and could duplicate the prompt.
	if (!reason || (sessionExisted && !sessionSnapshot)) return primary;

	try {
		if (sessionExisted && sessionSnapshot) writeFileSync(opts.sessionFile, sessionSnapshot);
		else unlinkSync(opts.sessionFile);
	} catch (error: any) {
		if (error?.code !== "ENOENT") return primary;
	}

	const notice: ModelFallbackNotice = { from: opts.model, to: fallbackModel, reason };
	cbs.onModelFallback?.(notice);
	const fallback = await spawnPiAgent({ ...opts, model: fallbackModel }, cbs);
	return { ...fallback, modelFallback: notice };
}
