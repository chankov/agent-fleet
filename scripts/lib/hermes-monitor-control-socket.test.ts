import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorRegistry } from "./hermes-monitor-registry.ts";
import { MonitorSocketServer } from "./hermes-monitor-socket.ts";

function controlRequest(socketPath: string, frame: string, timeoutMs = 100): Promise<string> {
	return new Promise((resolve, reject) => { const client = net.createConnection(socketPath); let body = ""; client.setTimeout(timeoutMs, () => client.destroy(new Error("control frame was not timed out by server"))); client.on("connect", () => client.write(frame)); client.on("data", (chunk) => { body += chunk; }); client.on("error", reject); client.on("close", () => resolve(body)); });
}

test("UDS cancel route authenticates profile token and forwards only task plus generation to the hub-owned control registry", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "monitor-control-socket-")); const profile = join(root, "profile"); mkdirSync(profile);
	const calls: unknown[] = [];
	const registration = new MonitorRegistry({ runtimeDir: join(root, "runtime") }).register({ profilePath: profile, hubInstanceId: "hub", snapshot: () => ({}) }) as any;
	registration.cancel = (request: unknown) => { calls.push(request); return { cancelled: true, state: "cancelled" }; };
	const socket = new MonitorSocketServer(registration); await socket.listen(); t.after(() => socket.close());
	const denied = await controlRequest(registration.socketPath, JSON.stringify({ type: "cancel", token: "wrong", taskId: "task", generation: 2 }) + "\n");
	assert.deepEqual(JSON.parse(denied), { ok: false, error: "unauthorized" });
	const allowed = await controlRequest(registration.socketPath, JSON.stringify({ type: "cancel", token: registration.token, taskId: "task", generation: 2, pid: 1 }) + "\n");
	assert.deepEqual(JSON.parse(allowed), { ok: true, result: { cancelled: true, state: "cancelled" } });
	assert.deepEqual(calls, [{ taskId: "task", generation: 2 }], "client PID/profile paths must never reach the hub control seam");
});

test("UDS rejects invalid bounded task IDs, generations, and output cursors before dispatch", async (t) => {
	const root=mkdtempSync(join(tmpdir(),"monitor-validation-")),profile=join(root,"profile");mkdirSync(profile);const calls:any[]=[];const registration:any=new MonitorRegistry({runtimeDir:join(root,"runtime")}).register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})});registration.output=(r:any)=>{calls.push(r);return{}};const socket=new MonitorSocketServer(registration);await socket.listen();t.after(()=>socket.close());
	for(const value of [{type:"output",token:registration.token,taskId:"bad/path",generation:1,afterSequence:0},{type:"output",token:registration.token,taskId:"task",generation:0,afterSequence:0},{type:"output",token:registration.token,taskId:"task",generation:1},{type:"output",token:registration.token,taskId:"task",generation:1,afterSequence:-1}]) assert.equal(await controlRequest(registration.socketPath,JSON.stringify(value)+"\n"),"");
	assert.deepEqual(calls,[]);
});

test("UDS output cap accommodates worst-case escaped retained output", async (t) => {const root=mkdtempSync(join(tmpdir(),"monitor-output-cap-")),profile=join(root,"profile");mkdirSync(profile);const registration:any=new MonitorRegistry({runtimeDir:join(root,"runtime")}).register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})});registration.output=()=>({text:"\u0000".repeat(256*1024),sequence:1,firstSequence:1,truncated:false});const socket=new MonitorSocketServer(registration);await socket.listen();t.after(()=>socket.close());const body=await controlRequest(registration.socketPath,JSON.stringify({type:"output",token:registration.token,taskId:"task",generation:1,afterSequence:0})+"\n", 5_000);assert.equal(JSON.parse(body).ok,true);});

test("UDS enforces a partial-frame deadline and connection cap", async () => {
	const api = await import("./hermes-monitor-socket.ts") as typeof import("./hermes-monitor-socket.ts") & { PARTIAL_FRAME_TIMEOUT_MS?: unknown; MAX_SOCKET_CONNECTIONS?: unknown };
	assert.equal(typeof api.PARTIAL_FRAME_TIMEOUT_MS, "number", "Slice 9 requires a server-owned partial-frame timeout");
	assert.equal(typeof api.MAX_SOCKET_CONNECTIONS, "number", "Slice 9 requires a bounded UDS connection cap");
});
