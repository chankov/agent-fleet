import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

// Pi gives every `-e` extension its own module instance. These load the real
// Damage-Control beside a second extension through Pi's own loader.
const lib = (name: string) => JSON.stringify(fileURLToPath(new URL(`./${name}`, import.meta.url)));
const damageControl = fileURLToPath(new URL("../damage-control-continue/index.ts", import.meta.url));
const portStore = Symbol.for("agent-fleet.damage-guard-port.v1");

async function fixture(t: any, peerSource?: string) {
 const dir = mkdtempSync(join(tmpdir(), "fleet-d6-loader-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 mkdirSync(join(dir, ".pi"));
 writeFileSync(join(dir, ".pi", "damage-control-rules.yaml"), "bashToolPatterns: []\nzeroAccessPaths: []\nreadOnlyPaths: []\nnoDeletePaths: []\n");
 const paths = [damageControl];
 if (peerSource) { paths.push(join(dir, "peer.ts")); writeFileSync(paths[1], peerSource); }
 const loaded = await loadExtensions(paths, dir); assert.deepEqual(loaded.errors, []);
 const ctx = { cwd: dir, hasUI: false, ui: { notify() {}, setStatus() {} } };
 const emit = async (index: number, name: string, event: any) => {
  let result; for (const handler of loaded.extensions[index].handlers.get(name) ?? []) result = await handler(event, ctx) ?? result; return result;
 };
 const command = (index: number, name: string) => (loaded.extensions[index].commands.get(name)!.handler as any)("", ctx);
 const bash = (id: string) => emit(0, "tool_call", { type: "tool_call", toolCallId: id, toolName: "bash", input: { command: "echo ok" } });
 await emit(0, "session_start", { type: "session_start" }); t.after(() => emit(0, "session_shutdown", { type: "session_shutdown" }));
 return { emit, command, bash };
}

test("a guard the Hub registers is consulted by the separately loaded Damage-Control", async t => {
 const f = await fixture(t, `import { registerDamageGuard } from ${lib("damage-guard-port.ts")};
 export default function (pi) { pi.registerCommand("hold", { handler: () => registerDamageGuard({ call: async () => ({ block: true, reason: "held by hub" }) }) }); }`);
 const unregister = await f.command(1, "hold"); t.after(unregister);
 assert.deepEqual(await f.bash("held"), { block: true, reason: "held by hub" });
 unregister(); assert.equal((await f.bash("released"))?.block, false);
});

test("a result Damage-Control captured is original evidence for another extension's result hook", async t => {
 const f = await fixture(t, `import { damageCaptureState } from ${lib("damage-result-evidence.ts")};
 export default function (pi) { pi.on("tool_result", event => ({ content: [{ type: "text", text: damageCaptureState(event) }] })); }`);
 const event = { type: "tool_result", toolCallId: "r", toolName: "ls", input: { path: "." }, content: [{ type: "text", text: "a\nb" }], details: {}, isError: false };
 await f.emit(0, "tool_result", event);
 assert.deepEqual(await f.emit(1, "tool_result", event), { content: [{ type: "text", text: "captured" }] });
});

test("independently loaded extensions share one human approval wait", async t => {
 const source = `import { sharedApprovalWait } from ${lib("approval-wait.ts")};
 export default function (pi) { pi.registerCommand("wait", { handler: () => sharedApprovalWait }); }`;
 const dir = mkdtempSync(join(tmpdir(), "fleet-wait-loader-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const paths = [join(dir, "a.ts"), join(dir, "b.ts")]; for (const path of paths) writeFileSync(path, source);
 const loaded = await loadExtensions(paths, dir); assert.deepEqual(loaded.errors, []);
 const [first, second] = await Promise.all(loaded.extensions.map(extension => (extension.commands.get("wait")!.handler as any)("", {})));
 const order: string[] = []; let release!: () => void;
 const asking = first.run(async () => { order.push("first"); await new Promise<void>(resolve => { release = resolve; }); });
 const queued = second.run(async () => { order.push("second"); });
 await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ["first"]);
 release(); await Promise.all([asking, queued]); assert.deepEqual(order, ["first", "second"]);
});

test("a native child takes its spawned assignment before tools run, and malformed transport fails closed", async t => {
 const saved = process.env.AF_D6_ASSIGNMENT;
 t.after(() => { saved === undefined ? delete process.env.AF_D6_ASSIGNMENT : process.env.AF_D6_ASSIGNMENT = saved; delete (globalThis as any)[portStore]?.spawned; });
 process.env.AF_D6_ASSIGNMENT = "malformed";
 const f = await fixture(t);
 assert.equal(process.env.AF_D6_ASSIGNMENT, undefined, "Bash subprocesses must not inherit the capability");
 const result = await f.bash("assigned");
 assert.equal(result?.block, true); assert.match(result.reason, /optional assessment transport or registration failed/);
});
