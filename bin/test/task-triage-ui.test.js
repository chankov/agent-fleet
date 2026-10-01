import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
registerHooks({ resolve(specifier, context, nextResolve) {
 if (specifier === "@earendil-works/pi-ai") return nextResolve(specifier, { ...context, parentURL: piEntry });
 return nextResolve(specifier, context);
} });

const launcher = new URL("./helpers/task-triage-ui.mjs", import.meta.url);
test("task-triage UI launcher isolates configs, credentials, provider, guard and scene input", async t => {
 const { prepareTriageUiCase } = await import(launcher.href);
 for (const scene of ["applied", "waived", "timeout", "oversized", "stale"]) {
  const prepared = prepareTriageUiCase(scene, { ambient: { PATH: process.env.PATH, TYPESAFE_API_KEY: "PRIVATE_KEY", OPENAI_API_KEY: "PRIVATE_OPENAI", HOME: "/PRIVATE_HOME", NODE_OPTIONS: "--require PRIVATE_PRELOAD" } });
  t.after(() => rmSync(prepared.workspace, { recursive: true, force: true }));
  assert.ok(prepared.workspace.startsWith(join(tmpdir(), "task-triage-ui-")));
  assert.equal(prepared.env.TYPESAFE_API_KEY, "synthetic-test-only-key");
  assert.equal(prepared.env.OPENAI_API_KEY, undefined);
  assert.equal(prepared.env.HOME, join(prepared.workspace, "home"));
  assert.equal(prepared.env.PI_CODING_AGENT_DIR, join(prepared.workspace, "agent"));
  assert.match(prepared.env.NODE_OPTIONS, /system1-no-network\.js$/);
  assert.equal(prepared.env.AGENT_SKILLS_NO_UPDATE_CHECK, "1");
  assert.equal(prepared.env.AGENT_HUB_TASK_TRIAGE_FAKE, scene === "timeout" ? "timeout" : "security");
  assert.ok(prepared.args.includes("--offline") && prepared.args.includes("--no-extensions") && prepared.args.includes("--no-context-files"));
  assert.ok(prepared.args.includes("triage-ui/m"));
  assert.ok(prepared.args.some(p => p.endsWith("agent-hub/index.ts")), "production Hub, not mock UI");
  assert.equal(JSON.parse(readFileSync(join(prepared.workspace, ".ai/task-triage.json"), "utf8")).remoteContextApproved, true);
  assert.equal(JSON.parse(readFileSync(join(prepared.workspace, ".ai/system1.json"), "utf8")).mode, "auto");
  assert.equal(existsSync(join(prepared.workspace, ".env")), false);
  assert.ok(!JSON.stringify(prepared).includes("PRIVATE_"));
 }
 assert.throws(() => prepareTriageUiCase("unreviewed"), /scene/);
});
test("task-triage UI helper refuses activation without opt-in and only permits synthetic editor input", async () => {
 const { createTriageUiProbe, TRIAGE_UI_INPUTS } = await import("./helpers/task-triage-ui-probe.ts");
 const events = new Map(), commands = new Map(); let providers = 0, editor = "";
 const pi = { on: (name, fn) => events.set(name, fn), registerCommand: (name, spec) => commands.set(name, spec), registerProvider: () => providers++ };
 assert.throws(() => createTriageUiProbe(pi, {}), /offline|opt-in/);
 createTriageUiProbe(pi, { AF_TASK_TRIAGE_UI: "1", PI_OFFLINE: "1", AF_TASK_TRIAGE_UI_SCENE: "applied" });
 assert.equal(providers, 1);
 const ctx = { ui: { notify() {}, setEditorText: text => { editor = text; } }, sessionManager: { getEntries: () => [] } };
 await commands.get("triage-ui-fill").handler("applied", ctx);
 assert.equal(editor, TRIAGE_UI_INPUTS.applied);
 assert.equal(TRIAGE_UI_INPUTS.oversized.length, 40961); assert.equal(TRIAGE_UI_INPUTS["viewer-withheld"].length, 33792);
 assert.deepEqual(await events.get("input")({ text: "PRIVATE_ARBITRARY_INPUT", source: "interactive" }, ctx), { action: "handled" });
 assert.deepEqual(await events.get("input")({ text: TRIAGE_UI_INPUTS.stale, source: "interactive" }, ctx), { action: "continue" });
 assert.deepEqual(await events.get("input")({ text: "PRIVATE_EXTENSION_INPUT", source: "extension" }, ctx), { action: "handled" });
 let aborted = false;
 assert.throws(() => events.get("before_agent_start")({}, { model: { provider: "external", id: "real" }, abort() { aborted = true; } }), /synthetic UI model/);
 assert.equal(aborted, true);
 assert.doesNotThrow(() => events.get("before_agent_start")({}, { model: { provider: "triage-ui", id: "m" } }));
 await commands.get("triage-ui-waiver").handler("", ctx);
 assert.equal(editor, TRIAGE_UI_INPUTS.applied, "missing addition cannot fabricate a waiver command");
});
test("exact-action UI scene exposes only fixed synthetic calls and never supplies a human answer", async t => {
 const { prepareTriageUiCase } = await import(launcher.href);
 const { createTriageUiProbe, TRIAGE_UI_INPUTS, TRIAGE_UI_ACTIONS } = await import("./helpers/task-triage-ui-probe.ts");
 const prepared = prepareTriageUiCase("action"); t.after(() => rmSync(prepared.workspace, { recursive: true, force: true }));
 assert.equal(prepared.env.AGENT_HUB_TASK_TRIAGE_FAKE, "irreversible");
 assert.equal(readFileSync(join(prepared.workspace, "action-edit.txt"), "utf8"), "alpha-before\nbeta-before\n");
 assert.ok(TRIAGE_UI_ACTIONS.length >= 6);
 const events = new Map(), commands = new Map(); let provider, editor = "", notifications = [];
 const pi = { on: (name, fn) => events.set(name, fn), registerCommand: (name, spec) => commands.set(name, spec), registerProvider: (_name, spec) => { provider = spec; } };
 createTriageUiProbe(pi, prepared.env);
 const ctx = { cwd: prepared.workspace, ui: { notify: text => notifications.push(text), setEditorText: text => { editor = text; } }, sessionManager: { getEntries: () => [] } };
 await commands.get("triage-ui-fill").handler("action", ctx); assert.equal(editor, TRIAGE_UI_INPUTS.action);
 assert.equal(events.get("input")({ text: TRIAGE_UI_INPUTS.applied }, ctx).action, "handled", "action scene cannot send unrelated approved scene inputs");
 assert.equal(events.get("input")({ text: TRIAGE_UI_INPUTS.action }, ctx).action, "continue");
 assert.ok(events.get("tool_call")({ toolName: "write", toolCallId: "forged", input: { path: "action-write.txt", content: "arbitrary" } }, ctx)?.block);
 for (const [i, expected] of TRIAGE_UI_ACTIONS.entries()) {
  const message = await provider.streamSimple({ api: "triage-ui-api", provider: "triage-ui", id: "m" }).result();
  const tc = message.content[0]; assert.equal(tc.type, "toolCall"); assert.equal(tc.name, expected.tool); assert.deepEqual(tc.arguments, expected.input);
  const event = { toolName: tc.name, toolCallId: tc.id, input: tc.arguments };
  assert.ok(events.get("tool_call")({ ...event, input: { ...event.input, injected: true } }, ctx)?.block);
  assert.ok(events.get("tool_call")(event, { ...ctx, cwd: "/other" })?.block);
  assert.equal(events.get("tool_call")(event, ctx), undefined, "only exact emitted input passes the fixture gate; production gates still decide");
  assert.ok(events.get("tool_call")(event, ctx)?.block, "fixture permit is one-call only");
 }
 assert.equal((await provider.streamSimple({ api: "triage-ui-api", provider: "triage-ui", id: "m" }).result()).stopReason, "stop");
 assert.equal(events.get("user_bash")({}, ctx).result.exitCode, 1);
 assert.match(events.get("user_bash")({}, ctx).result.output, /disabled/);
 await commands.get("triage-ui-action-status").handler("", ctx);
 assert.ok(notifications.some(text => /write.*missing/i.test(text)));
 assert.equal(existsSync(join(prepared.workspace, "action-write.txt")), false, "model generation and status do not execute any effect");
});

