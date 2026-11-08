import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KEYS } from "./transition.ts";

// pi aliases @mariozechner/* onto the installed @earendil-works/* packages at runtime; tests remap the same way.
const aliases: Record<string, string> = { "@mariozechner/pi-coding-agent": import.meta.resolve("@earendil-works/pi-coding-agent"), "@mariozechner/pi-tui": import.meta.resolve("@earendil-works/pi-tui") };
registerHooks({ resolve(specifier, context, nextResolve) { return aliases[specifier] ? { url: aliases[specifier], shortCircuit: true } : nextResolve(specifier, context); } });
const { createFleetConfigUi, fileViewerLines, renderFileViewer, toTransitionInput } = await import("./ui.ts");

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("registration contract: Hub and coms peer both register /af-config and Alt+, through the shared lib", () => {
	const hubCommand = read("../../agent-hub/commands/config.ts");
	assert.equal((hubCommand.match(/registerCommand\("af-config"/g) ?? []).length, 1);
	assert.match(hubCommand, /export function registerConfig\(pi: ExtensionAPI, commandCtx: CommandContext\)/);
	const hubShortcuts = read("../../agent-hub/input/shortcuts.ts");
	assert.equal((hubShortcuts.match(/registerShortcut\("alt\+,"/g) ?? []).length, 1);
	const hubRoot = read("../../agent-hub/index.ts");
	assert.match(hubRoot, /createFleetConfigUi\(\{/); assert.match(hubRoot, /fleetConfigUi\.recordBaseline\(_ctx\.cwd\)/); assert.match(hubRoot, /registerConfig\(pi, commandCtx\);/);
	const peer = read("../../coms/index.ts");
	assert.equal((peer.match(/registerCommand\("af-config"/g) ?? []).length, 1);
	assert.equal((peer.match(/registerShortcut\("alt\+,"/g) ?? []).length, 1);
	assert.match(peer, /createFleetConfigUi\(\{ livePeerNames/); assert.match(peer, /fleetConfigUi\.recordBaseline\(ctx\.cwd\)/);
	assert.doesNotMatch(peer, /readHubOverrides/, "a peer shows overrides sections only; effective Hub values belong to the Hub");
	for (const file of ["./snapshot.ts", "./view.ts", "./transition.ts", "./ui.ts"]) {
		const source = read(file);
		assert.doesNotMatch(source, /writeFileSync|appendFileSync|renameSync|unlinkSync|mkdirSync|spawn|exec/, `${file} must not write or run anything in phase 1`);
	}
});

test("headless sessions get the Overview as notify text; unknown tabs are reported", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-config-ui-"));
	mkdirSync(join(root, ".ai"), { recursive: true });
	writeFileSync(join(root, ".ai", "agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "default", features: {} }));
	try {
		const ui = createFleetConfigUi({ runtimeRows: () => [{ label: "Work mode", detail: "operator" }] });
		const notices: Array<[string, string | undefined]> = [];
		const ctx = { cwd: root, hasUI: false, ui: { notify: (message: string, level?: string) => { notices.push([message, level]); }, custom: undefined as any } };
		await ui.open(ctx as any);
		assert.equal(notices.length, 1); assert.match(notices[0][0], /^Fleet config · Overview/); assert.match(notices[0][0], /Installation: missing/);
		await ui.open(ctx as any, "runtime");
		assert.match(notices[1][0], /Work mode: operator/);
		await ui.open(ctx as any, "nope");
		assert.match(notices[2][0], /Unknown \/af-config tab "nope"/);
		ui.recordBaseline(root);
		writeFileSync(join(root, ".ai", "agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "full", features: {} }));
		assert.deepEqual(ui.collect(root).changedSinceStart, ["desired"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the file viewer is read-only, numbers lines, sanitizes content and maps pi keys", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-config-viewer-"));
	try {
		writeFileSync(join(root, "a.md"), "one\n\u001b[31mtwo\u001b[0m\nthree");
		const lines = fileViewerLines(root, "a.md");
		assert.deepEqual(lines, ["   1 │ one", "   2 │ two", "   3 │ three"]);
		assert.deepEqual(fileViewerLines(root, "missing.md"), ["(cannot read missing.md: ENOENT)"]);
		const theme = { bold: (text: string) => text, fg: (_: string, text: string) => text };
		const rendered = renderFileViewer("a.md", lines, 1, 80, 2, theme);
		assert.equal(rendered.length, 4); assert.match(rendered[0], /read-only/); assert.equal(rendered[1], "   2 │ two"); assert.match(rendered[3], /3\/3 lines/);
		assert.equal(toTransitionInput("\u001b[A"), KEYS.up); assert.equal(toTransitionInput("\u001b[Z"), KEYS.shiftTab); assert.equal(toTransitionInput("\t"), KEYS.tab); assert.equal(toTransitionInput("q"), "q");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
