import assert from "node:assert/strict";
import test from "node:test";
import { instrumentBash } from "./runtime-test-check.ts";

test("runtime test records the actual guarded operation exit and revisions without parsing output", async () => {
 let calls = 0;
 const factory = (_cwd: string, { operations }: any) => ({ execute: async (_id: string, params: any) => {
  const result = await operations.exec(params.command);
  if (result.exitCode) throw new Error("all green (misleading output)");
  return { content: [{ type: "text", text: "all green" }] };
 } });
 for (const code of [0, 1]) {
  const execute = instrumentBash(factory, { exec: async () => { calls++; return { exitCode: code }; } }, "/fixture", () => "revision");
  const result = await execute("id", { command: "node --test semantic.test.js" }, undefined, undefined);
  assert.equal(result.details.runtimeTest.exitCode, code);
  assert.equal(result.details.runtimeTest.beforeRevision, "revision");
  assert.equal(result.details.runtimeTest.afterRevision, "revision");
 }
 assert.equal(calls, 2);
});

test("unexecuted or interrupted bash creates no success evidence", async () => {
 const execute = instrumentBash(() => ({ execute: async () => { throw new Error("denied"); } }), {}, "/fixture", () => "revision");
 await assert.rejects(() => execute("id", { command: "node --test" }, undefined, undefined), /denied/);
});

test("transport rejects disabled, unmatched, and untrusted result-shaped claims", async () => {
 const { runtimeTestFromResult } = await import("./runtime-test-check.ts");
 const record = { producer: "agent-fleet.runtime-test/v1", command: "node --test", exitCode: 0, beforeRevision: "revision", afterRevision: "revision" };
 const result = { details: { runtimeTest: record } };
 assert.deepEqual(runtimeTestFromResult(true, record.command, "bash", result), record);
 assert.equal(runtimeTestFromResult(false, record.command, "bash", result), null);
 assert.equal(runtimeTestFromResult(true, undefined, "bash", result), null);
 assert.equal(runtimeTestFromResult(true, "echo success", "bash", result), null);
 assert.equal(runtimeTestFromResult(true, record.command, "write", result), null);
 assert.equal(runtimeTestFromResult(true, record.command, "bash", { details: { runtimeTest: { ...record, producer: "specialist" } } }), null);
});

test("observer forwards execution context and tool options", async () => {
 const ctx = { model: { id: "configured" } }; let seen: any;
 const execute = instrumentBash((_cwd: string, options: any) => ({ execute: async (...args: any[]) => { seen = { ctx: args[4], options }; return { content: [] }; } }), {}, "/fixture", () => "r", { commandPrefix: "setup", shellPath: "/configured/shell" });
 await execute("id", { command: "true" }, undefined, undefined, ctx);
 assert.equal(seen.ctx, ctx); assert.equal(seen.options.shellPath, "/configured/shell"); assert.equal(seen.options.commandPrefix, "setup");
});

test("real agent-core event transport preserves bash failure and repeated-failure terminal safeguard", async () => {
 const { realpathSync } = await import("node:fs");
 const { dirname, join } = await import("node:path");
 const cli = realpathSync("node_modules/.bin/pi");
 const api = await import(join(dirname(cli), "index.js"));
 const { agentLoop } = await import(join(dirname(cli), "../node_modules/@earendil-works/pi-agent-core/dist/index.js"));
 const { createDriftMonitor } = await import("./drift-watchdog.js");
 const { registerObservedBash } = await import("./runtime-test-check.ts");
 let tool: any, hook: any;
 registerObservedBash({ registerTool: (t: any) => tool = t, on: (name: string, fn: any) => { if (name === "tool_result") hook = fn; } }, api, process.cwd(), {});
 assert.equal(typeof tool.renderCall, "function"); assert.equal(typeof tool.renderResult, "function");
 const monitor = createDriftMonitor({}); let trips: any[] = []; let turns = 0; const ends: any[] = [];
 const streamFn = () => {
  const message = { role: "assistant", content: turns++ < 5 ? [{ type: "toolCall", id: `b${turns}`, name: "bash", arguments: { command: "exit 7" } }] : [], stopReason: turns <= 5 ? "toolUse" : "stop", api: "test", provider: "test", model: "test", timestamp: 0, usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } } };
  return { async *[Symbol.asyncIterator]() {}, result: async () => message };
 };
 const events = agentLoop([{ role: "user", content: "fixture", timestamp: 0 }], { systemPrompt: "", messages: [], tools: [tool] }, {
  model: { id: "fixture", api: "test", provider: "test" }, convertToLlm: (m: any) => m,
  afterToolCall: ({ toolCall, result, isError }: any) => hook?.({ toolName: toolCall.name, toolCallId: toolCall.id, ...result, isError }),
 }, undefined, streamFn);
 for await (const event of events) if (event.type === "tool_execution_end") { ends.push(event); const trip = monitor.onToolEnd(event.toolName, event.isError); if (trip) trips.push(trip); }
 assert.equal(ends.length, 5);
 for (const end of ends) { assert.equal(end.isError, true); assert.equal(end.result.details.runtimeTest.exitCode, 7); }
 assert.ok(trips.some(t => t.rule === "failures" && t.terminal));
});