test("real Pi TTY loads production Hub and opens synthetic Fleet and communication viewer", { timeout: 65000 }, async t => {
 const { prepareTriageUiCase } = await import(launcher.href);
 const prepared = prepareTriageUiCase("applied"); t.after(() => rmSync(prepared.workspace, { recursive: true, force: true }));
 const script = `
import os, pty, select, time, pathlib, fcntl, termios, struct, signal
ready=pathlib.Path(${JSON.stringify(join(prepared.workspace, "ready.json"))})
pid,fd=pty.fork()
if pid==0:
 os.chdir(${JSON.stringify(prepared.workspace)})
 os.execve(${JSON.stringify(prepared.executable)}, ${JSON.stringify([prepared.executable, ...prepared.args])}, dict(os.environ))
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",30,160,0,0))
buf=bytearray()
def drain(seconds):
 end=time.time()+seconds
 while time.time()<end:
  r,_,_=select.select([fd],[],[],.1)
  if r:
   try: buf.extend(os.read(fd,65536))
   except OSError: return
try:
 deadline=time.time()+20
 while not ready.exists() and time.time()<deadline: drain(.2)
 if not ready.exists(): raise RuntimeError("fixture not ready")
 drain(1)
 for text,delay in [("/triage-ui-fill applied",.8),("",2),("/af-agents-list",1)]:
  os.write(fd,(text+"\\r").encode());drain(delay)
 if b"Task triage" not in buf: raise RuntimeError("no task triage in Fleet")
 os.write(fd,b"1");drain(.8)
 if b"capture OFF" not in buf: raise RuntimeError("viewer capture not off")
 os.write(fd,b"e");drain(.4);os.write(fd,b"\\x1b");drain(.4);os.write(fd,b"q");drain(.4)
 os.write(fd,b"/triage-ui-fill viewer-withheld\\r");drain(.8);os.write(fd,b"\\r");drain(2)
 os.write(fd,b"/af-agents-list\\r");drain(1);os.write(fd,b"1");drain(.8)
 os.write(fd,b"\\r");drain(.5)
 if b"payload withheld or too large" not in buf: raise RuntimeError("oversized viewer payload not withheld")
 os.write(fd,b"\\x1b");drain(.3);os.write(fd,b"d");drain(.3);os.write(fd,b"\\x1b");drain(.3);os.write(fd,b"q");drain(.3)
 os.write(fd,b"/quit\\r");drain(1)
 deadline=time.time()+5
 status=None
 while time.time()<deadline:
  waited,code=os.waitpid(pid,os.WNOHANG)
  if waited: status=code;break
  drain(.1)
 if status is None: raise RuntimeError("Pi did not exit after /quit")
 if os.waitstatus_to_exitcode(status)!=0: raise RuntimeError("Pi nonzero exit")
 print("TTY_SMOKE_PASS")
except Exception as error:
 print(str(error));print(bytes(buf).decode(errors="replace")[-5000:]);raise SystemExit(1)
finally:
 try: os.kill(pid,signal.SIGKILL)
 except ProcessLookupError: pass
`;
 const result = spawnSync("python3", ["-c", script], { encoding: "utf8", env: prepared.env, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
 assert.equal(result.status, 0, result.stderr + result.stdout);
 assert.match(result.stdout, /TTY_SMOKE_PASS/);
 assert.doesNotMatch(result.stdout + result.stderr, /offline tests forbid network|synthetic-test-only-key/);
});

test("real Pi TTY exact-action questions show bash/write/edit data and refuse later or unsafe writes", { timeout: 90000 }, async t => {
 const { prepareTriageUiCase } = await import(launcher.href);
 const prepared = prepareTriageUiCase("action"); t.after(() => rmSync(prepared.workspace, { recursive: true, force: true }));
 const script = `
import os, pty, select, time, pathlib, fcntl, termios, struct, signal
root=pathlib.Path(${JSON.stringify(prepared.workspace)})
pid,fd=pty.fork()
if pid==0:
 os.chdir(str(root))
 os.execve(${JSON.stringify(prepared.executable)}, ${JSON.stringify([prepared.executable, ...prepared.args])}, dict(os.environ))
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",48,160,0,0))
buf=bytearray()
def drain(seconds):
 end=time.time()+seconds
 while time.time()<end:
  r,_,_=select.select([fd],[],[],.1)
  if r:
   try: buf.extend(os.read(fd,65536))
   except OSError: return
def wait_for(text,start=0):
 deadline=time.time()+15
 while time.time()<deadline:
  drain(.1)
  if text.encode() in buf[start:]: return
 raise RuntimeError("not rendered: "+text)
def keys(data,delay=.5):
 os.write(fd,data);drain(delay)
try:
 deadline=time.time()+20
 while not (root/"ready.json").exists() and time.time()<deadline: drain(.2)
 if not (root/"ready.json").exists(): raise RuntimeError("fixture not ready")
 drain(1)
 keys(b"!printf bypass > arbitrary-shell.txt\\r",1)
 wait_for("Shell commands are disabled")
 if (root/"arbitrary-shell.txt").exists(): raise RuntimeError("shell escaped the fixture")
 keys(b"/triage-ui-fill action\\r",.8);keys(b"\\r",1)
 for i,terms in enumerate([
  ["Operation: bash", "printf", "synthetic bash preview", '"timeout": 5'],
  ["Operation: write", "action-write.txt", "synthetic write line 1", "synthetic write line 2"],
  ["Operation: edit", "action-edit.txt", "alpha-before", "alpha-after", "beta-before", "beta-after"],
  ["Operation: write", "action-denied.txt", "later action needs its own decision"],
 ]):
  start=0 if i==0 else decision_end
  wait_for(terms[0],start)
  # A resized prompt remains navigable. PgDn exposes all JSON lines before answering.
  if i==2:
   fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",24,48,0,0));os.kill(pid,signal.SIGWINCH);drain(.5)
  for _ in range(8): keys(b"\\x1b[6~",.12)
  for term in terms: wait_for(term,start)
  wait_for("END ACTION INPUT JSON",start)
  wait_for("Working directory",start)
  if i==2:
   fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",48,160,0,0));os.kill(pid,signal.SIGWINCH);drain(.4)
  decision_end=len(buf)
  # Test automation is not a human UI sign-off. First 3 Yes, then distinct No.
  keys(b"2" if i==3 else b"1",.2);keys(b"\\r",1)
 wait_for("Fixed action sequence finished",decision_end)
 if (root/"action-write.txt").read_text()!="synthetic write line 1\\nsynthetic write line 2\\n": raise RuntimeError("approved write missing")
 if (root/"action-edit.txt").read_text()!="alpha-after\\nbeta-after\\n": raise RuntimeError("approved edit missing")
 for name in ["action-denied.txt","action-sensitive.txt","action-large.txt"]:
  if (root/name).exists(): raise RuntimeError("refused file exists: "+name)
 keys(b"/triage-ui-action-status\\r",.8);wait_for("exact expected bytes")
 keys(b"/quit\\r",1)
 deadline=time.time()+5
 while time.time()<deadline:
  waited,code=os.waitpid(pid,os.WNOHANG)
  if waited:
   if os.waitstatus_to_exitcode(code)!=0: raise RuntimeError("Pi nonzero exit")
   break
  drain(.1)
 else: raise RuntimeError("Pi did not exit")
 print("ACTION_TTY_SMOKE_PASS")
except Exception as error:
 print(str(error));print(bytes(buf).decode(errors="replace")[-10000:]);raise SystemExit(1)
finally:
 try: os.kill(pid,signal.SIGKILL)
 except ProcessLookupError: pass
`;
 const result = spawnSync("python3", ["-c", script], { encoding: "utf8", env: prepared.env, timeout: 85000, maxBuffer: 2 * 1024 * 1024 });
 assert.equal(result.status, 0, result.stderr + result.stdout); assert.match(result.stdout, /ACTION_TTY_SMOKE_PASS/);
 assert.doesNotMatch(result.stdout + result.stderr, /offline tests forbid network|synthetic-test-only-key/);
});

test("task-triage UI launcher help is write-free and explicit about human acceptance", () => {
 const result = spawnSync(process.execPath, [launcher.pathname, "--help"], { encoding: "utf8" });
 assert.equal(result.status, 0, result.stderr);
 assert.match(result.stdout, /applied.*waived.*timeout.*oversized.*stale/);
 assert.match(result.stdout, /human|човешк/); assert.match(result.stdout, /--keep/);
});
