// Real-Pi task-triage acceptance (C2 B5): loads the PRODUCTION agent-hub
// extension in a real Pi runtime with an injectable fake shared System 1
// service with a guarded fake transport (AGENT_HUB_TASK_TRIAGE_FAKE — test-only
// seam in index.ts, not a separate provider/service) and a network guard. Gathers actual registered-hook evidence for
// operator/orchestrator task-triage paths.
//
// No real API/model credentials: the child environment uses a whitelisted
// synthetic readiness key and NODE_OPTIONS preloads
// bin/test/helpers/system1-no-network.js, which fails the child process on
// any HTTPS attempt.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const hubDir = join(repoRoot, ".pi/harnesses/agent-hub");
const piExecutable = join(repoRoot, "node_modules/.bin/pi");
const noNetworkPreload = join(repoRoot, "bin/test/helpers/system1-no-network.js");
const README_CHECK = `node -e 'const fs=require("node:fs");process.exit(fs.readFileSync("README.md","utf8")==="The widget renders a greeting.\\n"?0:1)'`; 

const TRIAGE_CONFIG = {
  version: 1, mode: "experimental", remoteContextApproved: true,
  provider: "typesafe", model: "jev-1.13.0",
  questionVersion: "task-triage/questions/v1", policyVersion: "task-triage/policy/v1",
  limits: { maxTaskBytes: 40960, maxStateBytes: 65536, maxCallsPerSession: 100, timeoutMs: 2000 },
};

type ScriptStep = { text: string } | { tool: string; args: Record<string, unknown> };

const PROBE_SOURCE = String.raw`
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const eventsPath = process.env.TRIAGE_E2E_EVENTS as string;
const contextsPath = process.env.TRIAGE_E2E_CONTEXTS as string;
const script = JSON.parse(process.env.TRIAGE_E2E_SCRIPT as string);
const rec = (p: string, v: unknown) => appendFileSync(p, JSON.stringify(v) + "\n");
let calls = 0;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
export default function (pi: any) {
  for (const h of ["session_start", "input", "before_agent_start", "turn_end", "session_shutdown"]) {
    pi.on(h, () => rec(eventsPath, { hook: h, at: Date.now() }));
  }
  pi.on("tool_result", (event: any) => rec(eventsPath, {
    hook: "tool_result", id: event.toolCallId, tool: event.toolName,
    isError: event.isError, details: event.details,
    text: clip((event.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"), 3000),
  }));
  pi.registerProvider("triage-e2e", { name: "triage-e2e", baseUrl: "http://127.0.0.1", apiKey: "fixture", api: "triage-e2e-api",
    models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 2000 }],
    streamSimple(model: any, ctx: any) {
      const stream = createAssistantMessageEventStream(); calls++;
      queueMicrotask(() => {
        const step = script[Math.min(calls - 1, script.length - 1)];
        rec(contextsPath, { call: calls, tools: (ctx.tools ?? []).map((t: any) => t.name), step,
          promptSignals: { securityChange: String(ctx.systemPrompt ?? "").includes("security_change"), review: String(ctx.systemPrompt ?? "").includes("review") },
          inbound: clip(JSON.stringify(ctx.messages ?? []), 30000),
          results: (ctx.messages ?? []).filter((m: any) => m.role === "toolResult").map((m: any) => ({
            id: m.toolCallId, isError: m.isError, details: m.details,
            text: clip((m.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"), 3000),
          })) });
        const msg: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: msg });
        if (step && (step as any).tool) {
          const tc = { type: "toolCall", id: "e2e-" + calls, name: (step as any).tool, arguments: (step as any).args ?? {} };
          msg.content.push(tc);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tc, partial: msg });
          msg.stopReason = "toolUse";
        } else {
          const text = (step as any)?.text ?? "done";
          msg.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: msg });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
        }
        stream.push({ type: "done", reason: msg.stopReason, message: msg }); stream.end();
      });
      return stream;
    }});
}
`;

const CHILD_PROVIDER_SOURCE = String.raw`
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
let calls = 0;
export default function (pi: any) {
  pi.on("tool_result", (event: any) => { if (event.toolName === "bash") appendFileSync(process.env.TRIAGE_CHILD_EVENTS as string, JSON.stringify({ role: "tool_result", tool: "bash", isError: event.isError, runtimeTest: event.details?.runtimeTest ?? null }) + "\n"); });
  pi.registerProvider("triage-e2e", { name: "triage-e2e", baseUrl: "http://127.0.0.1", apiKey: "fixture", api: "triage-e2e-api", 
    models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 2000 }],
    streamSimple(model: any, ctx: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const results = (ctx.messages ?? []).filter((m: any) => m.role === "toolResult");
        const prompt = JSON.stringify((ctx.messages ?? []).filter((m: any) => m.role === "user"));
        const role = prompt.includes("BUILDER FIXTURE:") ? "builder" : prompt.includes("REVIEW FIXTURE:") ? "reviewer" : "planner";
        const readText = (results[0]?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        const readOk = !!results.length && !results[0].isError && (role === "reviewer" ? readText.includes("widget renders") && !readText.includes("wdiget renders") : readText.includes("wdiget renders"));
        const lastOk = !!results.length && !results.at(-1).isError;
        const step: any = role === "builder" ? results.length === 0 ? { tool: "read", args: { path: "README.md" } }
          : results.length === 1 && readOk ? { tool: "edit", args: { path: "README.md", oldText: "wdiget renders", newText: "widget renders" } }
          : results.length === 2 && lastOk ? { tool: "bash", args: { command: process.env.TRIAGE_CHILD_CHECK } }
          : { text: results.length === 3 && lastOk ? "BUILDER FIXTURE: exact README correction and declared runtime check completed." : "BUILDER REFUSED: read, edit or check failed." }
          : role === "reviewer" ? results.length === 0 ? { tool: "read", args: { path: "README.md" } }
          : { text: readOk ? "VERDICT: APPROVE\nchanged_files: [README.md]\nassertions_proven: []\nassertions_unproven: []\nassertions_failed: []\ntests_run: full regression\nopen_risks: [fixture-only inspection; not an independent A1 return]\nrequires_user_decision: []" : "VERDICT: REJECT\nassertions_unproven: [README content not verified]" }
          : results.length ? { text: readOk ? "PLAN: Correct only wdiget renders to widget renders in README.md; preserve other bytes and verify the exact change before review." : "PLAN REFUSED: README read was not verified." }
          : { tool: "read", args: { path: "README.md" } }; 
        appendFileSync(process.env.TRIAGE_CHILD_EVENTS as string, JSON.stringify({ pid: process.pid, role, call: ++calls, tools: (ctx.tools ?? []).map((t: any) => t.name), readOk, lastOk, step: step.tool ?? "return" }) + "\n");
        const msg: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: msg });
        if (step.tool) {
          const tc = { type: "toolCall", id: "child-read-" + calls, name: step.tool, arguments: step.args };
          msg.content.push(tc); stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tc, partial: msg }); msg.stopReason = "toolUse";
        } else {
          msg.content.push({ type: "text", text: step.text });
          stream.push({ type: "text_start", contentIndex: 0, partial: msg });
          stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: msg });
          stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: msg });
        }
        stream.push({ type: "done", reason: msg.stopReason, message: msg }); stream.end();
      });
      return stream;
    } });
}
`;

interface RpcSession {
  loadedHubEntry: string;
  request(message: string): Promise<any>;
  childEvents(): any[];
  notifications(): string[];
  contexts(): any[];
  events(): any[];
  fakeCalls(): any[];
  triageStates(): any[];
  close(): Promise<void>;
  decisions(): { title: string; value: string }[];
  rpc(message: Record<string, unknown>): Promise<any>;
}

