import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerTaskTriageRecover(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-task-triage-recover", {
		description: "Recheck and persist the in-memory process union after a persistence failure (no effect or waiver)",
		handler: async (_args, ctx) => {
			const recovered = commandCtx.handleTaskTriageRecover();
			ctx.ui.notify(recovered ? "Process state restored with checked append/readback; open gates still apply." : "Recovery refused: persisted state differs, is corrupt, oversized or remains unwritable; effects stay blocked. Inspect or resume a valid session without editing JSONL.", recovered ? "info" : "error");
		},
	});
}
