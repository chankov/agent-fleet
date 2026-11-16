export interface FleetEditorLike {
	getText(): string; setText(text: string): void; handleInput(data: string): void; render(width: number): string[]; invalidate(): void;
	focused?: boolean; wantsKeyRelease?: boolean; isShowingAutocomplete?(): boolean; dispose?(): void;
	[key: string]: any;
}
export type FleetEditorFactory = (tui: any, theme: any, keybindings: any) => FleetEditorLike;
export type FleetEditorWrapper = FleetEditorLike;
export interface FleetEditorUi {
	getEditorComponent(): FleetEditorFactory | undefined;
	setEditorComponent(factory: FleetEditorFactory | undefined): void;
}

/** Public-contract-only editor composition that preserves the actual editor object and receiver. */
export function installFleetEditor(ui: FleetEditorUi, createDefault: FleetEditorFactory, keyRelease: (data: string) => boolean, input: (data: string, meta: { paste: boolean; keyRelease: boolean }) => boolean) {
	const previous = ui.getEditorComponent();
	let current: FleetEditorLike | undefined, passive = false;
	const factory: FleetEditorFactory = (tui, theme, keybindings) => {
		const editor = previous ? previous.call(undefined, tui, theme, keybindings) : createDefault(tui, theme, keybindings);
		const supported = editor && typeof editor.handleInput === "function" && typeof editor.getText === "function" && typeof editor.render === "function" && typeof editor.invalidate === "function" && typeof editor.isShowingAutocomplete === "function" && typeof editor.focused === "boolean";
		if (!supported) { current = undefined; return editor; }
		const baseHandleInput = editor.handleInput;
		let pasteDepth = 0;
		editor.handleInput = function(data: string) {
			const starts = data.includes("\x1b[200~"), ends = data.includes("\x1b[201~");
			if (starts) pasteDepth++;
			const consumed = !passive && input(data, { paste: pasteDepth > 0, keyRelease: keyRelease(data) });
			if (!consumed) baseHandleInput.call(editor, data);
			if (ends) pasteDepth = Math.max(0, pasteDepth - 1);
		};
		current = editor;
		return editor;
	};
	ui.setEditorComponent(factory);
	return {
		factory,
		current: () => current,
		interactiveAvailable: () => !!current,
		dispose() {
			passive = true;
			if (ui.getEditorComponent() === factory) ui.setEditorComponent(previous);
			current = undefined;
		},
	};
}
