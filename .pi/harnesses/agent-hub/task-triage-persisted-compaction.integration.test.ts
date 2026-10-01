// Real Pi/RPC persisted-session compaction and resume. No live model or network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskTriageState } from "./task-triage-state.ts";
import { TASK_TRIAGE_QUESTIONS } from "./task-triage-contract.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const guard = join(root, "bin/test/helpers/system1-no-network.js");
const runtimeEntry = "agent-hub-task-triage-runtime/v1";
const processEntry = "agent-hub-process-state";
const task = "Review the installer trust boundary change";
const followUp = "Review the installer trust boundary change and its permission checks";
const config = { version: 1, mode: "experimental", remoteContextApproved: true, provider: "typesafe", model: "jev-1.13.0",
 questionVersion: "task-triage/questions/v1", policyVersion: "task-triage/policy/v1",
 limits: { maxTaskBytes: 40960, maxStateBytes: 65536, maxCallsPerSession: 100, timeoutMs: 2000 } };

// Only the Pi model and the guarded shared-service wire transport are faked.
// Compaction summary goes through Pi's own registered model/stream pipeline.
const probe = `
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
 for (const hook of ["session_start", "input", "before_agent_start", "session_compact", "session_shutdown"])
  pi.on(hook, event => appendFileSync(process.env.PROBE_EVENTS, JSON.stringify({ pid: process.pid, hook, ...(hook === "input" ? { text: event.text, source: event.source } : {}) }) + "\\n"));
 pi.registerProvider("triage-persisted", { name: "triage-persisted", baseUrl: "http://127.0.0.1", apiKey: "fixture", api: "triage-persisted-api",
  models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 2000 }],
  streamSimple(model, ctx) {
   const stream = createAssistantMessageEventStream();
   queueMicrotask(() => {
    const compact = JSON.stringify(ctx.messages ?? []).includes("Additional focus: persisted fixture compaction");
    appendFileSync(process.env.PROBE_CALLS, JSON.stringify({ compact, inbound: JSON.stringify(ctx.messages ?? []).slice(0, 30000) }) + "\\n");
    const text = compact ? "Offline deterministic Pi compaction summary" : "Fixture turn complete";
    const msg = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "text_start", contentIndex: 0, partial: msg });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
    stream.push({ type: "done", reason: "stop", message: msg }); stream.end();
   });
   return stream;
  } });
}
`;

const rows = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
const latest = (entries: any[], type: string) => entries.filter(e => (e.customType ?? e.type) === type).at(-1)?.data;
const taskRows = (entries: any[]) => entries.filter(e => (e.customType ?? e.type) === "agent-hub-recover-event" && e.data?.kind === "guard" && e.data.event?.type === "task");

