import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
	const history: any[] = [];
	const deps: any = {
		getResearchStates: () => states, setResearchStates: (value: typeof states) => { states = value; },
		getNextResearchId: () => nextId, setNextResearchId: (value: number) => { nextId = value; },
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
		createTranscriptStore: (path: string) => ({ path, append() {} }),
		spawnPiAgentWithModelFallback: async () => ({ output: "findings", stderr: "", exitCode: 0 }),
		...overrides,
	};
	return { runtime: createResearchRuntime<typeof def>(deps), dir, history, states: () => states, nextId: () => nextId };
}

const ctx = { cwd: "/repo", model: { provider: "provider", id: "dispatcher" }, ui: { notify() {} } } as any;

test("parseResearchHandle remains public and root-compatible", () => {
	for (const handle of ["r3", "R3", "#3", "3"]) assert.equal(parseResearchHandle(handle), 3);
	assert.equal(parseResearchHandle("research-3"), null);
});

test("runtime owns monotonic creation ids and root-backed reset", () => {
	const f = fixture();
	const first = f.runtime.createState(def, true, f.runtime.resolveModel(def, undefined, ctx));
	const second = f.runtime.createState(def, true, "provider/other");
	assert.deepEqual([first.id, second.id, f.nextId()], [1, 2, 3]);
	assert.deepEqual([...f.states().keys()], [1, 2]);
	f.runtime.reset();
	assert.equal(f.states().size, 0);
	assert.equal(f.nextId(), 1);
});

test("spawn guard refuses before provider acquisition and evicts the live helper", async () => {
	let acquired = false;
	const f = fixture({
		requireSafetyHarness: () => ({ ok: false, error: "missing safety harness" }),
		providerSemaphore: { run: async () => { acquired = true; } },
	});
	const state = f.runtime.createState(def, true, "provider/model");
	assert.equal(f.states().has(state.id), true);
	const result = await f.runtime.spawn(state, "question", ctx);
	assert.match(result.output, /missing safety harness/);
	assert.equal(acquired, false);
	assert.equal(f.states().has(state.id), false);
	assert.equal(f.history[0].status, "error");
	assert.equal(state.status, "error");
});

