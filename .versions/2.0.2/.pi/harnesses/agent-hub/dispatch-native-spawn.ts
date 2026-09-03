import { relative } from "node:path";
import { contextPct, overWindowDiagnostic } from "./context-window.js";
import { createDriftMonitor, hubOwnedScopeGlobs, resolveWatchdogActive } from "./drift-watchdog.js";
import { forceQuarantineSession, isCorruptSessionExit } from "./session-health.js";
import type { NativeSpawnOutcome, PiRunControl, PreparedNativeRun, SpawnPiAgentCallbacks, SpawnPiAgentOptions } from "./dispatch-native-types.ts";

const RESEARCHER_PERSONAS = new Set(["researcher", "deep-researcher"]);

interface DriftRuntime {
	monitor: any;
	stop: { rule: string; detail: string; verdict: string; reason: string } | null;
	advisories: Array<{ rule: string; detail: string; verdict: string; reason: string }>;
	control?: PiRunControl;
	escalate(violation: { rule: string; terminal?: boolean; detail: string }): void;
}

function createDriftRuntime(run: PreparedNativeRun): DriftRuntime {
	const { deps, state, ctx, watchdogParam, key, scopeGlobs, task, agentKey } = run;
	const watchdogArmed = resolveWatchdogActive(
		watchdogParam,
		deps.getWatchdogAgentOverride(key),
		deps.getWatchdogSetting(),
		deps.getWorkMode(),
	);
	const sessionDir = deps.getSessionDir();
	const hubOwnedGlobs = hubOwnedScopeGlobs(sessionDir, relative(ctx.cwd || process.cwd(), sessionDir));
	const runtime: DriftRuntime = {
		monitor: watchdogArmed ? createDriftMonitor({ scopeGlobs, allowGlobs: hubOwnedGlobs }) : null,
		stop: null,
		advisories: [],
		escalate: () => {},
	};
	let judgeBusy = false;
	let judgeCooldownUntil = 0;
	runtime.escalate = violation => {
		if (!runtime.monitor || judgeBusy || runtime.stop || Date.now() < judgeCooldownUntil) return;
		judgeBusy = true;
		void deps.runDriftJudge(
			{ agentLabel: deps.displayName(state.def.name), agentKey, task, scopeGlobs, hubOwnedGlobs, trail: runtime.monitor.trail(), violation },
			ctx,
		).then(verdict => {
			judgeBusy = false;
			judgeCooldownUntil = Date.now() + 90_000;
			if (!verdict || (verdict.verdict !== "drifting" && verdict.verdict !== "stuck")) return;
			if (violation.terminal === false) {
				runtime.advisories.push({ rule: violation.rule, detail: violation.detail, verdict: verdict.verdict, reason: verdict.reason });
				return;
			}
			runtime.stop = { rule: violation.rule, detail: violation.detail, verdict: verdict.verdict, reason: verdict.reason };
			runtime.control?.terminate("drift_stop");
		}).catch(() => { judgeBusy = false; });
	};
	return runtime;
}

