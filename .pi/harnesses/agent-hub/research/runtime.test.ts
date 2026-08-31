import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createResearchRuntime, parseResearchHandle, RESEARCH_TOOLS, type ResearchState } from "./runtime.ts";

const def = { name: "researcher", description: "Research", tools: "bash", systemPrompt: "prompt", file: "/agents/researcher.md", model: "provider/persona" };

function fixture(overrides: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "research-runtime-"));
	mkdirSync(join(dir, "transcripts"), { recursive: true });
	let states = new Map<number, ResearchState<typeof def>>();
	let nextId = 1;
	let keep = 4;
	const notices: string[] = [];
	const history: any[] = [];
	const deps: any = {
		getResearchStates: () => states, setResearchStates: (value: typeof states) => { states = value; },
		getNextResearchId: () => nextId, setNextResearchId: (value: number) => { nextId = value; },
		getResearchKeep: () => keep, setResearchKeep: (value: number) => { keep = value; },
		hubState: { getSessionDir: () => dir }, budget: { currentBudget: () => ({ agentTurnMs: 1234 }) },
		artifacts: { appendInputArtifacts: (prompt: string, artifacts: any[]) => artifacts.length ? `${prompt}\nARTIFACT:${artifacts[0].preview}` : prompt },
		executionHistory: {
			start: (kind: string, name: string) => { const entry = { kind, name, status: "running" }; history.push(entry); return entry; },
			end: (entry: any, status: string) => { entry.status = status; },
		},
		providerSemaphore: { run: async (_model: string, run: () => Promise<unknown>) => run() },
		getSafetyHarnessPath: () => "/safety.ts", getReconSearchTimeoutMs: () => 500, getContextWindow: () => 1000,
		resolvedModel: (agent: typeof def) => agent.model, resolvedThinking: () => "off", resolveThinkingLevel: () => "off",
		fallbackModelFor: () => undefined, substitutedModel: (model: string | undefined) => model,
		modelWindowLookup: () => () => undefined, guardrailEnv: () => ({ SHARED: "yes" }), notifyProviderQueue() {},
		nativeResearchSystemPrompt: () => "research policy", requireSafetyHarness: () => ({ ok: true, extensions: ["/safety.ts"] }),
		shortModel: (model: string) => model.split("/").pop()!, displayName: (name: string) => name.toUpperCase(),
		flushTimelineStore() {}, appendTimelineText: (state: any, kind: string, content: string) => state.timeline.push({ kind, title: kind, content, timestamp: 1 }),
		appendTimelineEvent: (state: any, event: any) => state.timeline.push(event),
		createTranscriptStore: (path: string) => ({ path, append() {} }), updateResearchWidget() {},
		sendResearchMessage: (message: any) => notices.push(message.content),
		spawnPiAgentWithModelFallback: async () => ({ output: "findings", stderr: "", exitCode: 0 }),
		...overrides,
	};
	return { runtime: createResearchRuntime<typeof def>(deps), dir, notices, history, states: () => states, nextId: () => nextId, keep: () => keep };
}

const ctx = { cwd: "/repo", model: { provider: "provider", id: "dispatcher" }, ui: { notify() {} } } as any;

test("parseResearchHandle remains public and root-compatible", () => {
	for (const handle of ["r3", "R3", "#3", "3"]) assert.equal(parseResearchHandle(handle), 3);
	assert.equal(parseResearchHandle("research-3"), null);
});

test("runtime owns creation ids, root-backed reset, model resolution, and retention", () => {
	const f = fixture();
	const first = f.runtime.createState(def, true, f.runtime.resolveModel(def, undefined, ctx));
	const second = f.runtime.createState(def, true, "provider/other");
	assert.deepEqual([first.id, second.id, f.nextId()], [1, 2, 3]);
	first.status = "done"; first.finishedAt = 1;
	second.status = "done"; second.finishedAt = 2;
	writeFileSync(f.runtime.sessionPath(first.id), "session");
	f.runtime.setRetention(1);
	f.runtime.prune();
	assert.deepEqual([...f.states().keys()], [2]);
	assert.equal(f.keep(), 1);
	f.runtime.reset();
	assert.equal(f.states().size, 0);
	assert.equal(f.nextId(), 1);
});

test("spawn guard refuses before provider acquisition", async () => {
	let acquired = false;
	const f = fixture({
		requireSafetyHarness: () => ({ ok: false, error: "missing safety harness" }),
		providerSemaphore: { run: async () => { acquired = true; } },
	});
	const state = f.runtime.createState(def, true, "provider/model");
	const result = await f.runtime.spawn(state, "question", ctx);
	assert.match(result.output, /missing safety harness/);
	assert.equal(acquired, false);
});

test("spawn streams timeline and preserves provider semaphore, guardrail, and completion history", async () => {
	let options: any;
	let acquired = 0;
	const f = fixture({
		providerSemaphore: { run: async (_model: string, run: () => Promise<unknown>) => { acquired++; return run(); } },
		spawnPiAgentWithModelFallback: async (input: any, _fallback: any, events: any) => {
			options = input;
			events.onTextDelta("line one\n");
			events.onToolStart("grep", "needle", "c1");
			events.onToolEnd("grep", "c1", false, "match", 8);
			events.onUsage({ input: 100, cacheRead: 25, cacheWrite: 25 });
			return { output: "line one\nfinished", stderr: "", exitCode: 0 };
		},
	});
	const state = f.runtime.createState(def, true, "provider/model");
	const result = await f.runtime.spawn(state, "question", ctx);
	assert.equal(acquired, 1);
	assert.equal(options.tools, RESEARCH_TOOLS);
	assert.deepEqual(options.env, { SHARED: "yes" });
	assert.equal(options.turnDeadlineMs, 1234);
	assert.equal(state.status, "done");
	assert.equal(state.sessionFile, f.runtime.sessionPath(state.id));
	assert.equal(state.toolCount, 1);
	assert.equal(state.contextTokens, 150);
	assert.deepEqual(state.timeline.map(entry => entry.kind), ["text", "tool-start", "tool-result"]);
	assert.equal(f.history[0].status, "done");
	assert.equal(result.output, "line one\nfinished");
});

test("spawn appends artifact previews and follow-up delivery keeps restart turn semantics", async () => {
	let prompt = "";
	const f = fixture({
		spawnPiAgentWithModelFallback: async (input: any) => { prompt = input.prompt; return { output: "artifact finding", stderr: "", exitCode: 0 }; },
	});
	const state = f.runtime.createState(def, true, "provider/model");
	state.turnCount = 2;
	const result = await f.runtime.spawn(state, "inspect", ctx, [{ preview: "evidence", input: "x", path: "/x", displayPath: "x" }]);
	assert.match(prompt, /inspect\nARTIFACT:evidence/);
	f.runtime.deliverFollowUp(state, result);
	assert.match(f.notices[0], /research r1 · RESEARCHER · Turn 2/);
	assert.match(f.notices[0], /Findings:\nartifact finding/);
});
