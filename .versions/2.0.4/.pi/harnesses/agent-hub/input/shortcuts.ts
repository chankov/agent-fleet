import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface ShortcutPorts {
	setWidgetContext(ctx: ExtensionContext): void;
	openFleetDashboard(ctx: ExtensionContext): Promise<void>;
	workModeStatusText(): string;
	openWorkModePicker(ctx: ExtensionContext): Promise<void>;
	isCompact(): boolean;
	toggleCompact(): string;
	refreshWidgets(): void;
	getSwitchableKeys(): string[];
	getMarkedAgent(): string | null;
	setMarkedAgent(key: string | null): void;
	clampMarker(): void;
	openMarkedAgent(ctx: ExtensionContext, key: string): Promise<boolean>;
}

export function registerInputShortcuts(pi: ExtensionAPI, ports: ShortcutPorts): void {
	const withContext = (ctx: ExtensionContext) => ports.setWidgetContext(ctx);
	const cycleMarker = (delta: number, ctx: ExtensionContext) => {
		withContext(ctx);
		if (!ports.isCompact()) { ctx.ui.notify("Agent switching is a compact-view feature — press Alt+A first", "info"); return; }
		const keys = ports.getSwitchableKeys();
		if (keys.length === 0) { ctx.ui.notify("No running subagents to switch between", "info"); return; }
		const current = ports.getMarkedAgent();
		const index = current ? keys.indexOf(current) : -1;
		ports.setMarkedAgent(index === -1 ? (delta > 0 ? keys[0] : keys[keys.length - 1]) : keys[(index + delta + keys.length) % keys.length]);
		ports.refreshWidgets();
	};
	pi.registerShortcut("alt+a", { description: "Open Fleet Dashboard", handler: ctx => { withContext(ctx); void ports.openFleetDashboard(ctx); } });
	pi.registerShortcut("alt+m", { description: "Open work mode picker", handler: ctx => {
		withContext(ctx);
		if (!ctx.hasUI || typeof ctx.ui.select !== "function") { ctx.ui.notify(`${ports.workModeStatusText()}\nSwitch with /af-work-mode operator|orchestrator`, "info"); return; }
		void ports.openWorkModePicker(ctx);
	} });
	pi.registerShortcut("alt+shift+a", { description: "Toggle compact agent widget", handler: ctx => { withContext(ctx); const mode = ports.toggleCompact(); ports.refreshWidgets(); ctx.ui.notify(`Compact agent widget: ${mode}`, "info"); } });
	pi.registerShortcut("alt+]", { description: "Compact view: mark next subagent", handler: ctx => cycleMarker(1, ctx) });
	pi.registerShortcut("alt+[", { description: "Compact view: mark previous subagent", handler: ctx => cycleMarker(-1, ctx) });
	pi.registerShortcut("alt+\\", { description: "Compact view: zoom the marked subagent", handler: async ctx => {
		withContext(ctx);
		if (!ports.isCompact()) { ctx.ui.notify("Agent zoom from the marker is a compact-view feature — press Alt+A first", "info"); return; }
		ports.clampMarker();
		const marked = ports.getMarkedAgent();
		if (!marked) { ctx.ui.notify("No running subagent marked to zoom", "info"); return; }
		if (!await ports.openMarkedAgent(ctx, marked)) ctx.ui.notify(`Marked agent ${marked} is no longer available`, "warning");
	} });
}
