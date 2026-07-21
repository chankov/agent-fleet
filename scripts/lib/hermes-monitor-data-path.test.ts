import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorStore } from "./hermes-monitor-store.ts";
import { MonitorRegistry } from "./hermes-monitor-registry.ts";
import { MonitorSocketServer } from "./hermes-monitor-socket.ts";
import { readFileSync } from "node:fs";

function request(socketPath: string, frame: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => { const client = net.createConnection(socketPath); let body = ""; client.setTimeout(500, () => client.destroy(new Error("UDS response timed out"))); client.on("connect", () => client.end(JSON.stringify(frame) + "\n")); client.on("data", chunk => { body += chunk; }); client.on("error", reject); client.on("close", () => resolve(body ? JSON.parse(body) : null)); });
}

test("store transition/update produces timestamped parent-child snapshot with correlation and cursor metadata", async () => {
	const api = await import("./hermes-monitor-store.ts") as typeof import("./hermes-monitor-store.ts") & { createMonitorStore?: unknown };
	assert.equal(typeof api.createMonitorStore, "function", "data path needs a clock-injected store transition/snapshot API");
	const store = (api.createMonitorStore as Function)({ now: () => new Date("2026-01-01T00:00:00Z") });
	store.createParent({ id: "parent", generation: 1, hubInstanceId: "hub", checkoutId: "checkout" });
	store.createChild({ id: "child", generation: 1, parentId: "parent", parentGeneration: 1, specialist: "builder", workspaceId: "workspace", hubPaneId: "pane" });
	store.transition("child", 1, "running"); store.appendPublicOutput("child", 1, "one");
	assert.deepEqual(store.snapshot(), { tasks: [{ id: "parent", generation: 1, children: [{ id: "child", generation: 1, state: "running", workspaceId: "workspace", hubPaneId: "pane", outputSequence: 1, updatedAt: "2026-01-01T00:00:00.000Z" }] }] });
});

test("typed UDS output request returns only cursor-new bounded output and caps output/cancel responses", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "monitor-output-route-")); const profile = join(root, "profile"); mkdirSync(profile);
	const store = new MonitorStore(); store.createParent({ id: "task", generation: 1, hubInstanceId: "hub", checkoutId: "checkout" }); store.appendPublicOutput("task", 1, "one"); store.appendPublicOutput("task", 1, "two");
	const registration = new MonitorRegistry({ runtimeDir: join(root, "runtime") }).register({ profilePath: profile, hubInstanceId: "hub", snapshot: () => ({}) }) as any;
	registration.output = ({ taskId, generation, afterSequence }: any) => store.readOutput(taskId, generation, afterSequence);
	const socket = new MonitorSocketServer(registration); await socket.listen(); t.after(() => socket.close());
	assert.deepEqual(await request(registration.socketPath, { type: "output", token: registration.token, taskId: "task", generation: 1, afterSequence: 1 }), { ok: true, output: { text: "two", sequence: 2, firstSequence: 1, truncated: false } });
});

test("index wires one explicit-env MonitorSessionBridge through turn, dispatch, process, delta, final, finish, snapshot, reset, and stop hooks", () => {
	const source = readFileSync(new URL("../../.pi/harnesses/agent-hub/index.ts", import.meta.url), "utf8");
	assert.match(source, /createMonitorSessionBridge/);
	assert.match(source, /monitorLifecycleConfig\(process\.env\)[\s\S]*monitorBridge\s*=/);
	assert.match(source, /monitorBridge\??\.startParent/);
	assert.match(source, /monitorBridge\??\.startChild/);
	assert.match(source, /monitorBridge\??\.registerOwnedProcess/);
	assert.match(source, /monitorBridge\??\.appendOutput/);
	assert.match(source, /monitorBridge\??\.finalizeChild/);
	assert.match(source, /monitorLifecycle\.startBridge\(monitorBridge/);
	assert.doesNotMatch(source, /snapshot:\s*\(\)\s*=>\s*\(\{\s*tasks:\s*\[\]\s*\}\)/);
	assert.match(source, /monitorBridge\??\.reset\(\)/);
	assert.match(source, /monitorBridge\??\.stop\(\)/);
	assert.doesNotMatch(source, /hermes\s*\.\s*(?:rpc|workspace|lifecycle)/i);
});
