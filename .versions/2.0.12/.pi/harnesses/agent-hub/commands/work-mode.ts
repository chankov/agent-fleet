import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseWorkModeArgs } from "../work-mode-controls.ts";
import type { CommandContext } from "./context.ts";

export function registerWorkMode(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-work-mode", {
		description: "Show or set Fleet work mode (operator | orchestrator). Alt+M opens the picker.",
		handler: async (args, ctx) => {
			commandCtx.setWidgetContext(ctx);
			const parsed = parseWorkModeArgs(args);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			if (parsed.action === "apply") {
				await commandCtx.applyWorkModeSelection(parsed.workMode, ctx);
				return;
			}
			if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
				ctx.ui.notify(
					`${commandCtx.getWorkModeStatusText()}\nSwitch with /af-work-mode operator|orchestrator`,
					"info",
				);
				return;
			}
			await commandCtx.openWorkModePicker(ctx);
		},
	});
}