const workspaceSessions = new Map<string, RpcSession[]>();
function setupWorkspace(t: any, opts: { team?: string; personas?: string[]; childProvider?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "triage-real-pi-"));
  const offlinePreloaded = process.execArgv.some(arg => arg.includes("system1-no-network.js")) ||
    process.env.NODE_OPTIONS?.split(/\s+/).includes(`--import=${noNetworkPreload}`);
  const retainIndex = opts.childProvider && process.env.PI_OFFLINE === "1" && offlinePreloaded &&
    process.env.AGENT_HUB_TASK_TRIAGE_RETAIN_INDEX?.startsWith(join(tmpdir(), "c2-real-pi-stage-"))
    ? process.env.AGENT_HUB_TASK_TRIAGE_RETAIN_INDEX : null;
  workspaceSessions.set(dir, []);
  t.after(async () => {
    try {
      for (const session of workspaceSessions.get(dir)!.reverse()) await session.close();
    } finally {
      workspaceSessions.delete(dir);
      if (retainIndex) appendFileSync(retainIndex, `${JSON.stringify({ fixture: dir, purpose: "offline native stage evidence" })}\n`);
      else rmSync(dir, { recursive: true, force: true });
    }
  });
  mkdirSync(join(dir, ".ai"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, ".ai/task-triage.json"), JSON.stringify(TRIAGE_CONFIG));
  writeFileSync(join(dir, ".ai/agent-fleet.json"), JSON.stringify({ features: { system1: true } }));
  writeFileSync(join(dir, ".ai/system1.json"), JSON.stringify({ version: 1, mode: "auto", provider: "typesafe", model: "jev-1.13.0", apiKeyEnv: "TYPESAFE_API_KEY" }));
  writeFileSync(join(dir, "probe.ts"), PROBE_SOURCE);
  if (opts.childProvider) {
    const childProvider = join(dir, "child-provider.ts");
    mkdirSync(join(dir, "bin"));
    writeFileSync(childProvider, CHILD_PROVIDER_SOURCE);
    writeFileSync(join(dir, "bin/pi"), `#!/bin/sh\n[ "$PI_OFFLINE" = "1" ] || exit 88\ncase "$NODE_OPTIONS" in *system1-no-network.js*) ;; *) exit 89;; esac\nexec ${JSON.stringify(piExecutable)} -e ${JSON.stringify(childProvider)} "$@"\n`, { mode: 0o700 });
  }
  if (opts.team) {
    const members = opts.personas ?? ["probe-builder"];
    mkdirSync(join(dir, ".pi/agents/personas"), { recursive: true });
    writeFileSync(join(dir, ".pi/agents/teams.yaml"), `${opts.team}:\n${members.map(m => `  - ${m}`).join("\n")}\n`);
    for (const member of members) {
      const desc = member === "probe-builder" ? "Minimal fixture builder for real-Pi triage acceptance" : `Minimal fixture ${member} for real-Pi stage acceptance`;
      writeFileSync(join(dir, `.pi/agents/personas/${member}.md`),
        `---\nname: ${member}\ndescription: ${desc}\ntools: ${opts.childProvider && member === "probe-builder" ? "read,edit,bash" : "read"}\nmodel: triage-e2e/m\n---\n\n# ${member}\n`);
    }
  }
  return dir;
}

async function startSession(t: any, dir: string, opts: { fake: string; script: ScriptStep[]; fleetArgs?: string[]; decisions?: string[]; childProvider?: boolean; hubEntry?: string; offlineGuardPath?: string; persistSession?: boolean; savedSession?: string }): Promise<RpcSession> {
  const recordId = workspaceSessions.get(dir)!.length + 1;
  const loadedHubEntry = opts.hubEntry ?? join(hubDir, "index.ts");
  const env: Record<string, string> = {
    PATH: opts.childProvider ? `${join(dir, "bin")}:${process.env.PATH}` : process.env.PATH!,
    HOME: join(dir, "home"),
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    PI_OFFLINE: "1",
    AGENT_SKILLS_NO_UPDATE_CHECK: "1",
    TYPESAFE_API_KEY: "synthetic-test-only-key",
    TMPDIR: dir,
    TRIAGE_E2E_EVENTS: join(dir, `events-${recordId}.ndjson`),
    TRIAGE_E2E_CONTEXTS: join(dir, `contexts-${recordId}.ndjson`),
    TRIAGE_CHILD_EVENTS: join(dir, `child-events-${recordId}.ndjson`),
    TRIAGE_CHILD_CHECK: README_CHECK,
    TRIAGE_E2E_SCRIPT: JSON.stringify(opts.script),
    AGENT_HUB_TASK_TRIAGE_FAKE: opts.fake,
    AGENT_HUB_TASK_TRIAGE_FAKE_RECORD: join(dir, `fake-calls-${recordId}.ndjson`),
    AGENT_HUB_TASK_TRIAGE_FAKE_STATE_RECORD: join(dir, `triage-states-${recordId}.ndjson`),
    NODE_OPTIONS: `--import=${opts.offlineGuardPath ?? noNetworkPreload}`,
  };
  assert.equal(env.TYPESAFE_API_KEY, "synthetic-test-only-key", "only the synthetic readiness key reaches the guarded child");
  const child: ChildProcess = spawn(piExecutable, [
    "--mode", "rpc", ...(opts.savedSession ? ["--session", opts.savedSession] : opts.persistSession ? ["--session-dir", join(dir, "saved-pi")] : ["--no-session"]), "--no-extensions",
    "-e", join(repoRoot, ".pi/harnesses/damage-control-continue/index.ts"),
    "-e", join(repoRoot, ".pi/harnesses/ask-user-remote/index.ts"),
    "-e", loadedHubEntry,
    "-e", join(dir, "probe.ts"),
    ...(opts.fleetArgs ?? ["--solo", "--work-mode", "operator"]),
    "--model", "triage-e2e/m",
  ], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let seq = 0;
  let ended = false;
  let turns = 0;
  const turnWaiters = new Set<() => void>();
  const failPending = (reason: string) => {
    ended = true;
    for (const wake of turnWaiters) wake();
    turnWaiters.clear();
    for (const callback of pending.values()) callback({ success: false, error: reason });
    pending.clear();
  };
  child.once("error", e => failPending(`Pi spawn error: ${e.message}`));
  child.once("close", (code, signal) => failPending(`Pi exited (${code ?? signal}): ${errText.slice(-4000)}`));
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid && !ended) {
      try { process.kill(-child.pid, signal); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
    }
  };
  let outBuf = "";
  let errText = "";
  let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("close", (code, signal) => { exitStatus = { code, signal }; });
  const pending = new Map<string, (e: any) => void>();
  const notes: string[] = [];
  const decisions: { title: string; value: string }[] = [];
  child.stderr!.on("data", c => { errText += String(c); });
  child.stdout!.on("data", c => {
    outBuf += String(c);
    for (;;) {
      const nl = outBuf.indexOf("\n");
      if (nl < 0) break;
      const line = outBuf.slice(0, nl).replace(/\r$/, "");
      outBuf = outBuf.slice(nl + 1);
      if (!line) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "agent_end") {
        turns++;
        for (const wake of turnWaiters) wake();
      }
      if (ev.type === "response" && ev.id && pending.has(ev.id)) {
        const r = pending.get(ev.id)!;
        pending.delete(ev.id);
        r(ev);
      }
      if (ev.type === "extension_ui_request" && ev.method === "notify") notes.push(String(ev.message ?? ""));
      if (ev.type === "extension_ui_request" && ev.method === "select") {
        const value = opts.decisions?.[decisions.length];
        if (!value || !ev.options?.includes(value)) {
          signalGroup("SIGTERM");
          continue;
        }
        decisions.push({ title: String(ev.title ?? ""), value });
        child.stdin!.write(`${JSON.stringify({ type: "extension_ui_response", id: ev.id, value })}\n`);
      }
    }
  });
  const readNdjson = (p: string) => existsSync(p)
    ? readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  const rpc = (message: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    if (ended) { reject(new Error(`Pi already exited: ${errText}`)); return; }
    const id = `triage-e2e-${++seq}`;
    const timer = setTimeout(() => { pending.delete(id); signalGroup("SIGTERM"); reject(new Error(`RPC timeout: ${message.type}\n${errText}`)); }, 30_000);
    pending.set(id, ev => { clearTimeout(timer); resolve(ev); });
    child.stdin!.write(`${JSON.stringify({ ...message, id })}\n`);
  });
  const session: RpcSession = {
    loadedHubEntry,
    rpc,
    childEvents: () => readNdjson(env.TRIAGE_CHILD_EVENTS),
    request: async (message: string) => {
      const previousTurns = turns;
      const response = await rpc({ type: "prompt", message });
      if (!response.success || message.startsWith("/")) return response;
      if (turns > previousTurns) return response;
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          if (turns <= previousTurns && !ended) return;
          clearTimeout(timer); turnWaiters.delete(wake);
          if (ended && turns <= previousTurns) reject(new Error(`Pi exited before agent_end: ${errText}`));
          else resolve();
        };
        const timer = setTimeout(() => {
          turnWaiters.delete(wake);
          signalGroup("SIGTERM");
          reject(new Error(`agent_end timeout for ${message}\n${errText}`));
        }, 60_000);
        turnWaiters.add(wake);
        wake();
      });
      return response;
    },
    notifications: () => [...notes],
    decisions: () => [...decisions],
    contexts: () => readNdjson(env.TRIAGE_E2E_CONTEXTS),
    events: () => readNdjson(env.TRIAGE_E2E_EVENTS),
    fakeCalls: () => readNdjson(env.AGENT_HUB_TASK_TRIAGE_FAKE_RECORD),
    triageStates: () => readNdjson(env.AGENT_HUB_TASK_TRIAGE_FAKE_STATE_RECORD),
    close: async () => {
      if (!ended) {
        child.stdin!.end();
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(grace); clearTimeout(kill); clearTimeout(bound); resolve(); };
          child.once("close", finish);
          const grace = setTimeout(() => signalGroup("SIGTERM"), 2_000);
          const kill = setTimeout(() => signalGroup("SIGKILL"), 3_000);
          const bound = setTimeout(() => { child.off("close", finish); finish(); }, 5_000);
        });
      }
      assert.doesNotMatch(errText, /System 1 offline tests forbid network requests/, "network guard must not trip");
      assert.deepEqual(exitStatus, { code: 0, signal: null }, `Pi must exit cleanly without an offline-guard latch: ${errText}`);
    },
  };
  workspaceSessions.get(dir)!.push(session);
  return session;
}

