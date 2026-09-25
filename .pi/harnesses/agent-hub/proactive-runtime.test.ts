import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createProactiveRuntime, createHubCapture, composeHubProactive, ingestObserverManifests } from "./proactive-runtime.ts";
import type { System1Service } from "../lib/system1/contracts.ts";
import type { ObserverAssignment } from "./proactive-observer.ts";
import type { ProactiveConfig, TurnSnapshot } from "./proactive-types.ts";
const config: ProactiveConfig = { version: 1, mode: "shadow", remoteContext: "disabled", include: ["src/**"], maxEvaluationsPerSession: 100 };
const hash = (data: string) => createHash("sha256").update(data).digest("hex");
const snap = (owner: string, attempt: string, i: number, path = `src/${i}.ts`): TurnSnapshot => ({ snapshotId: hash(`${owner}${attempt}${i}`), turnId: `session:${owner}:${attempt}:${i}`, head: "", context: { task: { path: "task", revision: "1", hash: hash("task") }, rules: [], exceptions: [] }, planStatus: "task_only", status: "complete", gaps: [], units: [{ id: String(i), path, kind: "modified", attribution: "observed_only" }], observedPaths: 1, coverage: { retainedUnits: 1, retainedBytes: 0, omittedPaths: 0 } });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
test("off and missing evaluator never call or claim semantic success", async () => {
 let calls = 0;
 const off = createProactiveRuntime({ config: { ...config, mode: "off" }, evaluate: async () => { calls++; } });
 assert.equal(off.submit("a", "1", snap("a", "1", 0), 0), false);
 const local = createProactiveRuntime({ config });
 assert.equal(local.submit("a", "1", snap("a", "1", 0), 0), true);
 assert.equal(local.records[0].status, "not_checked"); assert.equal(local.used, 0); assert.equal(calls, 0);
});
test("one active, one pending per owner, eight total, replacement carries only paths", async () => {
 const hold = deferred(); let now = 0; const jobs: Array<{ uncheckedPaths: readonly string[]; signal: AbortSignal }> = [];
 const runtime = createProactiveRuntime({ config, now: () => now, setTimer: () => 1 as any, clearTimer: () => {}, evaluate: async job => { jobs.push(job); await hold.promise; } });
 runtime.submit("a", "1", snap("a", "1", 0), 0); await flush();
 for (let i = 1; i <= 8; i++) runtime.submit(`o${i}`, "1", snap(`o${i}`, "1", 0), 0);
 assert.equal(runtime.activeCount, 1); assert.equal(runtime.pendingCount, 8);
 runtime.submit("ninth", "1", snap("ninth", "1", 0), 0);
 assert.equal(runtime.records.at(-1)?.status, "backlog_full");
 runtime.submit("o1", "1", snap("o1", "1", 1), 1);
 assert.equal(runtime.pendingCount, 8); assert.equal(runtime.records.at(-1)?.status, "superseded");
 assert.deepEqual(runtime.records.at(-1)?.uncheckedPaths, ["src/0.ts"]);
 now = 5000; hold.resolve(); await flush();
 assert.ok(runtime.records.some(r => r.status === "queue_timeout"));
 assert.equal(runtime.activeCount, 0);
});
test("budget and late completion/cancellation fence attempts, leave watchdog independent", async () => {
 const hold = deferred(); let watchdogCalls = 0;
 const runtime = createProactiveRuntime({ config: { ...config, maxEvaluationsPerSession: 1 }, evaluate: () => hold.promise });
 runtime.submit("a", "old", snap("a", "old", 0), 0); await flush();
 watchdogCalls++; // independent watchdog is not scheduled through the review queue
 runtime.abort("a", "old");
 assert.equal(runtime.records.at(-1)?.status, "cancelled");
 runtime.submit("b", "new", snap("b", "new", 0), 0);
 assert.equal(runtime.records.at(-1)?.status, "session_budget");
 hold.resolve(); await flush();
 assert.equal(runtime.records.filter(r => r.status === "reviewed").length, 0);
 assert.equal(watchdogCalls, 1);
});
test("owner-scoped restart leaves other owners schedulable; session abort stops all", () => {
 const runtime = createProactiveRuntime({ config });
 runtime.abort("builder", "old");
 assert.equal(runtime.submit("builder", "new", snap("builder", "new", 0), 0), true);
 assert.equal(runtime.submit("reviewer", "new", snap("reviewer", "new", 0), 0), true);
 runtime.abort();
 assert.equal(runtime.submit("builder", "later", snap("builder", "later", 0), 0), false);
 assert.equal(runtime.recordGap("hub", "direct", "session:hub:direct:0", "not_checked"), false);
});
test("missing capture has an explicit non-semantic closure", () => {
 const runtime = createProactiveRuntime({ config });
 assert.equal(runtime.recordGap("hub", "direct", "session:hub:direct:0", "not_checked"), true);
 assert.deepEqual(runtime.records[0], { owner: "hub", attempt: "direct", turnId: "session:hub:direct:0", status: "not_checked", paths: [], uncheckedPaths: [] });
 assert.equal(runtime.used, 0);
});
test("Hub hook finish crossing reset cannot submit to replacement session, even with identical directory", async () => {
 const gate = deferred();
 const old = createProactiveRuntime({ config }), next = createProactiveRuntime({ config });
 const hooks = createHubCapture({ root: () => ".", task: () => "task", begin: async () => ({ turnId: "session:hub:direct:0" } as any), finish: async () => { await gate.promise; return snap("hub", "direct", 0); } });
 hooks.initialize(config, old); hooks.bindSession("session");
 hooks.start(0); hooks.end(0, "text");
 await flush();
 hooks.reset(); hooks.initialize(config, next); hooks.bindSession("session");
 gate.resolve(); await hooks.capture;
 assert.equal(next.records.length, 0);
 assert.equal(old.records.length, 0);
 hooks.end(1, "missing baseline"); await hooks.capture;
 assert.deepEqual(next.records.map(r => r.status), ["not_checked"]);
});
test("production composition binds task bytes and refs to one discovered snapshot, shares service, retains privately", async () => {
 const root = mkdtempSync(join(tmpdir(), "proactive-compose-"));
 const sessionDir = join(root, ".pi", "sessions", "one");
 mkdirSync(sessionDir, { recursive: true }); mkdirSync(join(root, "rules"));
 writeFileSync(join(root, "rules", "README.md"), "# Rule\nCheck this unit.\n");
 let beginContext: any; let turnId = ""; let calls = 0; let outbound: any;
 const service = { evaluate: async (request: any) => { calls++; outbound = request; return { status: "unavailable", reason: "auth" }; } } as System1Service;
 const task = "Write a real unit";
 const capture = createHubCapture({ root: () => root, task: () => task,
  begin: async input => { beginContext = input.context; turnId = input.turnId; return { context: input.context } as any; },
  finish: async () => ({ ...snap("hub", "direct", 0), turnId, context: beginContext,
   units: [{ id: "unit", path: "src/a.ts", kind: "added", attribution: "observed_only", after: { text: "new unit", hash: hash("new unit"), offset: 0, endOffset: 8, startLine: 1, endLine: 1, truncated: false } }] }) });
 const runtime = composeHubProactive({ config: { ...config, remoteContext: "selected-excerpts" }, root, sessionDir, rulesRoots: ["rules"], service, capture });
 capture.start(0); capture.end(0, "hello"); await capture.capture;
 for (let i = 0; i < 20 && !runtime.records.length; i++) await new Promise(r => setTimeout(r, 5));
 assert.equal(calls, 1, JSON.stringify(runtime.records)); assert.equal(outbound.state.task, task);
 assert.equal(beginContext.task.hash, hash(task)); assert.equal(beginContext.rules.length, 1);
 assert.equal(beginContext.rules[0].hash, hash(readFileSync(join(root, "rules", "README.md"), "utf8")));
 assert.equal(runtime.records[0].status, "not_checked");
 assert.equal(runtime.records[0].assessment?.evaluations[0].status, "unavailable");
 assert.equal(statSync(join(sessionDir, "artifacts", "proactive-activity")).mode & 0o077, 0);
 capture.reset();
});
test("composition without consent, service, approved roots or task never infers or reviews", async () => {
 const root = mkdtempSync(join(tmpdir(), "proactive-compose-off-")); const sessionDir = join(root, "session"); mkdirSync(sessionDir);
 let calls = 0; const service = { evaluate: async () => { calls++; throw new Error("unexpected"); } } as unknown as System1Service;
 const run = async (cfg: ProactiveConfig, task: string | undefined, shared?: System1Service) => {
  let context: any, turnId = "";
  const capture = createHubCapture({ root: () => root, task: () => task, begin: async input => { context = input.context; turnId = input.turnId; return {} as any; }, finish: async () => ({ ...snap("hub", "direct", 0), turnId, context }) });
  const runtime = composeHubProactive({ config: cfg, root, sessionDir, rulesRoots: [], service: shared, capture });
  capture.start(0); capture.end(0, "hello"); await capture.capture;
  for (let i = 0; i < 20 && !runtime.records.length; i++) await new Promise(r => setTimeout(r, 5));
  return { runtime, context };
 };
 const local = await run(config, "actual task", service);
 assert.equal(local.runtime.used, 0); assert.equal(local.runtime.records[0].status, "not_checked");
 const missing = await run({ ...config, remoteContext: "selected-excerpts" }, "actual task");
 assert.equal(missing.runtime.used, 0); assert.equal(missing.runtime.records[0].status, "not_checked");
 const absent = await run({ ...config, remoteContext: "selected-excerpts" }, undefined, service);
 assert.equal(absent.runtime.records[0].status, "not_checked"); assert.equal(absent.context, undefined);
 assert.equal(calls, 0);
});
test("composed native turns use parent task bytes and the Hub catalog snapshot, never child prose", async () => {
 const root = mkdtempSync(join(tmpdir(), "proactive-native-"));
 const sessionDir = join(root, "session"), dir = join(root, "attempt");
 mkdirSync(sessionDir); mkdirSync(dir); mkdirSync(join(root, "rules"));
 writeFileSync(join(root, "rules", "README.md"), "# Rule\nCheck this unit.\n");
 const cfg: ProactiveConfig = { ...config, remoteContext: "selected-excerpts" };
 const calls: any[] = [];
 const service = { evaluate: async (request: any) => {
  calls.push(request);
  return { status: "ok", evaluation: { metadata: { provider: "fake", requestedModel: "offline", questionSetVersion: request.questionSetVersion, latencyMs: 1, attempts: 1 }, answers: request.questions.map((q: any) => ({ questionId: q.id, type: "choice", value: q.id === "drift" ? "aligned" : "no_observed_violation", uncertainty: { provenance: "provider", confidence: 0.99 } })) } };
 } } as System1Service;
 const capture = createHubCapture({ root: () => root, task: () => undefined });
 const runtime = composeHubProactive({ config: cfg, root, sessionDir, rulesRoots: ["rules"], service, capture });
 const context = capture.nativeContext(sessionDir, "builder", "run-1", "Parent dispatch bytes");
 assert.equal(context?.task.hash, hash("Parent dispatch bytes"));
 assert.equal(context?.rules.length, 1);
 assert.equal(context?.rules[0].hash, hash(readFileSync(join(root, "rules", "README.md"), "utf8")));
 assert.equal(capture.contentFor(`${sessionDir}:builder:run-1:0`)?.task, "Parent dispatch bytes");
 assert.equal(capture.contentFor(`${sessionDir}:builder:other:0`), undefined);
 const assignment: ObserverAssignment = { root, directory: dir, session: sessionDir, owner: "builder", attempt: "run-1", config: cfg, context: context! };
 const unitText = "new unit";
 const sample = (ctx: TurnSnapshot["context"], i: number): TurnSnapshot => ({ ...snap("builder", "run-1", i), turnId: `${sessionDir}:builder:run-1:${i}`, context: ctx, units: [{ id: "unit", path: "src/a.ts", kind: "added", attribution: "observed_only", after: { text: unitText, hash: hash(unitText), offset: 0, endOffset: 8, startLine: 1, endLine: 1, truncated: false } }] });
 const publish = (snapshot: TurnSnapshot, i: number, manifestAttempt = "run-1") => {
  const data = JSON.stringify(snapshot); writeFileSync(join(dir, `snapshot-${i}.json`), data);
  writeFileSync(join(dir, `turn-${i}.json`), JSON.stringify({ producer: "agent-fleet.proactive-observer/v1", session: sessionDir, owner: "builder", attempt: manifestAttempt, turnIndex: i, turnId: snapshot.turnId, status: "captured", snapshot: { path: `snapshot-${i}.json`, hash: hash(data), snapshotId: snapshot.snapshotId, bytes: Buffer.byteLength(data) } }));
 };
 publish(sample({ ...context!, task: { ...context!.task, hash: hash("child task") } }, 0), 0);
 assert.equal(ingestObserverManifests(assignment, runtime.submit), 0); // forged task
 publish(sample({ ...context!, rules: [] }, 0), 0);
 assert.equal(ingestObserverManifests(assignment, runtime.submit), 0); // missing refs
 publish(sample(context!, 0), 0, "stale");
 assert.equal(ingestObserverManifests(assignment, runtime.submit), 0);
 publish(sample(context!, 0), 0);
 assert.equal(ingestObserverManifests(assignment, runtime.submit), 1);
 for (let i = 0; i < 40 && !runtime.records.length; i++) await new Promise(r => setTimeout(r, 5));
 assert.equal(calls.length, 1);
 assert.equal(calls[0].state.task, "Parent dispatch bytes");
 assert.equal(calls[0].state.pairs.length, 1);
 assert.equal(runtime.records[0].assessment?.rules[0]?.ruleId, calls[0].state.pairs[0].ruleId);
 assert.equal(runtime.records[0].status, "reviewed");
 // A child with the right task hash but no catalog refs cannot close coverage.
 capture.nativeContext(sessionDir, "builder", "run-empty", "Parent dispatch bytes");
 const empty = { ...context!, rules: [] };
 const missingRefs: ObserverAssignment = { ...assignment, context: empty, attempt: "run-empty" };
 const emptySnapshot = { ...sample(empty, 1), turnId: `${sessionDir}:builder:run-empty:1` };
 const emptyData = JSON.stringify(emptySnapshot);
 writeFileSync(join(dir, "snapshot-1.json"), emptyData);
 writeFileSync(join(dir, "turn-1.json"), JSON.stringify({ producer: "agent-fleet.proactive-observer/v1", session: sessionDir, owner: "builder", attempt: "run-empty", turnIndex: 1, turnId: emptySnapshot.turnId, status: "captured", snapshot: { path: "snapshot-1.json", hash: hash(emptyData), snapshotId: emptySnapshot.snapshotId, bytes: Buffer.byteLength(emptyData) } }));
 assert.equal(ingestObserverManifests(missingRefs, runtime.submit), 1);
 for (let i = 0; i < 40 && runtime.records.length < 2; i++) await new Promise(r => setTimeout(r, 5));
 assert.equal(runtime.records[1].status, "not_checked");
 assert.equal(runtime.records[1].assessment?.gaps.includes("unbound_rules"), true);
 assert.equal(runtime.records[1].assessment?.gaps.includes("unconfigured_rules"), true);
 assert.equal(runtime.records[1].assessment?.ruleCoverage?.length, 0); // unbound rule cannot enter source-backed inventory
 assert.equal(calls.length, 2);
 capture.nativeContext(sessionDir, "builder", "run-2", "Replacement bytes");
 assert.equal(capture.contentFor(`${sessionDir}:builder:run-1:1`), undefined);
 assert.equal(capture.nativeContext("wrong-session", "builder", "run-3", "bad"), undefined);
 capture.reset();
 assert.equal(capture.contentFor(`${sessionDir}:builder:run-2:0`), undefined);
});
test("native assignment validates attempt, owner, sequence, paths, hashes and bounded snapshot", () => {
 const root = mkdtempSync(join(tmpdir(), "proactive-runtime-")); const dir = join(root, "attempt"); mkdirSync(dir);
 const assignment: ObserverAssignment = { root, directory: dir, session: "session", owner: "a", attempt: "1", config, context: snap("a", "1", 0).context };
 const snapshot = snap("a", "1", 0), data = JSON.stringify(snapshot);
 writeFileSync(join(dir, "snapshot-0.json"), data);
 const manifest = { producer: "agent-fleet.proactive-observer/v1", session: "session", owner: "a", attempt: "1", turnIndex: 0, turnId: snapshot.turnId, status: "captured", snapshot: { path: "snapshot-0.json", hash: hash(data), snapshotId: snapshot.snapshotId, bytes: Buffer.byteLength(data) } };
 const file = join(dir, "turn-0.json"); let calls = 0;
 const ingest = () => ingestObserverManifests(assignment, () => { calls++; return true; });
 writeFileSync(file, JSON.stringify({ ...manifest, owner: "b" })); assert.equal(ingest(), 0);
 writeFileSync(file, JSON.stringify({ ...manifest, attempt: "stale" })); assert.equal(ingest(), 0);
 writeFileSync(file, JSON.stringify({ ...manifest, turnIndex: 1 })); assert.equal(ingest(), 0);
 writeFileSync(file, JSON.stringify({ ...manifest, snapshot: { ...manifest.snapshot, path: "../escape" } })); assert.equal(ingest(), 0);
 writeFileSync(file, JSON.stringify({ ...manifest, snapshot: { ...manifest.snapshot, hash: hash("wrong") } })); assert.equal(ingest(), 0);
 writeFileSync(file, JSON.stringify(manifest)); assert.equal(ingest(), 1); assert.equal(calls, 1);
});

