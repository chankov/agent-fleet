// scripts/lib/coms-envelope.ts
//
// The coms envelope protocol for NON-pi participants (the coms-cli and the
// Claude Code bridge). Mirrors the wire behavior of .pi/harnesses/coms/
// exactly — same registry files, same endpoint sockets, same ndjson envelopes
// and ack/nack lines — so a process using this module is indistinguishable
// from a pi peer to the rest of the pool. Any change here must stay
// compatible with the coms harness (and vice versa).
//
// No pi imports; erasable-TS; the pure parts are under node --test.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const COMS_DIR = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
export const MAX_HOPS = Number(process.env.PI_COMS_MAX_HOPS) || 5;
export const DEFAULT_TIMEOUT_MS = Number(process.env.PI_COMS_TIMEOUT_MS) || 1_800_000;
const LINE_CAP_BYTES = 64 * 1024;
// Pi peers refresh heartbeat_at every 30 seconds. A fresh heartbeat is the
// portable liveness signal for callers inside a sandbox/PID namespace, where
// process.kill(pid, 0) can incorrectly report a live host peer as ESRCH.
const REGISTRY_HEARTBEAT_FRESH_MS = 90_000;

// Registry paths are shared by every coms participant. Keep their components
// conservative so callers cannot escape the project/name directory structure.
export const COMS_PROJECT_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const COMS_NAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validateComsProject(project: string): string {
	if (
		project.length === 0 ||
		project === "." ||
		project.includes("..") ||
		project.includes("/") ||
		project.includes("\\") ||
		!COMS_PROJECT_SAFE.test(project)
	) {
		throw new Error(`Invalid project name: ${JSON.stringify(project)}`);
	}
	return project;
}

export function validateComsName(name: string): string {
	if (!COMS_NAME_SAFE.test(name)) throw new Error(`Invalid coms name: ${JSON.stringify(name)}`);
	return name;
}

// ━━ Envelope shapes (mirror coms/index.ts) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface PromptEnvelope {
	type: "prompt";
	msg_id: string;
	sender_session: string;
	sender_endpoint: string;
	hops: number;
	timestamp: string;
	prompt: string;
	sender_name: string;
	sender_cwd: string;
	conversation_id?: string | null;
	response_schema?: object | null;
}

export interface ResponseEnvelope {
	type: "response";
	msg_id: string;
	sender_session: string;
	sender_endpoint: string;
	hops: number;
	timestamp: string;
	response: unknown;
	error?: string | null;
}

export interface CancelEnvelope {
	type: "cancel";
	msg_id: string;
	from: string;
	to: string;
	created_at: string;
	ref_msg_id: string;
}

export interface AgentCard {
	name: string;
	purpose: string;
	model: string;
	color: string;
	context_used_pct: number;
	queue_depth: number;
}

export interface RegistryEntry {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	color: string;
	pid: number;
	endpoint: string;
	cwd: string;
	started_at: string;
	explicit: boolean;
	version: number;
	context_used_pct?: number;
	queue_depth?: number;
	heartbeat_at?: string;
}

// ━━ ids / misc ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function makeEndpoint(sessionId: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-coms-${sessionId}`;
	}
	return path.join(COMS_DIR, "sockets", `${sessionId}.sock`);
}

// ━━ Envelope constructors ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SenderIdentity {
	session_id: string;
	name: string;
	endpoint: string;
	cwd: string;
}

export function makePromptEnvelope(
	from: SenderIdentity,
	prompt: string,
	opts: { hops?: number; response_schema?: object | null } = {},
): PromptEnvelope {
	return {
		type: "prompt",
		msg_id: ulid(),
		sender_session: from.session_id,
		sender_endpoint: from.endpoint,
		hops: opts.hops ?? 0,
		timestamp: nowIso(),
		prompt,
		sender_name: from.name,
		sender_cwd: from.cwd,
		conversation_id: null,
		response_schema: opts.response_schema ?? null,
	};
}

export function makeResponseEnvelope(
	from: SenderIdentity,
	msg_id: string,
	response: unknown,
	error: string | null = null,
): ResponseEnvelope {
	return {
		type: "response",
		msg_id,
		sender_session: from.session_id,
		sender_endpoint: from.endpoint,
		hops: 0,
		timestamp: nowIso(),
		response,
		error,
	};
}