const hookTypes = (s: RpcSession) => s.events().map(e => e.hook);
const inboundText = (s: RpcSession) => s.contexts().map(c => String(c.inbound ?? "")).join("\n").replaceAll('\\"', '"');
const toolResult = (s: RpcSession, call: number) => s.contexts().flatMap(c => c.results ?? []).find(r => r.id === `e2e-${call}`);

test("extracted tarball real Pi off to consented gates to disabled saved-session resume", { timeout: 240_000 }, async t => {
  const dir = setupWorkspace(t);
  rmSync(join(dir, ".ai/task-triage.json")); rmSync(join(dir, ".ai/agent-fleet.json")); rmSync(join(dir, ".ai/system1.json"));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const extracted = join(dir, "package"); mkdirSync(extracted);
  execFileSync("tar", ["-xzf", join(dir, packed[0].filename), "--strip-components=1", "-C", extracted]);
  const cli = join(extracted, "bin/cli.js");
  const setup = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, "setup", "--workspace", dir, "--preset", "default", ...args, "--yes"], {
      encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1", NODE_OPTIONS: `--import=${noNetworkPreload}`, TYPESAFE_API_KEY: "" },
    }); assert.equal(result.status, 0, result.stderr);
  };
  setup("--features", "none");
  for (const runtimeRoot of [".pi/harnesses", ".pi/agent-fleet/scripts", ".pi/extensions"]) {
    const deps = join(dir, runtimeRoot, "node_modules"); if (!existsSync(deps)) symlinkSync(join(repoRoot, "node_modules"), deps, "dir");
  }
  const installedHub = join(dir, ".pi/harnesses/agent-hub/index.ts");
  assert.equal(readFileSync(installedHub, "utf8"), readFileSync(join(extracted, ".pi/harnesses/agent-hub/index.ts"), "utf8"));
  const fixtureGuard = join(dir, "bin/test/helpers/system1-no-network.js");
  mkdirSync(join(dir, "bin/test/helpers"), { recursive: true }); copyFileSync(noNetworkPreload, fixtureGuard);
  const off = await startSession(t, dir, { fake: "security", script: [{ text: "off" }], hubEntry: installedHub, offlineGuardPath: fixtureGuard });
  await off.request("Synthetic off baseline"); assert.equal(off.fakeCalls().length, 0); await off.close();
  setup("--features", "system1-task-triage", "--task-triage-consent", "--save-desired");
  assert.equal(JSON.parse(readFileSync(join(dir, ".ai/agent-fleet.json"), "utf8")).features["system1-task-triage"], true);
  const humanConfig = readFileSync(join(dir, ".ai/task-triage.json"), "utf8");
  const active = await startSession(t, dir, { fake: "security", script: [{ tool: "write", args: { path: "README.md", content: "synthetic" } },
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", reason: "synthetic installed classification" } }, { text: "done" }],
    hubEntry: installedHub, offlineGuardPath: fixtureGuard, persistSession: true });
  await active.request("Synthetic installer trust-boundary change and verify acceptance criteria");
  assert.equal(active.loadedHubEntry, installedHub);
  assert.equal(active.triageStates().find(s => s.phase === "assessment")?.calls, 1, "installed first task evaluates before its first model turn");
  assert.equal(active.fakeCalls().length, 2, "explicit scope classification triggers one further scoped evaluation");
  assert.notEqual(active.fakeCalls()[0].stateFingerprint, active.fakeCalls()[1].stateFingerprint, "second call evaluates changed scope, not a duplicate hook");
  const state = (await active.rpc({ type: "get_state" })).data; assert.ok(state.sessionFile?.startsWith(dir));
  const entries = (await active.rpc({ type: "get_entries" })).data.entries;
  const processRecord = entries.filter((e: any) => e.customType === "agent-hub-process-state").at(-1).data;
  assert.equal(processRecord.obligations.review.status, "open");
  const original = processRecord.state.additions;
  assert.equal(original.length, 1); assert.equal(original[0].reason, "security_change");
  await active.close();
  setup("--features", "none", "--save-desired"); assert.equal(readFileSync(join(dir, ".ai/task-triage.json"), "utf8"), humanConfig);
  assert.equal(JSON.parse(readFileSync(join(dir, ".ai/agent-fleet.json"), "utf8")).features["system1-task-triage"], false);
  const resumed = await startSession(t, dir, { fake: "security", script: [
    { tool: "set_assertions", args: { assertions: [{ id: "A1", tag: "test", text: "Installed change independently reviewed", source: "synthetic tarball fixture", test_command: "node --test fixture" }] } },
    { tool: "update_assertion", args: { id: "A1", status: "proven", evidence: "synthetic evidence" } }, { text: "resumed" }], hubEntry: installedHub,
    offlineGuardPath: fixtureGuard, savedSession: state.sessionFile });
  await resumed.request("Synthetic installer trust-boundary change and verify acceptance criteria");
  assert.ok(resumed.contexts()[0].tools.includes("update_assertion"), "verification pack is exposed before the resumed proof attempt");
  assert.equal(resumed.fakeCalls().length, 0);
  const restored = (await resumed.rpc({ type: "get_entries" })).data.entries.filter((e: any) => e.customType === "agent-hub-process-state").at(-1).data;
  assert.deepEqual(restored.state.additions, original); assert.equal(restored.obligations.review.status, "open");
  const proof = resumed.events().filter(e => e.hook === "tool_result" && e.tool === "update_assertion").at(-1);
  assert.equal(proof?.details?.status, "refused", `disabled resumed consumer cannot bypass the retained review gate: ${JSON.stringify({ events: resumed.events(), calls: resumed.contexts().map(c => ({ tools: c.tools, step: c.step, results: c.results })) })}`);
  assert.equal(proof?.details?.reason, "process_obligations_open");
  assert.equal(packed[0].files.some((f: any) => /task-triage.*(?:test|user-run)|bin\/test\//.test(f.path)), false);
});

test("real Pi active assessment refresh preserves explicit compaction and drops it on ordinary follow-up", { timeout: 90000 }, async t => {
  for (const mode of ["off", "plain", "timeout", "wide"] as const) {
    const dir = setupWorkspace(t);
    if (mode === "off") writeFileSync(join(dir, ".ai/task-triage.json"), JSON.stringify({ ...TRIAGE_CONFIG, mode: "off", remoteContextApproved: false }));
    const session = await startSession(t, dir, { fake: mode === "off" ? "plain" : mode, script: [{ text: "Synthetic capability inspection only; no tool execution." }],
      fleetArgs: ["--solo", "--work-mode", "operator", "-e", join(repoRoot, ".pi/extensions/compact-and-continue/index.ts")] });
    assert.equal((await session.request("Please compact the conversation.")).success, true);
    assert.ok(session.contexts()[0].tools.includes("request_compaction"), `${mode}: current explicit compaction survives pre-model assessment refresh`);
    assert.equal(session.fakeCalls().length, mode === "off" ? 0 : 1, "refresh introduces no extra inference");
    if (mode === "wide") {
      const entries = (await session.rpc({ type: "get_entries" })).data.entries;
      const process = entries.filter((e: any) => e.customType === "agent-hub-process-state").at(-1).data;
      assert.ok(process.additions.some((a: any) => a.reason === "wide_change" && a.status === "active"));
      assert.ok(session.contexts()[0].tools.includes("dispatch_agent"), "new plan/review lease still exposes its producer path");
    }
    const idleDeadline = Date.now() + 10000;
    while ((await session.rpc({ type: "get_state" })).data.isStreaming) {
      assert.ok(Date.now() < idleDeadline, "first fixture turn must finish before ordinary follow-up");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await session.request("Explain this component; no change requested.")).success, true);
    assert.ok(!session.contexts().at(-1).tools.includes("request_compaction"), `${mode}: compaction is not retained for a new ordinary input`);
    assert.equal(session.fakeCalls().length, mode === "off" ? 0 : 2);
    assert.equal(session.events().some(e => e.hook === "tool_result"), false, "inspection fixture performs no compaction/tool effects");
  }
});

