import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

/** Human-only, failure-ID-bound one-shot authorization. Never executes work. */
export function registerRetry(pi: ExtensionAPI, commandCtx: CommandContext): void {
 pi.registerCommand("af-retry", {
  description: "Authorize one retry after operator cancellation only; no budget renewal or automatic dispatch.",
  handler: async (args, ctx) => commandCtx.handleRetry(args, ctx),
 });
}
