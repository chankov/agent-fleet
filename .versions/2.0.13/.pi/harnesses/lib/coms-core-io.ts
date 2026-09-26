import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { ComsRegistryEntry } from "./coms-registry-entry.ts";

export const COMS_DIR = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
export const MAX_HOPS = Number(process.env.PI_COMS_MAX_HOPS) || 5;
export const TIMEOUT_MS = Number(process.env.PI_COMS_TIMEOUT_MS) || 1_800_000;
export const PING_INTERVAL_MS = Number(process.env.PI_COMS_PING_INTERVAL_MS) || 10_000;
export const KEEPALIVE_INTERVAL_MS = 30_000;
export const LINE_CAP_BYTES = 64 * 1024;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const FALLBACK_PALETTE = [
	"#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
	"#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

export type RegistryEntry = ComsRegistryEntry;
export type PeerStatus = "idle" | "working" | "booting";
export type EnvelopeType = "prompt" | "response" | "ping";

export interface Envelope {
	type: EnvelopeType;
	msg_id: string;
	sender_session: string;
	sender_endpoint: string;
	hops: number;
	timestamp: string;
}

export interface PromptEnvelope extends Envelope {
	type: "prompt";
	prompt: string;
	sender_name: string;
	sender_cwd: string;
	conversation_id?: string | null;
	response_schema?: object | null;
	reply_timeout_ms?: number | null;
}

export interface ResponseEnvelope extends Envelope {
	type: "response";
	response: any;
	error?: string | null;
}

export interface PingEnvelope extends Envelope {
	type: "ping";
}

export interface AgentCard {
	name: string;
	purpose: string;
	model: string;
	color: string;
	context_used_pct: number;
	queue_depth: number;
	pane_id?: string | null;
	status?: PeerStatus;
}

export interface Pong {
	type: "pong";
	msg_id: string;
	agent_card: AgentCard;
}

export interface PendingReply {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout | null;
	promise: Promise<{ response?: any; error?: string | null }>;
	result?: { response?: any; error?: string | null };
	target_name?: string;
	created_at: string;
}

export interface InboundContext {
	msg_id: string;
	hops: number;
	sender_endpoint: string;
	sender_session: string;
	response_schema?: object | null;
	fulfilled: boolean;
}

export interface ComsIdentity {
	session_id: string;
	name: string;
	purpose: string;
	color: string;
	project: string;
	explicit: boolean;
	cwd: string;
	model: string;
	endpoint: string;
	registryFile: string;
	started_at: string;
}

interface CliFlags {
	name?: string;
	purpose?: string;
	project?: string;
	color?: string;
	explicit?: boolean;
}

export function ulid(): string {
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let time = Date.now();
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[time % 32] + timeStr;
		time = Math.floor(time / 32);
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

export function hexFg(hex: string, text: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function abbreviateModel(model: string): string {
	let abbreviated = model || "";
	if (abbreviated.startsWith("claude-")) abbreviated = abbreviated.slice("claude-".length);
	return abbreviated.length > 14 ? abbreviated.slice(0, 14) : abbreviated;
}

export function isValidHex(hex: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(hex);
}

export function fallbackColor(sessionId: string): string {
	const hash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
	return FALLBACK_PALETTE[Number(BigInt(`0x${hash}`)) % FALLBACK_PALETTE.length];
}

export function parseComsFrontmatter(raw: string): { name?: string; description?: string; color?: string; body: string } {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { body: raw };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		const key = line.slice(0, index).trim();
		let value = line.slice(index + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		frontmatter[key] = value;
	}
	return { name: frontmatter.name, description: frontmatter.description, color: frontmatter.color, body: match[2] };
}

export function readCliFlags(pi: ExtensionAPI): CliFlags {
	const name = pi.getFlag("name") as string | undefined;
	const purpose = pi.getFlag("purpose") as string | undefined;
	const project = pi.getFlag("project") as string | undefined;
	const color = pi.getFlag("color") as string | undefined;
	const explicit = pi.getFlag("explicit") as boolean | undefined;
	return {
		name: name && name.length > 0 ? name : undefined,
		purpose: purpose && purpose.length > 0 ? purpose : undefined,
		project: project && project.length > 0 ? project : undefined,
		color: color && color.length > 0 ? color : undefined,
		explicit: explicit === true,
	};
}

function findSystemPromptPath(argv: string[]): string | null {
	const scan = (flag: string): string | null => {
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] !== flag || i + 1 >= argv.length) continue;
			const candidate = argv[i + 1];
			if (!candidate.endsWith(".md")) continue;
			try {
				if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
			} catch { /* try the next candidate */ }
		}
		return null;
	};
	return scan("--system-prompt") ?? scan("--append-system-prompt");
}

export function readFrontmatterFromArgv(argv: string[]): { name?: string; description?: string; color?: string } {
	const promptPath = findSystemPromptPath(argv);
	if (!promptPath) return {};
	try {
		const { name, description, color } = parseComsFrontmatter(fs.readFileSync(promptPath, "utf8"));
		return { name, description, color };
	} catch {
		return {};
	}
}

