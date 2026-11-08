import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const aliases: Record<string, string> = { "@mariozechner/pi-coding-agent": import.meta.resolve("@earendil-works/pi-coding-agent"), "@mariozechner/pi-tui": import.meta.resolve("@earendil-works/pi-tui") };
registerHooks({ resolve(specifier, context, nextResolve) { return aliases[specifier] ? { url: aliases[specifier], shortCircuit: true } : nextResolve(specifier, context); } });
const { createFleetConfigUi } = await import("./ui.ts");

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const plan = (overrides: Record<string, unknown> = {}) => ({ publicSchemaVersion: 1, stage: "preview", verb: "setup", writeDesired: false, firstMigration: false, migrationBlocked: false, desired: { schemaVersion: 1, preset: "default", features: { voice: true } }, selection: { desired: { requestedFeatures: ["voice"], features: ["voice"] }, resolved: ["x"] }, actions: [{ kind: "create", id: "pi-extension:pi-voice-stt", target: ".pi/extensions/pi-voice-stt", reason: null }], conflicts: [], notes: [], summary: { create: 1, changes: 1 }, stt: { write: false, warning: null, provider: "azure-openai" }, taskTriage: null, overrides: { write: false }, ...overrides });

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "fleet-config-flows-"));
	mkdirSync(join(root, ".ai"), { recursive: true });
	writeFileSync(join(root, ".ai", "agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "default", features: { voice: false, "system1-task-triage": false } }));
	writeFileSync(join(root, ".ai", "agent-fleet-state.json"), JSON.stringify({ schemaVersion: 2, agent: "pi", method: "copy", packageVersion: "2.0.14", sourceRoot: join(root, "gone"), items: {} }));
	writeFileSync(join(root, ".ai", "agent-fleet-overrides.md"), "## agent-hub\nlanguage: Bulgarian\n");
	return root;
}

/** A scripted pi UI: every ui.custom call pops the next key script; `input` pops the next answer. */
function scriptedUi(scripts: string[][], inputs: Array<string | undefined> = []) {
	const titles: string[] = []; const reports: string[][] = [];
	const custom = async (factory: any) => {
		const keys = scripts.shift() ?? ["q"];
		let finished = false;
		const component = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, () => { finished = true; });
		const lines = component.render(140); titles.push(lines[0]); reports.push(lines);
		for (const key of keys) { if (finished) break; await component.handleInput(key); }
		if (!finished) throw new Error(`overlay "${lines[0]}" was left open by the script`);
	};
	return { titles, reports, ui: { notify(message: string, level?: string) { titles.push(`notify:${level}:${message}`); }, custom, input: async () => inputs.shift() } };
}

/** A fake CLI keyed on the Fleet verb and flags; records every call. */
function fakeCli(handlers: Record<string, (args: string[]) => { status?: number; stdout?: unknown; stderr?: string }>) {
	const calls: string[][] = [];
	const runner = async (_command: string, args: string[]) => {
		calls.push(args);
		const fleet = args.slice(args.indexOf("@chankov/agent-fleet@2.0.14") + 1);
		const key = fleet.includes("--dry-run") ? `${fleet[0]} dry-run` : fleet.includes("--yes") ? `${fleet[0]} yes` : fleet[0];
		const answer = handlers[key]?.(fleet) ?? { status: 1, stderr: `unexpected ${key}` };
		return { status: answer.status ?? 0, stdout: answer.stdout === undefined ? "" : typeof answer.stdout === "string" ? answer.stdout : JSON.stringify(answer.stdout), stderr: answer.stderr ?? "" };
	};
	return { calls, runner };
}

