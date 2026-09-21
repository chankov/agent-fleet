import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const fixturePath = new URL("./fixtures/registration-surface.json", import.meta.url);
const loaderUrl = new URL(
	"../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
	import.meta.url,
);

function sortedKeys(collection: Map<string, unknown>): string[] {
	return [...collection.keys()].sort();
}

function removeAddedSignalListeners(signal: NodeJS.Signals, before: Set<NodeJS.SignalsListener>): void {
	for (const listener of process.listeners(signal)) {
		if (!before.has(listener)) process.removeListener(signal, listener);
	}
}

test("agent-hub registration surface matches the checked-in fixture", async () => {
	const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
	const sigintBefore = new Set(process.listeners("SIGINT"));
	const sigtermBefore = new Set(process.listeners("SIGTERM"));

	try {
		// Use Pi's production extension loader so this captures registrations made by
		// the executed factory rather than names inferred from source text.
		const { loadExtensions } = await import(loaderUrl.href);
		const result = await loadExtensions([extensionPath], repoRoot);
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);

		const extension = result.extensions[0];
		const actual = {
			tools: sortedKeys(extension.tools),
			commands: sortedKeys(extension.commands),
			flags: sortedKeys(extension.flags),
		};
		assert.deepEqual(actual, fixture);
		assert.equal(extension.commands.has("af-probe"), false);
		assert.equal(extension.tools.has("af_probe_value"), false);
		for (const name of ["af-audit", "af-retry", "af-work-mode"]) assert.ok(extension.commands.has(name), name);
		// Exercise the real renderer through Pi's alias-aware production loader.
		const dispatch = extension.tools.get("dispatch_agent")!.definition;
		const rendered = dispatch.renderResult!({ content: [], details: { agent: "builder", status: "completed_unverified", executionStatus: "completed", accepted: false, elapsed: 0 } }, { expanded: false } as any, { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any).render(120).join("\n");
		assert.match(rendered, /acceptance unproven/);
		assert.doesNotMatch(rendered, /✓/, "exit-zero alone must not display acceptance");
		assert.ok(extension.tools.has("set_task_tier"), "real loader registered set_task_tier");
		const ctx = { cwd: repoRoot, ui: { notify() {}, setStatus() {} } } as any;
		const setTier = extension.tools.get("set_task_tier")!.definition;
		const classified = await setTier.execute!("t11", { tier: "small", risk: "high", scope: "wide", reason: "production callback gate" }, new AbortController().signal, () => {}, ctx);
		assert.equal((classified.details as any).status, "ok");
		const decisions = await Promise.all((extension.handlers.get("tool_call") ?? []).map(handler => handler({ type: "tool_call", toolName: "write", input: { path: "blocked" } }, ctx)));
		assert.ok(decisions.some(decision => decision?.block === true && /plan obligation/i.test(decision.reason)), "production tool_call callback blocks operator effects while the plan obligation is open");
	} finally {
		// The hub installs shutdown hooks when its factory runs. Avoid leaking them
		// into other tests when this file shares a Node test process.
		removeAddedSignalListeners("SIGINT", sigintBefore);
		removeAddedSignalListeners("SIGTERM", sigtermBefore);
	}
});