export function projectAgentsDir(project: string): string {
	return path.join(COMS_DIR, "projects", project, "agents");
}

function registryFilePath(project: string, name: string): string {
	return path.join(projectAgentsDir(project), `${name}.json`);
}

export function writeRegistryAtomic(entry: RegistryEntry, project: string): string {
	const dir = projectAgentsDir(project);
	fs.mkdirSync(dir, { recursive: true });
	const finalPath = registryFilePath(project, entry.name);
	const temporaryPath = `${finalPath}.tmp`;
	fs.writeFileSync(temporaryPath, JSON.stringify(entry, null, 2));
	fs.renameSync(temporaryPath, finalPath);
	return finalPath;
}

export function readAllRegistryEntries(project: string): RegistryEntry[] {
	const dir = projectAgentsDir(project);
	if (!fs.existsSync(dir)) return [];
	let files: string[];
	try { files = fs.readdirSync(dir); } catch { return []; }
	const entries: RegistryEntry[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as RegistryEntry;
			if (parsed && typeof parsed.session_id === "string") entries.push(parsed);
		} catch { /* skip malformed entries */ }
	}
	return entries;
}

export function readAllRegistryEntriesAcrossProjects(): RegistryEntry[] {
	return listProjects().flatMap(readAllRegistryEntries);
}

export function removeRegistryEntry(project: string, name: string): void {
	try { fs.unlinkSync(registryFilePath(project, name)); } catch { /* best effort */ }
}

export function pruneDeadEntries(project: string): RegistryEntry[] {
	const live: RegistryEntry[] = [];
	for (const entry of readAllRegistryEntries(project)) {
		try {
			process.kill(entry.pid, 0);
			live.push(entry);
		} catch (error: any) {
			if (error?.code === "ESRCH") removeRegistryEntry(project, entry.name);
			else live.push(entry);
		}
	}
	return live;
}

export function pruneDeadEntriesAllProjects(): RegistryEntry[] {
	return listProjects().flatMap(pruneDeadEntries);
}

export function resolveUniqueName(project: string, desiredName: string): string {
	const liveNames = new Set(pruneDeadEntries(project).map(entry => entry.name));
	if (!liveNames.has(desiredName)) return desiredName;
	let suffix = 2;
	while (liveNames.has(`${desiredName}${suffix}`)) suffix++;
	return `${desiredName}${suffix}`;
}

export function listProjects(): string[] {
	const root = path.join(COMS_DIR, "projects");
	try {
		return fs.readdirSync(root).filter(name => {
			try { return fs.statSync(path.join(root, name)).isDirectory(); } catch { return false; }
		});
	} catch {
		return [];
	}
}

export function makeEndpoint(sessionId: string): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\pi-coms-${sessionId}`
		: path.join(COMS_DIR, "sockets", `${sessionId}.sock`);
}

export function probeStaleSocket(endpoint: string): Promise<"in_use" | "stale"> {
	return new Promise(resolve => {
		const socket = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (verdict: "in_use" | "stale") => {
			if (settled) return;
			settled = true;
			try { socket.destroy(); } catch { /* ignore */ }
			resolve(verdict);
		};
		const timer = setTimeout(() => finish("stale"), 250);
		socket.once("connect", () => { clearTimeout(timer); finish("in_use"); });
		socket.once("error", () => { clearTimeout(timer); finish("stale"); });
	});
}

export async function bindEndpoint(endpoint: string, handler: (socket: net.Socket) => void): Promise<net.Server> {
	if (process.platform !== "win32" && fs.existsSync(endpoint)) {
		if (await probeStaleSocket(endpoint) === "in_use") throw new Error(`coms: endpoint already in use (${endpoint})`);
		try { fs.unlinkSync(endpoint); } catch { /* best effort */ }
	}
	return new Promise<net.Server>((resolve, reject) => {
		const server = net.createServer(handler);
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}

export function readOneLine(socket: net.Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		let settled = false;
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (buffer.length > LINE_CAP_BYTES) {
				if (settled) return;
				settled = true;
				socket.removeListener("data", onData);
				reject(new Error("line too large"));
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0 || settled) return;
			settled = true;
			socket.removeListener("data", onData);
			resolve(buffer.slice(0, newline));
		};
		socket.on("data", onData);
		socket.once("error", error => { if (!settled) { settled = true; reject(error); } });
		socket.once("close", () => { if (!settled) { settled = true; reject(new Error("connection closed before line received")); } });
	});
}

export function sendEnvelope(endpoint: string, envelope: Envelope | Pong | { type: string; msg_id?: string; [key: string]: any }): Promise<any> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ path: endpoint });
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			try { socket.destroy(); } catch { /* ignore */ }
			reject(error);
		};
		socket.once("error", fail);
		socket.once("connect", async () => {
			try {
				socket.write(`${JSON.stringify(envelope)}\n`);
				const parsed = JSON.parse(await readOneLine(socket));
				try { socket.end(); } catch { /* ignore */ }
				if (settled) return;
				settled = true;
				if (parsed?.type === "nack") reject(new Error(parsed.error || "nack"));
				else resolve(parsed);
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}
