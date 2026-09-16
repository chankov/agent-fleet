import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { fleetStripTransition, initialFleetStripState, reconcileStripState, type FleetStripIntent, type FleetStripState } from "../../lib/fleet-strip-controller.ts";
import { selectWidgetRows, summariseWidget, type FleetRow } from "../../lib/fleet-read-model.ts";
import { renderFleetStrip, visibleWindow } from "../../lib/fleet-strip-view.ts";
import { installFleetEditor, type FleetEditorFactory, type FleetEditorWrapper } from "./fleet-editor.ts";
export interface GridWidgetContext {
	mode?: string;
	ui: {
		setWidget(name: string, widget: unknown, options?: unknown): void;
		getEditorText?(): string;
		getEditorComponent?(): FleetEditorFactory | undefined;
		setEditorComponent?(factory: FleetEditorFactory | undefined): void;
	};
}
export interface GridUIContext {
	getWidgetContext(): GridWidgetContext | null | undefined;
	getRows(now: number): FleetRow[];
	handleIntent?(intent: FleetStripIntent): void | Promise<void>;
	now?(): number;
	setTimeout?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimeout?(timer: ReturnType<typeof setTimeout>): void;
}

export function createGridUI(deps: GridUIContext) {
	const clock = deps.now ?? Date.now;
	const schedule = deps.setTimeout ?? setTimeout;
	const cancel = deps.clearTimeout ?? clearTimeout;
	let owner: GridWidgetContext | null = null, widgetInstalled = false, editorInstallation: ReturnType<typeof installFleetEditor> | undefined;
	let tui: any, state: FleetStripState = initialFleetStripState(), suspended = 0, timer: ReturnType<typeof setTimeout> | undefined, disposed = false, lastDisplayKey = "", lastRows: FleetRow[] = [], snapshotNow = 0, epoch = 0;

	const maxRows = () => Number.isFinite(tui?.terminal?.rows) ? Math.max(0, Math.floor(tui.terminal.rows / 3)) : 0;
	const bodyRows = () => Math.max(0, maxRows() - 3);
	function editorGate() {
		const editor = currentEditor();
		const compatible = !!editor && typeof editor.isShowingAutocomplete === "function" && typeof editor.focused === "boolean";
		return { compatible, open: compatible && suspended === 0 && editor.focused === true && editor.getText() === "" && !editor.isShowingAutocomplete() };
	}
	function snapshot(now: number) {
		snapshotNow = now;
		if (state.confirmation && state.confirmation.until <= now) state = { ...state, confirmation: null };
		const gate = editorGate();
		if (!gate.open && (state.active || state.confirmation)) state = { ...state, active: false, confirmation: null };
		const all = deps.getRows(now);
		const selected = all.find(row => row.key === state.selectedKey);
		const pin = state.active && selected ? { key: selected.key, runToken: selected.runToken } : undefined;
		lastRows = selectWidgetRows(all, now, pin);
		state = reconcileStripState(state, lastRows, bodyRows());
		return lastRows;
	}
	function needsTimer(rows: readonly FleetRow[], now: number): boolean {
		return state.active || !!state.confirmation || rows.some(row => row.status === "running" || ((row.status === "done" || row.status === "error") && row.endedAt != null && now < row.endedAt + 10_000));
	}
	function arm() {
		if (timer || disposed) return;
		const now = clock(), rows = snapshot(now);
		if (!needsTimer(rows, now)) return;
		timer = schedule(() => { timer = undefined; const before = lastDisplayKey; refresh(false); if (before !== lastDisplayKey) tui?.requestRender?.(); arm(); }, 500);
	}
	function displayKey(rows: readonly FleetRow[], now: number): string {
		return JSON.stringify([Math.floor(now / 1000), rows.map(row => [row.key, row.runToken, row.status, Math.floor(row.elapsed / 1000), row.lastWork]), state, maxRows(), tui?.terminal?.columns ?? null, suspended, editorGate().open]);
	}
	function refresh(request = true) {
		if (disposed) return;
		install();
		const now = clock(), rows = snapshot(now), next = displayKey(rows, now), changed = next !== lastDisplayKey;
		lastDisplayKey = next;
		if (request && changed) tui?.requestRender?.();
		arm();
	}
	function input(data: string, meta: { paste: boolean; keyRelease: boolean }): boolean {
		// The production registrar owns Alt+I. Passing it to the host callback avoids
		// collapsing here and reopening when that callback invokes toggle().
		if (!meta.paste && !meta.keyRelease && matchesKey(data, "alt+i")) return false;
		const now = clock(), rows = snapshot(now), editor = currentEditor(), gate = editorGate();
		const normalized = meta.paste || meta.keyRelease ? data
			: matchesKey(data, Key.enter) ? "\r"
			: data === "\u001b" ? "\u001b"
			: data;
		const transition = fleetStripTransition({ data: normalized, paste: meta.paste, keyRelease: meta.keyRelease }, state, rows, {
			interactiveAvailable: gate.compatible && suspended === 0,
			focused: gate.compatible && editor?.focused === true,
			editorEmpty: editor?.getText?.() === "",
			autocomplete: gate.compatible ? editor!.isShowingAutocomplete() : true,
			modal: suspended > 0,
			bodyRows: bodyRows(),
		}, now);
		state = transition.state;
		if (transition.intent) {
			const intentEpoch = epoch;
			void Promise.resolve(deps.handleIntent?.(transition.intent)).finally(() => {
				if (disposed || epoch !== intentEpoch) return;
				state = { ...state, pendingAction: false, active: false, confirmation: null }; refresh();
			});
		}
		refresh();
		return transition.consume;
	}
	function currentEditor(): FleetEditorWrapper | undefined { return editorInstallation?.current(); }
	function installEditor(ctx: GridWidgetContext) {
		if (ctx.mode !== "tui" || !ctx.ui.getEditorComponent || !ctx.ui.setEditorComponent) return;
		editorInstallation = installFleetEditor(ctx.ui as any, (editorTui, theme, keybindings) => new CustomEditor(editorTui, theme, keybindings) as any, isKeyRelease, input);
	}
	function install() {
		const ctx = deps.getWidgetContext() ?? null;
		if (!ctx || disposed) return;
		if (owner !== ctx) { disposeOwned(); owner = ctx; widgetInstalled = false; installEditor(ctx); }
		if (widgetInstalled) return;
		widgetInstalled = true;
		ctx.ui.setWidget("agent-running", (widgetTui: any, theme: any) => {
			tui = widgetTui;
			refresh(false);
			return { invalidate() { lastDisplayKey = ""; refresh(); }, render(width: number): string[] {
				const body = bodyRows(), window = visibleWindow(lastRows, state.index, state.offset, body), gate = editorGate();
				const selected = lastRows.find(row => row.key === state.confirmation?.key && row.runToken === state.confirmation?.runToken);
				const action = state.confirmation?.action;
				const confirmation = state.confirmation && state.confirmation.until > snapshotNow
					? selected?.backend === "coms" && action === "kill" ? "press x again to abort request (peer pane keeps running)" : `press ${action === "kill" ? "x" : "r"} again to ${action}`
					: undefined;
				return renderFleetStrip({ active: state.active && gate.open, interactiveAvailable: gate.compatible && suspended === 0, selectedKey: state.selectedKey, summary: summariseWidget(lastRows), window, maxRows: maxRows(), confirmation: gate.open ? confirmation : undefined }, width, theme, { visibleWidth, truncateToWidth });
			} };
		}, { placement: "belowEditor" });
	}
	function toggle() {
		if (disposed) return;
		install();
		const now = clock(), rows = snapshot(now), editor = currentEditor(), gate = editorGate();
		const transition = fleetStripTransition({ data: "toggle" }, state, rows, {
			interactiveAvailable: gate.compatible && suspended === 0,
			focused: gate.compatible && editor?.focused === true,
			editorEmpty: editor?.getText?.() === "",
			autocomplete: gate.compatible ? editor!.isShowingAutocomplete() : true,
			modal: suspended > 0,
			bodyRows: bodyRows(),
		}, now);
		state = transition.state;
		refresh();
	}
	function disposeOwned() {
		epoch++;
		if (!owner) return;
		if (timer) { cancel(timer); timer = undefined; }
		try { owner.ui.setWidget("agent-running", undefined); } catch {}
		editorInstallation?.dispose(); editorInstallation = undefined; widgetInstalled = false; tui = undefined;
		state = initialFleetStripState(); lastRows = []; lastDisplayKey = "";
	}
	function reset() { disposeOwned(); owner = null; disposed = false; install(); }
	function dispose() { disposed = true; disposeOwned(); owner = null; }
	async function withSuspended<T>(work: () => Promise<T>): Promise<T> {
		suspended++; state = { ...state, active: false, confirmation: null }; refresh();
		try { return await work(); } finally { suspended = Math.max(0, suspended - 1); state = { ...state, active: false, confirmation: null }; refresh(); }
	}
	return { updateWidget: refresh, toggle, reset, dispose, withSuspended };
}
