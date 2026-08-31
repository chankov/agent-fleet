import test from "node:test";
import assert from "node:assert/strict";
import { createResearchControls } from "./controls.ts";

const state = (id: number, status: "running" | "done" = "done") => ({ id, def: { name: "research", description: "", tools: "", systemPrompt: "", file: "" }, persona: false, ephemeral: false, model: "p/m", status, task: "question", toolCount: 0, elapsed: 0, lastWork: "", contextPct: 0, contextTokens: 0, sessionFile: null, turnCount: 2, timeline: [] } as any);

test("research controls remove, clear, and restart through ResearchRuntime", async () => {
	const states = new Map([[1, state(1)], [2, state(2)]]); const calls: string[] = [];
	const runtime: any = { states: () => states, sessionPath: (id: number) => `/missing/${id}`, reset: () => { states.clear(); calls.push("reset"); }, spawn: async (item: any) => { calls.push(`spawn:${item.id}`); return { output: "ok", exitCode: 0, elapsed: 1 }; }, deliverFollowUp: (item: any) => calls.push(`deliver:${item.id}`) };
	const controls = createResearchControls({ runtime, refresh: () => calls.push("refresh"), restartSpecialist: async () => {}, getAgents: () => new Map(), displayName: name => name, modelWorkBlocked: () => false, cancelWait: async () => {}, cancelOwned: () => {} });
	const notifications: string[] = []; const ctx: any = { ui: { notify: (message: string) => notifications.push(message) } };
	controls.remove(states.get(1)!, ctx); assert.equal(states.has(1), false);
	controls.restart(states.get(2)!, ctx); await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(calls.slice(-3), ["refresh", "spawn:2", "deliver:2"]);
	controls.clear(ctx); assert.equal(states.size, 0); assert.match(notifications.at(-1)!, /Cleared 1 research helper/);
});
