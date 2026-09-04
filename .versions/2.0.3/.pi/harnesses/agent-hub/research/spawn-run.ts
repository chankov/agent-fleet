import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { contextPct, resolveContextWindow } from "../context-window.js";
import { isReadOnlyToolList, safePathWithin } from "../helpers.ts";
import { researchTerminationOutcome, researchWatchdogSpawnOptions } from "../research-watchdog.ts";
import type { InputArtifactPreview } from "../context/assertions-artifacts.ts";
import type { ResearchAgentDef, ResearchFinalizeOutcome, ResearchResult, ResearchRuntimeDeps, ResearchState } from "./runtime.ts";

export interface ResearchSpawnPorts<TDef extends ResearchAgentDef> extends ResearchRuntimeDeps<TDef> {
	researchTools: string;
	sessionPath(id: number): string;
	finalize(state: ResearchState<TDef>, outcome: ResearchFinalizeOutcome): void;
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
	const startTime = Date.now();
	let result: ResearchResult | undefined;
	const settle = (status: ResearchFinalizeOutcome["status"], historyStatus: ResearchFinalizeOutcome["historyStatus"], lastWork: string, settled: ResearchResult): ResearchResult => {
		state.elapsed = settled.elapsed;
		deps.finalize(state, { status, historyStatus, lastWork });
		result = settled;
		return settled;
	};

	try {
		if (!state.histEntry) state.histEntry = deps.executionHistory.start("research", `Research r${state.id}`);

		const safety = deps.requireSafetyHarness(deps.getSafetyHarnessPath());
		if (!safety.ok) return settle("error", "error", safety.error, { output: safety.error, exitCode: 1, elapsed: 0 });

		state.status = "running";
		state.task = prompt;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.killedByOperator = false;
		deps.flushTimelineStore(state);
		state.timeline = [];
		state.transcriptStore = deps.createTranscriptStore(safePathWithin(deps.hubState.getSessionDir(), "transcripts", `research-r${state.id}.jsonl`));

		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
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
			noSkills: true, noContextFiles: true, sessionFile: sessionPath, resume: false,
			prompt: deps.artifacts.appendInputArtifacts(prompt, inputArtifacts), cwd: ctx.cwd || process.cwd(),
			extensions: safety.extensions, env: deps.guardrailEnv(`research-r${state.id}`),
			...researchWatchdogSpawnOptions(deps.getReconSearchTimeoutMs(), signal),
			turnDeadlineMs: deps.budget.currentBudget().agentTurnMs,
		}, fallback, {
			onProcess: process => { state.proc = process; },
			onModelFallback: ({ from, to, reason }) => {
				state.lastWork = `model fallback: ${deps.shortModel(from)} → ${deps.shortModel(to)}`;
				ctx.ui.notify(`Research r${state.id}: overridden model ${from} failed before work began; retrying with persona model ${to} (${reason})`, "warning");
			},
			onTextDelta: delta => {
				fullText += delta;
				state.lastWork = fullText.split("\n").filter(line => line.trim()).pop() || "";
				deps.appendTimelineText(state, "text", delta);
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
				}
			},
		}, { midRun: isReadOnlyToolList(deps.researchTools) }));

		state.elapsed = Date.now() - startTime;
		state.proc = undefined;
		if (res.spawnError) {
			return settle("error", "error", `Error: ${res.spawnError}`, { output: `Error spawning research helper: ${res.spawnError}`, exitCode: 1, elapsed: state.elapsed });
		}
		if (res.termination) {
			const outcome = researchTerminationOutcome(state.id, res.termination);
			return settle("error", "error", outcome.lastWork, { output: outcome.output, exitCode: outcome.exitCode, elapsed: state.elapsed, termination: res.termination });
		}
		if (state.killedByOperator) {
			state.killedByOperator = false;
			return settle("idle", "idle", "(killed by operator)", { output: `Research helper r${state.id} was killed by the operator before it finished.`, exitCode: res.exitCode ?? 143, elapsed: state.elapsed });
		}

		const status = res.exitCode === 0 ? "done" : "error";
		const lastWork = String(res.output ?? "").split("\n").filter((line: string) => line.trim()).pop() || "";
		const settled = settle(status, status, lastWork, { output: completeOutput(state, res), exitCode: res.exitCode ?? 1, elapsed: state.elapsed });
		ctx.ui.notify(`Research r${state.id} ${status} in ${Math.round(state.elapsed / 1000)}s`, status === "done" ? "success" : "error");
		return settled;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		state.elapsed = Date.now() - startTime;
		return settle("error", "error", `Error: ${message}`, { output: `Error spawning research helper: ${message}`, exitCode: 1, elapsed: state.elapsed });
	} finally {
		if (!result) {
			state.elapsed = Date.now() - startTime;
			deps.finalize(state, { status: "error", historyStatus: "error", lastWork: "terminated unexpectedly" });
		}
	}
}
