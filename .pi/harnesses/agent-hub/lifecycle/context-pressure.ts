import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
// Pi exposes image content through sendUserMessage even when it does not re-export its type.
type ImageContent = Extract<Exclude<Parameters<ExtensionAPI["sendUserMessage"]>[0], string>[number], { type: "image" }>;
import { contextPressureDiagnostic, createContextPressureState, transitionContextPressure, type ContextPressureState } from "../context-pressure.ts";
import { estimatePromptTokens } from "../context-window.js";
import { ContextContinuityCoordinator } from "../context-continuity.ts";
import { contextContinuityCompatibility } from "../context-continuity-compat.ts";
import { registerManagedCompaction } from "../context-continuity-registry.ts";
import { ContextCompactionRuntime, compactionResponseReserve } from "../context-compaction-runtime.ts";
import { contextAssessmentMetadata } from "../context-compaction.ts";
import { getContextCompactionService } from "../system1-runtime.ts";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { compactionPreflight, type CompactionPreflight } from "../context-compaction-preflight.ts";

export type PressureSource = "message_end" | "turn_end" | "context" | "input" | "agent_settled" | "session_start" | "session_compact" | "compaction_callback";
export interface DeferredRecoveryInput { text: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
export interface ContextPressureRootState {
	pressure: ContextPressureState;
	automaticPending: boolean;
	automaticRunning: boolean;
	deferredReplayAllowance: number;
	deferredReplayTexts: string[];
	deferredInputs: DeferredRecoveryInput[];
}
export const createContextPressureRootState = (): ContextPressureRootState => ({ pressure: createContextPressureState(), automaticPending: false, automaticRunning: false, deferredReplayAllowance: 0, deferredReplayTexts: [], deferredInputs: [] });

export interface ContextPressurePorts {
 continuity?: { pi: ExtensionAPI; runtimeVersion: string; taskIdentity(): {task:string; revision:number}; preflight?(ctx:ExtensionContext):Promise<CompactionPreflight> };
	getState(): ContextPressureRootState;
	setPressure(value: ContextPressureState): void;
	getCurrentContext(): ExtensionContext | null;
	appendEntry(type: string, data: unknown): void;
	sendUserMessage(content: string | Array<{ type: "text"; text: string } | ImageContent>, options: { deliverAs?: "steer" | "followUp" }): void;
	resolveCapabilities(input: string, newTask?: boolean, refresh?: boolean): void;
	applyWorkMode(): void;
	modelWorkBlocked(ctx: ExtensionContext): boolean;
	/** Accepted user input (including an authenticated pressure replay), before pack resolution. */
	onAcceptedInput?(text: string, source: string, replayed: boolean): void;
}

export interface ContextPressureLifecycle {
	reset(ctx: ExtensionContext): void;
	status(ctx: ExtensionContext): void;
	observe(ctx: ExtensionContext, source: "message_end" | "turn_end" | "input" | "session_start", additionalTokens?: number): "none" | "expose-compaction" | "compact-now";
	runCompaction(ctx: ExtensionContext, source: "input" | "agent_settled" | "session_start"): void | Promise<void>;
	messageEnd(event: any, ctx: ExtensionContext): void;
	turnEnd(ctx: ExtensionContext): void | Promise<void>;
	context(ctx: ExtensionContext): void;
	agentSettled(ctx: ExtensionContext): Promise<void>;
	sessionCompact(restored?: boolean): void;
	input(event: any, ctx: ExtensionContext): { action: "handled" | "continue"; replayedUserInput?: boolean };
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
 let interrupted=false, restored=false;
 const semantic=new ContextCompactionRuntime();let semanticPending:Promise<void>|null=null, turn=0, taskText="",cancelled=false;
 let explicitRequested=false;
 let explicitInstructions="", nextStep="Resume the interrupted authorized step; retain all existing gates and budgets.";
 const supported=!!ports.continuity && contextContinuityCompatibility(ports.continuity.runtimeVersion).supported;
 const coordinator = supported ? new ContextContinuityCoordinator({
  identity: () => { const task=ports.continuity!.taskIdentity(); const ctx=ports.getCurrentContext(); return {session:ctx?.sessionManager.getSessionId() ?? "unknown",task:task.task,revision:task.revision,owner:"hub",attempt:1}; },
  eligibility: () => { const ctx=ports.getCurrentContext(); const blocked=!ctx || ports.modelWorkBlocked(ctx); return {active:interrupted,cancelled,completed:!interrupted,waitingUser:blocked,budgetBlocked:blocked}; },
  compact: instructions => new Promise<void>((resolve,reject) => { const ctx=ports.getCurrentContext(); if(!ctx) {reject(new Error("missing context"));return;} ctx.compact({customInstructions:instructions,onComplete:()=>resolve(),onError:reject}); }),
  restore: async () => restored,
  replayUser: () => { if(!state().deferredInputs.length)return false; replayDeferred(); return true; },
  continueTask: capsule => { interrupted=false; ports.continuity!.pi.sendMessage({customType:"agent-hub-context-continuation",content:`Continue the same authorized task. ${coordinator?.phase==="skipped" ? "Explicit compaction was skipped: no compactable history; no compact or restoration occurred." : "Context compaction and runtime restoration completed."} Do not restart or redispatch pending operations. Next step: ${capsule.nextStep}`,display:false},{triggerTurn:true}); },
 }) : null;
 if(ports.continuity) ports.continuity.pi.on("agent_settled",event=>{ if(event.aborted && !interrupted){cancelled=true;semantic.fence();coordinator?.fence();} });
	const status = (ctx: ExtensionContext) => {
		const diagnostic = contextPressureDiagnostic(state().pressure);
		const percent = diagnostic.percent === null ? "unknown" : `${diagnostic.percent.toFixed(1)}%`;
		ctx.ui.setStatus("context-pressure", `Context: ${state().pressure.phase} · ${percent} · auto ${diagnostic.automaticPercent}% · last ${diagnostic.lastRecoveryOutcome}`);
	};
	const record = (source: PressureSource, action: string, reason: string) => {
		const diagnostic = contextPressureDiagnostic(state().pressure);
		try { ports.appendEntry("agent-hub-context-pressure", { version: 1, source, phase: diagnostic.phase, pressure: diagnostic.pressure, episode: diagnostic.episode, tokens: diagnostic.tokens, context_window: diagnostic.contextWindow, percent: diagnostic.percent, warning_percent: diagnostic.warningPercent, automatic_percent: diagnostic.automaticPercent, last_recovery_outcome: diagnostic.lastRecoveryOutcome, action, reason }); } catch {}
	};
	// Pressure observations refresh runtime capabilities; they are not a new
 // user intent. Preserve the current explicit compaction request until the
 // next accepted user input, without retaining it as a permanent task pack.
 const syncPolicy = () => { ports.resolveCapabilities("", false, true); ports.applyWorkMode(); };
	const observe: ContextPressureLifecycle["observe"] = (ctx, source, additionalTokens = 0) => {
  if(coordinator) registerManagedCompaction(ctx.sessionManager,{request:request=>{explicitRequested=true;explicitInstructions=[explicitInstructions,request.instructions].filter(Boolean).join("\n\n");if(request.nextStep){nextStep=request.nextStep;interrupted=true;}state().automaticPending=true;}});
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
		state().deferredReplayTexts.push(...queued.map(input => input.text));
		queued.forEach((input, index) => ports.sendUserMessage(input.images?.length ? [{ type: "text", text: input.text }, ...input.images] : input.text, { deliverAs: index === 0 ? input.streamingBehavior : "followUp" }));
	};
	const runCompaction: ContextPressureLifecycle["runCompaction"] = async (ctx, source) => {
		if (!state().automaticPending || state().automaticRunning) return;
  const explicit=explicitRequested;explicitRequested=false;
  const sessionId=ctx.sessionManager?.getSessionId?.();const taskIdentity=ports.continuity?.taskIdentity();
  const pressureRequired=state().pressure.phase==="compacting" || state().pressure.phase==="failed" || (state().pressure.usage.percent??0)>=90;
		state().automaticPending = false; state().automaticRunning = true;
  if(coordinator && explicit && !pressureRequired) {
   const check=await (ports.continuity?.preflight??compactionPreflight)(ctx);
   const currentTask=ports.continuity?.taskIdentity();
   if(!state().automaticRunning)return;
   if(cancelled || ctx.sessionManager.getSessionId?.()!==sessionId || currentTask?.task!==taskIdentity?.task || currentTask?.revision!==taskIdentity?.revision){state().automaticRunning=false;coordinator.fence();return;}
   if(check==="no-history" && state().pressure.phase!=="compacting" && state().pressure.phase!=="failed" && (state().pressure.usage.percent??0)<90) {
    const capsule=coordinator.request(nextStep);explicitInstructions="";
    try {ports.appendEntry("agent-hub-context-continuity",{version:1,phase:"skipped",reason:"no-compactable-history",capsule});}
    catch {state().automaticRunning=false;ctx.ui.notify("Explicit compaction skipped, but continuation was withheld because its runtime entry could not be saved.","error");return;}
    state().automaticRunning=false;
    record(source,"skip-compaction","no-compactable-history");status(ctx);syncPolicy();
    ctx.ui.notify("Explicit compaction skipped: no compactable history (session too small or already compacted). No compaction occurred; any continuation remains subject to current task gates.","info");
    coordinator.skipNoHistory();return;
   }
  }
  record(source, "compact-now", explicit?"explicit-request":"automatic-threshold");
		if (ctx.hasUI) ctx.ui.notify(explicit?"Explicit context compaction started.":"Automatic context compaction started.", explicit?"info":"warning");
  if (coordinator) {
   restored=false; const capsule=coordinator.request(nextStep,["agent-hub-recovery","agent-hub-process","agent-hub-tool-catalog"],[]);
   try { ports.appendEntry("agent-hub-context-continuity",{version:1,phase:"compacting",capsule}); } catch { state().automaticRunning=false;ports.setPressure(transitionContextPressure(state().pressure,{type:"compaction-failed",error:"capsule persistence failed"}).state);return; }
   const instructions=[INSTRUCTIONS,explicitInstructions].filter(Boolean).join("\n\n");explicitInstructions="";
   return coordinator.run(instructions).then(ok=>{
    state().automaticRunning=false;
    if(ok){markSucceeded(); if(ctx.hasUI)ctx.ui.notify(explicit?"Explicit context compaction completed.":"Automatic context compaction completed.","info");replayDeferred();}
    else { const failed=transitionContextPressure(state().pressure,{type:"compaction-failed",error:"compaction or restore failed"});ports.setPressure(failed.state);status(ctx);syncPolicy();record("compaction_callback",failed.action,failed.reason); }
   });
  }
		ctx.compact({ customInstructions: INSTRUCTIONS, onComplete: () => { state().automaticRunning = false; markSucceeded(); if (ctx.hasUI) ctx.ui.notify("Automatic context compaction completed.", "info"); replayDeferred(); }, onError: error => {
			state().automaticRunning = false;
			const failed = transitionContextPressure(state().pressure, { type: "compaction-failed", error: "automatic compaction failed" });
			ports.setPressure(failed.state); status(ctx); syncPolicy(); record("compaction_callback", failed.action, failed.reason);
			if (ctx.hasUI) ctx.ui.notify(`Automatic compaction failed: ${error.message}. Deferred input is retained; run /compact or switch to a larger-context model.`, "error");
		} });
	};
	return {
		reset(ctx) { coordinator?.fence(); semantic.fence();semanticPending=null;turn=0;taskText="";explicitRequested=false;explicitInstructions="";nextStep="Resume the interrupted authorized step; retain all existing gates and budgets.";cancelled=false;interrupted=false; restored=false; const fresh = createContextPressureRootState(); ports.setPressure(fresh.pressure); Object.assign(state(), fresh); status(ctx); }, status, observe, runCompaction, replayDeferred,
		messageEnd(event, ctx) { if (event.message.role !== "toolResult") return; const projected = estimatePromptTokens(JSON.stringify(event.message.content ?? [])); if (observe(ctx, "message_end", projected) === "compact-now") { interrupted=true; ctx.abort(); } },
		async turnEnd(ctx) {
   observe(ctx, "turn_end");turn++;
   const usage=ctx.getContextUsage();
   const measurement={tokens:usage?.tokens??null,window:usage?.contextWindow??ctx.model?.contextWindow??null,turn};
   const diagnostic=(result:unknown,details:unknown=measurement)=>{const metadata=contextAssessmentMetadata(result,details);try{ports.appendEntry("agent-hub-context-assessment",metadata);}catch{}ctx.ui.setStatus("context-assessment",`Context assessment: ${metadata.status} · ${metadata.reason}`);};
   if(!coordinator){diagnostic({status:"off",reason:"runtime_unsupported"});return;}
   if(state().automaticPending || state().automaticRunning || cancelled){diagnostic({status:"ineligible",reason:cancelled?"cancelled":"recovery_pending"});return;}
   const consumer=getContextCompactionService();if(!consumer){diagnostic({status:"off",reason:"service_unavailable"});return;}
   const task=ports.continuity!.taskIdentity();
   const settings=SettingsManager.create(ctx.cwd).getCompactionSettings(ctx.model);
   const keep=settings.keepRecentTokens,responseTokens=compactionResponseReserve(settings,ctx.model?.maxTokens);
   const messages=ctx.sessionManager.getBranch().filter(entry=>entry.type==="message");
   const historyTokens=estimatePromptTokens(JSON.stringify(messages));
   const identity=`${ctx.sessionManager.getSessionId()}:${task.task}:${task.revision}`;
   const snapshot={...measurement,responseTokens,historyTokens,keepRecentTokens:keep};
   semanticPending=semantic.assess({identity,task:taskText,revision:task.revision,...snapshot,tokens:measurement.tokens,window:measurement.window,unsafe:false},consumer.service,consumer.config).then(result=>{
    const current=ports.continuity!.taskIdentity();
    if(current.task!==task.task || current.revision!==task.revision || cancelled || state().automaticRunning || ctx.getContextUsage()?.tokens!==usage?.tokens){diagnostic({status:"stale",reason:"snapshot_changed",inferenceRequested:result.inferenceRequested},snapshot);return;}
    diagnostic(result,snapshot);
    if(result.compact){explicitInstructions=result.instructions??"";state().automaticPending=true;}
   }).catch(()=>diagnostic({status:"unavailable",reason:"evaluation_failed"},snapshot));
   // Bounded assessment must settle at this safe turn boundary, before Pi
   // opens another model request and makes the advice stale.
   await semanticPending;
  },
		context(ctx) { if (!state().automaticPending) return; interrupted=true; record("context", "compact-now", "single-flight"); ctx.abort(); },
		async agentSettled(ctx) { if(semanticPending){await semanticPending;semanticPending=null;} await runCompaction(ctx, "agent_settled"); },
		sessionCompact(success = true) { restored=success; if(!success) return; semantic.compacted(ports.getCurrentContext()?.getContextUsage()?.tokens??null); markSucceeded(); if (!state().automaticRunning) { void coordinator?.nativeCompacted(); setTimeout(replayDeferred, 0); } },
		input(event, ctx) {
			const replaying = event.source === "extension" && state().deferredReplayTexts[0] === incomingText(event);
			if (replaying) { state().deferredReplayTexts.shift(); state().deferredReplayAllowance--; }
			else {
				// Extension feedback/status cannot join the user-owned recovery queue.
				if (event.source === "extension") return { action: state().automaticPending || state().automaticRunning ? "handled" : "continue" };
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
			const text = incomingText(event);
   if(event.source!=="extension"){taskText=text;cancelled=false;semantic.fence();if(!state().automaticRunning)coordinator?.fence();interrupted=false;explicitRequested=false;explicitInstructions="";nextStep="Resume the interrupted authorized step; retain all existing gates and budgets.";}
			ports.onAcceptedInput?.(text, event.source, replaying);
			ports.resolveCapabilities(text); ports.applyWorkMode(); return { action: "continue", ...(replaying ? { replayedUserInput: true } : {}) };
		},
	};
}
