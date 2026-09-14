import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const codingAgent = import.meta.resolve("@earendil-works/pi-coding-agent");
const tuiPackage = import.meta.resolve("@earendil-works/pi-tui");
registerHooks({ resolve(specifier, context, nextResolve) {
	if (specifier === "@mariozechner/pi-coding-agent") return { url: codingAgent, shortCircuit: true };
	if (specifier === "@mariozechner/pi-tui") return { url: tuiPackage, shortCircuit: true };
	return nextResolve(specifier, context);
} });
const { createGridUI } = await import("./grid.ts");
const { registerInputShortcuts } = await import("../input/shortcuts.ts");
const { matchesKey } = await import("@mariozechner/pi-tui");

const row = (status: "running" | "done" = "running") => ({ key: "builder", runToken: "builder:1", kind: "specialist" as const, name: "Builder", depth: 0, status, model: "m", backend: "native" as const, contextPct: 20, contextTokens: 1, elapsed: 1000, startedAt: 0, endedAt: status === "done" ? 1000 : undefined, timingKind: "run" as const, toolCount: 1, lastWork: "edit", hasTimeline: true, lastAtDepth: [] });
const plain = (text: string) => text;
const theme: any = { fg: (_: string, text: string) => text, bold: plain, bg: (_: string, text: string) => text, borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
const keybindings: any = { matches() { return false; } };

function harness(mode = "tui", rowsAt: (now: number) => any[] = () => [row()], handleIntent?: (intent: any) => void | Promise<void>) {
	let editorFactory: any, widgetFactory: any, setCount = 0, renders = 0, now = 2000, rowReads = 0, clockReads = 0;
	const timers = new Map<number, () => void>(); let timerId = 0;
	const ui = {
		setWidget(name: string, value: any) { if (name === "agent-running") { setCount++; widgetFactory = value; } },
		getEditorComponent: () => editorFactory,
		setEditorComponent: (value: any) => { editorFactory = value; },
	};
	const ctx: any = { mode, ui };
	const grid = createGridUI({ getWidgetContext: () => ctx, getRows: value => { rowReads++; return rowsAt(value); }, handleIntent, now: () => { clockReads++; return now; }, setTimeout: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id as any; }, clearTimeout: (id: any) => { timers.delete(id); } });
	grid.updateWidget();
	const tui: any = { terminal: { rows: 18 }, requestRender() { renders++; } };
	const widget = widgetFactory?.(tui, theme);
	const editor = editorFactory?.(tui, theme, keybindings);
	return { grid, ui, tui, widget, editor, timers, setCount: () => setCount, renders: () => renders, rowReads: () => rowReads, clockReads: () => clockReads, setNow: (value: number) => { now = value; }, recreate: () => ({ widget: widgetFactory?.(tui, theme), editor: editorFactory?.(tui, theme, keybindings) }) };
}

test("grid installs one below-editor widget and composes focused SDK editor without global input", () => {
	const h = harness();
	assert.equal(h.setCount(), 1);
	assert.ok(h.editor); h.editor.focused = true;
	assert.equal(h.widget.render(80).length, 1);
	h.grid.toggle();
	const expanded = h.widget.render(80);
	assert.ok(expanded.length <= 6);
	assert.equal(expanded.length, 4);
	assert.match(expanded[0], /select/);
	h.grid.updateWidget(); assert.equal(h.setCount(), 1, "refresh must not re-register");
});

test("plain and Alt arrows reach the editor exactly once in collapsed and expanded states while j/k navigate", () => {
	const h = harness("tui", () => [row(), { ...row(), key: "second", runToken: "second:1", name: "Second" }]); h.editor.focused = true;
	const arrows = ["\x1b[A", "\x1b[B", "\x1b[D", "\x1b[C", "\x1b[1;3A", "\x1b[1;3B", "\x1b[1;3D", "\x1b[1;3C"];
	const forwarded = new Map(arrows.map(value => [value, 0]));
	h.editor.onExtensionShortcut = (data: string) => { if (forwarded.has(data)) forwarded.set(data, forwarded.get(data)! + 1); return false; };
	for (const arrow of arrows) h.editor.handleInput(arrow);
	assert.deepEqual([...forwarded.values()], Array(arrows.length).fill(1));
	for (const arrow of arrows) {
		h.grid.toggle(); assert.ok(h.widget.render(80).length > 1);
		h.editor.handleInput(arrow); assert.equal(h.widget.render(80).length, 1);
	}
	assert.deepEqual([...forwarded.values()], Array(arrows.length).fill(2));
	h.grid.toggle(); h.editor.handleInput("j"); assert.match(h.widget.render(80).join("\n"), /❯.*Second/);
	h.editor.handleInput("k"); assert.match(h.widget.render(80).join("\n"), /❯.*Builder/);
});

test("production registrar callback toggles the production grid once and preserves Alt+A/M routing", () => {
	const h = harness(); h.editor.focused = true;
	const registrations = new Map<string, any>();
	const calls = { toggle: 0, dashboard: 0, mode: 0 };
	registerInputShortcuts({ registerShortcut: (key: string, spec: any) => registrations.set(key, spec) } as any, {
		setWidgetContext() {},
		openFleetDashboard: async () => { calls.dashboard++; },
		toggleFleetWidget: () => { calls.toggle++; h.grid.toggle(); },
		workModeStatusText: () => "mode",
		openWorkModePicker: async () => { calls.mode++; },
	});
	const ctx: any = { hasUI: true, ui: { select() {}, notify() {} } };
	h.editor.onExtensionShortcut = (data: string) => {
		for (const [key, spec] of registrations) if (matchesKey(data, key)) { spec.handler(ctx); return true; }
		return false;
	};
	h.editor.handleInput("\x1bi"); assert.equal(h.widget.render(80).length, 4); assert.equal(calls.toggle, 1);
	h.editor.handleInput("x"); assert.match(h.widget.render(80)[0]!, /press x again/);
	h.editor.handleInput("\x1bi"); assert.equal(h.widget.render(80).length, 1); assert.equal(calls.toggle, 2);
	h.editor.handleInput("\x1ba"); h.editor.handleInput("\x1bm");
	assert.deepEqual(calls, { toggle: 2, dashboard: 1, mode: 1 });
});

