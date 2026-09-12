import type { NativeDispatchResult, NativeExecutionDiagnostics, NativeSpawnOutcome, PreparedNativeRun } from "./dispatch-native-types.ts";

export async function completeNativeRun(run: PreparedNativeRun, outcome: NativeSpawnOutcome): Promise<NativeDispatchResult> {
	const { deps, state, ctx, histEntry, monitorStart, startTime, key, agentKey } = run;
	const { res, runBilled, runOut, sessionRecycled, sessionReset, driftStop, driftAdvisories } = outcome;
	clearInterval(state.timer);
	state.elapsed = Date.now() - startTime;
	state.proc = undefined;
	state.delegationsWatcher?.close();
	state.delegationsWatcher = undefined;
	const diagnostics: NativeExecutionDiagnostics = {
		reason: res.spawnError ? "spawn_error" : res.termination?.reason ?? (state.killedByOperator ? "operator_cancelled" : res.assistantError ? "assistant_error" : res.exitCode !== 0 ? "exit_code" : null),
		processExitCode: res.exitCode,
		assistantError: res.assistantError ?? null, stderr: res.stderr, spawnError: res.spawnError ?? null,
		modelUsed: res.modelUsed ?? null, toolCallsStarted: res.toolCallsStarted ?? null,
		termination: res.termination ?? null, modelFallback: res.modelFallback ?? null,
	};
	const diagnosticText = diagnostics.reason ? formatDiagnostics(diagnostics) : "";
	const finish = (result: NativeDispatchResult): NativeDispatchResult => ({
		...result, dispatchId: run.dispatchId, transcriptPath: run.transcriptPath, diagnostics, sessionReset,
		output: result.output + diagnosticText,
	});
	if (diagnosticText) deps.appendTimelineText(state, "text", diagnosticText);
	deps.flushTimelineStore(state);

	if (res.spawnError) {
		await monitorStart?.then(task => deps.finalizeMonitorChild(task, `Error spawning agent: ${res.spawnError}${diagnosticText}`, "failed"));
		state.status = "error";
		state.lastWork = `Error: ${res.spawnError}`;
		state.killedByOperator = false;
		state.restarting = false;
		deps.updateWidget();
		state.zoomRender?.(true);
		deps.executionHistory.end(histEntry, "error");
		const onTerminate = state.onTerminate;
		state.onTerminate = undefined;
		onTerminate?.();
		return finish({ output: `Error spawning agent: ${res.spawnError}`, exitCode: 1, elapsed: state.elapsed, billed: runBilled, out: runOut });
	}

	const full = res.output;
	const code = res.exitCode;
	if (res.termination) {
		const reason = res.termination.reason;
		const tool = res.termination.tool;
		state.status = "error";
		state.lastWork = reason === "tool_timeout"
			? `tool_timeout: ${tool?.toolName || "tool"} (${tool?.toolCallId || "unknown"})`
			: reason === "turn_timeout"
				? `turn_timeout after ${Math.round(state.elapsed / 1000)}s`
				: reason === "drift_stop"
					? `drift_stop: ${driftStop?.verdict || "watchdog"} (${driftStop?.rule || "rule"})`
					: "cancelled by caller";
		deps.updateWidget();
		state.zoomRender?.(true);
		deps.executionHistory.end(histEntry, "error");
		const onTerminate = state.onTerminate;
		state.onTerminate = undefined;
		onTerminate?.();
		if (reason === "drift_stop") {
			deps.bumpDriftStop();
			ctx.ui.notify(`${deps.displayName(state.def.name)} stopped by the drift watchdog (${driftStop?.verdict || "verdict"}: ${driftStop?.reason || driftStop?.detail || "no reason"})`, "warning");
		}
		const explanation = reason === "tool_timeout"
			? `exceeded its per-tool watchdog on ${tool?.toolName || "tool"} (${tool?.toolCallId || "unknown"})`
			: reason === "turn_timeout"
				? `exceeded the per-run deadline (${Math.round(state.elapsed / 1000)}s; agent-turn-timeout-s / mode budget). ` +
					`Do NOT re-dispatch the same task unchanged — split it into smaller pieces, or ask the user to raise the deadline`
				: reason === "drift_stop"
					? `was stopped by the drift watchdog. Rule "${driftStop?.rule || "unknown"}" fired (${driftStop?.detail || "no detail"}); ` +
						`judge verdict ${(driftStop?.verdict || "drifting").toUpperCase()}: ${driftStop?.reason || "(no reason given)"}. ` +
						`Re-dispatch ONCE with a corrected, NARROWED task that addresses this verdict — never repeat the same task unchanged. ` +
						`If you believe the watchdog is wrong, tell the user; they can disable it with /af-watchdog ${key} off`
					: "was cancelled by its caller";
		return finish({
			output: `${reason}: agent ${deps.displayName(state.def.name)} ${explanation}; terminationConfirmed=${res.termination.confirmed}.` +
				(full.trim() ? `\n\nPartial output before termination:\n${full.slice(-2000)}` : ""),
			exitCode: reason === "cancelled" ? 130 : reason === "drift_stop" ? 125 : 124,
			elapsed: state.elapsed,
			billed: runBilled,
			out: runOut,
		});
	}

	if (state.killedByOperator) {
		await monitorStart?.then(task => deps.finalizeMonitorChild(task, "operator killed run", "cancelled"));
		const wasRestart = !!state.restarting;
		state.killedByOperator = false;
		state.restarting = false;
		state.status = "idle";
		state.lastWork = wasRestart ? "(killed for restart)" : "(killed by operator)";
		deps.updateWidget();
		state.zoomRender?.(true);
		deps.executionHistory.end(histEntry, "idle");
		ctx.ui.notify(`${deps.displayName(state.def.name)} killed by operator`, "info");
		const onTerminate = state.onTerminate;
		state.onTerminate = undefined;
		onTerminate?.();
		return finish({
			output: wasRestart
				? `Agent "${deps.displayName(state.def.name)}" was killed by the operator for a restart. A fresh run is starting now; WAIT for the follow-up result before acting — do not re-dispatch this agent yourself.`
				: `Agent "${deps.displayName(state.def.name)}" was killed by the operator. Do NOT auto-retry or re-dispatch; wait for the operator's instruction.`,
			exitCode: code == null || code === 0 ? 143 : code,
			elapsed: state.elapsed,
			billed: runBilled, out: runOut,
		});
	}

	await monitorStart?.then(task => deps.finalizeMonitorChild(task, full + diagnosticText, code === 0 ? "completed" : "failed"));
	state.status = code === 0 ? "done" : "error";
	if (code === 0) {
		state.sessionFile = run.agentSessionFile;
		state.runsSinceFresh++;
	}
	state.lastWork = (full || res.assistantError || res.stderr).split("\n").filter(line => line.trim()).pop() || "";
	deps.updateWidget();
	state.zoomRender?.(true);
	deps.executionHistory.end(histEntry, state.status);
	ctx.ui.notify(
		`${deps.displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
		state.status === "done" ? "success" : "error",
	);
	const onTerminate = state.onTerminate;
	state.onTerminate = undefined;
	onTerminate?.();

	let output = full || (code !== 0 ? `Agent "${deps.displayName(state.def.name)}" exited with code ${code} and produced no output.` : "");
	if (res.modelFallback) output = `(ℹ model fallback: ${res.modelFallback.from} failed before work began; retried once with original persona model ${res.modelFallback.to}.)\n\n${output}`;
	if (sessionRecycled) output = `(ℹ ${deps.displayName(state.def.name)}'s session was recycled before this run — it has no memory of earlier dispatches; state must travel via task text/artifacts.)\n\n${output}`;
	if (driftAdvisories.length > 0) {
		output += `\n\n⚠ Drift advisory (run NOT stopped): ` +
			driftAdvisories.map(advisory => `rule "${advisory.rule}" — ${advisory.detail}; judge said ${advisory.verdict.toUpperCase()}: ${advisory.reason || "(no reason)"}`).join(" | ") +
			`\nReview whether the work still serves the task; nothing was reverted and nothing was killed.`;
	}
	if (sessionReset) {
		const resetSummary = sessionReset.retried
			? `was unusable and was quarantined${sessionReset.quarantined ? ` to ${sessionReset.quarantined}` : ""} (${sessionReset.reason}). This run started from a clean session after one automatic retry — the agent has no memory of earlier dispatches, and this is NOT a reason to drop it from the team.`
			: sessionReset.quarantined
				? `was unusable and was quarantined to ${sessionReset.quarantined} (${sessionReset.reason}) before the run. This run started from a clean session — the agent has no memory of earlier dispatches.`
				: `was rejected by pi but could not be quarantined (${sessionReset.reason}). No clean retry was attempted; fix the file permissions/path before retrying.`;
		output = `(⚠ ${deps.displayName(state.def.name)}'s session file ${resetSummary})\n\n${output}`;
	}
	return finish({ output, exitCode: code ?? 1, elapsed: state.elapsed, billed: runBilled, out: runOut, sessionReset });
}

/** Bounded human-facing excerpts; full diagnostics travel separately to the artifact. */
function formatDiagnostics(diagnostics: NativeExecutionDiagnostics): string {
	const fields = ["assistantError", "stderr", "spawnError"] as const;
	return `\n\n[execution: ${diagnostics.reason}; model=${diagnostics.modelUsed ?? "unknown"}; toolCallsStarted=${diagnostics.toolCallsStarted ?? "unknown"}]` +
		fields.filter(field => diagnostics[field]).map(field => {
			const text = diagnostics[field]!;
			return `\n\n[${field}]\n${text.length > 1500 ? "...\n" + text.slice(-1500) : text}`;
		}).join("");
}
