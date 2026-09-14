import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { installFleetEditor, type FleetEditorFactory } from "./fleet-editor.ts";

const plain = (text: string) => text;
const tui: any = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
const theme: any = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
const keybindings: any = { matches() { return false; } };
function ui(previous?: FleetEditorFactory) {
	let factory = previous;
	return { getEditorComponent: () => factory, setEditorComponent: (next: FleetEditorFactory | undefined) => { factory = next; } };
}
const defaultEditor = (editorTui: any, editorTheme: any, bindings: any) => new CustomEditor(editorTui, editorTheme, bindings) as any;

test("actual installed SDK default CustomEditor proves focus, autocomplete and arrow pass-through", async () => {
	const host = ui(); let calls = 0;
	let installation: ReturnType<typeof installFleetEditor>;
	installation = installFleetEditor(host, defaultEditor, isKeyRelease, (data) => {
		calls++;
		const editor = installation.current()!;
		return data === "\x1b[B" && editor.focused === true && editor.getText() === "" && !editor.isShowingAutocomplete();
	});
	const editor = host.getEditorComponent()!(tui, theme, keybindings);
	assert.equal(editor instanceof CustomEditor, true, "composition must preserve public SDK identity");
	editor.focused = true;
	editor.setAutocompleteProvider({ triggerCharacters: ["/"], async getSuggestions() { return { items: [{ value: "/abc", label: "/abc" }], prefix: "/" }; }, applyCompletion(lines: string[], cursorLine: number, cursorCol: number) { return { lines, cursorLine, cursorCol }; } });
	editor.handleInput("/"); await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(editor.isShowingAutocomplete(), true);
	const beforeArrow = calls;
	// Public runtime reports the menu; the wrapper must not consume its arrow.
	editor.handleInput("\x1b[B");
	assert.equal(calls, beforeArrow + 1);
	assert.equal(editor.isShowingAutocomplete(), true, "the installed editor retains autocomplete ownership");
	installation.dispose(); assert.equal(host.getEditorComponent(), undefined);
});

test("late assigned and defineProperty shortcut callbacks execute exactly once on the actual editor", () => {
	const host = ui(); const installation = installFleetEditor(host, defaultEditor, isKeyRelease, () => false);
	const editor = host.getEditorComponent()!(tui, theme, keybindings); let altM = 0, altA = 0;
	editor.onExtensionShortcut = (data: string) => { if (matchesKey(data, "alt+m")) { altM++; return true; } return false; };
	editor.handleInput("\x1bm");
	Object.defineProperty(editor, "onExtensionShortcut", { configurable: true, writable: true, value: (data: string) => { if (matchesKey(data, "alt+a")) { altA++; return true; } return false; } });
	editor.handleInput("\x1ba");
	assert.deepEqual({ altM, altA }, { altM: 1, altA: 1 });
	installation.dispose();
});

test("preinstalled CustomEditor preserves identity, late host callback, and original receiver", () => {
	let previousEditor: any;
	const previous: FleetEditorFactory = (...args) => (previousEditor = defaultEditor(...args));
	const host = ui(previous); const installation = installFleetEditor(host, defaultEditor, isKeyRelease, () => false);
	const editor = host.getEditorComponent()!(tui, theme, keybindings); let calls = 0;
	assert.equal(editor, previousEditor); assert.equal(editor instanceof CustomEditor, true);
	Object.defineProperty(editor, "onExtensionShortcut", { configurable: true, writable: true, value: (data: string) => { if (matchesKey(data, "alt+m")) { calls++; return true; } return false; } });
	editor.handleInput("\x1bm"); assert.equal(calls, 1);
	installation.dispose(); assert.equal(host.getEditorComponent(), previous);
});

test("previous custom editor is composed with correct receivers and full callback/method forwarding", () => {
	const receivers: string[] = [];
	const previous: FleetEditorFactory = () => ({
		text: "", focused: true, wantsKeyRelease: true,
		getText() { receivers.push(this === inner ? "get" : "bad"); return this.text; },
		setText(text: string) { receivers.push(this === inner ? "set" : "bad"); this.text = text; },
		handleInput(data: string) { receivers.push(this === inner ? "input" : "bad"); this.text += data; },
		render() { receivers.push(this === inner ? "render" : "bad"); return [this.text]; },
		invalidate() { receivers.push(this === inner ? "invalidate" : "bad"); },
		isShowingAutocomplete() { receivers.push(this === inner ? "autocomplete" : "bad"); return false; },
		insertTextAtCursor(text: string) { receivers.push(this === inner ? "insert" : "bad"); this.text += text; },
		getExpandedText() { receivers.push(this === inner ? "expanded" : "bad"); return this.text; },
	});
	let inner: any;
	const wrappedPrevious: FleetEditorFactory = (...args) => (inner = previous(...args));
	const host = ui(wrappedPrevious);
	const installation = installFleetEditor(host, defaultEditor, isKeyRelease, () => false);
	const editor = host.getEditorComponent()!(tui, theme, keybindings);
	const submit = () => {};
	editor.onSubmit = submit; assert.equal(inner.onSubmit, submit);
	editor.setText("a"); editor.handleInput("b"); editor.insertTextAtCursor("c"); editor.getExpandedText(); editor.isShowingAutocomplete(); editor.render(20); editor.invalidate();
	assert.equal(editor.getText(), "abc"); assert.ok(receivers.every(value => value !== "bad"));
	assert.equal(editor.wantsKeyRelease, true);
	installation.dispose(); assert.equal(host.getEditorComponent(), wrappedPrevious);
});

test("split bracketed paste and key releases pass through exactly once without widget actions", () => {
	const host = ui(); const seen: Array<{ data: string; paste: boolean; release: boolean }> = [];
	const installation = installFleetEditor(host, defaultEditor, () => false, (data, meta) => { seen.push({ data, paste: meta.paste, release: meta.keyRelease }); return false; });
	const editor = host.getEditorComponent()!(tui, theme, keybindings); editor.focused = true;
	for (const chunk of ["\x1b[200~", "x", "r", "j", "\x1b[201~"]) editor.handleInput(chunk);
	assert.deepEqual(seen.map(item => item.paste), [true, true, true, true, true]);
	assert.equal(editor.getText().includes("x"), true);
	installation.dispose();
});

test("unsupported editors fail closed and later foreign factories are not overwritten", () => {
	const unsupported: FleetEditorFactory = () => ({ getText: () => "", setText() {}, handleInput() {}, render: () => [], invalidate() {} });
	const host = ui(unsupported); let intercepted = 0;
	const installation = installFleetEditor(host, defaultEditor, isKeyRelease, () => { intercepted++; return true; });
	const editor = host.getEditorComponent()!(tui, theme, keybindings);
	editor.handleInput("x"); assert.equal(intercepted, 0); assert.equal(installation.interactiveAvailable(), false);
	const foreign: FleetEditorFactory = () => editor; host.setEditorComponent(foreign);
	installation.dispose(); assert.equal(host.getEditorComponent(), foreign);
});
