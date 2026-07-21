import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { readFileSync } from "node:fs";

import { MonitorRegistry } from "../../../scripts/lib/hermes-monitor-registry.ts";
import { monitorLifecycleConfig } from "./monitor-lifecycle.ts";

function request(socketPath: string, value: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const client = net.createConnection(socketPath); let body = "";
		client.setTimeout(500, () => client.destroy(new Error("monitor control response timed out")));
		client.on("connect", () => client.end(JSON.stringify(value) + "\n"));
		client.on("data", (chunk) => { body += chunk; });
		client.on("error", reject);
		client.on("close", () => resolve(body ? JSON.parse(body) : null));
	});
}

test("agent-hub index initializes monitor lifecycle only from explicit valid fail-closed environment", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(source, /monitorLifecycleConfig\(process\.env\)/);
	assert.match(source, /await monitorLifecycle\.startBridge\(monitorBridge/); assert.match(source, /const monitorStart = monitorBridge\?\.startChild/); assert.match(source, /finalizeChildFor\(task/); assert.match(source, /appendOutputFor\(task/); assert.match(source, /registerOwnedProcessFor\(task/); assert.doesNotMatch(source, /monitorBridge\?\.appendOutput\(monitorKey/); assert.doesNotMatch(source, /monitorBridge\?\.finalizeChild\(monitorKey/); assert.doesNotMatch(source, /monitorBridge\?\.registerOwnedProcess\(monitorKey/); assert.match(source, /registerWaitOnly\(monitorKey, \(\) => state\.comsAbort\?\.\(\)\)/); assert.match(source, /getRecoveryEvidence: async \(task: any\)/); assert.match(source, /monitorRegistry\.evidenceForOwner\(task\.ownerSessionId/); assert.match(source, /oldOwner: evidence\.owner,[\s\S]*oldSocket: evidence\.socket,[\s\S]*oldSession: evidence\.session,[\s\S]*oldHerdr: herdr\.herdr/); assert.match(source, /\n\t\t\t\t}\);\n\t\t\t\tmonitorBridge = createMonitorSessionBridge/);
	assert.match(source, /cancelLocalOwnedProcess\(\{ process: state\.proc, monitorBridge, monitorKey:/);
	assert.ok((source.match(/monitorKeyForAgent\(state\.def\.name, state\.runCount\)/g) ?? []).length >= 3, "dispatch, kill, and restart must derive the same canonical monitor key");
	assert.ok((source.match(/cancelLocalWaitOnly\(\{/g) ?? []).length >= 2, "kill and restart must preserve local wait cancellation");
	assert.equal(monitorLifecycleConfig({}), null);
	assert.equal(monitorLifecycleConfig({ AGENT_FLEET_PROFILE_ID: "../real", AGENT_FLEET_MONITOR_RUNTIME_DIR: "/tmp/runtime" }), null);
	assert.equal(monitorLifecycleConfig({ AGENT_FLEET_PROFILE_ID: "profile-a", AGENT_FLEET_MONITOR_RUNTIME_DIR: "relative" }), null);
	assert.deepEqual(monitorLifecycleConfig({ AGENT_FLEET_PROFILE_ID: "profile-a", AGENT_FLEET_MONITOR_RUNTIME_DIR: "/tmp/runtime" }), { runtimeDir: "/tmp/runtime", profileId: "profile-a", profilePath: "/tmp/runtime/profiles/profile-a" });
});

test("agent-hub index owns registered handles and exposes an authenticated UDS cancel lifecycle without workspace control", async (t) => {
	const index = await import("./monitor-lifecycle.ts") as typeof import("./monitor-lifecycle.ts") & { createMonitorLifecycle?: unknown };
	assert.equal(typeof index.createMonitorLifecycle, "function", "monitor lifecycle must be injectable for session-owned UDS/control wiring");

	const signals: string[] = [];
	const workspace = { closeCalls: 0, close() { this.closeCalls += 1; } };
	const runtimeDir = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/agent-hub-monitor-index-"));
	const fs = await import("node:fs/promises");
	await fs.mkdir(`${runtimeDir}/profile`);
	const lifecycle = (index.createMonitorLifecycle as Function)({
		registry: new MonitorRegistry({ runtimeDir: `${runtimeDir}/runtime` }),
		signal: (pid: number, signal: string) => signals.push(`${pid}:${signal}`),
		wait: async () => true,
		identity: (p: any) => ({ pid: p.pid, starttime: p.startedAt }),
		workspace,
	});
	const registration = await lifecycle.start({ profilePath: `${runtimeDir}/profile`, hubInstanceId: "hub", snapshot: () => ({ tasks: [] }) });
	t.after(async () => { await lifecycle.stop(); await fs.rm(runtimeDir, { recursive: true, force: true }); });
	const handle = lifecycle.registerOwnedGeneration({ profileKey: registration.profileKey, taskId: "task", generation: 2, token: registration.token, process: { pid: 44, startedAt: "start-44" } });
	assert.deepEqual(await request(registration.socketPath, { type: "cancel", token: registration.token, taskId: "task", generation: 1, pid: 1 }), { ok: true, result: { cancelled: false, reason: "unsupported" } });
	assert.deepEqual(await request(registration.socketPath, { type: "cancel", token: registration.token, taskId: "task", generation: 2, handle, pid: 1 }), { ok: true, result: { cancelled: true, state: "cancelled" } });
	assert.deepEqual(signals, ["44:SIGTERM"]);
	const sharedHandle = lifecycle.registerOwnedGeneration({ profileKey: registration.profileKey, taskId: "shared", generation: 3, token: registration.token, process: { pid: 45, startedAt: "start-45" } });
	const [uds, live] = await Promise.all([request(registration.socketPath, { type: "cancel", token: registration.token, taskId: "shared", generation: 3 }), lifecycle.cancelOwnedGeneration({ taskId: "shared", generation: 3 })]);
	assert.deepEqual(uds, { ok: true, result: { cancelled: true, state: "cancelled" } }); assert.deepEqual(live, { cancelled: true, state: "cancelled" }); assert.equal(sharedHandle.length > 0, true); assert.deepEqual(signals, ["44:SIGTERM", "45:SIGTERM"]);
	assert.equal(workspace.closeCalls, 0);
	assert.deepEqual(lifecycle.recordWaitOnlyCancellation({ taskId: "task", generation: 2, lateEvent: { sequence: 9, text: "late" } }), { state: "cancelled", history: [{ sequence: 9, text: "late" }] });
});
