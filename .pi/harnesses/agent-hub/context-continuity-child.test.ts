import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import contextContinuityChild from "./context-continuity-child.ts";

// The adapter only arms under a verified Pi runtime, which it detects from the launcher.
const piCli = fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));

function child() {
 const handlers = new Map<string, (...args: any[]) => any>(), entries: any[] = [];
 const pi: any = { on: (name: string, handler: any) => handlers.set(name, handler), appendEntry: (type: string, data: unknown) => entries.push({ type, data }), sendMessage() {} };
 const launcher = process.argv[1]; process.argv[1] = piCli;
 try { contextContinuityChild(pi); } finally { process.argv[1] = launcher; }
 const state = { tokens: 0, aborts: 0 };
 const ctx: any = { cwd: process.cwd(), model: { contextWindow: 1000 }, sessionManager: { getSessionId: () => "s", getBranch: () => [] },
  getContextUsage: () => ({ tokens: state.tokens, contextWindow: 1000, percent: state.tokens / 10 }), abort: () => { state.aborts++; }, compact() {} };
 const emit = (name: string) => handlers.get(name)!({}, ctx);
 return { state, entries, emit, phases: () => entries.filter(entry => entry.type === "agent-fleet-compaction-monitor").map(entry => entry.data.phase) };
}

test("native child: a compacted baseline between target and ceiling keeps working until growth re-arms compaction", async () => {
 const c = child();
 await c.emit("session_start"); await c.emit("session_compact");
 c.state.tokens = 750; await c.emit("turn_end");
 c.state.tokens = 820; c.emit("context"); c.emit("context");
 assert.equal(c.state.aborts, 0, "an unattended child is not cancelled while compaction re-arms by growth");
 assert.deepEqual(c.phases().filter(phase => phase.startsWith("ceiling")), ["ceiling_exceeded"]);
 c.state.tokens = 860; c.emit("context");
 assert.equal(c.state.aborts, 1, "one band of growth interrupts for compaction");
});

test("native child: a compacted baseline at or above the ceiling still stops work", async () => {
 const c = child();
 await c.emit("session_start"); await c.emit("session_compact");
 c.state.tokens = 850; await c.emit("turn_end"); c.emit("context");
 assert.equal(c.state.aborts, 1);
 assert.ok(c.phases().includes("ceiling_blocked"));
});
