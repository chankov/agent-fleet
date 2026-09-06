import { Text } from "@mariozechner/pi-tui";
import { renderRunningStrip, type RunningStripItem } from "./running-strip.ts";

export interface GridWidgetContext { ui: { setWidget(name: string, widget: unknown, options?: unknown): void } }

export interface GridUIContext {
	getWidgetContext(): GridWidgetContext | null | undefined;
	getRunningItems(): RunningStripItem[];
}

export function createGridUI(deps: GridUIContext) {
	let runningWidgetInstalled = false;

	function installRunningWidget() {
		if (!deps.getWidgetContext() || runningWidgetInstalled) return;
		runningWidgetInstalled = true;
		deps.getWidgetContext()!.ui.setWidget("agent-running", (_tui: any, theme: any) => ({
			invalidate() {},
			render(width: number): string[] {
				return renderRunningStrip(deps.getRunningItems(), width, theme);
			},
		}), { placement: "belowEditor" });
	}

	function updateWidget() {
		if (!deps.getWidgetContext()) return;
		installRunningWidget();
		deps.getWidgetContext()!.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);
			return {
				render(_width: number): string[] {
					return [];
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	return { updateWidget };
}
