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

test("owner-authenticated events replay through the existing bounded UDS", async (t) => {
 const root=fixtureRoot(), profile=join(root,"profile"); mkdirSync(profile); const registration:any=new MonitorRegistry({runtimeDir:join(root,"runtime")}).register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})}); registration.events=({afterSequence,limit,waitMs}:any)=>({firstAvailableSequence:1,latestSequence:2,items:[{eventSequence:2}],timedOut:waitMs===0&&afterSequence===2}); const socket=new MonitorSocketServer(registration); await socket.listen(); t.after(()=>socket.close());
 const denied=await request(registration.socketPath,JSON.stringify({type:"events",token:"wrong",afterSequence:0,limit:1,waitMs:0})+"\n"); assert.deepEqual(JSON.parse(denied),{ok:false,error:"unauthorized"});
 const allowed=await request(registration.socketPath,JSON.stringify({type:"events",token:registration.token,afterSequence:0,limit:1,waitMs:0})+"\n"); assert.equal(JSON.parse(allowed).events.items[0].eventSequence,2);
});

test("events refuse the ninth concurrent long-poll and abort the callback when its client disconnects", async (t) => {
 const root=fixtureRoot(), profile=join(root,"profile"); mkdirSync(profile); let aborted=0;
 const registration:any=new MonitorRegistry({runtimeDir:join(root,"runtime")}).register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})});
 registration.events=(request:any)=>new Promise(()=>{request.signal?.addEventListener("abort",()=>{aborted++;});}); const socket=new MonitorSocketServer(registration); await socket.listen(); t.after(()=>socket.close());
 const clients=Array.from({length:8},()=>net.createConnection(registration.socketPath));
 await Promise.all(clients.map(client=>new Promise<void>((resolve,reject)=>{client.once("connect",()=>{client.write(JSON.stringify({type:"events",token:registration.token,afterSequence:2,limit:1,waitMs:25_000})+"\n");resolve();});client.once("error",reject);})));
 const ninth=net.createConnection(registration.socketPath); const response=await new Promise<string>((resolve,reject)=>{let body="";ninth.once("connect",()=>ninth.write(JSON.stringify({type:"events",token:registration.token,afterSequence:2,limit:1,waitMs:25_000})+"\n"));ninth.on("data",chunk=>body+=chunk);ninth.once("error",reject);ninth.once("close",()=>resolve(body));});
 assert.deepEqual(JSON.parse(response),{ok:false,error:"too_many_waiters"});
 clients[0].destroy(); await new Promise(resolve=>setTimeout(resolve,20));
 for(const client of clients.slice(1)) client.destroy();
 assert.equal(aborted,1, "disconnect cancels the detached long-poll callback");
});

test("a half-closing consumer still receives a response that settles after its FIN", async (t) => {
	const root = fixtureRoot();
	const profile = join(root, "profile");
	mkdirSync(profile);
	const registration: any = new MonitorRegistry({ runtimeDir: join(root, "runtime") }).register({ profilePath: profile, hubInstanceId: "hub", snapshot: () => ({}) });
	// A handler that waits on real work — a process exit or a long poll — settles
	// in a later event-loop turn than the client's half-close.
	registration.cancel = async () => { await new Promise(resolve => setTimeout(resolve, 25)); return { cancelled: true, state: "cancelled" }; };
	registration.events = async ({ waitMs }: any) => { await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 25))); return { firstAvailableSequence: 1, latestSequence: 1, items: [{ eventSequence: 1 }] }; };
	const socket = new MonitorSocketServer(registration);
	await socket.listen();
	t.after(() => socket.close());

	const cancelled = await request(registration.socketPath, JSON.stringify({ type: "cancel", token: registration.token, taskId: "task-a", generation: 1 }) + "\n");
	assert.deepEqual(JSON.parse(cancelled), { ok: true, result: { cancelled: true, state: "cancelled" } });

	const events = await request(registration.socketPath, JSON.stringify({ type: "events", token: registration.token, afterSequence: 0, limit: 1, waitMs: 5_000 }) + "\n");
	assert.equal(JSON.parse(events).events.items[0].eventSequence, 1);
});
