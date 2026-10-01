// Test-only fixed synthetic model and human UI helper. Load ONLY through the offline launcher.
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TRIAGE_UI_INPUTS = Object.freeze({
 applied: "Change only the installer trust-boundary validation. Synthetic UI inspection; do not execute tools.",
 waived: "Change only the installer trust-boundary validation. Synthetic UI inspection; do not execute tools.",
 timeout: "Review a requested installer trust-boundary change. Synthetic provider timeout fixture.",
 oversized: "x".repeat(40961),
 stale: "A different requested installer trust-boundary change. Synthetic pending transition fixture.",
 "viewer-withheld": "x".repeat(33792),
 action: "Synthetic exact-action human UI inspection only. Request the fixed temporary bash, write and edit examples; never run a real migration.",
});
// Deeply frozen, complete actions. No ambient command, path or model-generated argument is used.
export const TRIAGE_UI_ACTIONS = Object.freeze([
 { tool: "bash", input: Object.freeze({ command: "printf 'synthetic bash preview\\n'", timeout: 5 }) },
 { tool: "write", input: Object.freeze({ path: "action-write.txt", content: "synthetic write line 1\nsynthetic write line 2\n" }) },
 { tool: "edit", input: Object.freeze({ path: "action-edit.txt", edits: Object.freeze([
  Object.freeze({ oldText: "alpha-before", newText: "alpha-after" }), Object.freeze({ oldText: "beta-before", newText: "beta-after" }),
 ]) }) },
 { tool: "write", input: Object.freeze({ path: "action-denied.txt", content: "later action needs its own decision" }) },
 { tool: "write", input: Object.freeze({ path: "action-sensitive.txt", content: "password=synthetic-only-action-sentinel" }) },
 { tool: "write", input: Object.freeze({ path: "action-large.txt", content: "x".repeat(20000) }) },
] as const);
export function createTriageUiProbe(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env) {
 if (env.AF_TASK_TRIAGE_UI !== "1" || env.PI_OFFLINE !== "1") throw new Error("Explicit offline UI opt-in required");
 if (!Object.hasOwn(TRIAGE_UI_INPUTS, env.AF_TASK_TRIAGE_UI_SCENE ?? "")) throw new Error("Unknown synthetic scene");
 const scene = env.AF_TASK_TRIAGE_UI_SCENE as keyof typeof TRIAGE_UI_INPUTS;
 if (scene === "action" && (!env.AF_TASK_TRIAGE_UI_WORKSPACE || !isAbsolute(env.AF_TASK_TRIAGE_UI_WORKSPACE))) throw new Error("Isolated action workspace required");
 let actionIndex = 0;
 const emitted = new Map<string, string>();
 pi.registerProvider("triage-ui", { name: "Synthetic UI only", baseUrl: "http://127.0.0.1", apiKey: "synthetic", api: "triage-ui-api",
  models: [{ id: "m", name: "Synthetic fixed-script UI model", reasoning: false, input: ["text"],
   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
  streamSimple(model) {
   const stream = createAssistantMessageEventStream();
   queueMicrotask(() => {
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
     timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "Synthetic reply only. Open /af-agents-list or /af-audit to inspect real Hub metadata. No tool was requested; no independent correctness claim." }],
     usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const action = scene === "action" ? TRIAGE_UI_ACTIONS[actionIndex++] : undefined;
    if (action) {
     const call = { type: "toolCall" as const, id: `triage-ui-action-${actionIndex}`, name: action.tool, arguments: JSON.parse(JSON.stringify(action.input)) };
     emitted.set(call.id, JSON.stringify([call.name, call.arguments]));
     message.content = [call]; message.stopReason = "toolUse";
     stream.push({ type: "start", partial: message }); stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
     stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
     stream.push({ type: "done", reason: "toolUse", message }); stream.end(); return;
    }
    if (scene === "action") message.content = [{ type: "text", text: "Fixed action sequence finished. Use /triage-ui-action-status and /af-audit; actual human observation is not recorded by this fixture." }];
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].type === "text" ? message.content[0].text : "", partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].type === "text" ? message.content[0].text : "", partial: message });
    stream.push({ type: "done", reason: "stop", message }); stream.end();
   });
   return stream;
  },
 });
 pi.registerCommand("triage-ui-fill", { description: "Place approved synthetic input in the editor (Enter sends it)", handler: async (args, ctx) => {
  const name = (args.trim() || scene) as keyof typeof TRIAGE_UI_INPUTS;
  if (!Object.hasOwn(TRIAGE_UI_INPUTS, name)) { ctx.ui.notify("Unknown synthetic scene", "warning"); return; }
  ctx.ui.setEditorText(TRIAGE_UI_INPUTS[name]);
  ctx.ui.notify(`Synthetic ${name} input is in the editor. Enter sends it; no real API.`, "info");
 } });
 pi.registerCommand("triage-ui-waiver", { description: "Prepare, never authorize, the real waiver command", handler: async (_args, ctx) => {
  const entries = ctx.sessionManager.getEntries();
  const row = [...entries].reverse().find((e: any) => (e.customType ?? e.type) === "agent-hub-process-state") as any;
  const addition = row?.data?.additions?.find((a: any) => a.status === "active" && a.reason === "security_change");
  if (!addition || !/^[a-f0-9]{64}$/.test(addition.id)) { ctx.ui.notify("No active synthetic security addition; send applied input first", "warning"); return; }
  ctx.ui.setEditorText(`/af-task-triage-waive ${addition.id} synthetic UI false-positive review`);
  ctx.ui.notify("Only the command was prepared. Enter and your actual correlated Yes/No decision are required.", "info");
 } });
 pi.registerCommand("triage-ui-action-status", { description: "Inspect only fixed synthetic action files, never authorize or execute", handler: async (_args, ctx) => {
  if (scene !== "action" || ctx.cwd !== env.AF_TASK_TRIAGE_UI_WORKSPACE) { ctx.ui.notify("Only the isolated action scene supports this status", "warning"); return; }
  const fileState = (name: string, expected: string) => {
   try { return readFileSync(join(ctx.cwd, name), "utf8") === expected ? "exact expected bytes" : "unexpected bytes"; }
   catch { return "missing"; }
  };
  ctx.ui.notify(`Synthetic action status (not acceptance):\nwrite: ${fileState("action-write.txt", String(TRIAGE_UI_ACTIONS[1].input.content))}\nedit: ${fileState("action-edit.txt", "alpha-after\nbeta-after\n")}\ndenied: ${fileState("action-denied.txt", "later action needs its own decision")}\nsensitive: ${fileState("action-sensitive.txt", "")}\nlarge: ${fileState("action-large.txt", "")}`, "info");
 } });
 pi.on("input", (event, ctx) => {
  if (scene === "action" ? event.text === TRIAGE_UI_INPUTS.action : Object.values(TRIAGE_UI_INPUTS).filter(text => text !== TRIAGE_UI_INPUTS.action).includes(event.text)) return { action: "continue" };
  ctx.ui.notify("Only approved synthetic inputs are allowed here. Use /triage-ui-fill; no arbitrary repository data.", "warning");
  return { action: "handled" };
 });
 pi.on("before_agent_start", (_event, ctx) => {
  if (ctx.model?.provider !== "triage-ui" || ctx.model.id !== "m") {
   ctx.abort(); throw new Error("Only the synthetic UI model is allowed in this fixture");
  }
 });
 pi.on("user_bash", () => ({ result: { output: "Shell commands are disabled in the synthetic human UI fixture", exitCode: 1, cancelled: false, truncated: false } }));
 pi.on("tool_call", (event, ctx) => {
  const exact = JSON.stringify([event.toolName, event.input]);
  if (scene === "action" && ctx.cwd === env.AF_TASK_TRIAGE_UI_WORKSPACE && emitted.get(event.toolCallId) === exact) {
   emitted.delete(event.toolCallId); return; // Fixture permit only; production human/process/damage-control gates remain authoritative.
  }
  return { block: true, reason: "Only exact fixed synthetic action calls in the isolated workspace are allowed" };
 });
 pi.on("session_start", (_event, ctx) => {
  ctx.ui.notify(`Offline HUMAN UI fixture: ${scene}. Use /triage-ui-fill ${scene === "stale" ? "applied" : scene}, Enter, then /af-agents-list. Capture starts OFF. /quit exits.`, "info");
  if (env.AF_TASK_TRIAGE_UI_READY) writeFileSync(env.AF_TASK_TRIAGE_UI_READY, JSON.stringify({ scene, offline: true, humanAcceptance: "not_recorded" }), { mode: 0o600 });
 });
}
export default function (pi: ExtensionAPI) { createTriageUiProbe(pi); }
