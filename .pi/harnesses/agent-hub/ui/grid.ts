import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { compactWidgetsEnabled } from "../../lib/fleet-dashboard-ops.ts";

type RunStatus = "idle" | "running" | "done" | "error";
export interface GridAgentDef { name: string; description: string; thinking?: string; }
export interface GridAgentState { def: GridAgentDef; status: RunStatus; elapsed: number; contextPct: number; lastBackend?: "native" | "coms"; comsPeerModel?: string; }
export interface GridWidgetContext { ui: { setWidget(name: string, widget: unknown, options?: unknown): void } }

export interface GridUIContext {
	getWidgetContext(): GridWidgetContext | null | undefined;
	getViewMode(): "compact" | "off";
	getAgentStates(): Map<string, GridAgentState>;
	getMarkedAgent(): string | null;
	setMarkedAgent(value: string | null): void;
	isRunningWidgetInstalled(): boolean;
	markRunningWidgetInstalled(): void;
	displayName(name: string): string;
	shortModel(model: string | undefined): string;
	modelWithThinking(def: GridAgentDef): string;
	contextWarnThreshold: number;
}

function contextPressure(contextPct: number, deps: GridUIContext): boolean {
	return contextPct >= deps.contextWarnThreshold;
}

function contextLabel(contextPct: number, warn = false): string {
	return `${warn ? "⚠" : ""}${Math.ceil(contextPct)}%`;
}

function cardStatus(status: "idle" | "running" | "done" | "error", elapsed: number): { color: string; text: string } {
	const color = status === "idle" ? "dim"
		: status === "running" ? "accent"
		: status === "done" ? "success" : "error";
	const icon = status === "idle" ? "○"
		: status === "running" ? "●"
		: status === "done" ? "✓" : "✗";
	const time = status !== "idle" ? ` ${Math.round(elapsed / 1000)}s` : "";
	return { color, text: `${icon} ${status}${time}` };
}

// One-line agent summary for compact view: " Name   42%  gpt-5.5 (xh)  ● running 12s".
// nameWidth aligns the name column across the running set; the styled line is
// truncated to the widget width so ANSI runs never overflow. `model` already
// carries the thinking badge (modelWithThinking); pass "" to omit it.
function renderCompactLine(
	nameRaw: string,
	contextPct: number,
	model: string,
	status: { color: string; text: string },
	nameWidth: number,
	width: number,
	theme: any,
	marked = false,
	warnContext = false,
): string {
	const vis = visibleWidth(nameRaw);
	const name = vis >= nameWidth ? nameRaw : nameRaw + " ".repeat(nameWidth - vis);
	const ctx = contextLabel(contextPct, warnContext).padStart(4);
	// The marked row (compact-view switcher) gets a `›` lead + a full-width
	// selectedBg highlight, mirroring ZoomUI's selected-row treatment.
	const lead = marked ? theme.fg("accent", "›") : " ";
	const line = lead
		+ theme.fg("accent", theme.bold(name))
		+ "  " + theme.fg(warnContext ? "warning" : "dim", ctx)
		+ (model ? "  " + theme.fg("dim", model) : "")
		+ "  " + theme.fg(status.color, status.text);
	const truncated = truncateToWidth(line, width);
	if (!marked) return truncated;
	const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return theme.bg("selectedBg", truncated + pad);
}

export function createGridUI(deps: GridUIContext) {
	function updateWidget() {
		if (!deps.getWidgetContext()) return;
		installRunningWidget();

		deps.getWidgetContext()!.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(_width: number): string[] {
					// The full fleet list is now a separate overlay; this legacy widget is retired.
					return [];

				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// The compact running-agents widget, rendered BELOW the editor (between the
	// input box and the footer). Registered once; it re-renders on every frame
	// driven by updateWidget, reading live state + viewMode each time. In
	// dashboard mode it renders nothing. In compact mode it lists only *running*
	// team specialists, one line each — idle/done agents and research helpers are
	// omitted. Research helpers appear only in the Fleet Dashboard (Alt+A).
	// Ordered list of switchable subagents for the compact-view marker: running
	// team specialists. main is the session under the input box, so it is never
	// listed. Each entry's `key` matches /af-zoom resolution (lowercase persona
	// name), so Alt+\ can resolve it.
	function switchableAgents(): { key: string; name: string; ctx: number; ctxWarn: boolean; model: string; status: { color: string; text: string } }[] {
		return Array.from(deps.getAgentStates().values())
			.filter(a => a.status === "running")
			.map(a => ({
				key: a.def.name.toLowerCase(),
				name: deps.displayName(a.def.name),
				ctx: a.contextPct,
				ctxWarn: contextPressure(a.contextPct, deps),
				model: a.lastBackend === "coms" ? `⇄coms ${deps.shortModel(a.comsPeerModel)}` : deps.modelWithThinking(a.def),
				status: cardStatus(a.status, a.elapsed),
			}));
	}

	// Keep markedAgent pointing at a still-running entry: if the marked one is gone
	// (finished/killed), clamp to the nearest surviving entry, or null when empty.
	// Called from the cycle shortcuts and before a zoom.
	function clampMarker() {
		const keys = switchableAgents().map(a => a.key);
		if (keys.length === 0) { deps.setMarkedAgent(null); return; }
		if (deps.getMarkedAgent() && keys.includes(deps.getMarkedAgent()!)) return;
		deps.setMarkedAgent(keys[0]);
	}

	function installRunningWidget() {
		if (!deps.getWidgetContext() || deps.isRunningWidgetInstalled()) return;
		deps.markRunningWidgetInstalled();
		deps.getWidgetContext()!.ui.setWidget("agent-running", (_tui: any, theme: any) => ({
			invalidate() {},
			render(width: number): string[] {
				if (!compactWidgetsEnabled(deps.getViewMode())) return [];
				const running = switchableAgents();
				if (running.length === 0) return [];
				const nameWidth = Math.min(24, Math.max(...running.map(r => visibleWidth(r.name))));
				return running.map(r => renderCompactLine(r.name, r.ctx, r.model, r.status, nameWidth, width, theme, r.key === deps.getMarkedAgent(), r.ctxWarn));
			},
		}), { placement: "belowEditor" });
	}

	return { updateWidget, switchableAgents, clampMarker };
}
