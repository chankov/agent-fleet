import { Text } from "@mariozechner/pi-tui";

export interface GridWidgetContext { ui: { setWidget(name: string, widget: unknown, options?: unknown): void } }

export interface GridUIContext {
	getWidgetContext(): GridWidgetContext | null | undefined;
}

export function createGridUI(deps: GridUIContext) {
	function updateWidget() {
		if (!deps.getWidgetContext()) return;
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