test("real Pi first turn uses installed Hub after consented setup and applies active triage", { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t);
  rmSync(join(dir, ".ai/task-triage.json"));
  rmSync(join(dir, ".ai/agent-fleet.json"));
  const setup = spawnSync(process.execPath, [join(repoRoot, "bin/cli.js"), "setup", "--workspace", dir,
    "--preset", "default", "--features", "system1-task-triage", "--task-triage-consent", "--yes"], {
    encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1", NODE_OPTIONS: `--import=${noNetworkPreload}`, TYPESAFE_API_KEY: "" },
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, ".ai/agent-fleet-state.json"), "utf8")).taskTriageSelected, true);
  assert.equal(JSON.parse(readFileSync(join(dir, ".ai/task-triage.json"), "utf8")).remoteContextApproved, true);
  assert.equal(JSON.parse(readFileSync(join(dir, ".ai/system1.json"), "utf8")).mode, "auto");
  const desired = JSON.parse(readFileSync(join(dir, ".ai/agent-fleet.json"), "utf8"));
  assert.equal(desired.features?.["system1-task-triage"], true);
  assert.equal(desired.features?.system1, false, "desired file retains only directly requested features; effective selection includes dependencies");
  const installedHub = join(dir, ".pi/harnesses/agent-hub/index.ts");
  assert.ok(existsSync(installedHub));
  // Setup does not execute npm without --allow-exec. Supply only local fixture
  // dependencies to each installed runtime root; product consent stays intact.
  for (const runtimeRoot of [".pi/harnesses", ".pi/agent-fleet/scripts", ".pi/extensions"]) {
    const deps = join(dir, runtimeRoot, "node_modules");
    if (!existsSync(deps)) symlinkSync(join(repoRoot, "node_modules"), deps, "dir");
  }
  const fixtureGuard = join(dir, "bin/test/helpers/system1-no-network.js");
  mkdirSync(join(dir, "bin/test/helpers"), { recursive: true });
  copyFileSync(noNetworkPreload, fixtureGuard);
  const session = await startSession(t, dir, { fake: "security", script: [{ text: "done" }], hubEntry: installedHub, offlineGuardPath: fixtureGuard });
  assert.equal(session.loadedHubEntry, installedHub, "spawn must select the installed copy, not the source checkout");
  const first = await session.request("change the synthetic installer trust boundary");
  assert.equal(first.success, true, JSON.stringify({ response: first, states: session.triageStates(), events: session.events() }));
  assert.equal(session.triageStates().find(s => s.phase === "service_init")?.consumerPresent, true,
    JSON.stringify({ states: session.triageStates(), events: session.events() }));
  assert.equal(session.triageStates().find(s => s.phase === "assessment")?.status, "applied",
    JSON.stringify({ states: session.triageStates(), fakeCalls: session.fakeCalls() }));
  assert.equal(session.triageStates().find(s => s.phase === "assessment")?.calls, 1);
  assert.equal(session.fakeCalls().length, 1);
  assert.equal(session.contexts()[0]?.promptSignals?.securityChange, true);
  assert.equal(session.contexts()[0]?.promptSignals?.review, true);
});

test("real Pi audit binds current assessment and reports observed calls/attempts without task payload", { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t);
  const session = await startSession(t, dir, { fake: "security", script: [{ text: "done" }] });
  assert.equal((await session.request("PRIVATE_TASK_MARKER change installer trust boundary")).success, true);
  assert.equal((await session.request("/af-audit")).success, true);
  const audit = session.notifications().flatMap(note => { try { const v = JSON.parse(note); return v.schema === "agent-fleet.session-audit/v1" ? [v] : []; } catch { return []; } }).at(-1);
  assert.ok(audit, "actual registered audit command emitted its JSON");
  assert.equal(audit.taskTriage.assessment.status, "applied");
  assert.equal(audit.taskTriage.assessment.binding, "current");
  assert.equal(audit.taskTriage.process.additions[0].binding, "current");
  assert.equal(audit.taskTriage.metrics.logicalCalls.reserved, 1);
  assert.equal(audit.taskTriage.metrics.physicalAttempts.observed, 1);
  assert.equal(audit.taskTriage.metrics.usage.inputTokens, 1);
  assert.equal(audit.taskTriage.taskAcceptance, "not_recorded");
  assert.equal(session.fakeCalls().length, 1, "audit cannot trigger another Jev evaluation");
  assert.equal(session.contexts().length, 1, "audit is human-only, no model turn");
  assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_TASK_MARKER|synthetic-test-only-key/);
  const root = join(dir, ".pi/agent-sessions/sessions");
  const traces = readdirSync(root).flatMap(id => { const p = join(root, id, "artifacts/task-triage-activity/task-triage-events.jsonl"); return existsSync(p) ? [readFileSync(p, "utf8")] : []; });
  assert.equal(traces.length, 1); assert.doesNotMatch(traces[0], /PRIVATE_TASK_MARKER|synthetic-test-only-key/);
  assert.equal((await session.request("A different installer change")).success, true);
  assert.equal((await session.request("/af-audit")).success, true);
  const pending = session.notifications().flatMap(note => { try { const v = JSON.parse(note); return v.schema === "agent-fleet.session-audit/v1" ? [v] : []; } catch { return []; } }).at(-1);
  assert.deepEqual(pending.taskTriage.runtimeBlocks, ["task_transition_pending"]);
  assert.equal(pending.taskTriage.process.completion, "unknown");
  assert.equal(pending.taskTriage.process.additions[0].binding, "stale");
});

test("real Pi audit reports timeout and oversized input without invented attempts or usage", { timeout: 180_000 }, async t => {
  for (const scenario of [{ fake: "timeout", input: "Change installer trust", status: "unavailable", reserved: 1 },
    { fake: "security", input: "x".repeat(40961), status: "oversized_input", reserved: 0 }]) {
    const dir = setupWorkspace(t);
    const session = await startSession(t, dir, { fake: scenario.fake, script: [{ text: "done" }] });
    assert.equal((await session.request(scenario.input)).success, true);
    assert.equal((await session.request("/af-audit")).success, true);
    const audit = session.notifications().flatMap(note => { try { const v = JSON.parse(note); return v.schema === "agent-fleet.session-audit/v1" ? [v] : []; } catch { return []; } }).at(-1);
    assert.equal(audit.taskTriage.assessment.status, scenario.status);
    assert.equal(audit.taskTriage.metrics.logicalCalls.reserved, scenario.reserved);
    assert.equal(audit.taskTriage.metrics.physicalAttempts.observed, null);
    assert.equal(audit.taskTriage.metrics.usage.inputTokens, null);
    assert.equal(audit.taskTriage.taskAcceptance, "not_recorded");
    assert.equal(session.fakeCalls().length, scenario.reserved);
  }
});

test("real Pi next session stays off after applied installer deselection despite active human config", { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t);
  writeFileSync(join(dir, ".ai/agent-fleet-state.json"), JSON.stringify({ schemaVersion: 2, taskTriageSelected: false }));
  const session = await startSession(t, dir, { fake: "security", script: [{ text: "no assessment" }] });
  assert.equal((await session.request("change the synthetic installer trust boundary")).success, true);
  assert.equal(session.triageStates().find(s => s.phase === "service_init")?.consumerPresent, false);
  assert.equal(session.triageStates().some(s => s.phase === "assessment"), false, "disabled consumer never calls the fake Jev provider");
  assert.equal(session.fakeCalls().length, 0);
  assert.equal(session.contexts()[0]?.promptSignals?.securityChange, false, "no new S1 addition is claimed");
});

test("real Pi first turn skips classification but retains S1 review on late binding", { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t);
  const authored = join(dir, "unclassified-security-write.txt");
  const session = await startSession(t, dir, { fake: "security", script: [
    { tool: "write", args: { path: authored, content: "synthetic change" } },
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", reason: "bind after first-turn authoring" } },
    { text: "first turn complete" },
  ] });
  assert.equal((await session.request("change the synthetic installer trust boundary and write the result")).success, true);
  const first = session.contexts()[0];
  assert.equal(first.step.tool, "write", "the first model turn skips set_task_tier");
  assert.equal(session.triageStates().find(s => s.phase === "assessment")?.status, "applied", "production pre-model hook evaluated the input");
  assert.equal(session.triageStates().find(s => s.phase === "assessment")?.calls, 1, "the first guarded evaluation precedes the first model turn");
  assert.equal(first.promptSignals.securityChange, true, "the first system prompt carries the source-specific addition");
  assert.equal(first.promptSignals.review, true, "the first system prompt names the review requirement");
  assert.equal(readFileSync(authored, "utf8"), "synthetic change", "security review is required before acceptance, not authoring");
  const bound = toolResult(session, 2);
  assert.equal(bound?.details?.status, "ok", "late classification binds the same first-turn task");
  assert.ok(bound?.details?.process?.additions?.some((a: any) => a.reason === "security_change" && a.status === "active"), "late classification retains the original S1 addition");
  assert.equal(bound.details.process.review.evidenceRef, null, "no review evidence was invented by authoring or late classification");
});

