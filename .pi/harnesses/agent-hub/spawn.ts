/**
 * spawnPiAgent — the ONE place agent-hub code spawns a headless `pi` child and
 * parses its JSON event stream. Used by the hub itself (specialist dispatch +
 * research helpers, index.ts) and by the injected delegate extension
 * (delegate.ts), so the spawn args and stream parsing never exist in two
 * copies.
 *
 * The child is always `pi --mode json -p --no-extensions` with explicit `-e`
 * extensions (damage-control first, delegate when the persona declares
 * subagents), a model, a tool allowlist, and a session file. NOTE: pi's
 * `--tools` allowlist applies to extension-registered tools too, so a tool a
 * `-e` extension provides (e.g. `delegate`) must be NAMED in `tools` or the
 * child model never sees it (validated 2026-06-11).
 */

import { spawn, type ChildProcess } from "child_process";

export interface PiUsage {
	input?: number;
	output?: number;
	[k: string]: any;
}

export interface SpawnPiAgentOptions {
	model: string;
	tools: string;
	thinking: string;
	appendSystemPrompt: string;
	sessionFile: string;
	/** Pass `-c` so the child resumes sessionFile instead of starting fresh. */
	resume?: boolean;
	prompt: string;
	/** `-e` extension paths, in order (damage-control first). */
	extensions?: string[];
	/** Extra env on top of process.env (e.g. AGENT_HUB_DELEGATE_CONFIG). */
	env?: Record<string, string>;
	/**
	 * Spawn the child as its own process group leader (setsid). The kill
	 * cascade relies on this: delegate children spawned INSIDE the child
	 * inherit its group, so signalling the negative PID kills the whole tree.
	 */
	detached?: boolean;
	cwd?: string;
}

export interface SpawnPiAgentCallbacks {
	/** Fires immediately after spawn so the caller can store the proc for kill. */
	onProcess?(proc: ChildProcess): void;
	onTextDelta?(delta: string): void;
	onThinkingDelta?(delta: string): void;
	onToolStart?(toolName: string, argStr: string): void;
	/**
	 * Usage from the stream: per assistant message (`message_end`) and once at
	 * the end with the final assistant message (`agent_end`).
	 */
	onUsage?(usage: PiUsage, source: "message_end" | "agent_end"): void;
}

export interface SpawnPiAgentResult {
	/** Concatenated assistant text deltas. */
	output: string;
	/** Process exit code; null when the child died from a signal (e.g. SIGTERM). */
	exitCode: number | null;
	stderr: string;
	/** Set when the process could not be spawned at all (proc `error` event). */
	spawnError?: string;
}

export function spawnPiAgent(
	opts: SpawnPiAgentOptions,
	cbs: SpawnPiAgentCallbacks = {},
): Promise<SpawnPiAgentResult> {
	const args = [
		"--mode", "json",
		"-p",
		"--no-extensions",
		...(opts.extensions || []).flatMap(e => ["-e", e]),
		"--model", opts.model,
		"--tools", opts.tools,
		"--thinking", opts.thinking,
		"--append-system-prompt", opts.appendSystemPrompt,
		"--session", opts.sessionFile,
	];
	if (opts.resume) args.push("-c");
	args.push(opts.prompt);

	const textChunks: string[] = [];
	const stderrChunks: string[] = [];

	return new Promise((resolve) => {
		const proc = spawn("pi", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...(opts.env || {}) },
			...(opts.cwd ? { cwd: opts.cwd } : {}),
			...(opts.detached ? { detached: true } : {}),
		});
		cbs.onProcess?.(proc);

		let buffer = "";
		const handleEvent = (event: any) => {
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta") {
					textChunks.push(delta.delta || "");
					cbs.onTextDelta?.(delta.delta || "");
				} else if (delta?.type === "thinking_delta") {
					cbs.onThinkingDelta?.(delta.delta || "");
				}
			} else if (event.type === "tool_execution_start") {
				let argStr = "";
				try { argStr = event.args != null ? JSON.stringify(event.args) : ""; } catch { argStr = ""; }
				cbs.onToolStart?.(event.toolName || "tool", argStr);
			} else if (event.type === "message_end") {
				if (event.message?.usage) cbs.onUsage?.(event.message.usage, "message_end");
			} else if (event.type === "agent_end") {
				const msgs = event.messages || [];
				const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
				if (last?.usage) cbs.onUsage?.(last.usage, "agent_end");
			}
		};

		proc.stdout!.setEncoding("utf-8");
		proc.stdout!.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try { handleEvent(JSON.parse(line)); } catch {}
			}
		});

		proc.stderr!.setEncoding("utf-8");
		proc.stderr!.on("data", (chunk: string) => {
			stderrChunks.push(chunk);
		});

		proc.on("close", (code) => {
			if (buffer.trim()) {
				try { handleEvent(JSON.parse(buffer)); } catch {}
			}
			resolve({
				output: textChunks.join(""),
				exitCode: code,
				stderr: stderrChunks.join(""),
			});
		});

		proc.on("error", (err) => {
			resolve({
				output: "",
				exitCode: 1,
				stderr: stderrChunks.join(""),
				spawnError: err.message,
			});
		});
	});
}

/**
 * Kill a spawned pi child and — when it was spawned `detached` — its whole
 * process group, so delegate children and grandchildren die with their parent.
 * For a non-detached child the group kill fails with ESRCH (its pgid is the
 * hub's, not its own pid) and we fall back to a single-process SIGTERM, which
 * matches the pre-cascade behavior.
 */
export function killPiTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
	const pid = proc.pid;
	if (pid == null) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try { proc.kill(signal); } catch {}
	}
}