export function makeCancelEnvelope(options: {
	from: string;
	to: string;
	ref_msg_id: string;
	msg_id?: string;
	created_at?: string;
}): CancelEnvelope {
	return {
		type: "cancel",
		msg_id: options.msg_id ?? ulid(),
		from: options.from,
		to: options.to,
		created_at: options.created_at ?? nowIso(),
		ref_msg_id: options.ref_msg_id,
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isPromptEnvelope(obj: unknown): obj is PromptEnvelope {
	const e = obj as PromptEnvelope;
	return (
		!!e &&
		e.type === "prompt" &&
		typeof e.msg_id === "string" &&
		typeof e.prompt === "string" &&
		typeof e.sender_endpoint === "string" &&
		typeof e.hops === "number"
	);
}

export function isResponseEnvelope(obj: unknown): obj is ResponseEnvelope {
	const e = obj as ResponseEnvelope;
	return !!e && e.type === "response" && typeof e.msg_id === "string" && "response" in e;
}

export function isCancelEnvelope(obj: unknown): obj is CancelEnvelope {
	const e = obj as CancelEnvelope;
	return (
		!!e &&
		e.type === "cancel" &&
		isNonEmptyString(e.msg_id) &&
		isNonEmptyString(e.from) &&
		isNonEmptyString(e.to) &&
		isNonEmptyString(e.created_at) &&
		isNonEmptyString(e.ref_msg_id)
	);
}

// ━━ Registry I/O (mirrors coms/index.ts semantics) ━━━━━━━━━━━━━━━━━━━━━━━━

export function projectAgentsDir(project: string): string {
	return path.join(COMS_DIR, "projects", validateComsProject(project), "agents");
}

export function registryFilePath(project: string, name: string): string {
	return path.join(projectAgentsDir(project), `${validateComsName(name)}.json`);
}

export function ensureComsDirs(project: string): void {
	fs.mkdirSync(projectAgentsDir(project), { recursive: true });
	if (process.platform !== "win32") {
		fs.mkdirSync(path.join(COMS_DIR, "sockets"), { recursive: true });
		try {
			fs.chmodSync(COMS_DIR, 0o700);
		} catch {
			// best-effort
		}
	}
}

export function writeRegistryAtomic(entry: RegistryEntry, project: string): string {
	validateComsName(entry.name);
	const file = registryFilePath(project, entry.name);
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
	fs.renameSync(tmp, file);
	return file;
}

export function removeRegistryEntry(project: string, name: string): void {
	try {
		fs.unlinkSync(registryFilePath(project, name));
	} catch {
		// best-effort
	}
}

export function readAllRegistryEntries(project: string): RegistryEntry[] {
	const dir = projectAgentsDir(project);
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`Unable to read coms registry ${dir}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`);
	}
	const out: RegistryEntry[] = [];
	for (const f of files) {
		try {
			const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as RegistryEntry;
			if (e && typeof e.name === "string" && typeof e.endpoint === "string") out.push(e);
		} catch {
			// unparseable entry — skip
		}
	}
	return out;
}

export function registryHeartbeatIsFresh(entry: RegistryEntry, now = Date.now()): boolean {
	if (!entry.heartbeat_at) return false;
	const heartbeat = Date.parse(entry.heartbeat_at);
	if (!Number.isFinite(heartbeat)) return false;
	const age = now - heartbeat;
	return age >= -5_000 && age <= REGISTRY_HEARTBEAT_FRESH_MS;
}

// A fresh heartbeat wins before the PID probe because Codex remote commands
// can execute in a distinct PID namespace. For entries without a fresh
// heartbeat, preserve the harness rule: ESRCH removes; EPERM counts as live.
export function pruneDeadEntries(project: string): RegistryEntry[] {
	const live: RegistryEntry[] = [];
	for (const entry of readAllRegistryEntries(project)) {
		if (registryHeartbeatIsFresh(entry)) {
			live.push(entry);
			continue;
		}
		try {
			process.kill(entry.pid, 0);
			live.push(entry);
		} catch (e) {
			if ((e as NodeJS.ErrnoException)?.code === "ESRCH") {
				removeRegistryEntry(project, entry.name);
			} else {
				live.push(entry);
			}
		}
	}
	return live;
}