test("real Pi operator/empty-roster: production hooks evaluate, adoption binds, fence refuses, recovery hint is actionable", { timeout: 180_000 }, async t => {
  assert.match(JSON.parse(readFileSync(join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version, /^0\.84\.2/);
  const dir = setupWorkspace(t);
  const fencedPath = join(dir, "transition-must-not-write.txt");
  const boundPath = join(dir, "bound-write.txt");
  const session = await startSession(t, dir, { fake: "security", script: [
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", reason: "real-pi adoption bind" } },
    { text: "first turn complete" },
    { tool: "write", args: { path: fencedPath, content: "must remain absent" } },
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", reason: "bind follow-up to same task" } },
    { tool: "write", args: { path: boundPath, content: "bound effect succeeded" } },
    { tool: "dispatch_agent", args: { agent: "planner", task: "Attempt after binding" } },
    { tool: "set_assertions", args: { assertions: [{ id: "A1", tag: "test", text: "Security change is independently reviewed", source: "real-Pi fixture", test_command: "node --test fixture" }] } },
    { tool: "update_assertion", args: { id: "A1", status: "proven", evidence: "fixture evidence" } },
    { text: "done" },
  ]});
  const r1 = await session.request("fix the typo in README");
  assert.equal(r1.success, true, `first prompt failed: ${JSON.stringify(r1)}`);
  const r2 = await session.request("also update the installer permissions check and verify acceptance criteria");
  assert.equal(r2.success, true, `follow-up prompt failed: ${JSON.stringify(r2)}`);

  // before_agent_start: production input -> before_agent_start ordering through the real extension.
  const hooks = hookTypes(session);
  assert.ok(hooks.includes("session_start"), `session_start fired in real Pi: ${hooks}`);
  const firstInput = hooks.indexOf("input");
  const firstEval = hooks.indexOf("before_agent_start");
  assert.ok(firstInput >= 0 && firstEval > firstInput, `input precedes before_agent_start: ${hooks}`);

  // Task adoption: the fake shared service was evaluated through the production composition point.
  const fake = session.fakeCalls();
  assert.ok(fake.length >= 2, `expected before_agent_start + scope-change adoption evaluations, got ${fake.length}`);
  assert.ok(fake.every(c => c.profile === "security"), "fake profile selectors are deterministic, not provider judgments");
  assert.ok(fake.every(c => Array.isArray(c.questions) && c.questions.includes("security_change")), "fake transport receives the production question set");
  assert.ok(fake.every(c => c.stack.some((frame: string) => frame.includes("jev.ts"))), "evaluations pass through the shared Jev adapter, not a separate task-triage service");

  // Operator surface: the real model turn saw direct tools plus the triage tool.
  const firstCall = session.contexts()[0];
  assert.ok(firstCall.tools.includes("set_task_tier"), "operator turn exposes set_task_tier");
  assert.ok(firstCall.tools.includes("bash") && firstCall.tools.includes("dispatch_agent"), "operator turn keeps direct + dispatch tools");

  // Empty roster: after binding, dispatch through the real hub refuses with an actionable recovery hint.
  const inbound = inboundText(session);
  assert.ok(session.contexts().length >= 9, "both turns execute their scripted calls");
  assert.match(inbound, /Unknown agent "planner"/, "empty-roster refusal names the agent");
  assert.match(inbound, /\/af-agents-add/, "empty-roster refusal points at roster recovery");

  // Input transition: a changed follow-up fences direct effects; its fleet lease permits binding.
  const followUp = session.contexts().slice(2);
  assert.ok(followUp[0].tools.includes("write") && followUp[0].tools.includes("dispatch_agent") && followUp[1].tools.includes("set_task_tier"), "pending transition retains both direct tools and the fleet adoption lease");
  assert.match(followUp[1].inbound, /Pending task transition: before dependent effects, call set_task_tier/, "follow-up direct effect is refused at the transition fence before adoption");
  assert.equal(existsSync(fencedPath), false, "refused transition effect did not write");
  // A successful post-adoption direct effect, not roster validation, proves the fence cleared.
  const afterBind = session.contexts()[4].inbound.replaceAll('\\"', '"');
  assert.match(afterBind, /"status":"ok"/, "follow-up set_task_tier returned a successful adoption result");
  assert.equal(readFileSync(boundPath, "utf8"), "bound effect succeeded", "post-adoption direct write reaches the filesystem");
  assert.match(inbound, /security_change/, "the fake high-risk signal is visible in the real Hub model input");
  assert.match(afterBind, /"tier":"small"/, "adoption did not inflate the budget tier");
  const registeredProof = () => JSON.stringify({
    exposed: session.contexts()[7]?.tools.includes("update_assertion"),
    ledger: toolResult(session, 7), proof: toolResult(session, 8),
  });
  assert.equal(session.contexts()[7]?.tools.includes("update_assertion"), true, `the verification pack exposes the registered proof tool; ${registeredProof()}`);
  assert.equal(toolResult(session, 7)?.details?.count, 1, `A1 was registered before the proof attempt; ${registeredProof()}`);
  const proofGate = toolResult(session, 8);
  assert.equal(proofGate?.details?.status, "refused", `registered proof tool refused the request; ${registeredProof()}`);
  assert.equal(proofGate?.details?.reason, "process_obligations_open", `the registered proof gate enforces effective obligations; ${registeredProof()}`);
  assert.match(proofGate.text, /review/, `review remains an actual open obligation; ${registeredProof()}`);
});

test("real Pi T4 wide-small empty-roster operator: plan blocks effects, inspection works, both role recoveries stay human-owned", { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t);
  const change = join(dir, "wide-plan-gated.txt");
  writeFileSync(join(dir, "README.md"), "inspection is allowed\n");
  const session = await startSession(t, dir, { fake: "wide", script: [
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", reason: "retain small spend" } },
    { tool: "write", args: { path: change, content: "must not land before plan" } },
    { tool: "read", args: { path: join(dir, "README.md") } },
    { tool: "dispatch_agent", args: { agent: "planner", task: "Produce a plan for the wide change" } },
    { tool: "dispatch_agent", args: { agent: "code-reviewer", task: "Review the wide change" } },
    { tool: "write", args: { path: change, content: "still must not land" } },
    { text: "done" },
  ]});
  const response = await session.request("rework the fleet workspace layout across components");
  assert.equal(response.success, true, JSON.stringify(response));
  assert.ok(session.fakeCalls().some(c => c.profile === "wide"), "real hooks used the shared fake Jev transport");
  assert.equal(existsSync(change), false, "the pre-plan operator effect never reached the filesystem");
  const calls = session.contexts();
  assert.ok(calls.length >= 7);
  const after = (i: number) => String(calls[i].inbound).replaceAll('\\"', '"');
  assert.match(after(1), /"tier":"small"/, "declaration returned the same spend tier");
  const firstWrite = toolResult(session, 2);
  assert.equal(firstWrite?.isError, true, "Pi reports the blocked write as a tool error");
  assert.match(firstWrite.text, /Process gate refused the dependent effect: the wide-task plan obligation is open/);
  assert.match(firstWrite.text, /\/af-agents-add planner|\/af-agents-team/, "plan gate names the human role recovery");
  assert.match(after(3), /inspection is allowed/, "read-only tool remained usable while plan was open");
  assert.match(after(4), /Unknown agent "planner"/, "missing planner has an actionable human recovery path");
  assert.match(after(4), /\/af-agents-add planner|\/af-agents-team/);
  assert.match(after(5), /Unknown agent "code-reviewer"/, "missing reviewer is not silently added");
  assert.match(after(5), /\/af-agents-add code-reviewer|\/af-agents-team/);
  const secondWrite = toolResult(session, 6);
  assert.equal(secondWrite?.isError, true, "the second attempted write is blocked too");
  assert.match(secondWrite.text, /wide-task plan obligation is open/, "human roster recovery did not erase the plan obligation");
  assert.equal(existsSync(change), false, "neither denied write created a file");
});

test("real Pi operator exact confirmation: deny, approve, then deny a separate write",  { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t);
  const denied = join(dir, "denied.txt"), approved = join(dir, "approved.txt"), deniedAgain = join(dir, "denied-again.txt");
  const actions = [
    { path: denied, content: "denied" }, { path: approved, content: "approved" }, { path: deniedAgain, content: "denied again" },
  ];
  const session = await startSession(t, dir, { fake: "irreversible", decisions: ["No — deny", "Yes — authorize once", "No — deny"], script: [
    ...actions.map(args => ({ tool: "write", args })),
    { text: "done" },
  ]});
  const r = await session.request("run the production database migration now");
  assert.equal(r.success, true, `prompt failed: ${JSON.stringify(r)}`);
  assert.ok(session.fakeCalls().length >= 1, "irreversible input was evaluated through the real hooks");
  assert.ok(session.contexts()[0].tools.includes("write") && !session.contexts()[0].tools.includes("dispatch_agent"), "operator action confirmation has direct tools but no fleet lease");
  assert.deepEqual(session.decisions().map(d => d.value), ["No — deny", "Yes — authorize once", "No — deny"], "each write gets its own real Pi UI decision");
  for (const [i, d] of session.decisions().entries()) {
    const target = createHash("sha256").update(JSON.stringify(actions[i])).digest("hex");
    assert.match(d.title, new RegExp(`Operation: write\\nTarget: ${target}\\nAction: e2e-${i + 1}\\b`), "UI decision binds the exact operation, arguments and call id");
    const shown = JSON.parse(d.title.split("BEGIN ACTION INPUT JSON\n")[1].split("\nEND ACTION INPUT JSON")[0]);
    assert.deepEqual(shown, actions[i], "human sees the actual path and complete proposed write content, not only a hash");
    assert.ok(d.title.includes(dir), "relative action working directory is shown");
  }
  assert.equal(existsSync(denied), false, "denied write did not reach the filesystem");
  assert.equal(readFileSync(approved, "utf8"), "approved", "approved exact write reached the filesystem");
  assert.equal(existsSync(deniedAgain), false, "approval did not authorize a later distinct write");
  assert.match(session.contexts()[1].inbound, /action_confirmation_unsupported|confirmation|blocked/i, "denial is observable to the model");
  assert.equal((await session.request("/af-audit")).success, true);
  const audit = session.notifications().flatMap(note => { try { const v = JSON.parse(note); return v.schema === "agent-fleet.session-audit/v1" ? [v] : []; } catch { return []; } }).at(-1);
  const history = audit.taskTriage.actions;
  assert.equal(history.records.length, 3);
  assert.deepEqual(history.records.map((a: any) => a.authorization), ["not_granted", "recorded_grant", "not_granted"]);
  assert.deepEqual(history.records.map((a: any) => a.consumption), ["not_recorded", "recorded_once", "not_recorded"]);
  assert.deepEqual(history.records.map((a: any) => a.execution), ["blocked", "tool_result_ok", "blocked"]);
  assert.ok(history.records.every((a: any) => a.binding === "current"));
  assert.equal(audit.taskTriage.process.obligations.confirmation, "open", "one approved action never grants future effects");
  assert.equal(audit.taskTriage.taskAcceptance, "not_recorded");
  assert.doesNotMatch(JSON.stringify(history), /approved\.txt|denied\.txt|denied-again\.txt|e2e-|synthetic-test-only-key/);
});

