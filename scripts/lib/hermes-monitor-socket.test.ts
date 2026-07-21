import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MonitorRegistry } from "./hermes-monitor-registry.ts";
import { MAX_SOCKET_FRAME_BYTES, MonitorSocketServer } from "./hermes-monitor-socket.ts";

function fixtureRoot(): string {
	return mkdtempSync(join(tmpdir(), "agent-fleet-monitor-socket-"));
}

function request(socketPath: string, frame: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const client = net.createConnection(socketPath);
		let response = "";
		client.setTimeout(1000, () => client.destroy(new Error("socket response timed out")));
		client.on("connect", () => client.end(frame));
		client.on("data", (chunk) => { response += chunk; });
		client.on("error", reject);
		client.on("close", () => resolve(response));
	});
}

test("owner-only socket serves a bounded snapshot only to its namespace token", async (t) => {
	const root = fixtureRoot();
	const profile = join(root, "profile");
	mkdirSync(profile);
	const registry = new MonitorRegistry({ runtimeDir: join(root, "runtime") });
	const registration = registry.register({ profilePath: profile, hubInstanceId: "hub-a", snapshot: () => ({ tasks: ["visible"] }) });
	const socket = new MonitorSocketServer(registration);
	await socket.listen();
	t.after(() => socket.close());

	assert.equal(socket.mode(), 0o600);
	const authorized = await request(registration.socketPath, JSON.stringify({ type: "snapshot", token: registration.token }) + "\n");
	assert.deepEqual(JSON.parse(authorized), { ok: true, snapshot: { tasks: ["visible"] } });
	const unauthorized = await request(registration.socketPath, JSON.stringify({ type: "snapshot", token: "wrong" }) + "\n");
	assert.deepEqual(JSON.parse(unauthorized), { ok: false, error: "unauthorized" });
});

test("owned socket close unlinks its socket, stale owned entry is replaced, active and foreign paths are refused", async (t) => {
	const root=fixtureRoot(), profile=join(root,"profile"); mkdirSync(profile); const registry=new MonitorRegistry({runtimeDir:join(root,"runtime")}); const registration=registry.register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})});
	const first=new MonitorSocketServer(registration); await first.listen(); assert.equal(existsSync(registration.socketPath),true); await first.close(); assert.equal(existsSync(registration.socketPath),false);
	writeFileSync(registration.socketPath,"stale"); const replacement=new MonitorSocketServer(registration); await replacement.listen(); const active=new MonitorSocketServer(registration); await assert.rejects(active.listen(),/already active/); await replacement.close();
	const foreign:any={...registration,socketPath:join(root,"foreign"),socketDir:registration.socketDir}; await assert.rejects(new MonitorSocketServer(foreign).listen(),/not registry-owned/);
});

test("malformed, oversized, and non-snapshot frames fail closed", async (t) => {
	const root = fixtureRoot();
	const profile = join(root, "profile");
	mkdirSync(profile);
	const registry = new MonitorRegistry({ runtimeDir: join(root, "runtime") });
	const registration = registry.register({ profilePath: profile, hubInstanceId: "hub-a", snapshot: () => ({}) });
	const socket = new MonitorSocketServer(registration);
	await socket.listen();
	t.after(() => socket.close());

	for (const frame of ["not-json\n", JSON.stringify({ type: "other", token: registration.token }) + "\n", "x".repeat(MAX_SOCKET_FRAME_BYTES + 1)]) {
		const response = await request(registration.socketPath, frame);
		assert.equal(response, "");
	}
});