test("spawn streams timeline and evicts the live helper without deleting session artifacts", async () => {
	let options: any;
	let acquired = 0;
	const f = fixture({
		providerSemaphore: { run: async (_model: string, run: () => Promise<unknown>) => { acquired++; return run(); } },
		spawnPiAgentWithModelFallback: async (input: any, _fallback: any, events: any) => {
			options = input;
			writeFileSync(input.sessionFile, "session");
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
	assert.equal(options.resume, false);
	assert.deepEqual(options.env, { SHARED: "yes" });
	assert.equal(options.turnDeadlineMs, 1234);
	assert.equal(state.status, "done");
	assert.equal(state.toolCount, 1);
	assert.equal(state.contextTokens, 150);
	assert.deepEqual(state.timeline.map(entry => entry.kind), ["text", "tool-start", "tool-result"]);
	assert.equal(f.history[0].status, "done");
	assert.equal(result.output, "line one\nfinished");
	assert.equal(f.states().has(state.id), false);
	assert.equal(existsSync(f.runtime.sessionPath(state.id)), true);
	const next = f.runtime.createState(def, true, "provider/model");
	assert.equal(next.id, 2);
});

test("spawn appends artifact previews and thrown failures still evict exactly once", async () => {
	let prompt = "";
	const f = fixture({
		spawnPiAgentWithModelFallback: async (input: any) => { prompt = input.prompt; return { output: "artifact finding", stderr: "", exitCode: 0 }; },
	});
	const state = f.runtime.createState(def, true, "provider/model");
	const result = await f.runtime.spawn(state, "inspect", ctx, [{ preview: "evidence", input: "x", path: "/x", displayPath: "x" }]);
	assert.match(prompt, /inspect\nARTIFACT:evidence/);
	assert.equal(result.output, "artifact finding");
	assert.equal(f.states().size, 0);

	const throwing = fixture({
		spawnPiAgentWithModelFallback: async () => { throw new Error("boom"); },
	});
	const failed = throwing.runtime.createState(def, true, "provider/model");
	const crashed = await throwing.runtime.spawn(failed, "inspect", ctx);
	assert.match(crashed.output, /boom/);
	assert.equal(throwing.states().size, 0);
	assert.equal(throwing.history[0].status, "error");
	throwing.runtime.finalize(failed, { status: "error", historyStatus: "error", lastWork: "again" });
	assert.equal(throwing.history[0].status, "error");
});

test("timeout, abort, and operator kill finalize history without unlinking sessions", async () => {
	const termination = { reason: "tool_timeout", tool: { toolCallId: "c1", toolName: "read" } };
	const timed = fixture({
		spawnPiAgentWithModelFallback: async (input: any) => {
			writeFileSync(input.sessionFile, "session");
			return { output: "partial", stderr: "", exitCode: 124, termination };
		},
	});
	const timedState = timed.runtime.createState(def, true, "provider/model");
	const timedResult = await timed.runtime.spawn(timedState, "question", ctx);
	assert.equal(timedResult.exitCode, 124);
	assert.equal(timed.states().size, 0);
	assert.equal(timed.history[0].status, "error");
	assert.equal(existsSync(timed.runtime.sessionPath(timedState.id)), true);

	let release!: (value: any) => void;
	const hanging = fixture({
		spawnPiAgentWithModelFallback: () => new Promise(resolve => { release = resolve; }),
	});
	const live = hanging.runtime.createState(def, true, "provider/model");
	writeFileSync(hanging.runtime.sessionPath(live.id), "session");
	const pending = hanging.runtime.spawn(live, "question", ctx);
	const hangDeadline = Date.now() + 1000;
	while (!release && Date.now() < hangDeadline) await new Promise(resolve => setImmediate(resolve));
	assert.equal(typeof release, "function");
	assert.equal(hanging.states().has(live.id), true);
	assert.equal(hanging.history[0].status, "running");
	hanging.runtime.finalize(live, { status: "idle", historyStatus: "idle", lastWork: "(killed by operator)" });
	assert.equal(hanging.states().has(live.id), false);
	assert.equal(hanging.history[0].status, "idle");
	release({ output: "ignored", stderr: "", exitCode: 143 });
	const killed = await pending;
	assert.match(killed.output, /killed by the operator|Error spawning|ignored/);
	assert.equal(hanging.history[0].status, "idle");
	assert.equal(existsSync(hanging.runtime.sessionPath(live.id)), true);
});

test("three parallel helpers are live together and independently disappear", async () => {
	const resolvers: Array<(value: any) => void> = [];
	const f = fixture({
		spawnPiAgentWithModelFallback: async (input: any) => {
			writeFileSync(input.sessionFile, "session");
			return await new Promise(resolve => resolvers.push(resolve));
		},
	});
	const states = [0, 1, 2].map(() => f.runtime.createState(def, true, "provider/model"));
	const pending = states.map(state => f.runtime.spawn(state, `q${state.id}`, ctx));
	assert.equal(f.states().size, 3);
	assert.deepEqual([...f.states().keys()], [1, 2, 3]);
	const deadline = Date.now() + 1000;
	while (resolvers.length < 3 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
	assert.equal(resolvers.length, 3);
	for (const resolve of resolvers) resolve({ output: "ok", stderr: "", exitCode: 0 });
	await Promise.all(pending);
	assert.equal(f.states().size, 0);
	assert.equal(f.history.length, 3);
	assert.ok(f.history.every(entry => entry.status === "done"));
	for (const state of states) assert.equal(existsSync(f.runtime.sessionPath(state.id)), true);
});