test("setup flow: toggle a feature, preview the CLI plan, confirm, re-verify the digest, then setup --yes; the draft is dropped and a restart note shown", async () => {
	const root = workspace();
	try {
		let dryRuns = 0;
		const cli = fakeCli({ "setup dry-run": () => { dryRuns++; return { stdout: plan() }; }, "setup yes": () => ({ stdout: { verb: "setup", exitCode: 0, results: [{ id: "pi-extension:pi-voice-stt", status: "applied" }, { id: "companion:pi-extension-deps", status: "skipped", detail: "exec deferred" }], summary: { applied: 1, skipped: 1, failed: 0 } } }) });
		const ui = createFleetConfigUi({ inspectRunner: cli.runner });
		const screen = scriptedUi([["2", "\u001b[B", "\u001b[B", "\u001b[B", " ", "a", "q"], ["y"], ["q"]]);
		await ui.open({ cwd: root, hasUI: true, ui: screen.ui } as any);
		assert.equal(dryRuns, 2, "a second dry run guards the apply");
		assert.deepEqual(cli.calls.map(args => args.slice(2)), [
			["setup", "--json", "--preset", "default", "--features", "voice", "--save-desired", "--dry-run", "--workspace", root],
			["setup", "--json", "--preset", "default", "--features", "voice", "--save-desired", "--dry-run", "--workspace", root],
			["setup", "--json", "--preset", "default", "--features", "voice", "--save-desired", "--yes", "--workspace", root],
		]);
		assert.match(screen.titles[1], /setup plan \(CLI dry run\)/); assert.match(screen.reports[1].join("\n"), /create\s+pi-extension:pi-voice-stt/); assert.match(screen.reports[1].at(-1)!, /y apply via agent-fleet setup --yes/);
		assert.match(screen.titles[2], /setup applied/); assert.match(screen.reports[2].join("\n"), /Summary → applied 1 · skipped 1 · failed 0/); assert.match(screen.reports[2].join("\n"), /skipped\s+companion:pi-extension-deps — exec deferred/); assert.match(screen.reports[2].join("\n"), /Restart the session/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup flow refuses to apply when the second dry run differs, when the plan has conflicts, and when the user cancels", async () => {
	const root = workspace();
	try {
		let dryRuns = 0;
		const changing = fakeCli({ "setup dry-run": () => ({ stdout: plan(++dryRuns === 1 ? {} : { actions: [{ kind: "refresh", id: "skill:z", target: "skills/z" }] }) }) });
		const screen1 = scriptedUi([["2", "\u001b[B", "\u001b[B", "\u001b[B", " ", "a", "q"], ["y"], ["q"]]);
		await createFleetConfigUi({ inspectRunner: changing.runner }).open({ cwd: root, hasUI: true, ui: screen1.ui } as any);
		assert.equal(changing.calls.length, 2); assert.ok(changing.calls.every(args => !args.slice(2).includes("--yes")), "npx --yes is not a Fleet flag; no Fleet --yes was passed");
		assert.match(screen1.titles[2], /not applied/); assert.match(screen1.reports[2].join("\n"), /workspace changed since the preview/);

		const conflicts = fakeCli({ "setup dry-run": () => ({ status: 3, stdout: plan({ conflicts: [{ id: "skill:c", kind: "conflict", reason: "three-way conflict" }], actions: [{ kind: "conflict", id: "skill:c", reason: "three-way conflict" }] }) }) });
		const screen2 = scriptedUi([["2", "\u001b[B", "\u001b[B", "\u001b[B", " ", "a", "q"], ["y", "q"]]);
		await createFleetConfigUi({ inspectRunner: conflicts.runner }).open({ cwd: root, hasUI: true, ui: screen2.ui } as any);
		assert.equal(conflicts.calls.length, 1, "y on a conflict report is not a confirmation");
		assert.match(screen2.reports[1].join("\n"), /CONFLICTS \(1\)/); assert.match(screen2.reports[1].join("\n"), /Terminal equivalent: agent-fleet setup --preset default --features voice --save-desired/); assert.doesNotMatch(screen2.reports[1].at(-1)!, /y apply/);

		const cancelled = fakeCli({ "setup dry-run": () => ({ stdout: plan() }) });
		const screen3 = scriptedUi([["2", "\u001b[B", "\u001b[B", "\u001b[B", " ", "a", "q"], ["q"]]);
		await createFleetConfigUi({ inspectRunner: cancelled.runner }).open({ cwd: root, hasUI: true, ui: screen3.ui } as any);
		assert.equal(cancelled.calls.length, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup flow surfaces a busy lock from the CLI, a config-repair preview, and asks the separate task-triage consent", async () => {
	const root = workspace();
	try {
		const locked = fakeCli({ "setup dry-run": () => ({ stdout: plan() }), "setup yes": () => ({ status: 4, stderr: "agent-fleet: workspace is locked (setup pid 4242); locks are never stolen automatically" }) });
		const screen = scriptedUi([["2", "\u001b[B", "\u001b[B", "\u001b[B", " ", "a", "q"], ["y"], ["q"]]);
		await createFleetConfigUi({ inspectRunner: locked.runner }).open({ cwd: root, hasUI: true, ui: screen.ui } as any);
		assert.match(screen.titles[2], /setup failed/); assert.match(screen.reports[2].join("\n"), /exit 4: agent-fleet: workspace is locked/);

		const repair = fakeCli({ "setup dry-run": () => ({ stdout: { publicSchemaVersion: 1, stage: "config-repair-preview", configRepair: { path: ".ai/agent-fleet.json", removed: ["chatgpt-client"], requiresApproval: true, nextStep: "Run setup interactively, or setup --yes --repair-config. No mutation was applied." } } }), "setup yes": (args) => ({ stdout: { verb: "setup", exitCode: 0, results: [], summary: { applied: 0 }, repaired: args.includes("--repair-config") } }) });
		const screen2 = scriptedUi([["2", "\u001b[B", "\u001b[B", "\u001b[B", " ", "a", "q"], ["y"], ["q"]]);
		await createFleetConfigUi({ inspectRunner: repair.runner }).open({ cwd: root, hasUI: true, ui: screen2.ui } as any);
		assert.match(screen2.titles[1], /desired file needs repair/); assert.match(screen2.reports[1].join("\n"), /Keys it would remove: chatgpt-client/);
		assert.ok(repair.calls.at(-1)!.slice(2).includes("--repair-config") && repair.calls.at(-1)!.slice(2).includes("--yes"));

		const triage = fakeCli({ "setup dry-run": () => ({ stdout: plan({ taskTriage: { alreadyApproved: false }, desired: { schemaVersion: 1, preset: "default", features: { "system1-task-triage": true } } }) }), "setup yes": () => ({ stdout: { verb: "setup", exitCode: 0, results: [], summary: { applied: 0 } } }) });
		// Row order on Setup: preset, schema, then features sorted: system1-task-triage (2 downs), voice (3 downs).
		const screen3 = scriptedUi([["2", "\u001b[B", "\u001b[B", " ", "a", "q"], ["y"], ["q"], ["q"]]);
		await createFleetConfigUi({ inspectRunner: triage.runner }).open({ cwd: root, hasUI: true, ui: screen3.ui } as any);
		assert.ok(triage.calls.every(args => !args.slice(2).includes("--yes")), "declining the consent dialog applies nothing");
		assert.match(screen3.titles[2], /separate consent: task triage remote context/);
		assert.ok(screen3.titles.some(title => /task-triage consent was not given/.test(title)));
		const triageYes = fakeCli({ "setup dry-run": () => ({ stdout: plan({ taskTriage: { alreadyApproved: false } }) }), "setup yes": () => ({ stdout: { verb: "setup", exitCode: 0, results: [], summary: { applied: 0 } } }) });
		const screen4 = scriptedUi([["2", "\u001b[B", "\u001b[B", " ", "a", "q"], ["y"], ["y"], ["q"]]);
		await createFleetConfigUi({ inspectRunner: triageYes.runner }).open({ cwd: root, hasUI: true, ui: screen4.ui } as any);
		assert.deepEqual(triageYes.calls.at(-1)!.slice(2, 10), ["setup", "--json", "--preset", "default", "--features", "system1-task-triage", "--save-desired", "--yes"]);
		assert.ok(triageYes.calls.at(-1)!.slice(2).includes("--task-triage-consent"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("configure flow: input dialogs, CLI dry-run diff, confirm, apply with the expected hash; invalid paths and cancels spawn nothing", async () => {
	const root = workspace();
	try {
		const cli = fakeCli({
			"configure dry-run": (args) => ({ stdout: { verb: "configure", stage: "preview", path: ".ai/agent-fleet-overrides.md", expectedHash: "9fd71ca0d8dddf9a", write: true, before: "## agent-hub\nlanguage: Bulgarian\n", after: `## agent-hub\nlanguage: Bulgarian\nrules: ${args[args.indexOf("--rules") + 1]}\n` } }),
			"configure yes": (args) => ({ stdout: { verb: "configure", changed: args.includes("9fd71ca0d8dddf9a") } }),
		});
		const screen = scriptedUi([["4", "a", "q"], ["y"], ["q"]], ["docs, .ai/rules", ""]);
		await createFleetConfigUi({ inspectRunner: cli.runner }).open({ cwd: root, hasUI: true, ui: screen.ui } as any);
		assert.deepEqual(cli.calls.map(args => args.slice(2)), [
			["configure", "--rules", "docs,.ai/rules", "--dry-run", "--workspace", root],
			["configure", "--rules", "docs,.ai/rules", "--yes", "--json", "--expect-hash", "9fd71ca0d8dddf9a", "--workspace", root],
		]);
		assert.match(screen.reports[1].join("\n"), /\+ rules: docs,\.ai\/rules/); assert.match(screen.reports[2].join("\n"), /Configuration applied by agent-fleet configure --yes/);

		const invalid = fakeCli({});
		const screen2 = scriptedUi([["4", "a", "q"]], ["/etc/passwd"]);
		await createFleetConfigUi({ inspectRunner: invalid.runner }).open({ cwd: root, hasUI: true, ui: screen2.ui } as any);
		assert.equal(invalid.calls.length, 0); assert.ok(screen2.titles.some(title => /checkout-relative without traversal/.test(title)));
		const screen3 = scriptedUi([["4", "a", "q"]], [undefined]);
		await createFleetConfigUi({ inspectRunner: invalid.runner }).open({ cwd: root, hasUI: true, ui: screen3.ui } as any);
		assert.equal(invalid.calls.length, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("headless sessions never reach the write flows and the shared modules never write themselves", async () => {
	const root = workspace();
	try {
		const cli = fakeCli({});
		const notices: string[] = [];
		await createFleetConfigUi({ inspectRunner: cli.runner }).open({ cwd: root, hasUI: false, ui: { notify: (message: string) => notices.push(message), custom: undefined } } as any, "setup");
		assert.equal(cli.calls.length, 0); assert.match(notices[0], /^Fleet config · Setup/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