function createSpawnCallbacks(run: PreparedNativeRun, drift: DriftRuntime, usageTotals: { billed: number; out: number }): SpawnPiAgentCallbacks {
	const { deps, state, ctx, monitorStart, agentWindow, model, wantThinking } = run;
	let fullText = "";
	let overWindowWarned = false;
	return {
		onProcess: proc => {
			state.proc = proc;
			void monitorStart?.then(task => deps.registerMonitorProcess(task, proc));
		},
		onModelFallback: ({ from, to, reason }) => {
			state.lastWork = `model fallback: ${deps.shortModel(from)} → ${deps.shortModel(to)}`;
			ctx.ui.notify(`${deps.displayName(state.def.name)}: overridden model ${from} failed before work began; retrying with persona model ${to} (${reason})`, "warning");
			deps.updateWidget();
		},
		...(drift.monitor ? { onControl: (control: PiRunControl) => { drift.control = control; } } : {}),
		onTextDelta: delta => {
			void monitorStart?.then(task => deps.appendMonitorOutput(task, delta));
			fullText += delta;
			state.lastWork = fullText.split("\n").filter(line => line.trim()).pop() || "";
			deps.appendTimelineText(state, "text", delta);
			deps.updateWidget();
			state.zoomRender?.();
		},
		onThinkingDelta: delta => {
			if (!wantThinking) return;
			deps.appendTimelineText(state, "thinking", delta);
			state.zoomRender?.();
		},
		onToolStart: (toolName, argStr, callId) => {
			state.toolCount++;
			deps.appendTimelineEvent(state, {
				kind: "tool-start",
				title: `Tool: ${toolName}`,
				content: argStr,
				timestamp: Date.now(),
				...(callId ? { callId } : {}),
			});
			deps.updateWidget();
			state.zoomRender?.();
			const violation = drift.monitor?.onToolStart(toolName, argStr);
			if (violation) drift.escalate(violation);
		},
		onToolEnd: (toolName, callId, isError, resultText, durationMs) => {
			deps.appendTimelineEvent(state, {
				kind: "tool-result",
				title: `Result: ${toolName}`,
				content: resultText ?? "",
				timestamp: Date.now(),
				...(callId ? { callId } : {}),
				status: isError ? "error" : "success",
				...(durationMs == null ? {} : { durationMs }),
			});
			state.zoomRender?.();
			const violation = drift.monitor?.onToolEnd(toolName, isError);
			if (violation) drift.escalate(violation);
		},
		onUsage: (usage, source) => {
			if (source === "message_end" || (usageTotals.billed === 0 && usageTotals.out === 0)) {
				usageTotals.billed += (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
				usageTotals.out += usage.output || 0;
			}
			if (agentWindow.window > 0) {
				state.contextTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
				state.contextPct = contextPct(usage, agentWindow.window);
				if (state.contextPct >= 100 && !overWindowWarned) {
					overWindowWarned = true;
					ctx.ui.notify(overWindowDiagnostic({
						agent: deps.displayName(state.def.name),
						model,
						pct: state.contextPct,
						window: agentWindow.window,
						source: agentWindow.source,
					}), "warning");
				}
				deps.updateWidget();
			}
		},
	};
}

export async function runPreparedNative(run: PreparedNativeRun): Promise<NativeSpawnOutcome> {
	const { deps, state, ctx, model, effectiveTools, thinkingLevel, replacementSystemPrompt, agentSessionFile, runPrompt, extensions, delegateEnv, turnBudget, personaKey, originalModelFallback } = run;
	const spawnOptions: SpawnPiAgentOptions = {
		model,
		tools: effectiveTools,
		thinking: thinkingLevel,
		systemPrompt: replacementSystemPrompt,
		noSkills: true,
		noContextFiles: true,
		sessionFile: agentSessionFile,
		resume: !!state.sessionFile,
		prompt: runPrompt,
		cwd: ctx.cwd || process.cwd(),
		extensions,
		env: { ...deps.guardrailEnv(run.agentKey), ...(delegateEnv || {}) },
		detached: true,
		...(RESEARCHER_PERSONAS.has(personaKey) ? { toolWatchdog: { timeoutMs: deps.getReconSearchTimeoutMs() } } : {}),
		turnDeadlineMs: turnBudget.agentTurnMs,
	};
	const drift = createDriftRuntime(run);
	const usageTotals = { billed: 0, out: 0 };
	const callbacks = createSpawnCallbacks(run, drift, usageTotals);
	deps.notifyProviderQueue(model, deps.displayName(state.def.name), ctx);
	let sessionReset = run.sessionReset;
	const res = await deps.providerSemaphore.run(model, async () => {
		let result = await deps.spawnPiAgentWithModelFallback(spawnOptions, originalModelFallback, callbacks);
		if (!result.spawnError && isCorruptSessionExit({ code: result.exitCode, output: result.output, stderr: result.stderr })) {
			const quarantine = forceQuarantineSession(agentSessionFile, deps.getSessionHealthIo());
			state.sessionFile = null;
			state.runsSinceFresh = 0;
			state.contextPct = 0;
			state.contextTokens = 0;
			sessionReset = {
				reason: quarantine.ok ? "pi rejected the session file" : quarantine.error!,
				quarantined: quarantine.quarantined,
				retried: quarantine.ok,
			};
			if (quarantine.ok) {
				ctx.ui.notify(`${deps.displayName(state.def.name)}: pi rejected the session file — quarantined, retrying once from a clean session`, "warning");
				result = await deps.spawnPiAgentWithModelFallback({ ...spawnOptions, resume: false }, originalModelFallback, callbacks);
			} else {
				ctx.ui.notify(`${deps.displayName(state.def.name)}: pi rejected the session file, but it could not be quarantined — clean retry refused (${quarantine.error})`, "error");
			}
		}
		return result;
	});
	return {
		res,
		runBilled: usageTotals.billed,
		runOut: usageTotals.out,
		sessionRecycled: run.sessionRecycled,
		sessionReset,
		driftStop: drift.stop,
		driftAdvisories: drift.advisories,
	};
}
