import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchControls } from "./controls.ts";

const state = (id: number, status: "running" | "done" = "running") => ({
	id, def: { name: "research", description: "", tools: "", systemPrompt: "", file: "" }, persona: false,
	model: "p/m", status, task: "question", toolCount: 0, elapsed: 0, lastWork: "", contextPct: 0,
	contextTokens: 0, timeline: [],
} as any);

test("research controls kill and clear live helpers without deleting session files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "research-controls-"));
	const states = new Map([[1, state(1)], [2, state(2)]]);
	const calls: string[] = [];
	const runtime: any = {
		states: () => states,
		sessionPath: (id: number) => join(dir, `research-${id}.json`),
		reset: () => { states.clear(); calls.push("reset"); },
		finalize: (item: any) => { states.delete(item.id); calls.push(`finalize:${item.id}`); },
	};
	writeFileSync(runtime.sessionPath(1), "session-1");
	writeFileSync(runtime.sessionPath(2), "session-2");
	const controls = createResearchControls({
		runtime, refresh: () => calls.push("refresh"), restartSpecialist: async () => calls.push("restart-specialist"),
		getAgents: () => new Map([["builder", { def: { name: "builder" }, task: "ship", status: "idle" }]]),
		displayName: name => name, modelWorkBlocked: () => false, cancelWait: async () => {}, cancelOwned: () => {},
	});
	const notifications: string[] = [];
	const ctx: any = { ui: { notify: (message: string) => notifications.push(message) } };

	controls.remove(states.get(1)!, ctx);
	assert.equal(states.has(1), false);
	assert.equal(existsSync(runtime.sessionPath(1)), true);

	await controls.handleRestart("r2", ctx);
	assert.ok(notifications.some(message => /cannot be restarted/.test(message)));
	assert.equal(calls.includes("finalize:2"), false);

	await controls.handleRestart("builder", ctx);
	assert.ok(calls.includes("restart-specialist"));

	controls.clear(ctx);
	assert.equal(states.size, 0);
	assert.equal(existsSync(runtime.sessionPath(2)), true);
	assert.match(notifications.at(-1)!, /Cleared 1 research helper/);
	assert.equal(calls.includes("reset"), false);
});
