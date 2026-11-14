// The Codex daemon client (`codex-daemon-observer.ts`, `codex-unix-queue-rpc.ts`)
// resolves `ws` relative to its own file. In a copied workspace that file sits in
// `.pi/agent-fleet/scripts/lib/`, so `ws` must come from the
// `.pi/agent-fleet/scripts` npm root, the one `companion:workflow-deps` installs
// with `npm ci --prefix .pi/agent-fleet/scripts`. Source-tree tests cannot show
// this, because the checkout also has `ws` in its root `node_modules`.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(root, "bin/cli.js");
const scriptsRoot = ".pi/agent-fleet/scripts";
const ua = "Codex Desktop/0.167.1 (installed-layout fixture;1)";
// Test-only: the fake daemon uses the checkout's `ws`. The probe below must not.
const { WebSocketServer } = createRequire(import.meta.url)("ws");
const posixTest = process.platform === "win32" ? test.skip : test;

// Runs in a child process and imports only the workspace's copied modules.
const PROBE = `
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const [workspace,socketPath]=process.argv.slice(1);
const lib=pathToFileURL(workspace+'/.pi/agent-fleet/scripts/lib/').href;
const {CodexDaemonObserver}=await import(lib+'codex-daemon-observer.ts');
const {CodexUnixQueueRpc}=await import(lib+'codex-unix-queue-rpc.ts');
const out={loaded:true};
try{out.resolved=createRequire(lib+'codex-daemon-observer.ts').resolve('ws');}catch(e){out.resolved=e.code;}
const signal=new AbortController().signal;
try{const o=new CodexDaemonObserver({socketPath,timeoutMs:2000});out.observer=(await o.initialize(signal,o.socketEpoch(signal))).result.userAgent;}catch(e){out.observer=e.code??String(e);}
try{out.queue=await new CodexUnixQueueRpc({socketPath,timeoutMs:2000}).request('thread/loaded/list',{});}catch(e){out.queue=e.code??String(e);}
console.log(JSON.stringify(out));
`;

async function fakeDaemon(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cws-")));
  mkdirSync(join(dir, "c"), { mode: 0o700 });
  const path = join(dir, "c", "s");
  const server = createServer(), wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
  const methods = [];
  server.on("upgrade", (request, socket, head) => wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws)));
  wss.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const packet = JSON.parse(raw.toString("utf8"));
      methods.push(packet.method);
      if (packet.method === "initialize") ws.send(JSON.stringify({ id: packet.id, result: { userAgent: ua } }));
      else if (packet.method === "thread/loaded/list") ws.send(JSON.stringify({ id: packet.id, result: { data: [] } }));
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  chmodSync(path, 0o600);
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => server.close(() => resolve()));
    wss.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, methods };
}

posixTest("installed workspace resolves ws for the Codex daemon connection from the workflow-deps npm root", { timeout: 60000 }, async (t) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codex-ws-installed-")));
  const home = mkdtempSync(join(tmpdir(), "codex-ws-home-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "codex-ws-bin-"));
  t.after(() => { for (const dir of [workspace, home, fakeBin]) rmSync(dir, { recursive: true, force: true }); });

  // The real installer copies the files. A recorder stands in for npm, because
  // tests have no registry access. It logs which npm roots setup installs.
  const npmLog = join(fakeBin, "npm.log");
  writeFileSync(join(fakeBin, "npm"), `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> ${JSON.stringify(npmLog)}\n[ "$1" = "ls" ] && printf '{}\\n'\nexit 0\n`);
  chmodSync(join(fakeBin, "npm"), 0o755);
  const setup = spawnSync(process.execPath, [cli, "setup", "--workspace", workspace, "--preset", "default", "--features", "none", "--allow-exec", "--yes"], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, HOME: home },
    encoding: "utf8",
    timeout: 45000,
  });
  assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
  const npmCalls = readFileSync(npmLog, "utf8").trim().split("\n");
  assert.ok(npmCalls.includes(`${workspace}|ci --prefix ${scriptsRoot}`), npmCalls.join("\n"));

  // The ws client and the npm root that declares `ws` are installed together.
  for (const file of ["lib/codex-daemon-observer.ts", "lib/codex-unix-queue-rpc.ts", "package.json", "package-lock.json"]) {
    assert.ok(readFileSync(join(workspace, scriptsRoot, file)).length > 0, file);
  }
  const manifest = JSON.parse(readFileSync(join(workspace, scriptsRoot, "package.json"), "utf8"));
  const pinned = JSON.parse(readFileSync(join(workspace, scriptsRoot, "package-lock.json"), "utf8")).packages["node_modules/ws"]?.version;
  assert.ok(manifest.dependencies?.ws, "the workflow runtime manifest declares ws");
  assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/, "the workflow runtime lockfile pins ws");

  const daemon = await fakeDaemon(t);
  const probe = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", PROBE, "--", workspace, daemon.path], {
      cwd: workspace,
      env: { PATH: process.env.PATH, HOME: home },
      encoding: "utf8",
      timeout: 20000,
    });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  };

  // Before `npm ci` has filled the root, the Hub path still imports. Only the
  // connection fails, and it never reaches the daemon.
  const missing = await probe();
  assert.deepEqual(missing, { loaded: true, resolved: "MODULE_NOT_FOUND", observer: "CONNECTION_ERROR", queue: "CONNECTION_ERROR" });
  assert.deepEqual(daemon.methods, []);

  // Put ws where `npm ci --prefix .pi/agent-fleet/scripts` puts it, at the
  // version the copied lockfile pins.
  const source = join(root, "node_modules/ws");
  assert.equal(JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version, pinned, "fixture ws matches the installed lockfile");
  cpSync(source, join(workspace, scriptsRoot, "node_modules/ws"), { recursive: true });

  const installed = await probe();
  assert.deepEqual(installed, {
    loaded: true,
    resolved: join(workspace, scriptsRoot, "node_modules/ws/index.js"),
    observer: ua,
    queue: { data: [] },
  });
  assert.deepEqual(daemon.methods, ["initialize", "initialize", "initialized", "thread/loaded/list"]);
});