export function resolveUniqueName(project: string, desiredName: string): string {
	validateComsName(desiredName);
	const liveNames = new Set(pruneDeadEntries(project).map((e) => e.name));
	if (!liveNames.has(desiredName)) return desiredName;
	let n = 2;
	while (liveNames.has(`${desiredName}${n}`)) n++;
	return `${desiredName}${n}`;
}

// ━━ Transport (mirrors coms/index.ts) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function readOneLine(socket: net.Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		let settled = false;
		const onData = (chunk: Buffer) => {
			buf += chunk.toString("utf-8");
			if (buf.length > LINE_CAP_BYTES) {
				if (settled) return;
				settled = true;
				socket.removeListener("data", onData);
				reject(new Error("line too large"));
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				if (settled) return;
				settled = true;
				socket.removeListener("data", onData);
				resolve(buf.slice(0, nl));
			}
		};
		socket.on("data", onData);
		socket.once("error", (err) => {
			if (settled) return;
			settled = true;
			reject(err);
		});
		socket.once("close", () => {
			if (settled) return;
			settled = true;
			reject(new Error("connection closed before line received"));
		});
	});
}

// Send one envelope, await the ack/nack (or pong) line. Rejects on nack.
export function sendEnvelope(
	endpoint: string,
	envelope: PromptEnvelope | ResponseEnvelope | CancelEnvelope | { type: string; msg_id?: string; [k: string]: unknown },
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {
				// ignore
			}
			reject(err);
		};
		sock.once("error", fail);
		sock.once("connect", async () => {
			try {
				sock.write(JSON.stringify(envelope) + "\n");
				const line = await readOneLine(sock);
				const parsed = JSON.parse(line);
				try {
					sock.end();
				} catch {
					// ignore
				}
				if (settled) return;
				settled = true;
				if (parsed && parsed.type === "nack") {
					reject(new Error(parsed.error || "nack"));
				} else {
					resolve(parsed);
				}
			} catch (err) {
				fail(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}

function probeStaleSocket(endpoint: string): Promise<"in_use" | "stale"> {
	return new Promise((resolve) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (verdict: "in_use" | "stale") => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {
				// ignore
			}
			resolve(verdict);
		};
		const timer = setTimeout(() => finish("stale"), 250);
		sock.once("connect", () => {
			clearTimeout(timer);
			finish("in_use");
		});
		sock.once("error", () => {
			clearTimeout(timer);
			finish("stale");
		});
	});
}

export async function bindEndpoint(
	endpoint: string,
	connHandler: (socket: net.Socket) => void,
): Promise<net.Server> {
	if (process.platform !== "win32" && fs.existsSync(endpoint)) {
		const verdict = await probeStaleSocket(endpoint);
		if (verdict === "in_use") {
			throw new Error(`coms: endpoint already in use (${endpoint})`);
		}
		try {
			fs.unlinkSync(endpoint);
		} catch {
			// best-effort
		}
	}
	return await new Promise<net.Server>((resolve, reject) => {
		const server = net.createServer(connHandler);
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}

export function writeAck(socket: net.Socket, msg_id: string): void {
	try {
		socket.write(JSON.stringify({ type: "ack", msg_id }) + "\n");
	} catch {
		// ignore
	}
	try {
		socket.end();
	} catch {
		// ignore
	}
}

export function writeNack(socket: net.Socket, msg_id: string, error: string): void {
	try {
		socket.write(JSON.stringify({ type: "nack", msg_id, error }) + "\n");
	} catch {
		// ignore
	}
	try {
		socket.end();
	} catch {
		// ignore
	}
}

// Line-oriented connection handler factory: parses each ndjson line and
// dispatches; malformed lines are nacked.
export function makeConnHandler(
	onEnvelope: (env: Record<string, unknown>, socket: net.Socket) => void,
): (socket: net.Socket) => void {
	return (socket) => {
		let buf = "";
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf-8");
			if (buf.length > LINE_CAP_BYTES) {
				writeNack(socket, "", "line too large");
				socket.destroy();
				return;
			}
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(line);
				} catch {
					writeNack(socket, "", "invalid json");
					continue;
				}
				onEnvelope(parsed, socket);
			}
		});
	};
}
