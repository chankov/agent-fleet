import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface ShortcutPorts {
	setWidgetContext(ctx: ExtensionContext): void;
	openFleetDashboard(ctx: ExtensionContext): Promise<void>;
	workModeStatusText(): string;
	openWorkModePicker(ctx: ExtensionContext): Promise<void>;
}

export function registerInputShortcuts(pi: ExtensionAPI, ports: ShortcutPorts): void {
	const withContext = (ctx: ExtensionContext) => ports.setWidgetContext(ctx);
	pi.registerShortcut("alt+a", { description: "Open Fleet Dashboard", handler: ctx => { withContext(ctx); void ports.openFleetDashboard(ctx); } });
	pi.registerShortcut("alt+m", { description: "Open work mode picker", handler: ctx => {
		withContext(ctx);
		if (!ctx.hasUI || typeof ctx.ui.select !== "function") { ctx.ui.notify(`${ports.workModeStatusText()}\nSwitch with /af-work-mode operator|orchestrator`, "info"); return; }
		void ports.openWorkModePicker(ctx);
	} });
}
