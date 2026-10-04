import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** A stage producer under action confirmation may inspect and return evidence text.
 * The Hub persists its output as the plan/review artifact; no unbound child
 * shell or file write can stand in for an exact action-bound human grant.
 */
export function stageProducerTools(declared: string): string {
 return declared.split(",").map(tool => tool.trim()).filter(tool => ["read", "grep", "find", "ls"].includes(tool)).join(",");
}

export function stageProducerToolGate(tool: string): string | null {
 return ["read", "grep", "find", "ls"].includes(tool)
  ? null : "Unbound stage producer effect refused; use the Hub's exact action confirmation for effects.";
}

export default function stageGuard(pi: ExtensionAPI): void {
 pi.on("tool_call", event => {
  const reason = stageProducerToolGate(String(event.toolName));
  if (reason) return { block: true, reason };
 });
}
