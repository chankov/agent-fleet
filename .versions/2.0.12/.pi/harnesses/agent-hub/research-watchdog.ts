import type { Termination } from "./spawn.ts";

/** Spawn policy shared by every native read-only research-helper path. */
export function researchWatchdogSpawnOptions(timeoutMs: number | null, signal?: AbortSignal) {
	return {
		detached: true,
		signal,
		toolWatchdog: { timeoutMs },
	};
}

/** Stable terminal result used by research lifecycle code after parent cleanup. */
export function researchTerminationOutcome(id: number, termination: Termination) {
	const reason = termination.reason;
	const tool = termination.tool;
	const status = reason; // "tool_timeout" | "turn_timeout" | "drift_stop" | "cancelled"
	const lastWork = reason === "tool_timeout"
		? `tool_timeout: ${tool?.toolName || "tool"} (${tool?.toolCallId || "unknown"})`
		: reason === "turn_timeout"
			? "turn_timeout: per-run deadline exceeded"
			: reason === "drift_stop"
				? "drift_stop: stopped by the drift watchdog"
				: "cancelled by caller";
	const metadata = reason === "tool_timeout"
		? `toolCallId=${tool?.toolCallId || "unknown"}, tool=${tool?.toolName || "unknown"}, deadline=${tool?.deadlineAt || "unknown"}, terminationConfirmed=${termination.confirmed}`
		: `terminationConfirmed=${termination.confirmed}`;
	const explanation = reason === "tool_timeout"
		? "exceeded its per-tool watchdog"
		: reason === "turn_timeout"
			? "exceeded the per-run deadline (agent-turn-timeout-s / mode budget) — narrow the question or raise the deadline"
			: reason === "drift_stop"
				? "was stopped by the drift watchdog"
				: "was cancelled by its caller";
	return {
		status,
		lastWork,
		output: `${status}: research helper r${id} ${explanation} (${metadata}).`,
		exitCode: reason === "cancelled" ? 130 : reason === "drift_stop" ? 125 : 124,
	};
}
