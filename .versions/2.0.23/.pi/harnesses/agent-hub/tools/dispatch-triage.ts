import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TriageInput } from "../dispatch-triage-contract.ts";
import type { createTriageRuntime } from "../dispatch-triage-runtime.ts";
export function registerDispatchTriage(pi: ExtensionAPI, deps: { runtime(): ReturnType<typeof createTriageRuntime> | null; input(task: string, scope: string[], language: string, domain: string): TriageInput; blocked(): unknown }) {
 pi.registerTool({
  name: "dispatch_triage", label: "Dispatch triage",
  description: "Optional System 1 advice before dispatch_agent: eligible persona or abstention, uncertainty and additive security/destructive signals. Never starts an agent, grants permission, reduces gates or changes budgets. Send only minimal non-secret task context; no credentials or file contents. Off unless human-configured. Not mandatory before dispatch.",
  parameters: Type.Object({ task: Type.String({ description: "Minimal non-secret task description, not a transcript" }), scope: Type.Array(Type.String()), language: Type.String({ description: "Task language, e.g. bg or en" }), domain: Type.String({ description: "Domain covered by the approved calibration profile" }) }),
  async execute(_id, params, signal) {
   const blocked = deps.blocked();
   const result = blocked ?? await deps.runtime()?.evaluate(deps.input(params.task,params.scope,params.language,params.domain),signal) ?? { status: "skipped", reason: "consumer_off" };
   return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
  },
 });
}
