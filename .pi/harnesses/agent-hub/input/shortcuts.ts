import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface ShortcutPorts {
	setWidgetContext(ctx: ExtensionContext): void;
	openFleetDashboard(ctx: ExtensionContext): Promise<void>;
	toggleFleetWidget(ctx: ExtensionContext): void;
	openFleetConfig(ctx: ExtensionContext): Promise<void>;
}

export function registerInputShortcuts(pi: ExtensionAPI, ports: ShortcutPorts): void {
	const withContext = (ctx: ExtensionContext) => ports.setWidgetContext(ctx);
	pi.registerShortcut("alt+a", { description: "Open Fleet Dashboard", handler: ctx => { withContext(ctx); void ports.openFleetDashboard(ctx); } });
	pi.registerShortcut("alt+i", { description: "Toggle Fleet widget", handler: ctx => { withContext(ctx); ports.toggleFleetWidget(ctx); } });
	// Headless sessions degrade inside openFleetConfig (notify with the Overview text).
	pi.registerShortcut("alt+,", { description: "Open Fleet config screen (read-only)", handler: ctx => { withContext(ctx); void ports.openFleetConfig(ctx); } });
}
