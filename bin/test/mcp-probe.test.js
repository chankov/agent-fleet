import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { PROBE_PROTOCOL, probeMcpServer } from "../lib/mcp-probe.js";
import { MINIMUM_NODE, RUNTIME_RELATIVE, SERVER_NAME, compareNodeVersion } from "../lib/set-codex-mcp.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runtime = join(repoRoot, RUNTIME_RELATIVE);
const nodeTooOld = compareNodeVersion(process.version, MINIMUM_NODE) < 0;

const disposables = [];

test.after(() => {
  for (const root of disposables) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "mcp-probe-"));
  disposables.push(root);
  return root;
}

/** A scripted STDIO server whose behaviour is selected by its first argument. */
const FAKE_SERVER = `
import { writeFileSync } from "node:fs";
const mode = process.argv[2];
if (process.env.PROBE_PID_FILE) writeFileSync(process.env.PROBE_PID_FILE, String(process.pid));
const reply = message => process.stdout.write(JSON.stringify(message) + "\\n");
let buffered = "";
process.stdin.on("data", chunk => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (mode === "silent") continue;
    if (message.method === "initialize") {
      if (mode === "rpc-error") { reply({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "launch refused by fake" } }); continue; }
      reply({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: mode === "wrong-name" ? "someone-else" : "af-local-read", version: "0" } } });
    } else if (message.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: message.id, result: { tools: mode === "no-tools" ? [] : [{ name: "fleet_discover" }, { name: "fleet_diagnostics" }] } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function fakeServer(mode) {
  const root = scratch();
  const script = join(root, "fake-server.mjs");
  writeFileSync(script, FAKE_SERVER);
  return { root, command: process.execPath, args: [script, mode] };
}

test("probes the packaged runtime with temporary paths and creates no policy state", { skip: nodeTooOld && `needs Node ${MINIMUM_NODE}` }, async () => {
  const root = scratch();
  const registryRoot = join(root, "registry");
  const parent = join(root, "parent");
  const policyRoot = join(parent, "policy");
  mkdirSync(parent);
  const result = await probeMcpServer({
    command: process.execPath,
    args: [runtime, "--registry-root", registryRoot, "--policy-root", policyRoot, "--host-profile", "probe", "--principal", "probe"],
    expectedName: SERVER_NAME,
  });
  assert.equal(result.serverInfo.name, SERVER_NAME);
  assert.equal(result.protocolVersion, PROBE_PROTOCOL);
  assert.ok(result.toolCount >= 1);
  assert.equal(result.toolCount, result.toolNames.length);
  assert.ok(result.toolNames.includes("fleet_discover"));
  assert.ok(result.toolNames.includes("fleet_diagnostics"));
  assert.ok(result.durationMs >= 0);
  for (const path of [registryRoot, policyRoot, `${policyRoot}.observations`, `${policyRoot}.instructions`, `${policyRoot}.reports`, `${policyRoot}.permissions`]) {
    assert.equal(existsSync(path), false, `${path} must not be created by a probe`);
  }
});

test("a runtime that refuses its launch is reported with its stderr", { skip: nodeTooOld && `needs Node ${MINIMUM_NODE}` }, async () => {
  await assert.rejects(
    probeMcpServer({ command: process.execPath, args: [runtime, "--registry-root", "/tmp/only-one-flag"], expectedName: SERVER_NAME, timeoutMs: 10000 }),
    /probe failed: server exited before replying[\s\S]*LOCAL_MCP_START_FAILED/,
  );
});

test("a server with another name, no tools, or an initialize error is refused", async () => {
  const wrongName = fakeServer("wrong-name");
  await assert.rejects(probeMcpServer({ ...wrongName, expectedName: SERVER_NAME }), /identified itself as "someone-else".*expected "af-local-read"/);
  const noTools = fakeServer("no-tools");
  await assert.rejects(probeMcpServer({ ...noTools, expectedName: SERVER_NAME }), /advertises no tools/);
  const rpcError = fakeServer("rpc-error");
  await assert.rejects(probeMcpServer({ ...rpcError, expectedName: SERVER_NAME }), /initialize failed: launch refused by fake/);
});

test("a silent server hits the bounded timeout and is terminated", async () => {
  const silent = fakeServer("silent");
  const pidFile = join(silent.root, "pid");
  const started = Date.now();
  await assert.rejects(
    probeMcpServer({ ...silent, expectedName: SERVER_NAME, timeoutMs: 500, env: { ...process.env, PROBE_PID_FILE: pidFile } }),
    /timed out after 500 ms/,
  );
  assert.ok(Date.now() - started < 5000, "the probe gives up promptly");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the probed child is gone");
});

test("a missing command fails to start without hanging", async () => {
  await assert.rejects(probeMcpServer({ command: join(scratch(), "no-such-node"), args: [], expectedName: SERVER_NAME, timeoutMs: 2000 }), /failed to start/);
});

test("a healthy scripted server yields its tool catalogue", async () => {
  const healthy = fakeServer("ok");
  const result = await probeMcpServer({ ...healthy, expectedName: SERVER_NAME });
  assert.deepEqual(result.toolNames, ["fleet_discover", "fleet_diagnostics"]);
  assert.equal(result.toolCount, 2);
});
