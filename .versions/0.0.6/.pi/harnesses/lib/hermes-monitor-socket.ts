import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import type { MonitorRegistration } from "./hermes-monitor-registry.ts";

export const MAX_SOCKET_FRAME_BYTES = 64 * 1024;
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_CANCEL_RESPONSE_BYTES = 16 * 1024;
export const PARTIAL_FRAME_TIMEOUT_MS = 1000;
export const MAX_SOCKET_CONNECTIONS = 32;
export const MAX_TASK_ID_LENGTH = 128;
export const MAX_AFTER_SEQUENCE = 1_000_000_000;
/** 2 MiB covers the 256 KiB retained UTF-8 output after worst-case JSON escaping plus its envelope. */
export const MAX_OUTPUT_RESPONSE_BYTES = 2 * 1024 * 1024;

interface SnapshotRequest {
	type: "snapshot";
	token: string;
}

function authorized(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function validTaskRequest(taskId: unknown, generation: unknown, afterSequence?: unknown): boolean { return typeof taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(taskId) && taskId.length <= MAX_TASK_ID_LENGTH && Number.isInteger(generation) && (generation as number) >= 1 && (afterSequence === undefined || (Number.isInteger(afterSequence) && (afterSequence as number) >= 0 && (afterSequence as number) <= MAX_AFTER_SEQUENCE)); }

function parseRequest(frame: string): SnapshotRequest | null {
	try {
		const value = JSON.parse(frame) as Partial<SnapshotRequest>;
		if (value.type !== "snapshot" || typeof value.token !== "string") return null;
		return { type: "snapshot", token: value.token };
	} catch {
		return null;
	}
}

export class MonitorSocketServer {
	private readonly registration: MonitorRegistration;
	private readonly server: net.Server;
	private connections = 0;

	constructor(registration: MonitorRegistration) {
		this.registration = registration;
		this.server = net.createServer((socket) => {
			if (this.connections >= MAX_SOCKET_CONNECTIONS) { socket.destroy(); return; }
			this.connections += 1;
			socket.once("close", () => { this.connections -= 1; });
			this.handle(socket);
		});
	}

	private assertOwnedSocketPath(): void {
		if (!this.registration.socketDir || path.resolve(this.registration.socketPath) !== path.join(path.resolve(this.registration.socketDir), "s")) throw new Error("monitor socket path is not registry-owned");
		if (fs.lstatSync(this.registration.socketDir).isSymbolicLink() || (fs.statSync(this.registration.socketDir).mode & 0o777) !== 0o700) throw new Error("monitor socket directory is unsafe");
	}
	private async removeVerifiedStaleSocket(): Promise<void> {
		this.assertOwnedSocketPath(); if (!fs.existsSync(this.registration.socketPath)) return;
		const active=await new Promise<boolean>(resolve=>{const probe=net.createConnection(this.registration.socketPath);probe.once("connect",()=>{probe.destroy();resolve(true);});probe.once("error",()=>resolve(false));});
		if (active) throw new Error("monitor socket is already active");
		if (fs.lstatSync(this.registration.socketPath).isSymbolicLink()) throw new Error("monitor socket must not be a symlink"); fs.unlinkSync(this.registration.socketPath);
	}
	async listen(): Promise<void> {
		await this.removeVerifiedStaleSocket(); return new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.registration.socketPath, () => { this.server.off("error", reject); fs.chmodSync(this.registration.socketPath, 0o600); resolve(); }); });
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
		this.assertOwnedSocketPath(); try { fs.unlinkSync(this.registration.socketPath); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
	}

	mode(): number {
		return fs.statSync(this.registration.socketPath).mode & 0o777;
	}

	private handle(socket: net.Socket): void {
		let buffer = "";
		let handled = false;
		const deadline = setTimeout(() => { if (!handled) socket.destroy(); }, PARTIAL_FRAME_TIMEOUT_MS);
		socket.on("data", (chunk) => {
			if (handled) return;
			buffer += chunk.toString("utf8");
			if (Buffer.byteLength(buffer, "utf8") > MAX_SOCKET_FRAME_BYTES) {
				socket.destroy();
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			handled = true;
			const request = parseRequest(buffer.slice(0, newline));
			clearTimeout(deadline);
			let value: { type?: string; token?: string; taskId?: string; generation?: number };
			try { value = JSON.parse(buffer.slice(0, newline)) as typeof value; } catch { socket.destroy(); return; }
			if (value.type === "output") {
				if (!authorized(String(value.token ?? ""), this.registration.token)) { socket.end(JSON.stringify({ ok: false, error: "unauthorized" }) + "\n"); return; }
				if (!this.registration.output || (value as any).afterSequence === undefined || !validTaskRequest(value.taskId, value.generation, (value as any).afterSequence)) { socket.destroy(); return; }
				Promise.resolve().then(()=>this.registration.output!({ taskId: value.taskId!, generation: value.generation!, afterSequence: (value as any).afterSequence })).then((output) => { const body=JSON.stringify({ ok:true, output }); if(Buffer.byteLength(body)>MAX_OUTPUT_RESPONSE_BYTES) socket.end(JSON.stringify({ok:false,error:"response_too_large"})+"\n"); else socket.end(body+"\n"); }).catch(()=>socket.end(JSON.stringify({ok:false,error:"monitor_unavailable"})+"\n")); return;
			}
			if (value.type === "cancel") {
				if (!authorized(String(value.token ?? ""), this.registration.token)) { socket.end(JSON.stringify({ ok: false, error: "unauthorized" }) + "\n"); return; }
				if (!this.registration.cancel || !validTaskRequest(value.taskId, value.generation)) { socket.destroy(); return; }
				Promise.resolve().then(()=>this.registration.cancel!({ taskId: value.taskId!, generation: value.generation! })).then((result) => { const body=JSON.stringify({ ok: true, result }); if (Buffer.byteLength(body, "utf8") > MAX_CANCEL_RESPONSE_BYTES) socket.end(JSON.stringify({ok:false,error:"response_too_large"})+"\n"); else socket.end(body + "\n"); }).catch(()=>socket.end(JSON.stringify({ok:false,error:"monitor_unavailable"})+"\n")); return;
			}
			if (!request || !authorized(request.token, this.registration.token)) {
				if (request) socket.end(JSON.stringify({ ok: false, error: "unauthorized" }) + "\n");
				else socket.destroy();
				return;
			}
			try { const response = JSON.stringify({ ok: true, snapshot: this.registration.snapshot() }); if (Buffer.byteLength(response, "utf8") > MAX_SNAPSHOT_BYTES) socket.end(JSON.stringify({ok:false,error:"response_too_large"})+"\n"); else socket.end(response + "\n"); } catch { socket.end(JSON.stringify({ok:false,error:"monitor_unavailable"})+"\n"); }
		});
		socket.on("end", () => {
			if (!handled) socket.destroy();
		});
	}
}