test("late host Alt+M/A callbacks forward exactly once collapsed and expanded", () => {
	const h = harness(); h.editor.focused = true; const counts = { m: 0, a: 0 };
	h.editor.onExtensionShortcut = (data: string) => {
		if (matchesKey(data, "alt+m")) { counts.m++; return true; }
		if (matchesKey(data, "alt+a")) { counts.a++; return true; }
		return false;
	};
	h.editor.handleInput("\x1bm"); h.editor.handleInput("\x1ba");
	h.grid.toggle(); assert.equal(h.widget.render(80).length, 4);
	h.editor.handleInput("\x1bm"); assert.equal(h.widget.render(80).length, 1, "foreign shortcut collapses widget before host view");
	h.grid.toggle(); h.editor.handleInput("\x1ba");
	assert.deepEqual(counts, { m: 2, a: 2 }); assert.equal(h.widget.render(80).length, 1);
});

test("RPC/headless mode renders noninteractive fallback and never installs editor wrapper", () => {
	const h = harness("rpc");
	assert.equal(h.editor, undefined);
	const lines = h.widget.render(100);
	assert.equal(lines.length, 1); assert.doesNotMatch(lines[0], /inspect/);
});

test("scheduler is bounded, survives retention after idle, and disposal cancels stale callbacks", () => {
	const h = harness(); h.widget.render(80);
	assert.equal(h.timers.size, 1);
	const callback = [...h.timers.values()][0]; h.timers.clear(); callback();
	assert.equal(h.timers.size, 1, "running work rearms exactly one scheduler");
	const before = h.renders(); h.grid.dispose();
	assert.equal(h.timers.size, 0);
	callback(); assert.equal(h.renders(), before, "disposed callback is passive");
});

test("retention scheduler expires the last completed run and idle refresh wakes for new activity", () => {
	let live = true;
	const h = harness("tui", now => live ? [row()] : [row("done")]); h.widget.render(80);
	live = false; h.setNow(10_999); h.grid.updateWidget();
	assert.equal(h.widget.render(80).length, 1, "terminal run is retained before deadline");
	h.setNow(11_000); const callback = [...h.timers.values()][0]; h.timers.clear(); callback();
	assert.deepEqual(h.widget.render(80), []); assert.equal(h.timers.size, 0, "idle scheduler stops after expiry");
	live = true; h.grid.updateWidget(); assert.equal(h.widget.render(80).length, 1, "event refresh wakes idle widget");
});

test("nested suspension is ref-counted and returns collapsed with confirmation cleared", async () => {
	const h = harness(); h.editor.focused = true; h.grid.toggle();
	let releaseOuter!: () => void, releaseInner!: () => void;
	const outer = h.grid.withSuspended(() => new Promise<void>(resolve => { releaseOuter = resolve; }));
	const inner = h.grid.withSuspended(() => new Promise<void>(resolve => { releaseInner = resolve; }));
	assert.equal(h.widget.render(80).length, 1);
	releaseInner(); await inner; assert.equal(h.widget.render(80).length, 1);
	releaseOuter(); await outer; assert.equal(h.widget.render(80).length, 1);
});

test("render is cache-only and focus, text, autocomplete, and zero-body gates hide expansion", async () => {
	const h = harness(); h.editor.focused = true; h.grid.toggle();
	const clocks = h.clockReads(), rows = h.rowReads(), timers = h.timers.size;
	assert.equal(h.widget.render(80).length, 4);
	assert.equal(h.clockReads(), clocks); assert.equal(h.rowReads(), rows); assert.equal(h.timers.size, timers, "render must not snapshot or arm timers");
	h.editor.focused = false; assert.equal(h.widget.render(80).length, 1);
	h.editor.focused = true; h.editor.setText("programmatic"); assert.equal(h.widget.render(80).length, 1);
	h.editor.setText(""); h.editor.isShowingAutocomplete = () => true; assert.equal(h.widget.render(80).length, 1);
	h.editor.isShowingAutocomplete = () => false; h.tui.terminal.rows = 8; h.grid.updateWidget(); assert.equal(h.widget.render(80).length, 1);
});

test("coms confirmation names abort semantics", () => {
	const peer = { ...row(), key: "peer:s1", runToken: "peer:s1:1", backend: "coms" as const, kind: "peer" as const };
	const h = harness("tui", () => [peer]); h.editor.focused = true;
	h.grid.toggle(); assert.equal(h.widget.render(80).length, 4);
	h.editor.handleInput("x"); assert.match(h.widget.render(80)[0]!, /abort request \(peer pane keeps running\)/);
});

test("deferred intent completion cannot mutate a successor context", async () => {
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	const h = harness("tui", () => [row()], () => pending);
	h.editor.focused = true; h.grid.toggle(); h.editor.handleInput("x"); h.editor.handleInput("x");
	h.grid.dispose(); h.grid.reset();
	const next = h.recreate(); next.editor.focused = true; h.grid.toggle(); next.editor.handleInput("x");
	assert.match(next.widget.render(80)[0]!, /press x again/);
	release(); await pending; await Promise.resolve();
	assert.match(next.widget.render(80)[0]!, /press x again/, "old finally must not clear successor confirmation");
});