test("real Pi refuses unsafe or oversized exact-action presentation before asking or writing", { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t);
  const denied = ["sensitive.txt", "large.txt", "control.txt"];
  const session = await startSession(t, dir, { fake: "irreversible", decisions: [], script: [
    { tool: "write", args: { path: denied[0], content: "password=synthetic-only-sentinel" } },
    { tool: "write", args: { path: denied[1], content: "x".repeat(20000) } },
    { tool: "write", args: { path: denied[2], content: "hidden\u001b[2J" } }, { text: "done" },
  ] });
  assert.equal((await session.request("Synthetic irreversible operation; never run a real migration")).success, true);
  assert.deepEqual(session.decisions(), [], "unreviewable details cannot become a human-approved grant");
  for (const file of denied) assert.equal(existsSync(join(dir, file)), false, "unsafe presentation refuses the effect");
  assert.equal(session.fakeCalls().length, 1);
  assert.equal((await session.request("/af-audit")).success, true);
  const audit = session.notifications().flatMap(note => { try { const v = JSON.parse(note); return v.schema === "agent-fleet.session-audit/v1" ? [v] : []; } catch { return []; } }).at(-1);
  assert.ok(audit.taskTriage.actions.records.every((a: any) => a.authorization === "not_granted" && a.consumption === "not_recorded"));
  assert.doesNotMatch(JSON.stringify(audit), /synthetic-only-sentinel|hidden/);
});

test("real Pi orchestrator/populated-roster, recover command, session switch and shutdown", { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t, { team: "tiny" });
  const script: ScriptStep[] = [
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", reason: "orchestrator bind" } },
    { tool: "dispatch_agent", args: { agent: "planner", task: "Plan the typo fix" } },
    { text: "done" },
  ];
  const first = await startSession(t, dir, { fake: "plain", script, fleetArgs: ["--solo", "--work-mode", "orchestrator", "--agent-team", "tiny"] });
  const r1 = await first.request("fix the typo in README");
  assert.equal(r1.success, true, `orchestrator prompt failed: ${JSON.stringify(r1)}`);
  const calls = first.contexts();
  assert.ok(calls.length >= 1, "orchestrator turn reached the model");
  assert.ok(!calls[0].tools.includes("bash") && !calls[0].tools.includes("write"), "orchestrator turn has no direct coding tools");
  assert.ok(calls[0].tools.includes("dispatch_agent"), "orchestrator turn keeps dispatch");
  const inbound = inboundText(first);
  assert.match(inbound, /Unknown agent "planner"/, "populated roster without planner still refuses unknown agent");
  assert.match(inbound, /\/af-agents-add planner/, "populated-roster refusal carries the missing-role recovery hint");

  // Persistence recovery command is live in the real session and reports checked state.
  const rr = await first.request("/af-task-triage-recover");
  assert.equal(rr.success, true, `recover command failed: ${JSON.stringify(rr)}`);
  const notes = first.notifications().join("\n");
  assert.match(notes, /Process state restored|Recovery refused/, "recover command reports its checked outcome in-session");

  // Session switch/shutdown: close, reopen, and confirm fresh hooks plus a fresh evaluation.
  await first.close();
  const second = await startSession(t, dir, { fake: "plain", script });
  const r2 = await second.request("fix the typo in README");
  assert.equal(r2.success, true, `second-session prompt failed: ${JSON.stringify(r2)}`);
  const hooks = hookTypes(second);
  assert.equal(hooks.filter(h => h === "session_start").length, 1, "second session has its own session_start");
  assert.ok(second.fakeCalls().length >= 1, "second session evaluates its own fresh input");
  assert.equal(hookTypes(first).filter(h => h === "session_shutdown").length, 1, "first session shut down");
  await second.close();
  assert.equal(hookTypes(second).filter(h => h === "session_shutdown").length, 1, "second session shut down independently");
});

