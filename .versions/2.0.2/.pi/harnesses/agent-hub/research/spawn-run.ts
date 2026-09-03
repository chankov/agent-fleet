import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { contextPct, resolveContextWindow } from "../context-window.js";
import { isReadOnlyToolList, safePathWithin } from "../helpers.ts";
import { researchTerminationOutcome, researchWatchdogSpawnOptions } from "../research-watchdog.ts";
import type { InputArtifactPreview } from "../context/assertions-artifacts.ts";
import type { ResearchAgentDef, ResearchResult, ResearchRuntimeDeps, ResearchState } from "./runtime.ts";

export interface ResearchSpawnPorts<TDef extends ResearchAgentDef> extends ResearchRuntimeDeps<TDef> {
	researchTools: string;
	sessionPath(id: number): string;
	prune(): void;
}

function finish<TDef extends ResearchAgentDef>(
	deps: ResearchSpawnPorts<TDef>, state: ResearchState<TDef>, status: "idle" | "done" | "error",
	historyStatus: "idle" | "done" | "error", lastWork: string,
): void {
	state.status = status;
	state.finishedAt = Date.now();
	state.lastWork = lastWork;
	deps.updateResearchWidget();
	state.zoomRender?.(true);
	if (state.histEntry) deps.executionHistory.end(state.histEntry, historyStatus);
	deps.prune();
}

function completeOutput<TDef extends ResearchAgentDef>(state: ResearchState<TDef>, res: any): string {
	let output = String(res.output ?? "");
	if (res.modelFallback) {
		output = `(ℹ model fallback: ${res.modelFallback.from} failed before work began; retried once with original persona model ${res.modelFallback.to}.)\n\n${output}`;
	}
	if (res.exitCode !== 0) {
		const errText = String(res.stderr ?? "").trim();
		const tail = errText.length > 1500 ? `...\n${errText.slice(-1500)}` : errText;
		const errBlock = tail ? `\n\n[stderr]\n${tail}` : "";
		output = output ? `${output}${errBlock}` : `Research helper r${state.id} exited with code ${res.exitCode} and produced no output.${errBlock}`;
	}
	return output;
}

