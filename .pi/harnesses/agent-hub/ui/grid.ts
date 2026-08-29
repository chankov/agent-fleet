import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { compactWidgetsEnabled, gridColumnsForItems, renderCardGrid } from "../../lib/fleet-dashboard-ops.ts";

type RunStatus = "idle" | "running" | "done" | "error";
export interface GridAgentDef { name: string; description: string; thinking?: string; }
export interface GridAgentState { def: GridAgentDef; status: RunStatus; elapsed: number; contextPct: number; lastBackend?: "native" | "coms"; comsPeerModel?: string; }
export interface GridResearchState { id: number; def: GridAgentDef; persona: boolean; status: RunStatus; elapsed: number; contextPct: number; model: string; turnCount: number; lastWork: string; task: string; }
export interface GridWidgetContext { ui: { setWidget(name: string, widget: unknown, options?: unknown): void } }

export interface GridUIContext {
	getWidgetContext(): GridWidgetContext | null | undefined;
	getViewMode(): "compact" | "off";
	getGridCols(): number;
	getAgentStates(): Map<string, GridAgentState>;
	getResearchStates(): Map<number, GridResearchState>;
	getMarkedAgent(): string | null;
	setMarkedAgent(value: string | null): void;
	isRunningWidgetInstalled(): boolean;
	markRunningWidgetInstalled(): void;
	displayName(name: string): string;
	resolvedModel(def: GridAgentDef): string | undefined;
	resolvedThinking(def: GridAgentDef): string | undefined;
	resolveThinkingLevel(raw?: string): string;
	abbrevThinking(level: string): string;
	contextWarnThreshold: number;
}

const CARD_HEIGHT = 4;

function truncateCardText(text: string, maxWidth: number): string {
	const width = Math.max(0, maxWidth);
	if (width === 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width <= 3) return ".".repeat(width);
	return `${truncateToWidth(text, width - 3)}...`;
}

function shortModel(model: string | undefined): string {
	return model ? model.split("/").pop()! : "default";
}

// A " (code)" thinking badge for display, or "" when the level is off.
function thinkingSuffix(rawThinking: string | undefined, deps: GridUIContext): string {
	const code = deps.abbrevThinking(deps.resolveThinkingLevel(rawThinking));
	return code ? ` (${code})` : "";
}