test("real Pi T4 spent orchestrator floor: human refusal starts no fourth child, charges nothing, and leaves review open", { timeout: 240_000 }, async t => {
  const dir = setupWorkspace(t, { team: "stage", personas: ["probe-builder", "probe-second", "code-reviewer", "probe-correction"] });
  writeFileSync(join(dir, "README.md"), "synthetic security review scope\n");
  const session = await startSession(t, dir, { fake: "security", decisions: ["No — stop"],
    fleetArgs: ["--solo", "--work-mode", "orchestrator", "--agent-team", "stage"], script: [
      { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", reason: "retain the small spend cap" } },
      { tool: "set_assertions", args: { assertions: [{ id: "A1", tag: "test", text: "Security change is independently reviewed", source: "real-Pi fixture", test_command: "node --test fixture" }] } },
      { tool: "update_assertion", args: { id: "A1", status: "proven", evidence: "fixture evidence" } },
      { tool: "dispatch_agent", args: { agent: "probe-builder", backend: "native", task: "Inspect synthetic fixture A for the security change" } },
      { tool: "dispatch_agent", args: { agent: "probe-second", backend: "native", task: "Independently inspect synthetic fixture B for the security change" } },
      { tool: "dispatch_agent", args: { agent: "code-reviewer", backend: "native", task: "Review the security change", scope: ["README.md"] } },
      { tool: "dispatch_agent", args: { agent: "probe-correction", backend: "native", task: "Apply one correction after review; this attempt is beyond the orchestrator floor" } },
      { text: "stopped" },
    ] });
  const response = await session.request("Review the high-risk security change and verify acceptance criteria in this synthetic workspace");
  assert.equal(response.success, true, JSON.stringify(response));
  assert.ok(session.fakeCalls().some(c => c.profile === "security"), "production hooks applied the fake high-risk signal");
  const report = await session.request("/af-hub-report");
  assert.equal(report.success, true, JSON.stringify(report));
  const budgetEvidence = () => JSON.stringify({
    decisions: session.decisions(),
    dispatchResults: session.contexts().flatMap(c => c.results ?? []).filter(r => /^e2e-[4-7]$/.test(r.id)).map(r => ({ id: r.id, status: r.details?.status, reason: r.details?.reason, recoveryCategory: r.details?.recoveryCategory, text: r.text.slice(0, 450) })),
    budgetNotices: session.notifications().filter(n => /budget|dispatch|refusal|Session —/i.test(n)).map(n => n.slice(0, 450)).slice(-6),
  });
  assert.deepEqual(session.decisions().map(d => d.value), ["No — stop"], `a real Pi UI decision denied the one-click budget continuation; ${budgetEvidence()}`);
  assert.match(session.decisions()[0].title, /budget window|dispatches|budget/i, "the refused decision is the budget question, not an action confirmation");
  const calls = session.contexts();
  // Orchestrator raises the small turn cap to 3. A denied budget calls ctx.abort():
  // Pi persists the seventh tool result and ends the turn without an eighth model
  // invocation to carry it in ctx.messages.
  const observedResults = session.events().filter(e => e.hook === "tool_result" && /^e2e-[1-7]$/.test(e.id));
  const observed = () => JSON.stringify({
    expected: { modelCalls: [1, 2, 3, 4, 5, 6, 7], resultIds: ["e2e-4", "e2e-5", "e2e-6", "e2e-7"], event: "tool_result", chargedDispatches: 3 },
    modelCalls: calls.slice(0, 8).map(c => ({ call: c.call, tool: c.step?.tool })),
    toolResults: observedResults.slice(0, 8).map(e => ({ id: e.id, tool: e.tool, status: e.details?.status, reason: e.details?.reason, exitCode: e.details?.exitCode, text: e.text.slice(0, 300) })),
    decisions: session.decisions().slice(0, 3),
    budgetReport: session.notifications().filter(n => n.includes("Session —")).slice(-1).map(n => n.slice(0, 450)),
  });
  assert.ok(calls.length >= 7, `seven scripted registered tool calls reached the real Pi model; ${observed()}`);
  for (const [id, tool] of [[4, "dispatch_agent"], [5, "dispatch_agent"], [6, "dispatch_agent"], [7, "dispatch_agent"]] as const) {
    assert.equal(calls[id - 1]?.step?.tool, tool, `scripted call e2e-${id} requested ${tool}; ${observed()}`);
    assert.equal(observedResults.find(e => e.id === `e2e-${id}`)?.tool, tool, `registered executor returned e2e-${id}; ${observed()}`);
  }
  assert.equal(toolResult(session, 1)?.details?.tier, "small", "risk adoption did not raise the spend tier");
  const registeredProof = () => JSON.stringify({
    exposed: calls[2]?.tools.includes("update_assertion"),
    ledger: toolResult(session, 2), proof: toolResult(session, 3),
  });
  assert.equal(calls[2]?.tools.includes("update_assertion"), true, `the verification pack exposes the registered proof tool; ${registeredProof()}`);
  assert.equal(toolResult(session, 2)?.details?.count, 1, `A1 was registered before the proof attempt; ${registeredProof()}`);
  assert.equal(toolResult(session, 3)?.details?.status, "refused", `registered proof tool refused the request; ${registeredProof()}`);
  assert.equal(toolResult(session, 3)?.details?.reason, "process_obligations_open", `proof is blocked by effective obligations; ${registeredProof()}`);
  assert.match(toolResult(session, 3).text, /review/, `the independent review obligation is open; ${registeredProof()}`);
  const notices = session.notifications().join("\n");
  assert.match(notices, /Session — .*3 dispatch\(es\)/, "the refused fourth dispatch did not inflate charged session dispatches");
  assert.match(notices, /1 refusal\(s\)/, "the human-denied budget attempt is reported as a refusal");
  const refusedCorrection = observedResults.find(e => e.id === "e2e-7");
  assert.match(refusedCorrection?.details?.status ?? "", /budget_stopped|budget_refused/, `human denial blocks the dispatch beyond the orchestrator floor, not a substitute no-progress refusal; ${observed()}`);
  assert.equal(refusedCorrection?.details?.exitCode, 1, `refused correction reports failure rather than child success; ${observed()}`);
  assert.notEqual(toolResult(session, 3)?.details?.status, "proven", "the independent review was never marked proven");
  const sessionsRoot = join(dir, ".pi/agent-sessions/sessions");
  const dispatches = readdirSync(sessionsRoot).flatMap(id => {
    const path = join(sessionsRoot, id, "dispatches");
    return existsSync(path) ? readdirSync(path) : [];
  });
  assert.equal(dispatches.length, 3, "only the three floor-allowed attempts launched; denied correction has no child session");
  assert.equal(toolResult(session, 3)?.details?.reason, "process_obligations_open", `no review evidence was invented; ${registeredProof()}`);
});

test("real Pi orchestrator G3.1 irreversible refuses fixture-producer dispatch as unsupported", { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t, { team: "stage", personas: ["probe-builder", "planner", "code-reviewer"] });
  for (const backend of ["coms", "native"] as const) {
    // A prior refused attempt is no-progress history for this actor; it must not
    // stand in for an independent action-gate observation on the other backend.
    const session = await startSession(t, dir, { fake: "irreversible", script: [
      { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", reason: "orchestrator irreversible bind" } },
      { tool: "dispatch_agent", args: { agent: "probe-builder", task: `Produce the fixture through ${backend}`, backend } },
      { text: "done" },
    ], fleetArgs: ["--solo", "--work-mode", "orchestrator", "--agent-team", "stage"] });
    const r = await session.request("run the production database migration now");
    assert.equal(r.success, true, `orchestrator ${backend} prompt failed: ${JSON.stringify(r)}`);
    const calls = session.contexts();
    assert.ok(calls.length >= 3, `${backend}: bind, blocked dispatch and closing turn execute`);
    assert.ok(!calls[0].tools.includes("bash") && !calls[0].tools.includes("write"), "orchestrator turn has no direct coding tools");
    assert.ok(session.fakeCalls().length >= 1, `${backend}: irreversible input was evaluated through the real hooks`);
    const refusal = toolResult(session, 2);
    assert.equal(refusal?.details?.status, "action_confirmation_unsupported", `${backend}: actual independent action-gate refusal, not no-progress`);
    assert.doesNotMatch(refusal.text, /\[probe-builder\] done in/, `${backend}: refused dispatch never reports a successful child/peer run`);
    const sessionsRoot = join(dir, ".pi/agent-sessions/sessions");
    const launched = existsSync(sessionsRoot) ? readdirSync(sessionsRoot).flatMap(id => {
      const path = join(sessionsRoot, id, "dispatches");
      return existsSync(path) ? readdirSync(path) : [];
    }) : [];
    assert.equal(launched.length, 0, `${backend}: no child session was launched`);
    await session.close();
  }
});

test("real Pi new-task reset denies without human grant and binds the approved successor", { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t);
  const refusedEffect = join(dir, "refused-transition-write.txt");
  const session = await startSession(t, dir, { fake: "security", decisions: ["No — keep old task", "Yes — supersede once"], script: [
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", reason: "bind initial security task" } },
    { text: "old task remains open" },
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", new_task: true, reason: "replace old task with a separate README request" } },
    { tool: "write", args: { path: refusedEffect, content: "must not be written" } },
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", new_task: true, reason: "replace old task with a separate README request" } },
    { text: "new task remains independently reviewed" },
  ] });
  assert.equal((await session.request("review the synthetic installer trust boundary change")).success, true);
  const first = toolResult(session, 1);
  assert.equal(first?.details?.status, "ok", "initial task binding succeeded");
  const original = first.details.process.additions.find((a: any) => a.source === "system1" && a.status === "active");
  assert.ok(original?.taskId, "first real Pi task has an active task-bound review addition");
  const originalCalls = session.fakeCalls().length;
  assert.equal((await session.request("instead review a separate synthetic README security change")).success, true);
  const denied = toolResult(session, 3), blocked = toolResult(session, 4), approved = toolResult(session, 5);
  assert.deepEqual(session.decisions().map(d => d.value), ["No — keep old task", "Yes — supersede once"], "only the human chooses task supersession");
  assert.equal(denied?.details?.reason, "task_supersession_not_authorized", "first refusal does not reset the old task");
  assert.equal(existsSync(refusedEffect), false, "denied supersession cannot write before the later approval");
  assert.equal(blocked?.isError, true, "production pre-effect hook refuses the write after denial");
  assert.match(blocked?.text ?? "", /Pending task transition: before dependent effects/, "refusal explicitly requires binding before the effect");
  assert.equal(approved?.details?.status, "ok", "second, explicitly approved transition succeeds");
  assert.equal(approved.details.newTask, true);
  assert.ok(approved.details.newTaskId && approved.details.newTaskId !== original.taskId, "approved successor gets a distinct actual task identity");
  const successor = approved.details.process.additions.filter((a: any) => a.source === "system1" && a.status === "active");
  assert.ok(successor.length && successor.every((a: any) => a.taskId === approved.details.newTaskId),
    `new obligations bind only to the successor, never the abandoned task; ${JSON.stringify({ priorId: original.taskId, newId: approved.details.newTaskId,
      additions: approved.details.process.additions.map((a: any) => ({ source: a.source, taskId: a.taskId, reason: a.reason, status: a.status })),
      assessments: session.triageStates().filter(s => s.phase === "assessment").map(s => ({ taskId: s.taskId, status: s.status, calls: s.calls, pendingTaskTransition: s.pendingTaskTransition })),
      fakeCallCount: session.fakeCalls().length, originalCalls })}`);
  assert.ok(session.fakeCalls().length > originalCalls, "successor input is assessed by the registered fake provider rather than inheriting stale advice");
  assert.equal(approved.details.tier, "small", "task reset never silently raises the spend tier");
});

test("real Pi provider deadline preserves baseline tools without inventing S1 obligations", { timeout: 180_000 }, async t => {
  const dir = setupWorkspace(t);
  const session = await startSession(t, dir, { fake: "timeout", script: [{ text: "fixture turn done" }] });
  const started = Date.now();
  const response = await session.request("fix the synthetic README typo");
  assert.equal(response.success, true, `real Pi prompt failed: ${JSON.stringify(response)}`);
  assert.equal(session.fakeCalls().length, 1, "one guarded shared-service request reached the fake transport");
  assert.ok(session.fakeCalls()[0].stack.some((frame: string) => frame.includes("jev.ts")), "production shared Jev adapter handled the request");
  assert.ok(session.triageStates().some(s => s.phase === "assessment" && s.status === "unavailable" && s.calls === 1),
    "production before_agent_start records unavailable after one reserved logical call");
  assert.ok(Date.now() - started >= TRIAGE_CONFIG.limits.timeoutMs, "registered hook awaited the bounded deadline");
  assert.ok(Date.now() - started < 15_000, "provider timeout is bounded and does not trap the operator");
  assert.ok(session.contexts()[0]?.tools.includes("write"), "baseline operator write tool remains available");
  assert.doesNotMatch(inboundText(session), /security_change|wide_change|irreversible_execution/, "timeout does not fabricate an S1 addition");
  assert.ok(hookTypes(session).includes("before_agent_start"), "actual production assessment hook ran");
});

