import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createDriftMonitor, normalizeWatchdogSetting } from "./drift-watchdog.js";
import { createDriftRuntime, type DriftRuntime, type DriftRuntimeOptions } from "./drift-runtime.ts";

interface OperatorWatchdogPorts {
 setting(): string;
 taskId(): string;
 task?(): string|undefined;
 runDriftJudge: DriftRuntimeOptions["runDriftJudge"];
}

/** Observe the root's actual tools, including direct operator work. Reuse the
 * specialist judge's cancellation fence, cooldown and bounded unavailable retry.
 * Tool volume alone is not a no-progress signal for a whole implementation task.
 */
export function registerOperatorWatchdog(pi: Pick<ExtensionAPI, "on" | "appendEntry">, ports: OperatorWatchdogPorts) {
 let active: DriftRuntime | null = null;
 let prompt = "";
 let activeTaskId: string | null = null;
 let abortRequested = false;
 let progressVersion = 0, lastSuccessfulCall = "";
 const calls = new Map<string, string>();
 const enabled = () => normalizeWatchdogSetting(ports.setting()) !== "off";
 const finish = () => {
  const previous = active;
  active = null;
  calls.clear(); lastSuccessfulCall = "";
  if (!previous) return;
  // Abort requested is distinct from proof that every in-flight effect stopped.
  previous.outcomeFor({});
  previous.dispose();
 };
 pi.on("before_agent_start", async event => { prompt = event.prompt; });
 const start = (ctx: ExtensionContext) => {
  finish();
  if (!enabled()) return;
  abortRequested = false;
  progressVersion = 0; lastSuccessfulCall = ""; calls.clear();
  const taskId = ports.taskId();
  activeTaskId = taskId;
  const runtime = createDriftRuntime({
   dispatchId: `operator-${randomUUID()}`, agentKey: "operator", agentLabel: "Fleet operator",
   task: ports.task?.() || prompt || "Continue the current authorized task", scopeGlobs: [], hubOwnedGlobs: [], armed: true, ctx,
   monitor: createDriftMonitor({ maxToolCalls: Number.POSITIVE_INFINITY }),
   runDriftJudge: async (input, context) => {
    const observedProgress = progressVersion;
    const result = await ports.runDriftJudge(input, context);
    return enabled() && observedProgress === progressVersion ? result : { status: "cancelled" };
   },
   onOutcome: outcome => {
    try { pi.appendEntry("agent-hub-operator-watchdog", { taskId, abortRequested, attributions: outcome.attributions }); }
    catch { /* Diagnostic persistence must not interfere with cancellation. */ }
   },
  });
  active = runtime;
  runtime.attemptLifecycle.beforePhysicalSpawn({ generation: 1 });
  runtime.bindControl({ terminate: () => {
   if (active !== runtime || !enabled() || ports.taskId() !== taskId) return;
   abortRequested = true;
   ctx.abort();
   if (ctx.hasUI) ctx.ui.notify("Watchdog stopped this turn after detecting repeated work without progress. Inspect the recorded evidence before resuming.", "warning");
  } });
 };
 pi.on("agent_start", async (_event, ctx) => start(ctx));
 pi.on("tool_execution_start", async (event, ctx) => {
  if (active && activeTaskId !== ports.taskId()) start(ctx);
  if (!enabled()) { finish(); return; }
  const runtime = active;
  if (!runtime) return;
  // Waiting for a real decision is not a no-progress loop. Fence old judgments.
  if (event.toolName === "ask_user") { progressVersion++; return; }
  const args = JSON.stringify(event.args ?? {});
  calls.set(event.toolCallId, `${event.toolName}:${args}`);
  const violation = runtime.monitor?.onToolStart(event.toolName, args, event.toolCallId);
  if (violation) runtime.escalate(violation);
 });
 pi.on("tool_execution_end", async (event, ctx) => {
  if (active && activeTaskId !== ports.taskId()) { start(ctx); return; }
  if (!enabled()) { finish(); return; }
  const runtime = active;
  if (!runtime) return;
  if (event.toolName === "ask_user") return;
  const fingerprint = calls.get(event.toolCallId); calls.delete(event.toolCallId);
  if (event.isError === false && fingerprint && fingerprint !== lastSuccessfulCall) {
   progressVersion++; lastSuccessfulCall = fingerprint;
  }
  const violation = runtime.monitor?.onToolEnd(event.toolName, event.isError, event.toolCallId);
  if (violation) runtime.escalate(violation);
 });
 pi.on("agent_end", async () => finish());
 pi.on("input", async () => { finish(); prompt = ""; });
 pi.on("session_start", async () => { finish(); prompt = ""; });
 pi.on("session_before_switch", async () => { finish(); prompt = ""; });
 pi.on("session_shutdown", async () => { finish(); prompt = ""; });
 return { dispose: finish };
}
