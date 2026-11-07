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

async function fixture(t: any, peerSource?: string, autoPolicy?:unknown,customRules?:unknown) {
 const dir = mkdtempSync(join(tmpdir(), "fleet-d6-loader-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 mkdirSync(join(dir, ".pi"),{mode:0o700});
 writeFileSync(join(dir, ".pi", "damage-control-rules.yaml"), "bashToolPatterns: []\nzeroAccessPaths: []\nreadOnlyPaths: []\nnoDeletePaths: []\n");
 if(autoPolicy){writeFileSync(join(dir,'.pi','damage-control-rules.yaml'),JSON.stringify({bashToolPatterns:[],zeroAccessPaths:[],readOnlyPaths:['fixture-protected/'],noDeletePaths:[]}));writeFileSync(join(dir,'.pi','damage-control-auto-policy.yaml'),JSON.stringify(autoPolicy),{mode:0o600});}
 if(customRules)writeFileSync(join(dir,'.pi','damage-control-rules.yaml'),JSON.stringify(customRules));
 const paths = [damageControl];
 if (peerSource) { paths.push(join(dir, "peer.ts")); writeFileSync(paths[1], peerSource); }
 const loaded = await loadExtensions(paths, dir); assert.deepEqual(loaded.errors, []);
 if(autoPolicy||customRules)(loaded.runtime as any).appendEntry=()=>{};
 const ctx = { cwd: dir, hasUI: false, ui: { notify() {}, setStatus() {} } };
 const emit = async (index: number, name: string, event: any) => {
  let result; for (const handler of loaded.extensions[index].handlers.get(name) ?? []) result = await handler(event, ctx) ?? result; return result;
 };
 const command = (index: number, name: string) => (loaded.extensions[index].commands.get(name)!.handler as any)("", ctx);
 const bash = (id: string) => emit(0, "tool_call", { type: "tool_call", toolCallId: id, toolName: "bash", input: { command: "echo ok" } });
 await emit(0, "session_start", { type: "session_start" }); t.after(() => emit(0, "session_shutdown", { type: "session_shutdown" }));
 return { emit, command, bash,dir };
}

for(const surface of ['path','bash'] as const)test(`real Pi baseline ${surface} reaches the common permission latch across separately loaded extensions`,async t=>{
 const relayModule=JSON.stringify(fileURLToPath(new URL('../agent-hub/permission-relay.ts',import.meta.url)));
 const rules={zeroAccessPaths:[],readOnlyPaths:['fixture-protected/'],noDeletePaths:[],bashToolPatterns:surface==='bash'?[{pattern:'fixture-danger',reason:'synthetic fixture',ask:true}]:[]};
 const f=await fixture(t,`import {PermissionRelay,registerPermissionRelay} from ${relayModule};export default function(pi){const relay=new PermissionRelay(()=>({project:'fixture',peer:'hub',sessionId:'session',startedAt:'2026-11-04T00:00:00Z'}),()=>({taskId:'task',inputRevision:'revision'}));registerPermissionRelay(pi.events,relay);pi.registerCommand('relay',{handler:()=>relay});}`,undefined,rules);
 const relay:any=await f.command(1,'relay'),owner={project:'fixture',peer:'hub',sessionId:'session',startedAt:'2026-11-04T00:00:00Z'};
 const event={type:'tool_call',toolCallId:'baseline-'+surface,toolName:surface==='path'?'write':'bash',input:surface==='path'?{path:join(f.dir,'fixture-protected/a'),content:'fixture'}:{command:'fixture-danger'}};
 const pending=f.emit(0,'tool_call',event);let row:any;
 for(let i=0;i<100&&!row;i++){relay.handle({end(text:string){row=JSON.parse(text).requests?.[0];}},{type:'permission_request',version:1,msg_id:'list',owner,operation:'list',payload:{},sender_session:'fixture',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()});if(!row)await new Promise(r=>setTimeout(r,5));}
 assert.ok(row,'baseline must publish before any effect');
 relay.handle({end(){}},{type:'permission_request',version:1,msg_id:'decide',owner,operation:'decide',payload:{snapshot:row.snapshot,decision:'allow_once',reason:'fixture exact action',principal:{actor:'codex_machine',bindingId:'fixture',bindingEpoch:'epoch',threadId:'thread',turnId:null,approve:true}},sender_session:'fixture',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()});
 assert.equal((await pending)?.block,false);
});

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

test('user opt-in static auto-policy still runs the separately loaded D6 guard and cannot bypass its hold',async t=>{
 const policy={version:1,rules:[{id:'fixture-once',decision:'allow_once',source:'damage_control_path',category:'read_only',tool:'write',pattern:'fixture-protected/',operation:'write',expiresAt:new Date(Date.now()+60000).toISOString(),reason:'Explicit synthetic fixture rule'}]};
 const f=await fixture(t,`import {registerDamageGuard} from ${lib('damage-guard-port.ts')};export default function(pi){pi.registerCommand('hold',{handler:()=>registerDamageGuard({call:async()=>({block:true,reason:'held by D6 fixture'})})});}`,policy);
 const unregister=await f.command(1,'hold');t.after(unregister);
 const event={type:'tool_call',toolCallId:'auto-held',toolName:'write',input:{path:join(f.dir,'fixture-protected/a'),content:'synthetic fixture'}};
 assert.deepEqual(await f.emit(0,'tool_call',event),{block:true,reason:'held by D6 fixture'});
 unregister();assert.equal((await f.emit(0,'tool_call',{...event,toolCallId:'auto-unheld'}))?.block,false);
});

test('auto policy evaluates original shell opacity, never a normalized conservative substitute',async t=>{
 const policy={version:1,rules:[{id:'fixture-bash-once',decision:'allow_once',source:'damage_control_path',category:'read_only',tool:'bash',pattern:'fixture-protected/',operation:'write',expiresAt:new Date(Date.now()+60000).toISOString(),reason:'Explicit static synthetic fixture rule'}]};
 const f=await fixture(t,undefined,policy);
 assert.equal((await f.emit(0,'tool_call',{type:'tool_call',toolCallId:'auto-static-bash',toolName:'bash',input:{command:'echo synthetic > fixture-protected/a'}}))?.block,false);
 const dynamic=await f.emit(0,'tool_call',{type:'tool_call',toolCallId:'auto-opaque-bash',toolName:'bash',input:{command:'echo synthetic > fixture-protected/$(printf a)'}});
 assert.equal(dynamic?.block,true);
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

test("Pi loader retains the assigned broker across sequential bash calls and results", async t => {
 const { createDamageOwners } = await import('../agent-hub/damage-guard-owners.ts');
 const { createDamageBroker } = await import('../agent-hub/damage-guard-broker.ts');
 const owners = createDamageOwners({ current: () => ({ session: 'fixture', taskToken: 't', taskId: 'task', inputRevision: 'r' }), admit: () => true });
 let calls = 0;
 const broker = await createDamageBroker({ authority: owners, assess: async () => { calls++; return 'no_hold'; } });
 t.after(async () => { await broker.close(); owners.dispose(); });
 const assignment = broker.register({ owner: 'child', tools: ['bash'], cwd: process.cwd() });
 const saved = process.env.AF_D6_ASSIGNMENT;
 t.after(() => { saved === undefined ? delete process.env.AF_D6_ASSIGNMENT : process.env.AF_D6_ASSIGNMENT = saved; delete (globalThis as any)[portStore]?.spawned; });
 process.env.AF_D6_ASSIGNMENT = JSON.stringify(assignment);
 const f = await fixture(t);
 for (const [i, command] of ['node --test --test-timeout=15000 .pi/agent-fleet/scripts/fleet-codex-actions-compat.test.ts', 'node --test --test-timeout=15000 .pi/harnesses/ask-user-remote/questions-guarded.test.ts'].entries()) {
  const event = { type: 'tool_call', toolCallId: 'seq-' + i, toolName: 'bash', input: { command, timeout: 180 } };
  assert.equal((await f.emit(0, 'tool_call', event))?.block, false);
  await f.emit(0, 'tool_result', { ...event, type: 'tool_result', content: [{ type: 'text', text: '13 pass' }], details: {}, isError: false });
 }
 assert.equal(calls, 2);
});