test("real Pi required wide plan closes through a runnable offline native planner", { timeout: 240_000 }, async t => {
  const dir = setupWorkspace(t, { team: "stage", personas: ["planner", "code-reviewer"], childProvider: true });
  writeFileSync(join(dir, "README.md"), "The wdiget renders a greeting.\n");
  const session = await startSession(t, dir, { fake: "wide", childProvider: true, script: [
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "wide", reason: "synthetic wide task requires a plan" } },
    { tool: "dispatch_agent", args: { agent: "planner", backend: "native", task: "Read README.md and plan ONLY the wdiget to widget correction." } },
    { text: "plan stage observed" },
  ], fleetArgs: ["--solo", "--work-mode", "orchestrator", "--agent-team", "stage"] });
  assert.equal((await session.request("change the synthetic README fixture across the declared wide scope")).success, true);
  const planned = toolResult(session, 2);
  assert.equal(planned?.details?.exitCode, 0, `a real native Pi planner must run: ${planned?.text}`);
  assert.equal(planned?.details?.processVerdict?.obligations?.plan?.status, "satisfied", "the planner return is recorded as plan-stage evidence");
  assert.deepEqual(session.childEvents().map(e => e.step), ["read", "return"], "the native child used real Pi read before returning a plan");
  assert.equal(session.childEvents()[1]?.readOk, true, "plan text follows a successful README read");
  assert.match(planned?.details?.fullOutput ?? "", /PLAN: Correct only wdiget renders to widget renders/, "the retained stage return is concrete, not empty status");
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "The wdiget renders a greeting.\n", "the planner cannot author the change");
});

test("real Pi offline native planner, verified builder and read-only reviewer close required stages", { timeout: 240_000 }, async t => {
  const dir = setupWorkspace(t, { team: "stage", personas: ["planner", "probe-builder", "code-reviewer"], childProvider: true });
  const readme = join(dir, "README.md"), initial = "The wdiget renders a greeting.\n";
  writeFileSync(readme, initial);
  writeFileSync(join(dir, ".gitignore"), ".pi/\n.ai/\nagent/\nhome/\nbin/\nprobe.ts\nchild-provider.ts\nchild-events-*.ndjson\nchild-wire-*.ndjson\nfake-calls-*.ndjson\ntriage-states-*.ndjson\ncontexts-*.ndjson\nevents-*.ndjson\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "synthetic baseline"], { cwd: dir });
  const assertion = { id: "A1", tag: "test", text: "Synthetic README has exactly the widget typo correction", source: "isolated C2 fixture", test_command: README_CHECK };
  const session = await startSession(t, dir, { fake: "wide", childProvider: true,
    fleetArgs: ["--solo", "--work-mode", "orchestrator", "--agent-team", "stage"], script: [
      { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "wide", reason: "synthetic wide task requires a plan and review" } },
      { text: "initial classification complete" },
      { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "wide", reason: "bind clarified verification to same task" } },
      { tool: "set_assertions", args: { assertions: [assertion] } },
      { text: "assertion prepared" },
      { tool: "dispatch_agent", args: { agent: "planner", backend: "native", task: "PLAN FIXTURE: Read README.md and plan the exact typo-only correction." } },
      { text: "plan returned" },
      { tool: "dispatch_agent", args: { agent: "probe-builder", backend: "native", scope: ["README.md"], deliverables: ["README.md"], task: `BUILDER FIXTURE: Read README.md, edit only wdiget to widget, then run exactly ${README_CHECK}. No other changes. A1 [test] is declared.` } },
      { text: "builder returned" },
      { tool: "dispatch_agent", args: { agent: "code-reviewer", backend: "native", scope: ["README.md"], review_reason: "Explicit independent review required by the synthetic wide process stage", task: "REVIEW FIXTURE: Read README.md and reject unless the exact expected widget text is present. This scripted fixture verdict is NOT independent A1 evidence." } },
      { text: "review returned" },
    ] });
  assert.equal((await session.request("correct the synthetic README typo within the declared wide scope")).success, true);
  const request = "continue the same README task and register the exact verification criterion";
  assert.equal((await session.request(request)).success, true);
  assert.equal(toolResult(session, 4)?.details?.count, 1, `A1 must be registered before dispatch: ${toolResult(session, 4)?.text}`);
  assert.equal((await session.request(request)).success, true);
  const plan = toolResult(session, 6);
  assert.equal(plan?.details?.processVerdict?.obligations?.plan?.status, "satisfied", `native planner must satisfy the plan stage: ${plan?.text}`);
  assert.equal(readFileSync(readme, "utf8"), initial, "planner did not preempt builder work");
  assert.equal((await session.request(request)).success, true);
  const build = toolResult(session, 8);
  assert.equal(build?.details?.runtimeResult?.verification?.status, "passed", `native builder verification must pass: ${JSON.stringify(build?.details?.runtimeResult?.verification)}`);
  assert.equal(build?.details?.processVerdict?.obligations?.acceptance?.status, "satisfied", "runtime check closes acceptance evidence before review");
  assert.equal(build?.details?.processVerdict?.obligations?.review?.status, "open", "builder cannot close independent review");
  assert.match(build?.text ?? "", /required process review remains open/i, "docs-lane advice must respect the live S1 review obligation");
  assert.doesNotMatch(build?.text ?? "", /do not dispatch a reviewer/i, "docs-lane advice cannot override the process gate");
  assert.equal(build?.details?.processVerdict?.obligations?.plan?.status, "satisfied", "builder must not erase the completed plan");
  assert.equal(readFileSync(readme, "utf8"), "The widget renders a greeting.\n");
  assert.equal((await session.request(request)).success, true);
  const review = toolResult(session, 10);
  assert.equal(review?.details?.processVerdict?.obligations?.review?.status, "satisfied", `native reviewer must satisfy review after builder acceptance: ${review?.text}`);
  assert.equal(review?.details?.processVerdict?.obligations?.plan?.status, "satisfied", "both stages remain closed together");
  assert.equal(review?.details?.processVerdict?.accepted, true, "Hub accepts the task only after both stages and runtime verification");
  assert.equal(review?.details?.processVerdict?.currentStage, "complete");
  assert.equal(review?.details?.exitCode, 0);
  assert.equal(review?.details?.structuredReturn?.assertions_proven?.length ?? 0, 0, "scripted model never fabricates independent A1 proof");
  const events = session.childEvents();
  assert.deepEqual(events.filter(e => e.role === "builder").map(e => e.step), ["read", "edit", "bash", "return"], "native builder executes the real read/edit/runtime-check tools");
  assert.deepEqual(events.filter(e => e.role === "reviewer").map(e => e.step), ["read", "return"], "native reviewer inspects the authored README");
  assert.equal(events.find(e => e.role === "reviewer" && e.step === "return")?.readOk, true);
});

test("real Pi orchestrator G3.2 wide plan gate blocks fixture, admits producer, stays closed on producer failure", { timeout: 240_000 }, async t => {
  const dir = setupWorkspace(t, { team: "stage", personas: ["probe-builder", "planner", "code-reviewer"] });
  const session = await startSession(t, dir, { fake: "wide", script: [
    { tool: "set_task_tier", args: { tier: "small", risk: "low", scope: "small", reason: "orchestrator wide bind" } },
    { tool: "dispatch_agent", args: { agent: "probe-builder", task: "Produce the fixture before planning" } },
    { tool: "dispatch_agent", args: { agent: "planner", task: "Plan the wide fixture change" } },
    { tool: "dispatch_agent", args: { agent: "probe-builder", task: "Produce the fixture after a failed plan" } },
    { text: "done" },
  ], fleetArgs: ["--solo", "--work-mode", "orchestrator", "--agent-team", "stage"] });
  const r = await session.request("rework the fleet workspace layout across components");
  assert.equal(r.success, true, `orchestrator prompt failed: ${JSON.stringify(r)}`);
  const calls = session.contexts();
  assert.ok(calls.length >= 5, `all staged dispatches execute, got ${calls.length}`);
  assert.ok(session.fakeCalls().length >= 1, "wide input was evaluated through the real hooks");
  const inboundAt = (i: number) => String(calls[i]?.inbound ?? "").replaceAll('\\"', '"');
  const tailAfter = (i: number, marker: string) => {
    const full = inboundAt(i);
    const cut = full.lastIndexOf(marker);
    assert.ok(cut >= 0, `expected tool call ${marker} in inbound history`);
    return full.slice(cut);
  };
  assert.match(tailAfter(2, "e2e-2"), /process_plan_open/, "pre-plan fixture dispatch is refused while the plan obligation is open");
  // The required plan producer passes the process gate: the Hub really spawns it
  // (the spawn itself fails here because the fixture model triage-e2e/m exists
  // only in the parent session, which is exactly why a failed producer must
  // not close the stage).
  const plannerTail = tailAfter(3, "e2e-3");
  assert.match(plannerTail, /\[planner\]/, "planner stage dispatch runs as the required plan producer");
  assert.doesNotMatch(plannerTail, /"status":"process_plan_open"/, "planner stage dispatch is not refused by the plan gate");
  assert.match(plannerTail, /"status":"error"/, "producer dispatch attempted a real spawn and reports its execution status");
  assert.match(plannerTail, /triage-e2e\/m" not found/, "producer failure is the missing fixture model in the child, not a gate refusal");
  assert.match(tailAfter(4, "e2e-4"), /process_plan_open/, "a failed producer run leaves the plan gate closed for the next fixture dispatch");
});