test("real Pi persists task additions, bound cache and call budget across RPC compaction and saved-session resume", { timeout: 180_000 }, async t => {
 const dir = mkdtempSync(join(tmpdir(), "triage-persisted-"));
 mkdirSync(join(dir, ".ai")); mkdirSync(join(dir, "home")); mkdirSync(join(dir, "agent"));
 writeFileSync(join(dir, ".ai/task-triage.json"), JSON.stringify(config));
 writeFileSync(join(dir, ".ai/agent-fleet.json"), JSON.stringify({ features: { system1: true } }));
 writeFileSync(join(dir, ".ai/system1.json"), JSON.stringify({ version: 1, mode: "auto", provider: "typesafe", model: "jev-1.13.0", apiKeyEnv: "TYPESAFE_API_KEY" }));
 writeFileSync(join(dir, "agent/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
 writeFileSync(join(dir, "probe.ts"), probe);
 const processes: Array<() => Promise<void>> = [];
 t.after(async () => { try { for (const close of processes.reverse()) await close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
 const wire = join(dir, "fake-calls.ndjson"), calls = join(dir, "model-calls.ndjson"), hooks = join(dir, "hooks.ndjson"), states = join(dir, "triage-states.ndjson");
 const start = (sessionFile?: string) => {
  const env = { PATH: process.env.PATH!, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1",
   TYPESAFE_API_KEY: "synthetic-test-only-key", TMPDIR: dir, NODE_OPTIONS: `--import=${guard}`,
   AGENT_HUB_TASK_TRIAGE_FAKE: "security", AGENT_HUB_TASK_TRIAGE_FAKE_RECORD: wire, AGENT_HUB_TASK_TRIAGE_FAKE_STATE_RECORD: states, PROBE_CALLS: calls, PROBE_EVENTS: hooks };
  const child = spawn(join(root, "node_modules/.bin/pi"), ["--mode", "rpc", "--no-extensions", "--session-dir", join(dir, "sessions"),
   ...(sessionFile ? ["--session", sessionFile] : []),
   "-e", join(root, ".pi/harnesses/damage-control-continue/index.ts"), "-e", join(root, ".pi/harnesses/ask-user-remote/index.ts"),
   "-e", join(root, ".pi/harnesses/agent-hub/index.ts"), "-e", join(dir, "probe.ts"),
   "--solo", "--work-mode", "operator", "--model", "triage-persisted/m"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let buffer = "", stderr = "", settled = 0, ended = false;
  const pending = new Map<string, (value: any) => void>();
  const turnWaiters = new Set<() => void>();
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  child.stdout!.on("data", chunk => {
   buffer += String(chunk);
   for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    let event: any; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "agent_settled") { settled++; for (const wake of turnWaiters) wake(); }
    if (event.type === "response" && pending.has(event.id)) { pending.get(event.id)!(event); pending.delete(event.id); }
   }
  });
  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => {
   ended = true; for (const wake of turnWaiters) wake();
   for (const wake of pending.values()) wake({ success: false, error: `Pi exited: ${stderr}` }); pending.clear();
   resolve({ code, signal });
  }));
  let seq = 0;
  const rpc = async (command: Record<string, unknown>, awaitTurn = false) => {
   const before = settled, id = `persisted-${++seq}`;
   const response = await new Promise<any>((resolve, reject) => {
    if (ended) return reject(new Error(`Pi exited: ${stderr}`));
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${command.type} timed out: ${stderr}`)); }, 30_000);
    pending.set(id, value => { clearTimeout(timeout); resolve(value); });
    child.stdin!.write(JSON.stringify({ ...command, id }) + "\n");
   });
   assert.equal(response.success, true, `RPC ${command.type}: ${JSON.stringify(response)} ${stderr}`);
   // agent_end precedes Pi's post-run compaction/continuation and is not an idle barrier.
   if (awaitTurn && settled <= before) await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { turnWaiters.delete(wake); reject(new Error(`agent_settled timed out: ${stderr}`)); }, 60_000);
    const wake = () => { if (settled <= before && !ended) return; clearTimeout(timeout); turnWaiters.delete(wake); ended ? reject(new Error(stderr)) : resolve(); };
    turnWaiters.add(wake); wake();
   });
   return response.data;
  };
  const close = async () => {
   if (!ended) child.stdin!.end();
   const timeout = setTimeout(() => { if (child.pid && !ended) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 5000);
   const exit = await finished; clearTimeout(timeout);
   assert.doesNotMatch(stderr, /System 1 offline tests forbid network requests/, "offline guard never trips");
   assert.deepEqual(exit, { code: 0, signal: null }, `Pi exits cleanly: ${stderr}`);
  };
  processes.push(close);
  return { rpc, close, pid: child.pid };
 };

 const first = start();
 await first.rpc({ type: "prompt", message: task }, true);
 const state = await first.rpc({ type: "get_state" });
 const sessionFile = state.sessionFile;
 assert.ok(typeof sessionFile === "string" && sessionFile.startsWith(dir), "Pi assigns a persisted, isolated session file");
 assert.equal(rows(wire).length, 1, "first registered pre-model hook calls shared Jev transport once");
 let entries = (await first.rpc({ type: "get_entries" })).entries;
 const initial = latest(entries, runtimeEntry);
 assert.equal(initial.calls, 1); assert.equal(initial.fingerprints.length, 1);
 assert.equal((Object.values(initial.assessments) as any[])[0]?.status, "applied");
 const original = latest(entries, processEntry).state.additions.filter((a: any) => a.source === "system1" && a.status === "active");
 assert.equal(original.length, 1); assert.equal(original[0].reason, "security_change");
 assert.ok(original[0].taskId && original[0].inputRevision && original[0].evaluationId, "addition is task/input/evaluation bound");
 assert.equal(taskRows(entries).length, 1, "first turn persists exactly one task identity, not a startup reset identity");
 assert.equal(taskRows(entries)[0].data.event.taskId, original[0].taskId,
  "the first task identity is saved before triage despite no dispatch or explicit task reset");
 // A second user turn supplies a real cut point; Pi's keepRecentTokens=1 forces
 // the earlier user/model pair into the summarizer without fabricating JSONL.
 await first.rpc({ type: "prompt", message: task }, true);
 assert.equal(rows(wire).length, 1, "duplicate registered hooks and identical input do not consume a second call");
 const compact = await first.rpc({ type: "compact", customInstructions: "persisted fixture compaction" });
 assert.match(compact.summary, /Offline deterministic Pi compaction summary/);
 assert.ok(rows(calls).some(c => c.compact), "Pi invoked the fake model for its own compaction request");
 entries = (await first.rpc({ type: "get_entries" })).entries;
 assert.ok(entries.some((e: any) => e.type === "compaction"), "Pi appended an actual compaction entry");
 assert.equal(rows(hooks).filter(h => h.hook === "session_compact").length, 1, "production session_compact hook fired");
 assert.equal(latest(entries, runtimeEntry).calls, 1);
 assert.deepEqual(latest(entries, processEntry).state.additions.filter((a: any) => a.source === "system1" && a.status === "active"), original);
 const taskRowCountBeforeResume = taskRows(entries).length;
 assert.equal(taskRowCountBeforeResume, 1, "compaction retains the single task identity");
 await first.close();
 assert.ok(existsSync(sessionFile), "the Pi JSONL is on disk after clean shutdown");

 const second = start(sessionFile);
 const resumed = await second.rpc({ type: "get_state" });
 assert.equal(resumed.sessionFile, sessionFile, "new Pi process reopened the same saved session, not a new session");
 entries = (await second.rpc({ type: "get_entries" })).entries;
 assert.equal(taskRows(entries).length, taskRowCountBeforeResume, "resumed session_start must not append another task identity");
 assert.ok(entries.some((e: any) => e.type === "compaction"), "resumed Pi reads the saved compaction");
 assert.equal(latest(entries, runtimeEntry).calls, 1, "logical count survives restart");
 assert.deepEqual(latest(entries, processEntry).state.additions.filter((a: any) => a.source === "system1" && a.status === "active"), original);
 await second.rpc({ type: "prompt", message: task }, true);
 assert.ok(rows(states).some(s => s.pid === second.pid && s.phase === "assessment" && s.taskId === original[0].taskId),
  "resumed process actually assesses the original task instead of skipping triage behind a persistence block");
 assert.equal(rows(wire).length, 1, "replay of bound input uses persisted assessment, without duplicate consumption");
 entries = (await second.rpc({ type: "get_entries" })).entries;
 assert.equal(latest(entries, runtimeEntry).calls, 1);
 assert.deepEqual(latest(entries, processEntry).state.additions.filter((a: any) => a.source === "system1" && a.status === "active"), original,
  "replay does not create a duplicate addition or apply a stale callback");
 await second.rpc({ type: "prompt", message: followUp }, true);
 assert.ok(rows(hooks).some(h => h.hook === "input" && h.source === "rpc" && h.text === followUp), "Pi delivered the changed RPC user input to the registered input hook");
 assert.ok(rows(calls).some(c => c.inbound.includes(followUp)), "the changed input reached the fake Pi model on its own settled turn");
 entries = (await second.rpc({ type: "get_entries" })).entries;
 const changedWire = rows(wire);
 if (changedWire.length !== 2) {
  // Failure-only metadata; no user text, inbound model context, wire body or credential.
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const accepted = rows(hooks).filter(h => h.pid === second.pid && h.hook === "input" && h.source === "rpc");
  const runtime = latest(entries, runtimeEntry);
  const bound = latest(entries, processEntry)?.state?.additions?.filter((a: any) => a.source === "system1" && a.status === "active") ?? [];
  const expected = buildTaskTriageState({ task: followUp, constraints: [] }, dir);
  const secondStates = rows(states).filter(s => s.pid === second.pid);
  const resumedHooks = rows(hooks).filter(h => h.pid === second.pid);
  const countByPid = Object.fromEntries([...new Set(changedWire.map(c => c.pid))].map(pid => [String(pid), changedWire.filter(c => c.pid === pid).length]));
  assert.equal(changedWire.length, 2, `changed input invalidates the persisted fingerprint once; instrumentation (not a fix): ${JSON.stringify({
   acceptedRpcCount: accepted.length, acceptedRevisions: accepted.slice(-4).map(h => hash(h.text)), expectedRevision: hash(followUp),
   expectedStateFingerprintWithoutScope: expected.ok ? expected.fingerprint : expected.reason,
   runtimeCalls: runtime?.calls ?? null, runtimeFingerprintCount: runtime?.fingerprints?.length ?? null,
   runtimeFingerprints: runtime?.fingerprints?.slice(-3) ?? [],
   runtimeCacheStatuses: Object.entries(runtime?.assessments ?? {}).slice(-3).map(([fingerprint, value]: [string, any]) => ({ fingerprint, status: value.status })),
   currentBinding: secondStates.filter(s => s.phase === "assessment").at(-1) ?? null,
   resumedHookCounts: Object.fromEntries([...new Set(resumedHooks.map(h => h.hook))].map(hook => [hook, resumedHooks.filter(h => h.hook === hook).length])),
   resumedInit: secondStates.filter(s => s.phase === "service_init" || s.phase === "restore"),
   resumedBeforeAgentStart: secondStates.filter(s => s.phase === "before_agent_start").slice(-3),
   boundAdditionTaskIds: bound.slice(-4).map((a: any) => a.taskId),
   questionVersion: config.questionVersion, expectedQuestionIdsFingerprint: hash(JSON.stringify(TASK_TRIAGE_QUESTIONS.map(q => q.id))),
   lastWireQuestionFingerprint: changedWire.at(-1)?.questionFingerprint ?? null,
   lastWireStateFingerprint: changedWire.at(-1)?.stateFingerprint ?? null,
   wireRecordsTotal: changedWire.length, wireRecordsByPid: countByPid, resumedPid: second.pid, resumedStateRecordCount: secondStates.length,
  })}`);
 }
 assert.equal(latest(entries, runtimeEntry).calls, 2, "new evaluation advances, never resets, the saved session budget");
 assert.equal(latest(entries, runtimeEntry).fingerprints.length, 2);
 assert.deepEqual(latest(entries, processEntry).state.additions.filter((a: any) => a.source === "system1" && a.status === "active"), original,
  "a changed follow-up is assessed but cannot silently declare a new task or apply its addition before binding");
 assert.ok(rows(hooks).filter(h => h.hook === "session_start").length >= 2, "both real Pi processes started extensions");
 await second.close();
});