// The model + thinking badge a persona would dispatch with: "gpt-5.5 (xh)".
function modelWithThinking(def: GridAgentDef, deps: GridUIContext): string {
	return shortModel(deps.resolvedModel(def)) + thinkingSuffix(deps.resolvedThinking(def), deps);
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

function renderCardHeaderLine(
	nameRaw: string,
	contextPct: number,
	modelRaw: string,
	statusRaw: string,
	statusColor: string,
	w: number,
	theme: any,
	warnContext = false,
): string {
	const indent = w > 0 ? " " : "";
	const contentWidth = Math.max(0, w - visibleWidth(indent));
	if (contentWidth === 0) return "";

	const rightRaw = `${modelRaw} ${statusRaw}`;
	const rightWidth = visibleWidth(rightRaw);
	const renderRight = () => theme.fg("dim", `${modelRaw} `) + theme.fg(statusColor, statusRaw);

	if (rightWidth === contentWidth) return indent + renderRight();
	if (rightWidth > contentWidth) return indent + theme.fg("dim", truncateCardText(rightRaw, contentWidth));

	const leftBudget = Math.max(0, contentWidth - rightWidth - 1);
	const ctxRaw = contextLabel(contextPct, warnContext);
	const ctxWidth = visibleWidth(ctxRaw);
	let leftVisible = 0;
	let leftStyled = "";

	if (leftBudget >= ctxWidth) {
		const nameBudget = Math.max(0, leftBudget - ctxWidth - 1);
		const nameText = truncateCardText(nameRaw, nameBudget);
		const ctxStyle = warnContext ? "warning" : "dim";
		if (nameText) {
			leftStyled = theme.fg("accent", theme.bold(nameText)) + theme.fg(ctxStyle, ` ${ctxRaw}`);
			leftVisible = visibleWidth(`${nameText} ${ctxRaw}`);
		} else {
			leftStyled = theme.fg(ctxStyle, ctxRaw);
			leftVisible = ctxWidth;
		}
	} else {
		const ctxText = truncateCardText(ctxRaw, leftBudget);
		leftStyled = theme.fg(warnContext ? "warning" : "dim", ctxText);
		leftVisible = visibleWidth(ctxText);
	}

	const gap = " ".repeat(Math.max(1, contentWidth - leftVisible - rightWidth));
	return indent + leftStyled + gap + renderRight();
}

function renderWorkLine(workRaw: string, w: number, theme: any): string {
	const indent = w > 0 ? " " : "";
	const maxWorkWidth = Math.max(0, Math.min(50, w - visibleWidth(indent)));
	return indent + theme.fg("muted", truncateCardText(workRaw, maxWorkWidth));
}

function renderBorderedLine(content: string, w: number, theme: any): string {
	return theme.fg("dim", "│")
		+ content
		+ " ".repeat(Math.max(0, w - visibleWidth(content)))
		+ theme.fg("dim", "│");
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

// A research-helper card. Mirrors renderCard's compact two-line layout while
// keeping the `rN` handle + persona/anon label + turn in the name slot.
function renderResearchCard(state: GridResearchState, colWidth: number, theme: any, deps: GridUIContext): string[] {
	const w = Math.max(0, colWidth - 2);
	const status = cardStatus(state.status, state.elapsed);
	const label = state.persona ? deps.displayName(state.def.name) : "research";
	const turnStr = state.turnCount > 1 ? ` ·T${state.turnCount}` : "";
	const headerLine = renderCardHeaderLine(
		`r${state.id} ${label}${turnStr}`,
		state.contextPct,
		shortModel(state.model) + thinkingSuffix(deps.resolvedThinking(state.def), deps),
		status.text,
		status.color,
		w,
		theme,
	);
	const workRaw = state.lastWork || state.task || state.def.description;

	return [
		theme.fg("dim", "┌" + "─".repeat(Math.max(0, w)) + "┐"),
		renderBorderedLine(headerLine, w, theme),
		renderBorderedLine(renderWorkLine(workRaw, w, theme), w, theme),
		theme.fg("dim", "└" + "─".repeat(Math.max(0, w)) + "┘"),
	];
}


export function createGridUI(deps: GridUIContext) {
	function updateWidget() {
		if (!deps.getWidgetContext()) return;
		installRunningWidget();

		deps.getWidgetContext()!.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					// The full fleet list is now a separate overlay; this legacy widget is retired.
					return [];

				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// Research helpers render in their own widget row, labelled "research", below the
	// team grid. The widget is removed entirely when no helpers exist so it takes no
	// space on a fresh session.
	function updateResearchWidget() {
		if (!deps.getWidgetContext()) return;
		if (deps.getResearchStates().size === 0) {
			deps.getWidgetContext()!.ui.setWidget("agent-research", undefined);
			return;
		}
		deps.getWidgetContext()!.ui.setWidget("agent-research", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					const states = Array.from(deps.getResearchStates().values());
					if (states.length === 0) {
						text.setText("");
						return text.render(width);
					}

					// Compact mode hides the research grid; running helpers are folded
					// into the belowEditor "agent-running" widget instead.
					if (!compactWidgetsEnabled(deps.getViewMode())) return [];

					const cols = gridColumnsForItems(deps.getGridCols(), states.length);
					const gap = 1;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
					const labelText = "── research ";
					const header = theme.fg("dim", labelText + "─".repeat(Math.max(0, width - labelText.length)));
					const grid = renderCardGrid(
						states,
						cols,
						CARD_HEIGHT,
						s => renderResearchCard(s, colWidth, theme, deps),
						" ".repeat(gap),
						" ".repeat(Math.max(0, colWidth)),
					);
					text.setText([header, ...grid].join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// The compact running-agents widget, rendered BELOW the editor (between the
	// input box and the footer). Registered once; it re-renders on every frame
	// driven by the existing updateWidget/updateResearchWidget refreshes, reading
	// live state + viewMode each time. In dashboard mode it renders nothing. In
	// compact mode it lists only *running* team specialists and research helpers,
	// one line each — idle/done agents are omitted.
	// Ordered list of switchable subagents for the compact-view marker: running team
	// specialists then running research helpers. main is the session under the input
	// box, so it is never listed. Each entry's `key` matches /af-zoom resolution
	// (lowercase persona name for team, `rN` for research), so Alt+\ can resolve it.
	function switchableAgents(): { key: string; name: string; ctx: number; ctxWarn: boolean; model: string; status: { color: string; text: string } }[] {
		return [
			...Array.from(deps.getAgentStates().values())
				.filter(a => a.status === "running")
				.map(a => ({
					key: a.def.name.toLowerCase(),
					name: deps.displayName(a.def.name),
					ctx: a.contextPct,
					ctxWarn: contextPressure(a.contextPct, deps),
					model: a.lastBackend === "coms" ? `⇄coms ${shortModel(a.comsPeerModel)}` : modelWithThinking(a.def, deps),
					status: cardStatus(a.status, a.elapsed),
				})),
			...Array.from(deps.getResearchStates().values())
				.filter(s => s.status === "running")
				.map(s => ({
					key: `r${s.id}`,
					name: `r${s.id} ${s.persona ? deps.displayName(s.def.name) : "research"}`,
					ctx: s.contextPct,
					ctxWarn: false,
					model: shortModel(s.model) + thinkingSuffix(deps.resolvedThinking(s.def), deps),
					status: cardStatus(s.status, s.elapsed),
				})),
		];
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

	return { updateWidget, updateResearchWidget, switchableAgents, clampMarker };
}
