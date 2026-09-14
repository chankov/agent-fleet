import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { installFleetEditor } from "../ui/fleet-editor.ts";

const codingAgent = import.meta.resolve("@earendil-works/pi-coding-agent");
registerHooks({ resolve(specifier, context, nextResolve) {
	if (specifier === "@mariozechner/pi-coding-agent") return { url: codingAgent, shortCircuit: true };
	return nextResolve(specifier, context);
} });
const { registerInputShortcuts } = await import("./shortcuts.ts");

const plain = (text: string) => text;
const tui: any = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
const theme: any = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
const keybindings: any = { matches() { return false; } };

test("registered Alt+I/M/A dispatch exactly once through the composed editor host callback", () => {
	const shortcuts = new Map<string, any>();
	const pi: any = { registerShortcut(key: string, value: any) { shortcuts.set(key, value); } };
	const opened = { mode: 0, dashboard: 0, toggle: 0, context: 0 }; const ctx: any = { hasUI: true, ui: { select() {}, notify() {} } };
	registerInputShortcuts(pi, { setWidgetContext() { opened.context++; }, toggleFleetWidget: () => { opened.toggle++; }, workModeStatusText: () => "mode", openWorkModePicker: async () => { opened.mode++; }, openFleetDashboard: async () => { opened.dashboard++; } });
	let factory: any;
	const host = { getEditorComponent: () => factory, setEditorComponent: (value: any) => { factory = value; } };
	const installation = installFleetEditor(host, (et, th, kb) => new CustomEditor(et, th, kb) as any, isKeyRelease, () => false);
	const editor: any = factory(tui, theme, keybindings);
	Object.defineProperty(editor, "onExtensionShortcut", { configurable: true, writable: true, value(data: string) {
		for (const [key, registration] of shortcuts) if (matchesKey(data, key as any)) { registration.handler(ctx); return true; }
		return false;
	} });
	assert.deepEqual([...shortcuts.keys()], ["alt+a", "alt+m", "alt+i"]);
	for (const input of ["\x1bm", "\x1ba", "\x1bi", "\x1bm", "\x1ba", "\x1bi"]) editor.handleInput(input);
	assert.deepEqual(opened, { mode: 2, dashboard: 2, toggle: 2, context: 6 });
	installation.dispose();
});
