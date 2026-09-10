import type { ExtensionContext, ImageContent } from "@mariozechner/pi-coding-agent";
import { contextPressureDiagnostic, createContextPressureState, transitionContextPressure, type ContextPressureState } from "../context-pressure.ts";
import { estimatePromptTokens } from "../context-window.js";

export type PressureSource = "message_end" | "turn_end" | "context" | "input" | "agent_settled" | "session_start" | "session_compact" | "compaction_callback";
export interface DeferredRecoveryInput { text: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
export interface ContextPressureRootState {
	pressure: ContextPressureState;
	automaticPending: boolean;
	automaticRunning: boolean;
	deferredReplayAllowance: number;
	deferredInputs: DeferredRecoveryInput[];
}
export const createContextPressureRootState = (): ContextPressureRootState => ({ pressure: createContextPressureState(), automaticPending: false, automaticRunning: false, deferredReplayAllowance: 0, deferredInputs: [] });

export interface ContextPressurePorts {
	getState(): ContextPressureRootState;
	setPressure(value: ContextPressureState): void;
	getCurrentContext(): ExtensionContext | null;
	appendEntry(type: string, data: unknown): void;
	sendUserMessage(content: string | Array<{ type: "text"; text: string } | ImageContent>, options: { deliverAs?: "steer" | "followUp" }): void;
	resolveCapabilities(input: string): void;
	applyWorkMode(): void;
	modelWorkBlocked(ctx: ExtensionContext): boolean;
}

export interface ContextPressureLifecycle {
	reset(ctx: ExtensionContext): void;
	status(ctx: ExtensionContext): void;
	observe(ctx: ExtensionContext, source: "message_end" | "turn_end" | "input" | "session_start", additionalTokens?: number): "none" | "expose-compaction" | "compact-now";
	runCompaction(ctx: ExtensionContext, source: "input" | "agent_settled" | "session_start"): void;
	messageEnd(event: any, ctx: ExtensionContext): void;
	turnEnd(ctx: ExtensionContext): void;
	context(ctx: ExtensionContext): void;
	agentSettled(ctx: ExtensionContext): void;
	sessionCompact(): void;
	input(event: any, ctx: ExtensionContext): { action: "handled" | "continue" };
	replayDeferred(): void;
}

const INSTRUCTIONS = "Preserve the current goal, completed and open assertions, decisions, modified/read files, pending child or peer operations, blockers, and the concrete next step.";
const incomingText = (event: unknown): string => {
	const value = event as { text?: unknown; message?: unknown; input?: unknown } | null;
	if (typeof value?.text === "string") return value.text;
	if (typeof value?.message === "string") return value.message;
	if (typeof value?.input === "string") return value.input;
	const message = value?.message as { content?: unknown } | undefined;
	return typeof message?.content === "string" ? message.content : "";
};

export function createContextPressureLifecycle(ports: ContextPressurePorts): ContextPressureLifecycle {
	const state = () => ports.getState();
	const status = (ctx: ExtensionContext) => {
		const diagnostic = contextPressureDiagnostic(state().pressure);
		const percent = diagnostic.percent === null ? "unknown" : `${diagnostic.percent.toFixed(1)}%`;
		ctx.ui.setStatus("context-pressure", `Context: ${state().pressure.phase} · ${percent} · auto ${diagnostic.automaticPercent}% · last ${diagnostic.lastRecoveryOutcome}`);
	};
	const record = (source: PressureSource, action: string, reason: string) => {
		const diagnostic = contextPressureDiagnostic(state().pressure);
		try { ports.appendEntry("agent-hub-context-pressure", { version: 1, source, phase: diagnostic.phase, pressure: diagnostic.pressure, episode: diagnostic.episode, tokens: diagnostic.tokens, context_window: diagnostic.contextWindow, percent: diagnostic.percent, warning_percent: diagnostic.warningPercent, automatic_percent: diagnostic.automaticPercent, last_recovery_outcome: diagnostic.lastRecoveryOutcome, action, reason }); } catch {}
	};
	const syncPolicy = () => { ports.resolveCapabilities(""); ports.applyWorkMode(); };
	const observe: ContextPressureLifecycle["observe"] = (ctx, source, additionalTokens = 0) => {
		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
		const tokens = usage?.tokens == null ? null : usage.tokens + Math.max(0, additionalTokens);
		const percent = tokens != null && contextWindow != null && contextWindow > 0 ? tokens / contextWindow * 100 : usage?.percent ?? null;
		const previous = state().pressure.phase;
		const decision = transitionContextPressure(state().pressure, { type: "usage", usage: { tokens, contextWindow, percent } });
		ports.setPressure(decision.state); status(ctx); syncPolicy();
		if (decision.action !== "none" || previous !== decision.state.phase) record(source, decision.action, decision.reason);
		if (decision.action === "compact-now") { state().automaticPending = true; if (ctx.hasUI) ctx.ui.notify("Context reached 90%; pausing the tool loop for automatic compaction.", "warning"); }
		return decision.action;
	};
	const markSucceeded = () => {
		state().automaticPending = false;
		if (state().pressure.phase === "recovered") return;
		const decision = transitionContextPressure(state().pressure, { type: "compaction-succeeded" });
		ports.setPressure(decision.state);
		const ctx = ports.getCurrentContext(); if (ctx) status(ctx);
		syncPolicy(); record("session_compact", decision.action, decision.reason);
	};
	const replayDeferred = () => {
		if (state().automaticPending || state().automaticRunning || state().deferredInputs.length === 0) return;
		const queued = state().deferredInputs.splice(0); state().deferredReplayAllowance += queued.length;
		queued.forEach((input, index) => ports.sendUserMessage(input.images?.length ? [{ type: "text", text: input.text }, ...input.images] : input.text, { deliverAs: index === 0 ? input.streamingBehavior : "followUp" }));
	};
	const runCompaction: ContextPressureLifecycle["runCompaction"] = (ctx, source) => {
		if (!state().automaticPending || state().automaticRunning) return;
		state().automaticPending = false; state().automaticRunning = true; record(source, "compact-now", "automatic-threshold");
		if (ctx.hasUI) ctx.ui.notify("Automatic context compaction started.", "warning");
		ctx.compact({ customInstructions: INSTRUCTIONS, onComplete: () => { state().automaticRunning = false; markSucceeded(); if (ctx.hasUI) ctx.ui.notify("Automatic context compaction completed.", "success"); replayDeferred(); }, onError: error => {
			state().automaticRunning = false;
			const failed = transitionContextPressure(state().pressure, { type: "compaction-failed", error: "automatic compaction failed" });
			ports.setPressure(failed.state); status(ctx); syncPolicy(); record("compaction_callback", failed.action, failed.reason);
			if (ctx.hasUI) ctx.ui.notify(`Automatic compaction failed: ${error.message}. Deferred input is retained; run /compact or switch to a larger-context model.`, "error");
		} });
	};
	return {
		reset(ctx) { const fresh = createContextPressureRootState(); ports.setPressure(fresh.pressure); Object.assign(state(), fresh); status(ctx); }, status, observe, runCompaction, replayDeferred,
		messageEnd(event, ctx) { if (event.message.role !== "toolResult") return; const projected = estimatePromptTokens(JSON.stringify(event.message.content ?? [])); if (observe(ctx, "message_end", projected) === "compact-now") ctx.abort(); },
		turnEnd(ctx) { observe(ctx, "turn_end"); },
		context(ctx) { if (!state().automaticPending) return; record("context", "compact-now", "single-flight"); ctx.abort(); },
		agentSettled(ctx) { runCompaction(ctx, "agent_settled"); },
		sessionCompact() { markSucceeded(); if (!state().automaticRunning) setTimeout(replayDeferred, 0); },
		input(event, ctx) {
			const replaying = event.source === "extension" && state().deferredReplayAllowance > 0;
			if (replaying) state().deferredReplayAllowance--;
			else {
				if (state().pressure.phase === "normal") observe(ctx, "input");
				if (state().automaticPending || state().automaticRunning || state().pressure.phase === "failed") {
					state().deferredInputs.push({ text: event.text, images: event.images ? [...event.images] : undefined, streamingBehavior: event.streamingBehavior });
					if (state().automaticPending && ctx.isIdle()) setTimeout(() => runCompaction(ctx, "input"), 0);
					ctx.ui.notify(state().pressure.phase === "failed" ? "Context recovery failed; input is retained. Run /compact or switch to a larger-context model." : "Input retained until automatic context recovery completes.", "warning");
					return { action: "handled" };
				}
			}
			if (replaying && ports.modelWorkBlocked(ctx)) { state().deferredInputs.push({ text: event.text, images: event.images ? [...event.images] : undefined, streamingBehavior: event.streamingBehavior }); return { action: "handled" }; }
			if (ports.modelWorkBlocked(ctx)) return { action: "handled" };
			ports.resolveCapabilities(incomingText(event)); ports.applyWorkMode(); return { action: "continue" };
		},
	};
}