export async function runResearchSpawn<TDef extends ResearchAgentDef>(
	deps: ResearchSpawnPorts<TDef>, state: ResearchState<TDef>, prompt: string, ctx: ExtensionContext,
	inputArtifacts: InputArtifactPreview[] = [], signal?: AbortSignal,
): Promise<ResearchResult> {
	const safety = deps.requireSafetyHarness(deps.getSafetyHarnessPath());
	if (!safety.ok) return { output: safety.error, exitCode: 1, elapsed: 0 };

	state.status = "running";
	state.task = prompt;
	state.toolCount = 0;
	state.elapsed = 0;
	state.lastWork = "";
	state.killedByOperator = false;
	deps.flushTimelineStore(state);
	state.timeline = [];
	state.transcriptStore = deps.createTranscriptStore(safePathWithin(deps.hubState.getSessionDir(), "transcripts", `research-r${state.id}-turn${state.turnCount}.jsonl`));
	deps.updateResearchWidget();
	state.histEntry = deps.executionHistory.start("research", `Research r${state.id}`);

	const startTime = Date.now();
	state.timer = setInterval(() => {
		state.elapsed = Date.now() - startTime;
		deps.updateResearchWidget();
	}, 1000);
	const thinkingLevel = deps.resolveThinkingLevel(deps.resolvedThinking(state.def));
	const wantThinking = thinkingLevel !== "off";
	const sessionPath = deps.sessionPath(state.id);
	const researchWindow = resolveContextWindow(state.model, { lookup: deps.modelWindowLookup(ctx), fallbackWindow: deps.getContextWindow() });
	const fallbackCandidate = deps.substitutedModel(deps.fallbackModelFor(state.def, state.model));
	const fallback = fallbackCandidate === state.model ? undefined : fallbackCandidate;
	let fullText = "";
	deps.notifyProviderQueue(state.model, `Research r${state.id}`, ctx);

	const res = await deps.providerSemaphore.run(state.model, () => deps.spawnPiAgentWithModelFallback({
		model: state.model, tools: deps.researchTools, thinking: thinkingLevel,
		systemPrompt: deps.nativeResearchSystemPrompt({
			...(state.persona ? { personaName: state.def.name, personaPath: state.def.file } : {}),
			cwd: ctx.cwd || process.cwd(),
		}),
		noSkills: true, noContextFiles: true, sessionFile: sessionPath, resume: !!state.sessionFile,
		prompt: deps.artifacts.appendInputArtifacts(prompt, inputArtifacts), cwd: ctx.cwd || process.cwd(),
		extensions: safety.extensions, env: deps.guardrailEnv(`research-r${state.id}`),
		...researchWatchdogSpawnOptions(deps.getReconSearchTimeoutMs(), signal),
		turnDeadlineMs: deps.budget.currentBudget().agentTurnMs,
	}, fallback, {
		onProcess: process => { state.proc = process; },
		onModelFallback: ({ from, to, reason }) => {
			state.lastWork = `model fallback: ${deps.shortModel(from)} → ${deps.shortModel(to)}`;
			ctx.ui.notify(`Research r${state.id}: overridden model ${from} failed before work began; retrying with persona model ${to} (${reason})`, "warning");
			deps.updateResearchWidget();
		},
		onTextDelta: delta => {
			fullText += delta;
			state.lastWork = fullText.split("\n").filter(line => line.trim()).pop() || "";
			deps.appendTimelineText(state, "text", delta);
			deps.updateResearchWidget();
			state.zoomRender?.();
		},
		onThinkingDelta: delta => {
			if (!wantThinking) return;
			deps.appendTimelineText(state, "thinking", delta);
			state.zoomRender?.();
		},
		onToolStart: (toolName, argStr, callId) => {
			state.toolCount++;
			deps.appendTimelineEvent(state, { kind: "tool-start", title: `Tool: ${toolName}`, content: argStr, timestamp: Date.now(), ...(callId ? { callId } : {}) });
			deps.updateResearchWidget();
			state.zoomRender?.();
		},
		onToolEnd: (toolName, callId, isError, resultText, durationMs) => {
			deps.appendTimelineEvent(state, { kind: "tool-result", title: `Result: ${toolName}`, content: resultText ?? "", timestamp: Date.now(), ...(callId ? { callId } : {}), status: isError ? "error" : "success", ...(durationMs == null ? {} : { durationMs }) });
			state.zoomRender?.();
		},
		onUsage: usage => {
			state.contextTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
			if (researchWindow.window > 0) {
				state.contextPct = contextPct(usage, researchWindow.window);
				deps.updateResearchWidget();
			}
		},
	}, { midRun: isReadOnlyToolList(deps.researchTools) }));

	if (state.timer) clearInterval(state.timer);
	state.elapsed = Date.now() - startTime;
	state.proc = undefined;
	if (res.spawnError) {
		finish(deps, state, "error", "error", `Error: ${res.spawnError}`);
		return { output: `Error spawning research helper: ${res.spawnError}`, exitCode: 1, elapsed: state.elapsed };
	}
	if (res.termination) {
		const outcome = researchTerminationOutcome(state.id, res.termination);
		finish(deps, state, "error", "error", outcome.lastWork);
		return { output: outcome.output, exitCode: outcome.exitCode, elapsed: state.elapsed, termination: res.termination };
	}
	if (state.killedByOperator) {
		state.killedByOperator = false;
		finish(deps, state, "idle", "idle", "(killed by operator)");
		return { output: `Research helper r${state.id} was killed by the operator before it finished.`, exitCode: res.exitCode ?? 143, elapsed: state.elapsed };
	}

	const status = res.exitCode === 0 ? "done" : "error";
	if (res.exitCode === 0) state.sessionFile = sessionPath;
	finish(deps, state, status, status, String(res.output ?? "").split("\n").filter((line: string) => line.trim()).pop() || "");
	ctx.ui.notify(`Research r${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`, state.status === "done" ? "success" : "error");
	return { output: completeOutput(state, res), exitCode: res.exitCode ?? 1, elapsed: state.elapsed };
}
