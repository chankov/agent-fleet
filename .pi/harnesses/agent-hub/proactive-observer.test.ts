import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PROACTIVE_OBSERVER_ENV, isProactiveSpecialist, observerStatus, type ObserverAssignment, type ObserverManifest } from "./proactive-observer.ts";
import { loadProactiveConfig, parseProactiveConfig } from "./proactive-config.ts";
import { sessionObserverAssignment } from "./dispatch-native-prepare.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const pi = join(repo, "node_modules/.bin/pi");
const observer = fileURLToPath(new URL("./proactive-observer.ts", import.meta.url));
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(t: { after: (fn: () => void) => void }) {
 const dir = mkdtempSync(join(repo, ".tmp-p4-observer-"));
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
 writeFileSync(join(dir, "sample.md"), "original\n");
 assert.equal(spawnSync("git", ["-C", dir, "add", "sample.md"]).status, 0);
 assert.equal(spawnSync("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]).status, 0);
 const assignment: ObserverAssignment = { root: dir, directory: join(dir, "attempt-1"), session: "session-1", owner: "builder", attempt: "attempt-1", config: parseProactiveConfig({ version: 1, mode: "shadow", remoteContext: "selected-excerpts", include: ["sample.md"] }), context: { task: { path: "dispatch", hash: digest("task"), revision: "r1" }, rules: [], exceptions: [] } };
 // Include syntax accepts nested glob; the explicit path is enough for this fixture.
 return { dir, assignment };
}
function run(dir: string, assignment: ObserverAssignment | null, variant: "text" | "tool" | "aborted" = "text") {
 const providerPath = join(dir, "provider.ts");
 writeFileSync(providerPath, `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
let n = 0;
export default function(pi) {
 pi.registerTool({ name: "fixture_write", label: "Fixture write", description: "Fixture only", parameters: Type.Object({}), async execute() { writeFileSync("sample.md", "changed by tool\\n"); return { content: [{ type: "text", text: "done" }] }; } });
 pi.registerProvider("observer-fixture", { name: "Offline fixture", baseUrl: "http://127.0.0.1", apiKey: "fixture", api: "observer-fixture-api", models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 100 }], streamSimple(model) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
   n++;
   const msg = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
   stream.push({ type: "start", partial: msg });
   if (${JSON.stringify(variant)} === "tool" && n === 1) { const toolCall = { type: "toolCall", id: "one", name: "fixture_write", arguments: {} }; msg.content.push(toolCall); stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg }); stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: msg }); msg.stopReason = "toolUse"; }
   else { msg.content.push({ type: "text", text: "authored answer" }); stream.push({ type: "text_start", contentIndex: 0, partial: msg }); stream.push({ type: "text_delta", contentIndex: 0, delta: "authored answer", partial: msg }); stream.push({ type: "text_end", contentIndex: 0, content: "authored answer", partial: msg }); if (${JSON.stringify(variant)} === "aborted") msg.stopReason = "aborted"; }
   stream.push({ type: "done", reason: msg.stopReason, message: msg }); stream.end();
  }); return stream;
 } });
}
`);
 const env = { ...process.env, PI_OFFLINE: "1", TEST_KEY_SENTINEL: "must-not-enter-manifest", ...(assignment ? { [PROACTIVE_OBSERVER_ENV]: JSON.stringify(assignment) } : {}) };
 const result = spawnSync(pi, ["--mode", "print", "--no-session", "--no-extensions", "-e", providerPath, "-e", observer, "--model", "observer-fixture/m", "prompt"], { cwd: dir, env, encoding: "utf8", timeout: 20_000 });
 assert.equal(result.status, variant === "aborted" ? 1 : 0, `local Pi failed: ${result.error?.message ?? ""} ${result.stderr} ${result.stdout}`);
 return result;
}

test("real repository-local Pi 0.84.2 delivers text and tool turn boundaries to awaited subprocess snapshots", t => {
 assert.match(spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout, /0\.84\.2/);
 for (const variant of ["text", "tool"] as const) {
  const { dir, assignment } = fixture(t);
  run(dir, assignment, variant);
  const names = readdirSync(assignment.directory).filter(n => /^turn-\d+\.json$/.test(n));
  assert.equal(names.length, variant === "tool" ? 2 : 1);
  let sawToolWrite = false;
  const observed: unknown[] = [];
  for (const name of names) {
   const manifest = JSON.parse(readFileSync(join(assignment.directory, name), "utf8")) as ObserverManifest;
   assert.equal(manifest.status, "captured");
   assert.equal(manifest.turnId, `${assignment.session}:${assignment.owner}:${assignment.attempt}:${manifest.turnIndex}`);
   const ref = manifest.snapshot!;
   const raw = readFileSync(join(assignment.directory, ref.path), "utf8");
   assert.equal(digest(raw), ref.hash);
   assert.equal(Buffer.byteLength(raw), ref.bytes);
   assert.ok(!raw.includes("must-not-enter-manifest"));
   const snap = JSON.parse(raw);
   observed.push({ index: manifest.turnIndex, status: snap.status, gaps: snap.gaps, paths: snap.units.map((u: { path: string }) => u.path) });
   assert.equal(snap.snapshotId, ref.snapshotId);
   if (snap.units.some((u: { path: string }) => u.path === "sample.md")) sawToolWrite = true;
  }
  if (variant === "tool") assert.ok(sawToolWrite, `tool mutation must appear at an actual Pi turn boundary: ${JSON.stringify(observed)}, file=${readFileSync(join(dir, "sample.md"), "utf8")}`);
 }
});

test("aborted real Pi turn records incomplete evidence without claiming review", t => {
 const { dir, assignment } = fixture(t);
 run(dir, assignment, "aborted");
 const records = readdirSync(assignment.directory).filter(n => /^turn-\d+\.json$/.test(n));
 assert.ok(records.length > 0);
 const manifest = JSON.parse(readFileSync(join(assignment.directory, records[0]), "utf8")) as ObserverManifest;
 assert.equal(manifest.status, "incomplete");
 assert.equal(manifest.reason, "aborted");
});

test("resumed run starts at turn zero in a distinct parent-assigned attempt", t => {
 const { dir, assignment } = fixture(t);
 run(dir, assignment);
 const next = { ...assignment, directory: join(dir, "attempt-2"), attempt: "attempt-2" };
 run(dir, next);
 const a = JSON.parse(readFileSync(join(assignment.directory, "turn-0.json"), "utf8")) as ObserverManifest;
 const b = JSON.parse(readFileSync(join(next.directory, "turn-0.json"), "utf8")) as ObserverManifest;
 assert.equal(a.turnIndex, 0);
 assert.equal(b.turnIndex, 0);
 assert.notEqual(a.turnId, b.turnId);
 assert.equal(a.snapshot?.snapshotId === b.snapshot?.snapshotId, false);
});

test("native observer uses frozen session config across attempts; fresh session sees edits", t => {
 const { dir, assignment } = fixture(t);
 const configPath = join(dir, ".ai", "proactive-review.json");
 const writeConfig = (mode: "off" | "shadow" | "advisory", include?: string[]) => {
  mkdirSync(join(dir, ".ai"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ version: 1, mode, ...(include ? { include } : {}) }));
 };
 const { config: _config, ...identity } = assignment;
 const assigned = (config: ReturnType<typeof loadProactiveConfig>, attempt: string) => sessionObserverAssignment(config, "builder", { ...identity, attempt, directory: join(dir, attempt) });

 // A session started without consumer config cannot gain capture mid-session.
 const missing = loadProactiveConfig(dir);
 assert.equal(assigned(missing, "missing-1"), undefined);
 writeConfig("shadow", ["sample.md"]);
 assert.equal(assigned(missing, "missing-2"), undefined);
 const shadow = loadProactiveConfig(dir);
 assert.equal(assigned(shadow, "shadow-1")?.config, shadow);

 // Removing or changing the config on disk cannot revoke or expand a running session.
 writeConfig("advisory", ["docs/**"]);
 assert.equal(assigned(shadow, "shadow-2")?.config, shadow);
 assert.deepEqual(assigned(shadow, "shadow-2")?.config.include, ["sample.md"]);
 const advisory = loadProactiveConfig(dir);
 assert.equal(assigned(advisory, "advisory-1")?.config, advisory);
 assert.deepEqual(advisory.include, ["docs/**"]);

 writeConfig("off");
 assert.equal(assigned(advisory, "advisory-2")?.config, advisory);
 const off = loadProactiveConfig(dir);
 assert.equal(assigned(off, "off-1"), undefined);
 writeConfig("shadow", ["sample.md"]);
 assert.equal(assigned(off, "off-2"), undefined);
 assert.equal(assigned(loadProactiveConfig(dir), "fresh-1")?.config.mode, "shadow");
 assert.equal(sessionObserverAssignment(shadow, "researcher", identity), undefined);
});

test("specialist guard excludes research and review recursion", () => {
 assert.equal(isProactiveSpecialist("builder"), true);
 for (const name of ["researcher", "deep-researcher", "reviewer", "code-reviewer", "security-auditor", "test-engineer", "system1", "system-one-judge"]) assert.equal(isProactiveSpecialist(name), false, name);
});

test("off and absent assignment create zero capture; missing hook is not_instrumented", t => {
 const { dir, assignment } = fixture(t);
 run(dir, null);
 assert.equal(existsSync(assignment.directory), false);
 assert.equal(observerStatus(assignment.directory, false), "not_instrumented");
 run(dir, { ...assignment, config: parseProactiveConfig({ version: 1, mode: "off" }) });
 assert.equal(existsSync(assignment.directory), false);
});