test("Hub capture failures recover after task/root/plan/submit throws without poisoning future turns", async () => {
 for (const failure of ["task","root","plan","submit"] as const) {
  let fail=true, turnId="", context:any;
  const runtime=createProactiveRuntime({config});
  const original=runtime.submit;
  if (failure==="submit") (runtime as any).submit=(...args:Parameters<typeof original>)=>{ if (fail) {fail=false;throw Error("SECRET_PAYLOAD");}return original(...args);};
  const hooks=createHubCapture({root:()=>{if(failure==="root" && fail){fail=false;throw Error("SECRET_PAYLOAD");}return ".";},
   task:()=>{if(failure==="task" && fail){fail=false;throw Error("SECRET_PAYLOAD");}return "task";},
   plan:()=>{if(failure==="plan" && fail){fail=false;throw Error("SECRET_PAYLOAD");}return undefined;},
   begin:async input=>{turnId=input.turnId;context=input.context;return {} as any;},
   finish:async()=>({...snap("hub","direct",Number(turnId.split(":").at(-1))),turnId,context})});
  hooks.initialize(config,runtime);hooks.bindSession("session");
  await hooks.start(0);hooks.end(0,"SECRET_PAYLOAD");await hooks.capture;
  assert.deepEqual(runtime.records.map(r=>r.status),["not_checked"],failure);
  await hooks.start(1);hooks.end(1,"second");await hooks.capture;
  assert.deepEqual(runtime.records.map(r=>r.status),["not_checked","not_checked"],failure);
  assert.doesNotMatch(JSON.stringify(runtime.records),/SECRET_PAYLOAD/);
 }
});
