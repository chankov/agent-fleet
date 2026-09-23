/**
 * Proves the opt-in C4 entry wires the real below-chat widget and Fleet overlays.
 * Not part of `npm test`. Does not edit workspace config.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { C4_PI_ARGS } from "./system1-c4-pi-ui-state.ts";

const codingAgent = import.meta.resolve("@earendil-works/pi-coding-agent");
const tuiPackage = import.meta.resolve("@earendil-works/pi-tui");
registerHooks({ resolve(specifier, context, nextResolve) {
	if (specifier === "@mariozechner/pi-coding-agent") return { url: codingAgent, shortCircuit: true };
	if (specifier === "@mariozechner/pi-tui") return { url: tuiPackage, shortCircuit: true };
	return nextResolve(specifier, context);
} });

const { createC4PiUi } = await import("./system1-c4-pi-ui.ts");
const { createC4MockState } = await import("./system1-c4-pi-ui-state.ts");
const { createFleetSource } = await import("../../../.pi/harnesses/agent-hub/ui/fleet-source.ts");
const { selectWidgetRows } = await import("../../../.pi/harnesses/lib/fleet-read-model.ts");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_color: string, text: string) => text,
};
const keybindings = { matches: () => false };

function fakePi() {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const flags: string[] = [];
	return {
		flags,
		handlers,
		commands,
		shortcuts,
		pi: {
			on(event: string, fn: Function) { handlers.set(event, fn); },
			registerCommand(name: string, spec: any) { commands.set(name, spec); },
			registerShortcut(key: string, spec: any) { shortcuts.set(key, spec); },
			registerFlag(name: string) { flags.push(name); },
		},
	};
}

function host() {
	let editorFactory: any;
	let widgetFactory: any;
	let widgetOptions: any;
	const notifications: string[] = [];
	const overlays: any[] = [];
	const ui = {
		setWidget(name: string, factory: any, options?: any) {
			assert.equal(name, "agent-running");
			widgetFactory = factory;
			widgetOptions = options;
		},
		getEditorComponent: () => editorFactory,
		setEditorComponent: (factory: any) => { editorFactory = factory; },
		notify(message: string) { notifications.push(message); },
		setStatus() {},
		custom: async (factory: any, options: any) => {
			const tui = { terminal: { rows: 36, columns: 120 }, requestRender() {} };
			const component = factory(tui, theme, keybindings, () => {});
			overlays.push({ options, component, text: component.render(120).join("\n") });
			component.dispose?.();
		},
	};
	const ctx: any = { mode: "tui", hasUI: true, ui, abort() {}, modelRegistry: { getAvailable: () => [], refresh: async () => {} } };
	return {
		ctx,
		notifications,
		overlays,
		options: () => widgetOptions,
		widget() {
			const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} };
			return { tui, widget: widgetFactory(tui, theme), editor: editorFactory?.(tui, theme, keybindings) };
		},
	};
}

test("C4 launch flags are present in the installed pi help", () => {
	const help = spawnSync("pi", ["--help"], { encoding: "utf8" });
	assert.equal(help.status, 0);
	const text = `${help.stdout}\n${help.stderr}`;
	for (const flag of C4_PI_ARGS) {
		if (flag === "-e") assert.match(text, /--extension, -e/);
		else assert.match(text, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("opt-in gate does not install the widget or register production flags", async () => {
	const fake = fakePi();
	createC4PiUi(fake.pi as any, {});
	assert.equal(fake.flags.length, 0);
	assert.equal(fake.shortcuts.size, 0);
	const ui = host();
	await fake.handlers.get("session_start")?.({}, ui.ctx);
	assert.equal(ui.options(), undefined);
	assert.match(ui.notifications.join("\n"), /refused/);
	const input = await fake.handlers.get("input")?.({ text: "hello" }, ui.ctx);
	assert.equal(input.action, "handled");
});

test("enabled entry installs the real below-chat widget and Fleet overlays", async () => {
	const fake = fakePi();
	createC4PiUi(fake.pi as any, { AF_C4_PI_UI: "1" });
	assert.equal(fake.flags.length, 0);
	assert.ok(fake.shortcuts.has("alt+a"));
	assert.ok(fake.shortcuts.has("alt+i"));
	const ui = host();
	await fake.handlers.get("session_start")?.({}, ui.ctx);
	assert.equal(ui.options().placement, "belowEditor");
	const view = ui.widget();
	view.editor.focused = true;
	view.editor.getText = () => "";
	fake.shortcuts.get("alt+i").handler(ui.ctx);
	const wide = view.widget.render(120).join("\n");
	const narrowLines = view.widget.render(20);
	assert.match(wide, /Builder/);
	assert.match(wide, /S1 evaluating/);
	assert.match(wide, /Reviewer/);
	assert.match(wide, /S1 unavailable/);
	assert.match(wide, /1 tools/);
	assert.match(wide, /edit/);
	assert.match(narrowLines.join("\n"), /S1/);
	assert.ok(narrowLines.every((line: string) => visibleWidth(line) <= 20));

	await fake.commands.get("c4").handler("fast", ui.ctx);
	const fast = view.widget.render(120).join("\n");
	assert.match(fast, /S1 on_track/);
	assert.match(fast, /1 tools/);
	assert.match(fast, /edit/);
	assert.doesNotMatch(fast, /2 tools/);

	await fake.commands.get("c4").handler("dash", ui.ctx);
	assert.match(ui.overlays.at(-1).text, /S1 on_track/);
	assert.equal(ui.overlays.at(-1).text.split("\n").filter((line: string) => /System 1/.test(line) && !/Builder|Reviewer/.test(line)).length, 0);

	await fake.commands.get("c4").handler("reopen", ui.ctx);
	await fake.commands.get("c4").handler("detail", ui.ctx);
	const detail = ui.overlays.at(-1).text;
	assert.match(detail, /S1 System 1/);
	assert.match(detail, /source none/);
	assert.match(detail, /Tool: read/);
	assert.doesNotMatch(detail, /S1 on_track ·/);

	await fake.commands.get("c4").handler("statuses", ui.ctx);
	fake.shortcuts.get("alt+i").handler(ui.ctx);
	const statuses = view.widget.render(120).join("\n");
	assert.match(statuses, /S1 evaluating/);
	assert.match(statuses, /S1 unavailable/);
	assert.match(statuses, /S1 on_track/);
	assert.match(statuses, /S1 cancelled/);

	try {
		const blocked = await fake.handlers.get("input")?.({ text: "dispatch now" }, ui.ctx);
		assert.equal(blocked.action, "handled");
		const quit = await fake.handlers.get("input")?.({ text: "/quit" }, ui.ctx);
		assert.equal(quit.action, "continue");
	} finally {
		await fake.handlers.get("session_shutdown")?.();
	}
});

test("shared projection drops cancelled idle rows at the 10s boundary and keeps worker fields", () => {
	const state = createC4MockState();
	const now = 20_000;
	state.apply("cancel", now);
	const source = createFleetSource({
		getAgents: () => state.workers,
		getResearch: () => new Map(),
		getPeerInputs: () => [],
		getPeerCards: () => new Map(),
		getPendingReplies: () => [],
		displayName: name => name,
		modelForAgent: () => "mock",
		modelForResearch: () => "mock",
		modelForPeer: model => model,
		getSystem1: () => state.live(),
	});
	const rows = source.rows(now, { showFinished: true });
	const builder = rows.find(row => row.key === "builder");
	assert.equal(builder?.toolCount, 1);
	assert.equal(builder?.lastWork, "edit");
	assert.equal(builder?.status, "idle");
	assert.equal(selectWidgetRows(rows, now + 9_999).some(row => row.key === "builder"), true);
	assert.equal(selectWidgetRows(rows, now + 10_000).some(row => row.key === "builder"), false);
	assert.equal(rows.some(row => row.name === "System 1"), false);
	state.dispose();
});

test("real pi loads the opt-in extension under the documented flags", { timeout: 45_000 }, () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-fleet-c4-pty-"));
	const ready = join(dir, "ready.txt");
	const output = join(dir, "pty.txt");
	const extension = join(import.meta.dirname, "system1-c4-pi-ui.ts");
	const guard = join(import.meta.dirname, "system1-c4-no-inference.js");
	const args = [...C4_PI_ARGS, extension];
	const script = `
import os, pty, select, signal, time, pathlib
ready = pathlib.Path(${JSON.stringify(ready)})
out = pathlib.Path(${JSON.stringify(output)})
pid, fd = pty.fork()
if pid == 0:
    os.execvp("pi", ${JSON.stringify(["pi", ...args])})
buf = b""
deadline = time.time() + 25
while time.time() < deadline and not ready.exists():
    readable, _, _ = select.select([fd], [], [], 0.2)
    if not readable:
        continue
    try:
        buf += os.read(fd, 8192)
    except OSError:
        break
paint = time.time() + 2
while time.time() < paint:
    readable, _, _ = select.select([fd], [], [], 0.2)
    if not readable:
        continue
    try:
        buf += os.read(fd, 16384)
    except OSError:
        break
out.write_bytes(buf)
os.kill(pid, signal.SIGTERM)
time.sleep(0.3)
try:
    os.kill(pid, signal.SIGKILL)
except OSError:
    pass
raise SystemExit(0 if ready.exists() else 2)
`;
	const env = { ...process.env, AF_C4_PI_UI: "1", AF_C4_READY_FILE: ready, NODE_OPTIONS: `--import ${guard}` };
	for (const key of Object.keys(env)) {
		if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
	}
	const result = spawnSync("python3", ["-c", script], { encoding: "utf8", env, timeout: 40_000 });
	let ptyText = "";
	try { ptyText = readFileSync(output, "utf8"); } catch { /* captured only on write */ }
	try {
		assert.equal(result.status, 0, `pi smoke status ${result.status}\n${result.stderr}\n${ptyText.slice(0, 2000)}`);
		assert.match(readFileSync(ready, "utf8"), /ready concurrent/);
		assert.match(ptyText, /system1-c4-pi-ui\.ts/);
		assert.match(ptyText, /S1 1 evaluating/);
		assert.match(ptyText, /S1 mixed/);
		assert.doesNotMatch(ptyText, /sk-[A-Za-z0-9_-]{16,}/);
		assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${ptyText}`, /System 1 offline tests forbid HTTPS requests/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
